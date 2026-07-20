/** Skill bundle 来源适配：Codebase / GitHub / ZIP。所有路径先校验，单包上限 512KB/64 files。 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillDependency, SkillSource } from "../protocol.js";
import { BitsCodebaseRunner, type CodebaseCommandRunner } from "./codebase.js";

const MAX_FILES = 64;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_BUNDLE_BYTES = 512 * 1024;

export interface ImportedSkillBundle {
  source: Exclude<SkillSource, "builtin" | "manual" | "runtime">;
  originUrl: string | null;
  sourceRef: string | null;
  files: { path: string; content: string }[];
}

export interface ImportedSkillMetadata {
  name: string;
  description: string;
  instruction: string;
  dependencies: SkillDependency[];
}

export type GitHubImportCredentialResolver = (input: {
  workspaceId: string;
  owner: string;
  repository: string;
}) => string | null | Promise<string | null>;

export class SkillImportService {
  constructor(
    private readonly codebase: CodebaseCommandRunner = new BitsCodebaseRunner(),
    private readonly fetcher: typeof fetch = fetch,
    private readonly githubCredential: GitHubImportCredentialResolver | null = null,
  ) {}

  async fromCodebase(
    repository: string,
    path: string,
    ref = "main",
  ): Promise<ImportedSkillBundle> {
    const cleanRepository = repository.trim();
    const root = cleanPath(path || ".");
    if (
      !/^[\w.-]+\/[\w./-]+$/.test(cleanRepository) ||
      cleanRepository.includes("..")
    ) {
      throw new Error("Codebase repository 需要形如 team/repository");
    }
    const files: { path: string; content: string }[] = [];
    const queue = [root];
    const visited = new Set<string>();
    while (
      queue.length &&
      files.length < MAX_FILES &&
      visited.size < MAX_FILES * 2
    ) {
      const directory = queue.shift()!;
      if (visited.has(directory)) continue;
      visited.add(directory);
      const listing = await this.codebaseJson([
        "repo",
        "file",
        "list",
        "-R",
        cleanRepository,
        "--path",
        directory,
        "--ref",
        ref,
      ]);
      for (const entry of codebaseEntries(listing)) {
        const absolute = cleanPath(entry.path);
        if (entry.directory) queue.push(absolute);
        else {
          const result = await this.codebase.run([
            "repo",
            "file",
            "cat",
            "-R",
            cleanRepository,
            "--path",
            absolute,
            "--ref",
            ref,
          ]);
          if (result.exitCode !== 0)
            throw new Error(result.stderr.trim() || `读取 ${absolute} 失败`);
          addFile(files, relativeTo(root, absolute), result.stdout);
        }
        if (files.length >= MAX_FILES) break;
      }
    }
    validateBundle(files);
    return {
      source: "codebase",
      originUrl: `codebase://${cleanRepository}`,
      sourceRef: ref,
      files,
    };
  }

  async fromGitHub(
    url: string,
    refOverride?: string,
    workspaceId?: string,
  ): Promise<ImportedSkillBundle> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com")
      throw new Error("GitHub source 必须是 github.com HTTPS URL");
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) throw new Error("GitHub URL 缺少 owner/repository");
    const [owner, repository] = parts;
    const tree = parts[2] === "tree" ? parts.slice(3) : [];
    const ref = refOverride?.trim() || tree[0] || "main";
    const root = cleanPath(tree.length ? tree.slice(1).join("/") || "." : ".");
    const files: { path: string; content: string }[] = [];
    const queue = [root];
    const headers: HeadersInit = {
      Accept: "application/vnd.github+json",
      "User-Agent": "Harbor",
    };
    const credential = this.githubCredential && workspaceId
      ? await this.githubCredential({ workspaceId, owner: owner!, repository: repository! })
      : null;
    if (credential)
      (headers as Record<string, string>).Authorization =
        `Bearer ${credential}`;
    while (queue.length && files.length < MAX_FILES) {
      const path = queue.shift()!;
      const api = `https://api.github.com/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repository!)}/contents/${path === "." ? "" : path}?ref=${encodeURIComponent(ref)}`;
      const response = await this.fetcher(api, { headers });
      if (!response.ok)
        throw new Error(
          `GitHub import 失败（${response.status}）：${(await response.text()).slice(0, 500)}`,
        );
      const entries = (await response.json()) as unknown;
      const list = Array.isArray(entries) ? entries : [entries];
      for (const entry of list) {
        if (
          !isRecord(entry) ||
          typeof entry.path !== "string" ||
          typeof entry.type !== "string"
        )
          continue;
        if (entry.type === "dir") queue.push(cleanPath(entry.path));
        else if (
          entry.type === "file" &&
          typeof entry.download_url === "string"
        ) {
          const downloadUrl = new URL(entry.download_url);
          if (downloadUrl.protocol !== "https:" || !["raw.githubusercontent.com", "api.github.com"].includes(downloadUrl.hostname)) {
            throw new Error(`GitHub file ${entry.path} download_url origin 不可信`);
          }
          const content = await this.fetcher(downloadUrl, { headers });
          if (!content.ok)
            throw new Error(
              `GitHub file ${entry.path} 下载失败（${content.status}）`,
            );
          addFile(files, relativeTo(root, entry.path), await content.text());
        }
        if (files.length >= MAX_FILES) break;
      }
    }
    validateBundle(files);
    return { source: "github", originUrl: url, sourceRef: ref, files };
  }

  async fromZip(base64: string): Promise<ImportedSkillBundle> {
    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length || buffer.length > 2 * 1024 * 1024)
      throw new Error("ZIP 需要是 1B–2MB");
    const directory = mkdtempSync(join(tmpdir(), "harbor-skill-"));
    const archive = join(directory, "skill.zip");
    try {
      writeFileSync(archive, buffer, { mode: 0o600 });
      const listing = await unzip(["-Z1", archive], 512 * 1024);
      if (listing.exitCode !== 0)
        throw new Error(`ZIP 无法读取：${listing.stderr || listing.stdout}`);
      const paths = listing.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .filter((path) => !path.endsWith("/"));
      const commonRoot = commonDirectory(paths);
      const files: { path: string; content: string }[] = [];
      for (const raw of paths.slice(0, MAX_FILES + 1)) {
        const path = cleanPath(raw);
        const result = await unzip(["-p", archive, raw], MAX_FILE_BYTES + 1);
        if (result.exitCode !== 0) throw new Error(`ZIP file ${path} 无法读取`);
        if (result.stdout.includes("\0")) continue;
        addFile(files, relativeTo(commonRoot, path), result.stdout);
      }
      validateBundle(files);
      return { source: "upload", originUrl: null, sourceRef: null, files };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  async refresh(input: {
    source: "codebase" | "github";
    originUrl: string;
    sourcePath: string | null;
    sourceRef: string | null;
    workspaceId?: string;
  }): Promise<ImportedSkillBundle> {
    if (input.source === "github")
      return this.fromGitHub(input.originUrl, input.sourceRef ?? undefined, input.workspaceId);
    if (!input.originUrl.startsWith("codebase://"))
      throw new Error("Codebase Skill originUrl 无效");
    const repository = input.originUrl
      .slice("codebase://".length)
      .replace(/^\/+/, "");
    return this.fromCodebase(
      repository,
      input.sourcePath ?? ".",
      input.sourceRef ?? "main",
    );
  }

  private async codebaseJson(args: string[]): Promise<unknown> {
    const result = await this.codebase.run(args);
    if (result.exitCode !== 0)
      throw new Error(
        result.stderr.trim() ||
          result.stdout.trim() ||
          "bitscli Codebase import 失败",
      );
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error("bitscli Codebase file list 未返回 JSON");
    }
  }
}

export function importedSkillMetadata(
  files: { path: string; content: string }[],
  fallbackName: string,
): ImportedSkillMetadata {
  validateBundle(files);
  const entry =
    files.find((file) => file.path === "SKILL.md") ??
    (files.length === 1 && files[0]!.path.endsWith("/SKILL.md")
      ? files[0]
      : null);
  if (!entry) throw new Error("Skill bundle 根目录缺少 SKILL.md");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(entry.content);
  let frontmatter: Record<string, unknown> = {};
  if (match) {
    try {
      frontmatter =
        (parseYaml(match[1] ?? "") as Record<string, unknown>) ?? {};
    } catch {
      throw new Error("SKILL.md frontmatter YAML 无法解析");
    }
  }
  const dependencies = parseDependencies(frontmatter.dependencies);
  return {
    name:
      typeof frontmatter.name === "string" && frontmatter.name.trim()
        ? frontmatter.name.trim()
        : fallbackName,
    description:
      typeof frontmatter.description === "string"
        ? frontmatter.description.trim()
        : "",
    instruction: entry.content,
    dependencies,
  };
}

function codebaseEntries(
  value: unknown,
): { path: string; directory: boolean }[] {
  if (!isRecord(value)) return [];
  const candidates = [
    value.Files,
    value.files,
    value.Entries,
    value.entries,
    value.Items,
    value.items,
  ];
  const list = candidates.find(Array.isArray) as unknown[] | undefined;
  return (list ?? []).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const path = [entry.Path, entry.path, entry.Name, entry.name].find(
      (candidate) => typeof candidate === "string",
    ) as string | undefined;
    const type = String(
      entry.Type ?? entry.type ?? entry.Kind ?? entry.kind ?? "file",
    ).toLowerCase();
    return path ? [{ path, directory: /dir|tree|folder/.test(type) }] : [];
  });
}

function parseDependencies(value: unknown): SkillDependency[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim())
      return [{ name: item.trim(), spec: null, required: true }];
    if (!isRecord(item) || typeof item.name !== "string" || !item.name.trim())
      return [];
    return [
      {
        name: item.name.trim(),
        spec: typeof item.spec === "string" ? item.spec : null,
        required: item.required !== false,
      },
    ];
  });
}

function addFile(
  files: { path: string; content: string }[],
  path: string,
  content: string,
): void {
  const clean = cleanPath(path);
  if (Buffer.byteLength(content) > MAX_FILE_BYTES)
    throw new Error(`Skill file ${clean} 超过 128KB`);
  if (!files.some((file) => file.path === clean))
    files.push({ path: clean, content });
}

function validateBundle(files: { path: string; content: string }[]): void {
  if (!files.length) throw new Error("Skill bundle 为空");
  if (files.length > MAX_FILES)
    throw new Error(`Skill bundle 超过 ${MAX_FILES} files`);
  const bytes = files.reduce(
    (sum, file) => sum + Buffer.byteLength(file.content),
    0,
  );
  if (bytes > MAX_BUNDLE_BYTES) throw new Error("Skill bundle 超过 512KB");
}

function cleanPath(value: string): string {
  const path =
    value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "") || ".";
  if (
    path.startsWith("/") ||
    path.split("/").includes("..") ||
    path.includes("\0")
  )
    throw new Error(`非法 Skill path：${value}`);
  return path;
}

function relativeTo(root: string, path: string): string {
  if (root === ".") return cleanPath(path);
  if (path === root) return path.split("/").at(-1)!;
  if (!path.startsWith(`${root}/`))
    throw new Error(`文件 ${path} 不在 Skill root ${root} 内`);
  return cleanPath(path.slice(root.length + 1));
}

function commonDirectory(paths: string[]): string {
  if (!paths.length) return ".";
  const first = cleanPath(paths[0]!).split("/");
  if (first.length < 2) return ".";
  const root = first[0]!;
  return paths.every((path) => cleanPath(path).startsWith(`${root}/`))
    ? root
    : ".";
}

function unzip(
  args: string[],
  maxStdoutBytes: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("unzip", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxStdoutBytes) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`ZIP 输出超过 ${maxStdoutBytes} bytes`));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) =>
      reject(new Error(`unzip 不可用：${error.message}`)),
    );
    child.on("close", (code) => {
      if (!settled) resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
