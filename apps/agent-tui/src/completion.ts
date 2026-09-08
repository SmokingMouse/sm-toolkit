import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

export interface Candidate { name: string; description: string }
export interface Completion { start: number; prefix: "@" | "/"; candidates: Candidate[]; selected: number; draft?: string }
export const commands: Candidate[] = [
  { name: "new", description: "新建会话" },
  { name: "clear", description: "新建空会话" },
  { name: "threads", description: "选择 daemon 会话" },
  { name: "resume", description: "恢复会话：/resume [id]" },
  { name: "fork", description: "选择分叉 item：/fork [itemId]" },
  { name: "permissions", description: "选择权限模式" },
  { name: "effort", description: "thinking budget：low/medium/high/max" },
  { name: "model", description: "切换模型：/model <name>" },
  { name: "compact", description: "压缩上下文：/compact [instructions]" },
  { name: "takeover", description: "获取 30 秒控制租约" },
  { name: "release", description: "释放控制租约" },
  { name: "context", description: "查询上下文占用；/context <tokens> 指定窗口" },
  { name: "diff", description: "工作区差异（原生引擎）" },
  { name: "usage", description: "用量与限额表格" },
  { name: "cost", description: "本会话费用" },
  { name: "mcp", description: "MCP 服务器状态" },
  { name: "rewind", description: "回滚：/rewind <原生消息 UUID>，y/N 确认" },
  { name: "btw", description: "侧问：/btw <question>" },
  { name: "help", description: "显示命令与快捷键帮助" },
  { name: "image", description: "发送图片：/image <path>" },
  { name: "paste-image", description: "附加 macOS 剪贴板图片（pngpaste）" },
  { name: "steer", description: "向当前 turn 插话：/steer <text>" },
  { name: "log", description: "展开或折叠系统日志" },
  { name: "tasks", description: "切换已观测任务底栏" },
  { name: "agents", description: "折叠或展开子 agent：/agents [id]" },
];

/** Contiguous substrings first (earliest first), then subsequences by skipped characters. */
export function fuzzyMatch(query: string, candidates: Candidate[], limit = 50): Candidate[] {
  query = query.toLowerCase();
  return candidates.map(candidate => {
    const name = candidate.name.toLowerCase(); let cursor = 0, score = 0;
    const contiguous = name.indexOf(query);
    if (contiguous >= 0) return { candidate, group: 0, score: contiguous };
    for (const char of query) {
      const index = name.indexOf(char, cursor);
      if (index < 0) return { candidate, group: 1, score: Infinity };
      score += index - cursor; cursor = index + 1;
    }
    return { candidate, group: 1, score };
  }).filter(c => Number.isFinite(c.score)).sort((a, b) => a.group - b.group || a.score - b.score || a.candidate.name.localeCompare(b.candidate.name)).slice(0, limit).map(c => c.candidate);
}

interface FileTools { git?: string | null; rg?: string | null }
const excluded = (name: string) => name.split("/").some(part => part === ".git" || part === "node_modules");

