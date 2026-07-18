/**
 * per-Issue worktree 生命周期（P2，harbor.md §6）。
 * 创建：<workdir>/../harbor-worktrees/<issue-id>，分支 harbor/<issue-id>。
 * 收尾：保留分支删目录（git worktree remove，不 --force——有未提交改动时留目录 fail loudly）。
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 30_000 });
  const stdout = (r.stdout ?? "").trim();
  const stderr = [r.stderr, r.error?.message].filter(Boolean).join("\n").trim();
  return { ok: r.status === 0, stdout, stderr };
}

function gitMessage(result: GitResult): string {
  return result.stderr || result.stdout;
}

function gitOutput(cwd: string, args: string[], operation: string): string {
  const result = git(cwd, args);
  if (!result.ok || !result.stdout) {
    throw new Error(
      `worktree Git 元数据解析失败（${operation}, cwd=${cwd}）：${gitMessage(result) || "git stdout 无输出"}`,
    );
  }
  // rev-parse/worktree list 的机器路径只能来自 stdout；stderr 仅用于失败诊断。
  return result.stdout;
}

function canonicalExistingPath(path: string, label: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    throw new Error(`${label} 路径解析失败（${path}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonicalGitPath(cwd: string, value: string, label: string): string {
  return canonicalExistingPath(isAbsolute(value) ? value : resolve(cwd, value), label);
}

function isStrictDescendant(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function registeredWorktrees(repositoryRoot: string): string[] {
  const output = gitOutput(repositoryRoot, ["worktree", "list", "--porcelain", "-z"], "worktree list");
  return output
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));
}

function canonicalExpectedWorktreeLeaf(workdir: string, conversationId: string): string {
  const expected = resolve(worktreePathFor(workdir, conversationId));
  return join(canonicalExistingPath(dirname(expected), "worktree parent"), basename(expected));
}

function assertLeafIsNotSymlink(path: string, label: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} leaf 不能是符号链接（path=${path}）`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} leaf`)) throw error;
    throw new Error(`${label} 路径解析失败（${path}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function worktreePathFor(workdir: string, conversationId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(conversationId)) {
    throw new Error(`conversation id 不能用于 worktree 路径：${conversationId}`);
  }
  // 与主仓库同级的 harbor-worktrees/，避免 worktree 嵌在仓库内被工具误扫
  return join(dirname(workdir), "harbor-worktrees", `${basename(workdir)}-${conversationId}`);
}

/**
 * 确认候选路径就是当前 Conversation 的物理 leaf。允许父目录自身经 symlink 挂载，
 * 但拒绝 expected leaf 指向其他 Issue worktree，避免 registry 只验证 Repository 后串 Issue。
 */
function validateExpectedWorktreePath(workdir: string, conversationId: string, candidate: string): string {
  const expected = resolve(worktreePathFor(workdir, conversationId));
  const actualPath = resolve(candidate);
  if (actualPath !== expected) {
    throw new Error(`worktreePath 与 Repository/Conversation 不匹配（expected=${expected}, actual=${actualPath}）`);
  }
  assertLeafIsNotSymlink(actualPath, "worktree");

  const canonicalExpected = canonicalExpectedWorktreeLeaf(workdir, conversationId);
  const actual = canonicalExistingPath(actualPath, "worktree");
  if (actual !== canonicalExpected) {
    throw new Error(
      `worktree 物理路径与当前 Conversation 不匹配（expected=${canonicalExpected}, actual=${actual}）`,
    );
  }
  return actual;
}

/**
 * 校验 linked worktree 确实属于声明的 Repository，并返回其真实 git common dir。
 * common dir 是 commit 写 objects/refs/reflogs 与 per-worktree index 的共同元数据根。
 */
