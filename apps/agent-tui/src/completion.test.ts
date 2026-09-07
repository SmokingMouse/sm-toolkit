import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
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
    for (const tools of [{}, { git: null, rg: null }]) {
      const result = (await files(cwd, tools)).map(c => c.name);
      expect(result).toEqual(expect.arrayContaining(["keep.log", ".visible", "src/space name.ts", "src/visible.ts"]));
      for (const name of ["a.log", "ignored/hidden.ts", "node_modules/top.js", "src/node_modules/nested.js", ".git/config", "src/secret.ts"]) expect(result).not.toContain(name);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("git file listing takes precedence, respects ignores and cwd, and drops deleted or excluded tracked files", async () => {
  const cwd = mkdtempSync("/tmp/tui-git-files-");
  const git = Bun.which("git"); expect(git).not.toBeNull();
  const run = (...args: string[]) => {
    const result = Bun.spawnSync([git!, ...args], { cwd, stdout: "ignore", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  };
  try {
    run("init", "--quiet");
    mkdirSync(join(cwd, "src")); mkdirSync(join(cwd, "node_modules"));
    writeFileSync(join(cwd, "tracked.log"), ""); writeFileSync(join(cwd, "deleted.ts"), "");
    writeFileSync(join(cwd, "node_modules/tracked.js"), "");
    run("add", "tracked.log", "deleted.ts", "node_modules/tracked.js");
    rmSync(join(cwd, "deleted.ts"));
    writeFileSync(join(cwd, ".gitignore"), "*.log\n");
    writeFileSync(join(cwd, "hidden.log"), ""); writeFileSync(join(cwd, "src/visible.ts"), "");
    const marker = join(cwd, "rg-called");
    const fakeRg = join(cwd, "fake-rg");
    writeFileSync(fakeRg, `#!${process.execPath}\nawait Bun.write(${JSON.stringify(marker)}, 'called'); process.exit(2);\n`, { mode: 0o755 });
    const names = (await files(cwd, { git, rg: fakeRg })).map(c => c.name);
    expect(names).toEqual(expect.arrayContaining(["tracked.log", "src/visible.ts"]));
    for (const name of ["hidden.log", "deleted.ts", "node_modules/tracked.js"]) expect(names).not.toContain(name);
    expect(existsSync(marker)).toBe(false);
    expect((await files(join(cwd, "src"), { git, rg: null })).map(c => c.name)).toEqual(["visible.ts"]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("optional rg listing handles NUL paths and falls back to fs when the tool fails", async () => {
  const cwd = mkdtempSync("/tmp/tui-rg-files-");
  try {
    writeFileSync(join(cwd, "space name.ts"), ""); writeFileSync(join(cwd, "fallback.ts"), "");
    const argv = join(cwd, "argv.json"), fakeRg = join(cwd, "fake-rg");
    writeFileSync(fakeRg, `#!${process.execPath}\nawait Bun.write(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2))); process.stdout.write('space name.ts\\0node_modules/hidden.ts\\0');\n`, { mode: 0o755 });
    expect((await files(cwd, { git: Bun.which("git"), rg: fakeRg })).map(c => c.name)).toEqual(["space name.ts"]);
    expect(JSON.parse(readFileSync(argv, "utf8"))).toEqual(["--files", "--hidden", "--no-require-git", "--null", "-g", "!.git", "-g", "!node_modules"]);
    writeFileSync(fakeRg, `#!${process.execPath}\nprocess.exit(2);\n`, { mode: 0o755 });
    expect((await files(cwd, { git: "/absent/git", rg: fakeRg })).map(c => c.name)).toContain("fallback.ts");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("fs fallback needs no executables and handles anchored ignores, directory rules and symlink cycles", async () => {
  const cwd = mkdtempSync("/tmp/tui-fs-files-");
  try {
    mkdirSync(join(cwd, "src")); mkdirSync(join(cwd, "cache"));
    writeFileSync(join(cwd, ".gitignore"), "/root.txt\ncache/\n*.tmp\n!keep.tmp\n\\!literal\n\\#literal\n");
    for (const name of ["root.txt", "src/root.txt", "cache/drop.ts", "keep.tmp", "drop.tmp", "src/visible.ts", "!literal", "#literal"]) writeFileSync(join(cwd, name), "");
    symlinkSync(cwd, join(cwd, "src/cycle"));
    const names = (await files(cwd, { git: null, rg: null })).map(c => c.name);
    expect(names).toEqual(expect.arrayContaining(["src/root.txt", "keep.tmp", "src/visible.ts"]));
    for (const name of ["root.txt", "cache/drop.ts", "drop.tmp", "src/cycle", "!literal", "#literal"]) expect(names).not.toContain(name);
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
