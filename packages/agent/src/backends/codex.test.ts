import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PermissionPolicy } from "../backend.js";
import { buildCodexArgs, codexEnvironmentSkillArgs, forkCodexSession } from "./codex.js";

describe("forkCodexSession", () => {
  const PARENT = "019fcca2-16f1-70c0-903e-5ab3345aeb41";

  function seedRollout(): { root: string; day: string; src: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fork-"));
    const day = path.join(root, "2026", "08", "04");
    fs.mkdirSync(day, { recursive: true });
    const src = path.join(day, `rollout-2026-08-04T19-56-42-${PARENT}.jsonl`);
    fs.writeFileSync(
      src,
      JSON.stringify({ type: "session_meta", payload: { session_id: PARENT, id: PARENT } }) +
        "\n" +
        JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }) +
        "\n",
    );
    return { root, day, src };
  }

  test("copies the rollout under a fresh uuid, rewriting every id occurrence", () => {
    const { root, day, src } = seedRollout();
    const child = forkCodexSession(PARENT, root);
    expect(child).not.toBe(PARENT);
    const dst = path.join(day, `rollout-2026-08-04T19-56-42-${child}.jsonl`);
    const forked = fs.readFileSync(dst, "utf8");
    expect(forked).toContain(`"session_id":"${child}"`);
    expect(forked).not.toContain(PARENT);
    // 父线原样保留(fork 是复制不是搬移)
    expect(fs.readFileSync(src, "utf8")).toContain(PARENT);
  });

  test("two forks of the same parent yield distinct threads", () => {
    const { root } = seedRollout();
    const a = forkCodexSession(PARENT, root);
    const b = forkCodexSession(PARENT, root);
    expect(a).not.toBe(b);
  });

  test("throws loudly when the parent rollout is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fork-"));
    expect(() => forkCodexSession("0000-no-such-thread", root)).toThrow(/not found/);
  });
});

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

  test("resume keeps the ephemeral promise", () => {
    const resumed = args("readonly", { resume: "thread-1", ephemeral: true });
    expect(resumed).toContain("--ephemeral");
    expect(args("readonly", { resume: "thread-1" })).not.toContain("--ephemeral");
  });

  const ENDPOINT_OVERRIDES = [
    "-c", 'model_provider="sm_endpoint"',
    "-c", 'model_providers.sm_endpoint.name="sm-endpoint"',
    "-c", 'model_providers.sm_endpoint.base_url="https://cpa.example/v1"',
    "-c", 'model_providers.sm_endpoint.env_key="CPA_API_KEY"',
    "-c", 'model_providers.sm_endpoint.wire_api="responses"',
  ];

  test("endpoint config overrides ride along with model on initial exec", () => {
    const initial = args("readonly", { model: "gpt-5.4-mini", configOverrides: ENDPOINT_OVERRIDES });
    expect(initial.join(" ")).toContain('model_provider="sm_endpoint"');
    expect(initial.join(" ")).toContain('model_providers.sm_endpoint.wire_api="responses"');
    expect(initial.slice(initial.indexOf("-m"))).toContain("gpt-5.4-mini");
    // -c 必须在 prompt 之前(prompt 是位置参数,永远收尾)
    expect(initial[initial.length - 1]).toBe("ship it");
  });

  test("endpoint config overrides survive resume", () => {
    const resumed = args("readonly", {
      resume: "thread-1",
      model: "gpt-5.4-mini",
      configOverrides: ENDPOINT_OVERRIDES,
    });
    expect(resumed.slice(0, 3)).toEqual(["exec", "resume", "thread-1"]);
    expect(resumed.join(" ")).toContain('model_provider="sm_endpoint"');
    expect(resumed.join(" ")).toContain('model_providers.sm_endpoint.env_key="CPA_API_KEY"');
    // 注入不得挤掉 resume 自身的 sandbox config override
    expect(resumed).toContain('sandbox_mode="read-only"');
  });

  test("no overrides means args stay identical to the pre-endpoint behavior", () => {
    expect(args("readonly", { model: "gpt-5.5" })).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-m",
      "gpt-5.5",
      "--sandbox",
      "read-only",
      "ship it",
    ]);
  });
});