export function resolveWorktreeGitCommonDir(
  repositoryRoot: string,
  worktreeRoot: string,
  conversationId?: string,
): string {
  const repository = canonicalExistingPath(repositoryRoot, "Repository mount");
  const worktree = canonicalExistingPath(worktreeRoot, "worktree");
  if (repository === worktree) {
    throw new Error("worktree 路径不能等于 Repository mount（拒绝把主 checkout 当作 linked worktree）");
  }

  const repositoryTop = canonicalGitPath(
    repository,
    gitOutput(repository, ["rev-parse", "--show-toplevel"], "Repository top-level"),
    "Repository top-level",
  );
  if (repositoryTop !== repository) {
    throw new Error(`Repository mount 必须指向 checkout 根目录（mount=${repository}, top-level=${repositoryTop}）`);
  }

  const worktreeTop = canonicalGitPath(
    worktree,
    gitOutput(worktree, ["rev-parse", "--show-toplevel"], "worktree top-level"),
    "worktree top-level",
  );
  if (worktreeTop !== worktree) {
    throw new Error(`worktreePath 必须指向 checkout 根目录（path=${worktree}, top-level=${worktreeTop}）`);
  }

  const repositoryCommon = canonicalGitPath(
    repository,
    gitOutput(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "Repository common dir"),
    "Repository common dir",
  );
  const worktreeCommon = canonicalGitPath(
    worktree,
    gitOutput(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "worktree common dir"),
    "worktree common dir",
  );
  if (repositoryCommon !== worktreeCommon) {
    throw new Error(
      `worktree 不属于声明的 Repository（repository common=${repositoryCommon}, worktree common=${worktreeCommon}）`,
    );
  }

  const worktreeGitDir = canonicalGitPath(
    worktree,
    gitOutput(worktree, ["rev-parse", "--absolute-git-dir"], "worktree git dir"),
    "worktree git dir",
  );
  if (!isStrictDescendant(worktreeCommon, worktreeGitDir)) {
    throw new Error(
      `worktree 不是 Repository 的 linked worktree（common=${worktreeCommon}, gitdir=${worktreeGitDir}）`,
    );
  }

  const expectedRegistryLeaf = conversationId
    ? canonicalExpectedWorktreeLeaf(repositoryRoot, conversationId)
    : worktree;
  if (worktree !== expectedRegistryLeaf) {
    throw new Error(
      `worktree 物理路径与当前 Conversation 不匹配（expected=${expectedRegistryLeaf}, actual=${worktree}）`,
    );
  }

  const registryLeaves = registeredWorktrees(repository).map((path) => {
    if (!isAbsolute(path)) {
      throw new Error(`Git worktree registry leaf 必须是绝对路径（path=${path}）`);
    }
    // 这里只做字面绝对化/规范化，不能 realpath leaf，否则 A → B symlink 会冒充 B 的登记项。
    return resolve(path);
  });
  const exactRegistryLeaf = registryLeaves.find((path) => path === expectedRegistryLeaf);
  if (!exactRegistryLeaf) {
    const reverseSymlink = registryLeaves.find((path) => {
      try {
        return lstatSync(path).isSymbolicLink() && realpathSync(path) === worktree;
      } catch {
        return false;
      }
    });
    if (reverseSymlink) {
      throw new Error(
        `Git worktree registry leaf 不能是符号链接（registry=${reverseSymlink}, expected=${expectedRegistryLeaf}）`,
      );
    }
    throw new Error(
      `worktree registry leaf 与当前 Conversation 不匹配（expected=${expectedRegistryLeaf}, registered=${registryLeaves.join(",") || "无"}）`,
    );
  }
  assertLeafIsNotSymlink(exactRegistryLeaf, "Git worktree registry");

  if (conversationId) {
    const expectedHead = `refs/heads/harbor/${conversationId}`;
    const head = git(worktree, ["symbolic-ref", "--quiet", "HEAD"]);
    if (!head.ok || !head.stdout) {
      throw new Error(
        `worktree HEAD 必须是当前 Issue branch（expected=${expectedHead}, actual=detached；${gitMessage(head) || "无 symbolic HEAD"}）`,
      );
    }
    if (head.stdout !== expectedHead) {
      throw new Error(`worktree HEAD 不属于当前 Issue（expected=${expectedHead}, actual=${head.stdout}）`);
    }
  }
  return worktreeCommon;
}

/**
 * 确保 worktree 存在并返回其路径。幂等：已存在直接复用（同一 issue 多轮共享）。
 * 失败 throw（错误信息带 git 原文，run 直接 failed —— 拒绝静默降级回主仓库）。
 */
export function ensureWorktree(workdir: string, conversationId: string, existing: string | null): string {
  const expectedPath = resolve(worktreePathFor(workdir, conversationId));
  const path = existing ? resolve(existing) : expectedPath;
  if (path !== expectedPath) {
    throw new Error(`worktreePath 与 Repository/Conversation 不匹配（expected=${expectedPath}, actual=${path}）`);
  }
  // 即使是 broken symlink，leaf 也必须先拒绝，不能交给 git add/prune 改写语义。
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`worktree leaf 不能是符号链接（path=${path}）`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  if (existsSync(join(path, ".git"))) {
    const physicalPath = validateExpectedWorktreePath(workdir, conversationId, path);
    // registry 必须命中当前 Issue 的 canonical physical leaf，而不只是同 Repository 的任一 worktree。
    resolveWorktreeGitCommonDir(workdir, physicalPath, conversationId);
    return path;
  }

  const branch = `harbor/${conversationId}`;
  let r = git(workdir, ["worktree", "add", path, "-b", branch]);
  if (!r.ok && /already exists/i.test(gitMessage(r)) && gitMessage(r).includes(branch)) {
    // 分支已存在（issue 曾清理过目录又续跑）→ 挂回既有分支
    r = git(workdir, ["worktree", "add", path, branch]);
  }
  if (!r.ok && /already registered|missing but already registered/i.test(gitMessage(r))) {
    // 目录被手动删过但 git 还记着 → prune 后重试
    git(workdir, ["worktree", "prune"]);
    r = git(workdir, ["worktree", "add", path, "-b", branch]);
    if (!r.ok && /already exists/i.test(gitMessage(r))) r = git(workdir, ["worktree", "add", path, branch]);
  }
  if (!r.ok) {
    throw new Error(`worktree 创建失败（workdir=${workdir}）：${gitMessage(r) || "git worktree add 无输出"}`);
  }
  const physicalPath = validateExpectedWorktreePath(workdir, conversationId, path);
  resolveWorktreeGitCommonDir(workdir, physicalPath, conversationId);
  return path;
}

/** 收尾：保留分支删目录。未提交改动会让 remove 失败——保留目录并报因（不 --force 吞成果） */
export function removeWorktree(workdir: string, worktreePath: string): { ok: boolean; message: string } {
  if (!existsSync(worktreePath)) {
    git(workdir, ["worktree", "prune"]); // 目录已没了，把 git 记录也清掉
    return { ok: true, message: "目录已不存在，prune 完成" };
  }
  const r = git(workdir, ["worktree", "remove", worktreePath]);
  if (r.ok) return { ok: true, message: "已删除（分支保留）" };
  return { ok: false, message: gitMessage(r) || "git worktree remove 失败（可能有未提交改动，需人工处理）" };
}
