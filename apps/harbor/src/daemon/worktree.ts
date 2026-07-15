/**
 * per-Issue worktree 生命周期（P2，harbor.md §6）。
 * 创建：<workdir>/../harbor-worktrees/<issue-id>，分支 harbor/<issue-id>。
 * 收尾：保留分支删目录（git worktree remove，不 --force——有未提交改动时留目录 fail loudly）。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 30_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { ok: r.status === 0, out };
}

export function worktreePathFor(workdir: string, conversationId: string): string {
  // 与主仓库同级的 harbor-worktrees/，避免 worktree 嵌在仓库内被工具误扫
  return join(dirname(workdir), "harbor-worktrees", `${basename(workdir)}-${conversationId}`);
}

/**
 * 确保 worktree 存在并返回其路径。幂等：已存在直接复用（同一 issue 多轮共享）。
 * 失败 throw（错误信息带 git 原文，run 直接 failed —— 拒绝静默降级回主仓库）。
 */
export function ensureWorktree(workdir: string, conversationId: string, existing: string | null): string {
  const path = existing ?? worktreePathFor(workdir, conversationId);
  if (existsSync(join(path, ".git"))) return path; // worktree 目录的 .git 是文件，存在即可用

  const branch = `harbor/${conversationId}`;
  let r = git(workdir, ["worktree", "add", path, "-b", branch]);
  if (!r.ok && /already exists/i.test(r.out) && r.out.includes(branch)) {
    // 分支已存在（issue 曾清理过目录又续跑）→ 挂回既有分支
    r = git(workdir, ["worktree", "add", path, branch]);
  }
  if (!r.ok && /already registered|missing but already registered/i.test(r.out)) {
    // 目录被手动删过但 git 还记着 → prune 后重试
    git(workdir, ["worktree", "prune"]);
    r = git(workdir, ["worktree", "add", path, "-b", branch]);
    if (!r.ok && /already exists/i.test(r.out)) r = git(workdir, ["worktree", "add", path, branch]);
  }
  if (!r.ok) {
    throw new Error(`worktree 创建失败（workdir=${workdir}）：${r.out || "git worktree add 无输出"}`);
  }
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
  return { ok: false, message: r.out || "git worktree remove 失败（可能有未提交改动，需人工处理）" };
}
