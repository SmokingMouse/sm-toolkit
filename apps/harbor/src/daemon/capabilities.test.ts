import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EndpointInfo } from "@sm/llm";
import {
  buildCodexModelRoutes,
  buildModelRoutes,
  detectEnvironmentSkillNames,
  detectInstalledSkills,
} from "./capabilities.js";

describe("buildModelRoutes", () => {
  test("only exposes routes Claude Code can execute and preserves readiness", () => {
    const infos: EndpointInfo[] = [
      { name: "sonnet", provider: "claude", model: "sonnet", hasKey: false },
      { name: "k3", provider: "kimi", model: "k3", anthropic_url: "https://example.test", hasKey: true },
      { name: "missing-key", provider: "proxy", model: "missing-key", anthropic_url: "https://example.test", hasKey: false },
      { name: "gemini", provider: "gemini", model: "gemini", openai_url: "https://example.test", hasKey: true },
    ];

    expect(buildModelRoutes(infos)).toEqual([
      { id: "claude:sonnet", provider: "claude", model: "sonnet", runtime: "claude", kind: "native", ready: true },
      { id: "kimi:k3", provider: "kimi", model: "k3", runtime: "claude", kind: "anthropic", ready: true },
      { id: "proxy:missing-key", provider: "proxy", model: "missing-key", runtime: "claude", kind: "anthropic", ready: false },
    ]);
  });
});

describe("detectInstalledSkills", () => {
  test("reads SKILL.md metadata and merges runtimes for the same installed skill", () => {
    const root = mkdtempSync(join(tmpdir(), "harbor-skills-"));
    try {
      const dir = join(root, "reviewer");
      mkdirSync(dir);
      writeFileSync(join(dir, "SKILL.md"), `---\nname: pr-review\ndescription: Review pull requests\n---\n\nCheck correctness first.\n`);
      const skills = detectInstalledSkills([
        { path: root, runtimes: ["claude"] },
        { path: root, runtimes: ["codex"] },
      ]);
      expect(skills).toHaveLength(1);
      expect(skills[0]).toEqual(expect.objectContaining({
        name: "pr-review",
        description: "Review pull requests",
        runtimes: ["claude", "codex"],
      }));
      expect(skills[0]?.instruction).toContain("Check correctness first");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("detectEnvironmentSkillNames", () => {
  test("uses frontmatter names and includes every configured Runtime root", () => {
    const first = mkdtempSync(join(tmpdir(), "harbor-environment-skills-"));
    const second = mkdtempSync(join(tmpdir(), "harbor-environment-skills-"));
    try {
      mkdirSync(join(first, "folder-name"));
      writeFileSync(join(first, "folder-name", "SKILL.md"), "---\nname: canonical-name\n---\n");
      mkdirSync(join(second, "fallback-name"));
      writeFileSync(join(second, "fallback-name", "SKILL.md"), "No frontmatter\n");

      expect(detectEnvironmentSkillNames(null, [first, second, first])).toEqual([
        "canonical-name",
        "fallback-name",
      ]);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  test("fails closed instead of truncating an oversized environment Skill set", () => {
    const root = mkdtempSync(join(tmpdir(), "harbor-environment-skills-"));
    try {
      for (const name of ["one", "two"]) {
        mkdirSync(join(root, name));
        writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
      }
      expect(() => detectEnvironmentSkillNames(null, [root], 1)).toThrow(
        "环境 Skill 超过安全上限 1",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when an environment Skill cannot be safely inspected", () => {
    const root = mkdtempSync(join(tmpdir(), "harbor-environment-skills-"));
    try {
      mkdirSync(join(root, "oversized"));
      writeFileSync(join(root, "oversized", "SKILL.md"), "x".repeat(128 * 1024 + 1));
      expect(() => detectEnvironmentSkillNames(null, [root])).toThrow(
        "无法确认环境 Skill",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildCodexModelRoutes", () => {
  test("maps listed models with display label and hides non-list entries", () => {
    expect(buildCodexModelRoutes([
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list" },
      { slug: "internal-x", display_name: "Internal X", visibility: "hidden" },
      { slug: "gpt-5.5-codex", visibility: "list" },
    ])).toEqual([
      { id: "codex:gpt-5.6-sol", provider: "codex", model: "gpt-5.6-sol", label: "GPT-5.6-Sol", runtime: "codex", kind: "native", ready: true },
      { id: "codex:gpt-5.5-codex", provider: "codex", model: "gpt-5.5-codex", label: undefined, runtime: "codex", kind: "native", ready: true },
    ]);
  });
});
