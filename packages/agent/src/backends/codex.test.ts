import { describe, expect, test } from "bun:test";
import type { PermissionPolicy } from "../backend.js";
import { buildCodexArgs } from "./codex.js";

function args(
  policy: PermissionPolicy,
  options: Partial<Parameters<typeof buildCodexArgs>[0]> = {},
): string[] {
  return buildCodexArgs({
    policy,
    ephemeral: false,
    resume: null,
    additionalWritableDirs: [],
    imagePaths: [],
    prompt: "ship it",
    ...options,
  });
}

describe("Codex argument construction", () => {
  test("passes every additional writable dir to an initial workspace-write exec", () => {
    expect(
      args("auto-edit", {
        additionalWritableDirs: ["/repo/.git", "/shared/cache", "/repo/.git"],
      }),
    ).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "--add-dir",
      "/repo/.git",
      "--add-dir",
      "/shared/cache",
      "ship it",
    ]);
  });

  test("ignores additional writable dirs for readonly exec", () => {
    const readonly = args("readonly", { additionalWritableDirs: ["/repo/.git"] });
    expect(readonly).toContain("read-only");
    expect(readonly).not.toContain("--add-dir");
    expect(readonly).not.toContain("/repo/.git");
  });

  test("default permission cannot add writable dirs for initial or resumed exec", () => {
    const initial = args("default", { additionalWritableDirs: ["/repo/.git"] });
    const resumed = args("default", { resume: "thread-1", additionalWritableDirs: ["/repo/.git"] });

    expect(initial).not.toContain("--add-dir");
    expect(initial).not.toContain("/repo/.git");
    expect(resumed).toContain('sandbox_mode="workspace-write"');
    expect(resumed.join(" ")).not.toContain("writable_roots");
    expect(resumed).not.toContain("/repo/.git");
  });

  test("resume uses workspace-write config roots without full access", () => {
    const resumed = args("auto-edit", {
      resume: "thread-1",
      additionalWritableDirs: ["/repo/.git", "/shared/cache"],
    });
    expect(resumed).toContain('sandbox_mode="workspace-write"');
    expect(resumed).toContain('sandbox_workspace_write.writable_roots=["/repo/.git","/shared/cache"]');
    expect(resumed).not.toContain("--add-dir");
    expect(resumed).not.toContain("--sandbox");
    expect(resumed).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("resume pins readonly instead of inheriting a writable user default", () => {
    const resumed = args("readonly", { resume: "thread-1", additionalWritableDirs: ["/repo/.git"] });
    expect(resumed).toContain('sandbox_mode="read-only"');
    expect(resumed.join(" ")).not.toContain("writable_roots");
    expect(resumed).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });
});