async function listedFiles(cwd: string, executable: string | null, args: string[], emptyCode = 0): Promise<string[] | undefined> {
  if (!executable) return;
  try {
    const proc = Bun.spawn([executable, ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code === 0 || code === emptyCode) return output.split("\0").filter(Boolean);
  } catch { /* An unavailable tool must not disable completion. */ }
}

interface IgnoreRule { base: string; glob: Bun.Glob; slash: boolean; directory: boolean; negate: boolean }
function ignoreRules(text: string, base: string): IgnoreRule[] {
  return text.split(/\r?\n/).flatMap(raw => {
    let pattern = raw.replace(/(?<!\\)\s+$/, "");
    if (!pattern || pattern.startsWith("#")) return [];
    const negate = pattern.startsWith("!");
    if (negate) pattern = pattern.slice(1);
    pattern = pattern.replace(/\\([#! ])/g, "$1");
    const directory = pattern.endsWith("/");
    if (directory) pattern = pattern.slice(0, -1);
    const slash = pattern.includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    // Prefix keeps a literal escaped leading ! from becoming Bun.Glob negation.
    return pattern ? [{ base, glob: new Bun.Glob(`./${pattern}`), slash, directory, negate }] : [];
  });
}

async function walkFiles(cwd: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string, inherited: IgnoreRule[]): Promise<void> {
    let rules = inherited;
    try { rules = [...rules, ...ignoreRules(await readFile(join(cwd, dir, ".gitignore"), "utf8"), dir)]; } catch { /* Optional. */ }
    let entries;
    try { entries = await readdir(join(cwd, dir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const name = dir ? `${dir}/${entry.name}` : entry.name;
      if (excluded(name)) continue;
      let ignored = false;
      for (const rule of rules) {
        if (rule.directory && !entry.isDirectory()) continue;
        const relative = rule.base ? name.slice(rule.base.length + 1) : name;
        if (rule.glob.match(`./${rule.slash ? relative : basename(relative)}`)) ignored = !rule.negate;
      }
      if (ignored) continue;
      if (entry.isDirectory()) await walk(name, rules);
      else result.push(name); // Do not recurse through symlinked directories/cycles.
    }
  }
  await walk("", []); return result;
}

export async function files(cwd: string, tools: FileTools = {}): Promise<Candidate[]> {
  // Git preserves tracked files and applies the repository's native ignore rules.
  // Outside repositories, rg is optional; fs always provides a dependency-free path.
  const git = tools.git === undefined ? Bun.which("git") : tools.git;
  const rg = tools.rg === undefined ? Bun.which("rg") : tools.rg;
  const names = await listedFiles(cwd, git, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    ?? await listedFiles(cwd, rg, ["--files", "--hidden", "--no-require-git", "--null", "-g", "!.git", "-g", "!node_modules"], 1)
    ?? await walkFiles(cwd);
  const candidates: Candidate[] = [];
  for (const name of new Set(names)) {
    if (excluded(name) || /[\r\n]/.test(name)) continue;
    try { if ((await stat(join(cwd, name))).isFile()) candidates.push({ name, description: "文件" }); } catch { /* Deleted index entries and broken symlinks. */ }
  }
  return candidates;
}

export async function skills(cwd: string, home = homedir()): Promise<Candidate[]> {
  const found = new Map<string, Candidate>();
  for (const dir of [join(home, ".claude/skills"), join(cwd, ".claude/skills")]) {
    let names: string[];
    try { names = await readdir(dir); } catch { continue; }
    await Promise.all(names.map(async name => {
      try {
        const content = await readFile(join(dir, name, "SKILL.md"), "utf8");
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "";
        const raw = /^description:\s*(.*)$/m.exec(frontmatter)?.[1]?.trim();
        const description = raw && !/^[>|][-+]?$/.test(raw) ? raw.replace(/^['"]|['"]$/g, "")
          : /^description:\s*[>|][-+]?\s*\r?\n((?:[ \t]+[^\n]*\n?)*)/m.exec(frontmatter)?.[1]?.trim().replace(/\s+/g, " ")
            || content.replace(/^---[\s\S]*?---\s*/, "").split(/\r?\n/).find(line => line.trim() && !line.startsWith("#"))?.trim() || "Skill";
        found.set(name, { name, description });
      } catch { /* Missing/unreadable SKILL.md is not a skill. Symlinked directories work. */ }
    }));
  }
  for (const command of commands) found.set(command.name, command);
  return [...found.values()];
}

export function completionToken(input: string): { start: number; prefix: "@" | "/"; query: string } | undefined {
  if (input.startsWith("!")) return;
  const file = /(?:^|\s)@([^\s"']*)$/.exec(input);
  if (file) return { start: input.length - file[1].length - 1, prefix: "@", query: file[1] };
  if (/^\/[^\s]*$/.test(input)) return { start: 0, prefix: "/", query: input.slice(1) };
}

export class CompletionSource {
  private cache = new Map<string, { at: number; value: Promise<Candidate[]> }>();
  async complete(input: string, cwd: string): Promise<Completion | undefined> {
    const token = completionToken(input); if (!token) return;
    const key = `${cwd}\0${token.prefix}`;
    let entry = this.cache.get(key);
    if (!entry || Date.now() - entry.at > 5000) {
      entry = { at: Date.now(), value: token.prefix === "@" ? files(cwd) : skills(cwd) }; this.cache.set(key, entry);
      entry.value.catch(() => { this.cache.delete(key); });
    }
    const candidates = fuzzyMatch(token.query, await entry.value);
    return candidates.length ? { start: token.start, prefix: token.prefix, candidates, selected: 0, draft: input } : undefined;
  }
}
