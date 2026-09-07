import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { completionToken, files, fuzzyMatch, skills } from "./completion.js";

test("fuzzy subsequence ranking is case insensitive, deterministic and capped at 50", () => {
  const names = ["src/readme.ts", "README.md", "random.txt"].map(name => ({ name, description: "" }));
  expect(fuzzyMatch("RdM", names).map(c => c.name)).toEqual(["README.md", "random.txt", "src/readme.ts"]);
  expect(fuzzyMatch("no-match", names)).toEqual([]);
  expect(fuzzyMatch("", Array.from({ length: 100 }, (_, i) => ({ name: String(i), description: "" })))).toHaveLength(50);
  expect(completionToken("look\n@src/rd")).toEqual({ start: 5, prefix: "@", query: "src/rd" });
  expect(completionToken("mail@example.com ")).toBeUndefined();
  expect(completionToken("/steer words")).toBeUndefined();
});

test("recursive file completion honors nested gitignore, negation, dotfiles and excluded directories outside git", async () => {
  const cwd = mkdtempSync("/tmp/tui-complete-");
  const put = (name: string, body = "") => { const path = join(cwd, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };
  try {
    put(".gitignore", "*.log\nignored/\n!keep.log\n"); put("a.log"); put("keep.log"); put(".visible"); put("ignored/hidden.ts");
    put("node_modules/top.js"); put("src/node_modules/nested.js"); put(".git/config"); put("src/.gitignore", "secret*\n");
    put("src/secret.ts"); put("src/space name.ts"); put("src/visible.ts");
    const result = (await files(cwd)).map(c => c.name);
    expect(result).toEqual(expect.arrayContaining(["keep.log", ".visible", "src/space name.ts", "src/visible.ts"]));
    for (const name of ["a.log", "ignored/hidden.ts", "node_modules/top.js", "src/node_modules/nested.js", ".git/config", "src/secret.ts"]) expect(result).not.toContain(name);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("skill completion discovers symlinks and project overrides, with descriptions and builtin precedence", async () => {
  const dir = mkdtempSync("/tmp/tui-skills-"), home = join(dir, "home"), cwd = join(dir, "project");
  const put = (root: string, name: string, text: string) => {
    const path = join(root, ".claude/skills", name); mkdirSync(path, { recursive: true }); writeFileSync(join(path, "SKILL.md"), text); return path;
  };
  try {
    const target = put(home, "global", "---\ndescription: global description\n---\n");
    symlinkSync(target, join(home, ".claude/skills/linked"));
    put(home, "shared", "---\ndescription: old\n---\n");
    put(cwd, "shared", "---\ndescription: >\n  project description\n  second line\n---\n");
    put(cwd, "steer", "---\ndescription: conflicting\n---\n");
    const result = await skills(cwd, home);
    expect(result.find(c => c.name === "linked")?.description).toBe("global description");
    expect(result.find(c => c.name === "shared")?.description).toBe("project description second line");
    expect(result.filter(c => c.name === "steer")).toHaveLength(1);
    expect(result.find(c => c.name === "steer")?.description).toContain("turn");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
