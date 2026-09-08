import { describe, expect, test } from "bun:test";
import { classifyReadonlyCommand, DEFAULT_READONLY_COMMANDS } from "./readonly-commands.js";

describe("classifyReadonlyCommand", () => {
  test.each([
    "ls", "ls -la /tmp", "cat file.txt", "head -n 5 file", "tail -f log", "wc -l file",
    "find . -name '*.ts'", "grep foo bar.txt", "rg pattern", "pwd", "echo hello", "stat file",
    "file thing", "which bun", "env", "env -0", "git status", "git log -n 5", "git diff HEAD",
    "git show abc123", "git rev-parse HEAD", "git branch -a",
  ])("allows plain readonly command: %s", command => {
    expect(classifyReadonlyCommand(command).readonly).toBe(true);
  });

  test.each([
    "ls && cat file", "ls | grep foo", "git status && git log", "cat a | grep b | wc -l",
    "git log || echo none",
  ])("allows pipe/&&/|| chains when every segment is readonly: %s", command => {
    expect(classifyReadonlyCommand(command).readonly).toBe(true);
  });

  test.each([
    "ls; cat file", "pwd;git status",
  ])("allows ; sequencing when every segment is readonly: %s", command => {
    expect(classifyReadonlyCommand(command).readonly).toBe(true);
  });

  test('treats quoted separators as literal text, not chaining: echo "a | b && c"', () => {
    const result = classifyReadonlyCommand('echo "a | b && c"');
    expect(result).toEqual({ readonly: true, matchedRules: ["echo"] });
  });

  test.each([
    "rm -rf /tmp/x", "mv a b", "cp a b", "chmod +x a", "git commit -m x", "git push",
    "npm install", "curl -X POST http://x", "xargs rm",
  ])("denies known write/network commands: %s", command => {
    expect(classifyReadonlyCommand(command).readonly).toBe(false);
  });

  test.each([
    "echo hi > /tmp/f", "echo hi >> /tmp/f", "cat < /tmp/f", "ls 2>&1",
  ])("denies redirection: %s", command => {
    expect(classifyReadonlyCommand(command).readonly).toBe(false);
  });

  test.each([
    "echo $(rm -rf /)", "echo `rm -rf /`", "cat <(rm -rf /)", "ls $(whoami)",
  ])("denies command substitution and process substitution: %s", command => {
    expect(classifyReadonlyCommand(command).readonly).toBe(false);
  });

  test.each([
    "(cd /tmp && ls)", "ls (subshell)",
  ])("denies subshell grouping: %s", command => {
    expect(classifyReadonlyCommand(command).readonly).toBe(false);
  });

  test.each([
    "ls && rm -rf /tmp/x", "cat file | tee /tmp/out",
  ])("denies chains where any segment is not readonly: %s", command => {
    expect(classifyReadonlyCommand(command).readonly).toBe(false);
  });

  test("denies find with mutating flags", () => {
    expect(classifyReadonlyCommand("find . -name x -delete").readonly).toBe(false);
    expect(classifyReadonlyCommand("find . -exec rm {} ;").readonly).toBe(false);
  });

  test("denies env used to launch another program", () => {
    expect(classifyReadonlyCommand("env FOO=bar rm -rf /tmp/x").readonly).toBe(false);
  });

  test("denies git subcommands outside the readonly set", () => {
    expect(classifyReadonlyCommand("git commit -am x").readonly).toBe(false);
    expect(classifyReadonlyCommand("git checkout main").readonly).toBe(false);
  });

  test("denies empty or whitespace-only command", () => {
    expect(classifyReadonlyCommand("").readonly).toBe(false);
    expect(classifyReadonlyCommand("   ").readonly).toBe(false);
  });

  test("reports matched rules for auditing", () => {
    expect(classifyReadonlyCommand("git status && ls").matchedRules).toEqual(["git status", "ls"]);
  });

  test("respects a custom allowlist that replaces the default", () => {
    const custom = new Set(["ls"]);
    expect(classifyReadonlyCommand("ls", custom).readonly).toBe(true);
    expect(classifyReadonlyCommand("cat file", custom).readonly).toBe(false);
  });

  test("default allowlist export matches the documented set", () => {
    expect(new Set(DEFAULT_READONLY_COMMANDS)).toEqual(new Set([
      "ls", "cat", "head", "tail", "wc", "find", "grep", "rg", "pwd", "echo", "stat", "file", "which", "env", "git",
    ]));
  });
});
