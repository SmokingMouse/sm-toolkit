import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ensureWorktree, resolveWorktreeGitCommonDir, worktreePathFor } from "./worktree.js";

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function createRepository(parent: string, name: string): string {
  const repository = join(parent, name);
  mkdirSync(repository);
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.name", "Harbor Test"]);
  git(repository, ["config", "user.email", "harbor@example.test"]);
  writeFileSync(join(repository, "README.md"), "fixture\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "fixture"]);
  return repository;
}

describe("worktree path and Repository identity", () => {
  test("resolves the common git dir for a registered linked worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "harbor-worktree-"));
    try {
      const repository = createRepository(root, "repo");
      const worktree = ensureWorktree(repository, "c_safe", null);
      expect(worktree).toBe(worktreePathFor(repository, "c_safe"));
      expect(resolveWorktreeGitCommonDir(repository, worktree)).toBe(realpathSync(join(repository, ".git")));

      writeFileSync(join(worktree, "implementation.txt"), "committed from linked worktree\n");
      git(worktree, ["add", "implementation.txt"]);
      git(worktree, ["commit", "-m", "linked worktree commit"]);
      expect(git(worktree, ["show", "--format=%s", "--no-patch", "HEAD"])).toBe("linked worktree commit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects path traversal and an existing path not derived from the Conversation", () => {
    const root = mkdtempSync(join(tmpdir(), "harbor-worktree-path-"));
    try {
      const repository = createRepository(root, "repo");
      expect(() => worktreePathFor(repository, "../../escape")).toThrow("conversation id");
      expect(() => ensureWorktree(repository, "c_safe", join(root, "another-worktree"))).toThrow(
        "worktreePath 与 Repository/Conversation 不匹配",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a main checkout and a worktree owned by another Repository", () => {
    const root = mkdtempSync(join(tmpdir(), "harbor-worktree-owner-"));
    try {
      const repositoryA = createRepository(root, "repo-a");
      const repositoryB = createRepository(root, "repo-b");
      const worktreeB = ensureWorktree(repositoryB, "c_other", null);
      expect(() => resolveWorktreeGitCommonDir(repositoryA, repositoryA)).toThrow("主 checkout");
      expect(() => resolveWorktreeGitCommonDir(repositoryA, worktreeB)).toThrow("不属于声明的 Repository");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an Issue leaf symlink to another Issue worktree in the same Repository", () => {
    const root = mkdtempSync(join(tmpdir(), "harbor-worktree-issue-link-"));
    try {
      const repository = createRepository(root, "repo");
      const issueA = ensureWorktree(repository, "c_issue_a", null);
      const issueB = worktreePathFor(repository, "c_issue_b");
      symlinkSync(issueA, issueB, "dir");

      expect(() => ensureWorktree(repository, "c_issue_b", issueB)).toThrow("worktree leaf 不能是符号链接");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a reverse cross-Issue symlink hidden behind the expected physical leaf", () => {
    const root = mkdtempSync(join(tmpdir(), "harbor-worktree-reverse-link-"));
    try {
      const repository = createRepository(root, "repo");
      const issueA = ensureWorktree(repository, "c_issue_a", null);
      const issueB = worktreePathFor(repository, "c_issue_b");
      renameSync(issueA, issueB);
      symlinkSync(issueB, issueA, "dir");
      expect(lstatSync(issueB).isSymbolicLink()).toBe(false);

      expect(() => ensureWorktree(repository, "c_issue_b", issueB)).toThrow(
        "Git worktree registry leaf 不能是符号链接",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a worktree checked out on another Issue branch", () => {
    const root = mkdtempSync(join(tmpdir(), "harbor-worktree-wrong-branch-"));
    try {
      const repository = createRepository(root, "repo");
      const worktree = ensureWorktree(repository, "c_branch", null);
      git(worktree, ["switch", "-c", "harbor/c_other"]);

      expect(() => ensureWorktree(repository, "c_branch", worktree)).toThrow(
        "worktree HEAD 不属于当前 Issue",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a detached worktree HEAD", () => {
    const root = mkdtempSync(join(tmpdir(), "harbor-worktree-detached-"));
    try {
      const repository = createRepository(root, "repo");
      const worktree = ensureWorktree(repository, "c_detached", null);
      git(worktree, ["checkout", "--detach"]);

      expect(() => ensureWorktree(repository, "c_detached", worktree)).toThrow(
        "actual=detached",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses only stdout for Git machine paths when successful commands warn on stderr", () => {
    const root = mkdtempSync(join(tmpdir(), "harbor-worktree-git-warning-"));
    const originalPath = process.env.PATH;
    try {
      const repository = createRepository(root, "repo");
      const realGit = Bun.which("git");
      if (!realGit) throw new Error("test fixture 找不到 git");
      const fakeBin = join(root, "fake-bin");
      const fakeGit = join(fakeBin, "git");
      mkdirSync(fakeBin);
      writeFileSync(
        fakeGit,
        `#!/bin/sh\nprintf '%s\\n' 'warning: fixture stderr must not become a path' >&2\nexec ${JSON.stringify(realGit)} "$@"\n`,
      );
      chmodSync(fakeGit, 0o755);
      process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ""}`;

      const worktree = ensureWorktree(repository, "c_warning", null);
      expect(resolveWorktreeGitCommonDir(repository, worktree, "c_warning")).toBe(
        realpathSync(join(repository, ".git")),
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
