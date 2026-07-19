import { describe, expect, test } from "bun:test";
import { claudeEnvironmentSkillArgs } from "./claude.js";

describe("Claude environment Skill isolation", () => {
  test("keeps Runtime customizations by default", () => {
    expect(claudeEnvironmentSkillArgs()).toEqual([]);
  });

  test("uses Claude safe mode when environment Skills are disabled", () => {
    expect(claudeEnvironmentSkillArgs(false)).toEqual([
      "--safe-mode",
      "--disable-slash-commands",
    ]);
  });
});
