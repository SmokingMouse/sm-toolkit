import { describe, expect, test } from "bun:test";
import type { PermissionPolicy } from "../backend.js";
import { buildCodexArgs, codexEnvironmentSkillArgs } from "./codex.js";

function args(
  policy: PermissionPolicy,
  options: Partial<Parameters<typeof buildCodexArgs>[0]> = {},
): string[] {
  return buildCodexArgs({
    policy,
    ephemeral: false,
    resume: null,
    additionalWritableDirs: [],
    sandboxNetworkAccess: false,
    imagePaths: [],
    prompt: "ship it",
    ...options,
  });
}

describe("Codex argument construction", () => {
  test("isolates user, plugin and explicit environment Skills for initial and resumed Runs", () => {
    const isolation = codexEnvironmentSkillArgs(["reviewer", "browser", "reviewer", " "]);
    expect(isolation).toEqual([
      "--ignore-user-config",
      "--ignore-rules",
      "--disable",
      "plugins",
      "-c",
      "skills.include_instructions=false",
      "-c",
      'skills.config=[{ name = "browser", enabled = false }, { name = "reviewer", enabled = false }]',
    ]);

    for (const resume of [null, "thread-1"]) {
      const isolated = args("auto-edit", {
        resume,
        environmentSkills: false,
        environmentSkillNames: ["reviewer"],
      });
      for (const token of isolation.slice(0, 6)) expect(isolated).toContain(token);
      expect(isolated).toContain('skills.config=[{ name = "reviewer", enabled = false }]');
    }
  });

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
      "-c",
      "sandbox_workspace_write.network_access=false",
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

  test("enables direct network only for workspace-write initial and resumed exec", () => {
    const initial = args("auto-edit", { sandboxNetworkAccess: true });
    const resumed = args("auto-edit", {
      resume: "thread-1",
      sandboxNetworkAccess: true,
    });
    const readonly = args("readonly", { sandboxNetworkAccess: true });
    const full = args("full", { sandboxNetworkAccess: true });

    expect(initial).toContain("sandbox_workspace_write.network_access=true");
    expect(resumed).toContain("sandbox_workspace_write.network_access=true");
    expect(readonly.join(" ")).not.toContain("network_access");
    expect(full.join(" ")).not.toContain("network_access");
  });

  test("default permission cannot add writable dirs for initial or resumed exec", () => {
    const initial = args("default", { additionalWritableDirs: ["/repo/.git"] });
    const resumed = args("default", { resume: "thread-1", additionalWritableDirs: ["/repo/.git"] });

    expect(initial).not.toContain("--add-dir");
    expect(initial).not.toContain("/repo/.git");
    expect(resumed).toContain('sandbox_mode="workspace-write"');
    expect(resumed).toContain("sandbox_workspace_write.network_access=false");
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
