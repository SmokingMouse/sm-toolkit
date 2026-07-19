/**
 * 设备能力探测：已装 Runtime 版本 + 本机 sm-toolkit Model route 清单。
 * server 建 agent 时用结构化 route 校验模型与可用状态；endpoints 仅为旧客户端保留。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadEndpoints, listEndpoints } from "@sm/llm";
import type { EndpointInfo } from "@sm/llm";
import { parse as parseYaml } from "yaml";
import type { BackendKind, DeviceCapabilities, InstalledSkillCapability, ModelRouteCapability, SkillDependency } from "../protocol.js";

const MAX_SKILLS = 128;
const MAX_SKILL_BYTES = 128 * 1024;
const MAX_SKILL_BUNDLE_BYTES = 512 * 1024;
const MAX_SKILL_FILES = 64;
const MAX_ENVIRONMENT_SKILL_NAMES = 512;

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
 * import 时保存成 Workspace 快照；GET /api/devices 会剥离 instruction 与 files 正文。
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
        const directory = dirname(file);
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
          files: readSkillBundle(directory),
          dependencies: frontmatter.dependencies,
        });
      } catch {
        // 坏 symlink / 无权限 / 非 UTF-8：不宣称可导入，避免同步后运行才失败。
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Harbor Agent 只应看到 control plane 绑定的 Skill。Claude 有 safe-mode；Codex 仍会
 * 扫描 `$HOME/.agents/skills`、`$CODEX_HOME/skills(.system)` 和 checkout 祖先的
 * `.agents/.codex` Skill，因此在 Run 启动时取一份名字快照，交给 Codex 的
 * `skills.config` 逐一禁用，连 Issue 文本里的显式 `$skill` 也不能绕过。
 */
export function detectEnvironmentSkillNames(
  cwd: string | null | undefined,
  roots: string[] = environmentSkillRoots(cwd),
  maxNames = MAX_ENVIRONMENT_SKILL_NAMES,
): string[] {
  const names = new Set<string>();
  for (const root of [...new Set(roots)]) {
    if (!existsSync(root)) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      throw new Error(
        `无法完整扫描环境 Skill root ${root}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const entry of entries) {
      const candidate = join(root, entry.name, "SKILL.md");
      if (!existsSync(candidate)) continue;
      try {
        if (statSync(candidate).size > MAX_SKILL_BYTES) {
          throw new Error(`Skill 文件超过 ${MAX_SKILL_BYTES} bytes 安全扫描上限`);
        }
        const frontmatter = readSkillFrontmatter(readFileSync(realpathSync(candidate), "utf8"));
        const name = frontmatter.name?.trim() || entry.name.trim();
        if (!name || names.has(name)) continue;
        if (names.size >= maxNames) {
          throw new Error(
            `环境 Skill 超过安全上限 ${maxNames}，拒绝启动 Codex Run；请清理 Device 的 Runtime/checkout Skill 安装`,
          );
        }
        names.add(name);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("环境 Skill 超过安全上限")) {
          throw error;
        }
        throw new Error(
          `无法确认环境 Skill ${candidate} 的禁用名称：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return [...names].sort();
}

function environmentSkillRoots(cwd: string | null | undefined): string[] {
  const home = homedir();
  const codexHome = process.env.CODEX_HOME ?? join(home, ".codex");
  const roots = [
    ...defaultSkillRoots().map((root) => root.path),
    join(codexHome, "skills", ".system"),
    "/etc/codex/skills",
  ];
  if (!cwd) return roots;
  let current = resolve(cwd);
  for (let depth = 0; depth < 64; depth++) {
    roots.push(join(current, ".agents", "skills"), join(current, ".codex", "skills"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

function defaultSkillRoots(): SkillScanRoot[] {
  const home = homedir();
  return [
    { path: join(process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "skills"), runtimes: ["claude"] },
    { path: join(process.env.CODEX_HOME ?? join(home, ".codex"), "skills"), runtimes: ["codex"] },
    { path: join(home, ".agents", "skills"), runtimes: ["claude", "codex"] },
  ];
}

function readSkillFrontmatter(text: string): { name?: string; description?: string; dependencies?: SkillDependency[] } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return {};
  try {
    const value = parseYaml(match[1] ?? "") as { name?: unknown; description?: unknown; dependencies?: unknown } | null;
    return {
      ...(typeof value?.name === "string" ? { name: value.name.trim() } : {}),
      ...(typeof value?.description === "string" ? { description: value.description.trim() } : {}),
      dependencies: parseSkillDependencies(value?.dependencies),
    };
  } catch {
    return {};
  }
}

function readSkillBundle(directory: string): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  let total = 0;
  const walk = (current: string): void => {
    if (files.length >= MAX_SKILL_FILES || total >= MAX_SKILL_BUNDLE_BYTES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_SKILL_FILES || total >= MAX_SKILL_BUNDLE_BYTES) break;
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "__pycache__") continue;
      const candidate = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(candidate);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const real = realpathSync(candidate);
        const prefix = `${realpathSync(directory)}${sep}`;
        if (real !== join(realpathSync(directory), "SKILL.md") && !real.startsWith(prefix)) continue;
        const size = statSync(real).size;
        if (size > MAX_SKILL_BYTES || total + size > MAX_SKILL_BUNDLE_BYTES) continue;
        const content = readFileSync(real);
        if (content.includes(0)) continue;
        files.push({ path: relative(directory, real).split(sep).join("/"), content: content.toString("utf8") });
        total += size;
      } catch {
        // bundle 中单个文件不可读不影响整个 Skill 被发现。
      }
    }
  };
  walk(directory);
  return files;
}

function parseSkillDependencies(value: unknown): SkillDependency[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string" && item.trim()) return [{ name: item.trim(), spec: null, required: true }];
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      return typeof record.name === "string" && record.name.trim()
        ? [{
            name: record.name.trim(),
            spec: typeof record.spec === "string" ? record.spec : null,
            required: record.required !== false,
          }]
        : [];
    });
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([name, spec]) =>
      typeof spec === "string" || spec === null
        ? [{ name, spec: typeof spec === "string" ? spec : null, required: true }]
        : []);
  }
  return [];
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
