import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Candidate { name: string; description: string }
export interface Completion { start: number; prefix: "@" | "/"; candidates: Candidate[]; selected: number }
export const commands: Candidate[] = [
  { name: "image", description: "发送图片：/image <path>" },
  { name: "paste-image", description: "附加 macOS 剪贴板图片（pngpaste）" },
  { name: "steer", description: "向当前 turn 插话：/steer <text>" },
];

/** Subsequence matching; contiguous and early matches sort first. */
export function fuzzyMatch(query: string, candidates: Candidate[], limit = 50): Candidate[] {
  query = query.toLowerCase();
  return candidates.map(candidate => {
    const name = candidate.name.toLowerCase(); let cursor = 0, score = 0;
    for (const char of query) {
      const index = name.indexOf(char, cursor);
      if (index < 0) return { candidate, score: Infinity };
      score += index - cursor; cursor = index + 1;
    }
    return { candidate, score };
  }).filter(c => Number.isFinite(c.score)).sort((a, b) => a.score - b.score || a.candidate.name.localeCompare(b.candidate.name)).slice(0, limit).map(c => c.candidate);
}

export async function files(cwd: string): Promise<Candidate[]> {
  // rg applies nested .gitignore rules even outside repositories. NUL supports spaces.
  const rg = Bun.which("rg");
  if (!rg) throw new Error("文件补全需要 ripgrep（rg）；macOS：brew install ripgrep");
  const proc = Bun.spawn([rg, "--files", "--hidden", "--no-require-git", "--null", "-g", "!.git", "-g", "!node_modules"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code > 1) throw new Error(`文件补全失败：${error.trim()}`);
  return output.split("\0").filter(name => name && !/[\r\n]/.test(name)).map(name => ({ name, description: "文件" }));
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
    return candidates.length ? { start: token.start, prefix: token.prefix, candidates, selected: 0 } : undefined;
  }
}
