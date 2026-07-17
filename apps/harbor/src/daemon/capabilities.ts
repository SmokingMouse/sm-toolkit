/**
 * 设备能力探测：已装 Runtime 版本 + 本机 sm-toolkit Model route 清单。
 * server 建 agent 时用结构化 route 校验模型与可用状态；endpoints 仅为旧客户端保留。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadEndpoints, listEndpoints } from "@sm/llm";
import type { EndpointInfo } from "@sm/llm";
import { parse as parseYaml } from "yaml";
import type { BackendKind, DeviceCapabilities, InstalledSkillCapability, ModelRouteCapability } from "../protocol.js";

const MAX_SKILLS = 128;
const MAX_SKILL_BYTES = 128 * 1024;

export interface SkillScanRoot {
  path: string;
  runtimes: BackendKind[];
}

function cliVersion(cmd: string): string | null {
  try {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf-8", timeout: 10_000 });
    if (r.status !== 0 || !r.stdout) return null;
    // "2.1.207 (Claude Code)" → "2.1.207"；"codex-cli 0.142.2" → "0.142.2"
    const out = r.stdout.trim();
    return /\d+\.\d+[^\s]*/.exec(out)?.[0] ?? out.split(/\s+/)[0] ?? null;
  } catch {
    return null;
  }
}

export function detectCapabilities(): DeviceCapabilities {
  const clis: Record<string, string> = {};
  const claude = cliVersion("claude");
  if (claude) clis.claude = claude;
  const codex = cliVersion("codex");
  if (codex) clis.codex = codex;

  let endpoints: string[] = [];
  let modelRoutes: ModelRouteCapability[] = [];
  try {
    const configPath = process.env.SM_TOOLKIT_ENDPOINTS_PATH || undefined;
    const infos = listEndpoints(loadEndpoints(configPath));
    modelRoutes = buildModelRoutes(infos);
    // legacy endpoints 只打平 claude routes：claude 校验/旧客户端不消费 codex 清单
    endpoints = [...new Set(modelRoutes.flatMap((route) => [route.model, route.id]))];
  } catch {
    // endpoints.yaml 缺失/坏 → 空清单；agent 仍可用裸 tier 别名或 CLI 默认模型
  }
  if (clis.codex) modelRoutes = [...modelRoutes, ...detectCodexModelRoutes()];
  return { clis, endpoints, modelRoutes, installedSkills: detectInstalledSkills() };
}

/**
 * 只扫描各 Runtime 的显式安装目录，不递归插件 cache。正文随 hello 送到 server，
 * import 时保存成 Workspace 快照；GET /api/devices 会剥离 instruction。
 */
export function detectInstalledSkills(roots: SkillScanRoot[] = defaultSkillRoots()): InstalledSkillCapability[] {
  const found = new Map<string, InstalledSkillCapability>();
  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(root.path, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.size >= MAX_SKILLS) break;
      const candidate = join(root.path, entry.name, "SKILL.md");
      if (!existsSync(candidate)) continue;
      try {
        if (statSync(candidate).size > MAX_SKILL_BYTES) continue;
        const file = realpathSync(candidate);
        const instruction = readFileSync(file, "utf8");
        const frontmatter = readSkillFrontmatter(instruction);
        const existing = found.get(file);
        if (existing) {
          existing.runtimes = [...new Set([...existing.runtimes, ...root.runtimes])].sort() as BackendKind[];
          continue;
        }
        found.set(file, {
          name: frontmatter.name || entry.name,
          description: frontmatter.description || "",
          path: dirname(file),
          runtimes: [...root.runtimes],
          instruction,
        });
      } catch {
        // 坏 symlink / 无权限 / 非 UTF-8：不宣称可导入，避免同步后运行才失败。
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function defaultSkillRoots(): SkillScanRoot[] {
  const home = homedir();
  return [
    { path: join(process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "skills"), runtimes: ["claude"] },
    { path: join(process.env.CODEX_HOME ?? join(home, ".codex"), "skills"), runtimes: ["codex"] },
    { path: join(home, ".agents", "skills"), runtimes: ["claude", "codex"] },
  ];
}

function readSkillFrontmatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return {};
  try {
    const value = parseYaml(match[1] ?? "") as { name?: unknown; description?: unknown } | null;
    return {
      ...(typeof value?.name === "string" ? { name: value.name.trim() } : {}),
      ...(typeof value?.description === "string" ? { description: value.description.trim() } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Harbor 跑的是 coding runtime，不是 @sm/llm 的直连 chat。
 * Claude Code 只能接 native 或 anthropic-compatible route；openai-only route 不上报，
 * 避免 UI 可选、执行时才报协议不兼容。
 */
export function buildModelRoutes(infos: EndpointInfo[]): ModelRouteCapability[] {
  return infos.flatMap((info) => {
    const native = !info.openai_url && !info.anthropic_url;
    if (!native && !info.anthropic_url) return [];
    return [{
      id: `${info.provider}:${info.model}`,
      provider: info.provider,
      model: info.model,
      runtime: "claude" as const,
      kind: native ? "native" as const : "anthropic" as const,
      ready: native || info.hasKey,
    }];
  });
}

/** codex models_cache.json 中 models[] 的必需字段（其余忽略）。 */
export interface CodexCachedModel {
  slug: string;
  display_name?: string;
  visibility?: string;
}

/**
 * Codex 不接 sm-toolkit route；其可用模型由 codex CLI 按登录态 fetch 并缓存在
 * $CODEX_HOME/models_cache.json。只暴露 visibility === "list"（官方模型选择器可见项）。
 */
export function buildCodexModelRoutes(models: CodexCachedModel[]): ModelRouteCapability[] {
  return models
    .filter((entry) => entry.slug && entry.visibility === "list")
    .map((entry) => ({
      id: `codex:${entry.slug}`,
      provider: "codex",
      model: entry.slug,
      label: entry.display_name?.trim() || undefined,
      runtime: "codex" as const,
      kind: "native" as const,
      ready: true,
    }));
}

function detectCodexModelRoutes(): ModelRouteCapability[] {
  try {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const parsed = JSON.parse(readFileSync(join(codexHome, "models_cache.json"), "utf-8")) as { models?: CodexCachedModel[] };
    return buildCodexModelRoutes(parsed.models ?? []);
  } catch {
    // cache 不存在/坏 JSON → 空清单，UI 回落到手输 model
    return [];
  }
}
