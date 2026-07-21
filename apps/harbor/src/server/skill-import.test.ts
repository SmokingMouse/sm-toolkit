import { describe, expect, test } from "bun:test";
import type { CodebaseCommandRunner } from "./codebase.js";
import { importedSkillMetadata, SkillImportService } from "./skill-import.js";
import { HarborStore } from "./store.js";
import { openDb } from "./db.js";

class FakeCodebase implements CodebaseCommandRunner {
  calls: string[][] = [];
  async run(args: string[]) {
    this.calls.push(args);
    if (args.includes("list")) {
      return {
        stdout: JSON.stringify({ Files: [
          { Path: "skills/review/SKILL.md", Type: "file" },
          { Path: "skills/review/references/checklist.md", Type: "file" },
        ] }),
        stderr: "",
        exitCode: 0,
      };
    }
    const path = args[args.indexOf("--path") + 1];
    return {
      stdout: path?.endsWith("SKILL.md")
        ? "---\nname: pr-review\ndescription: Review safely\ndependencies:\n  - name: git\n    required: true\n---\nReview the change."
        : "# Checklist\n- CI passed",
      stderr: "",
      exitCode: 0,
    };
  }
}

describe("Skill bundle imports", () => {
  test("Codebase source imports a bounded multi-file bundle with metadata", async () => {
    const runner = new FakeCodebase();
    const service = new SkillImportService(runner);
    const bundle = await service.fromCodebase("team/repo", "skills/review", "main");
    expect(bundle).toEqual(expect.objectContaining({
      source: "codebase",
      originUrl: "codebase://team/repo",
      sourceRef: "main",
      files: [
        expect.objectContaining({ path: "SKILL.md" }),
        expect.objectContaining({ path: "references/checklist.md" }),
      ],
    }));
    expect(importedSkillMetadata(bundle.files, "fallback")).toEqual(expect.objectContaining({
      name: "pr-review",
      description: "Review safely",
      dependencies: [{ name: "git", spec: null, required: true }],
    }));
    expect(runner.calls[0]).toEqual([
      "repo", "file", "list", "-R", "team/repo", "--path", "skills/review", "--ref", "main",
    ]);
  });

  test("runtime auto-sync refreshes files and bundle hash on daemon hello", () => {
    const store = new HarborStore(openDb(":memory:"));
    const first = store.upsertDevice("worker", "hash", {
      clis: { claude: "2" },
      endpoints: [],
      installedSkills: [{
        name: "review",
        description: "v1",
        path: "/skills/review",
        runtimes: ["claude"],
        instruction: "v1",
        files: [{ path: "SKILL.md", content: "v1" }],
      }],
    }, 1);
    const skill = store.createSkill({
      name: "review",
      source: "runtime",
      instruction: "v1",
      deviceId: first.id,
      sourcePath: "/skills/review",
      autoSync: true,
    }, 2);
    const oldHash = skill.bundleHash;
    store.upsertDevice("worker", "hash", {
      clis: { claude: "2" },
      endpoints: [],
      installedSkills: [{
        name: "review",
        description: "v2",
        path: "/skills/review",
        runtimes: ["claude"],
        instruction: "v2",
        files: [
          { path: "SKILL.md", content: "v2" },
          { path: "reference.md", content: "details" },
        ],
      }],
    }, 3);
    expect(store.getSkill(skill.id)).toEqual(expect.objectContaining({
      description: "v2",
      instruction: "v2",
      files: [expect.objectContaining({ path: "SKILL.md" }), expect.objectContaining({ path: "reference.md" })],
    }));
    expect(store.getSkill(skill.id)?.bundleHash).not.toBe(oldHash);
  });

  test("GitHub import resolves the request principal credential and never reads a static PAT", async () => {
    const authorizations: string[] = [];
    const fetchMock = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(String(input));
      authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
      if (url.hostname === "api.github.com") {
        return Response.json([{
          path: "skills/review/SKILL.md",
          type: "file",
          download_url: "https://raw.githubusercontent.com/acme/repo/main/skills/review/SKILL.md",
        }]);
      }
      return new Response("---\nname: review\ndescription: Review\n---\nDo review.");
    }) as typeof fetch;
    const resolverCalls: unknown[] = [];
    const service = new SkillImportService(undefined, fetchMock, (input) => {
      resolverCalls.push(input);
      return "principal-token-only";
    });
    const principal = {
      type: "account" as const,
      id: "acc_owner",
      membershipId: "member_owner",
      initiator: { kind: "test" },
    };
    const bundle = await service.fromGitHub(
      "https://github.com/acme/repo/tree/main/skills/review",
      undefined,
      "ws_team",
      principal,
    );
    expect(bundle.files).toEqual([expect.objectContaining({ path: "SKILL.md" })]);
    expect(resolverCalls).toEqual([{ workspaceId: "ws_team", owner: "acme", repository: "repo", principal }]);
    expect(authorizations).toEqual(["Bearer principal-token-only", "Bearer principal-token-only"]);
  });
});
