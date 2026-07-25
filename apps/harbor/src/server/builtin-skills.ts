import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HarborSkill } from "../protocol.js";
import { importedSkillMetadata } from "./skill-import.js";
import type { HarborStore } from "./store.js";

export const HARBOR_BUILTIN_SKILL_NAME = "harbor";

const HARBOR_SKILL_PATH = resolve(
  import.meta.dir,
  "../../skills/harbor/SKILL.md",
);
const HARBOR_SKILL_CONTENT = readFileSync(HARBOR_SKILL_PATH, "utf8");
const HARBOR_SKILL_FILES = [
  { path: "SKILL.md", content: HARBOR_SKILL_CONTENT },
];
const HARBOR_SKILL_METADATA = importedSkillMetadata(
  HARBOR_SKILL_FILES,
  HARBOR_BUILTIN_SKILL_NAME,
);

/**
 * Built-in Skills are versioned with Harbor and materialized per Workspace so
 * they remain visible, auditable, and bindable through the normal Agent model.
 */
export function ensureBuiltinHarborSkill(
  store: HarborStore,
  workspaceId: string,
  now = Date.now(),
): HarborSkill {
  const existing = store.getSkillByName(HARBOR_BUILTIN_SKILL_NAME, workspaceId);
  if (existing && existing.source !== "builtin") {
    throw new Error(
      `Workspace ${workspaceId} 已有非内置 Skill "${HARBOR_BUILTIN_SKILL_NAME}"；该名称由 Harbor 保留`,
    );
  }
  if (!existing) {
    return store.createSkill(
      {
        workspaceId,
        name: HARBOR_SKILL_METADATA.name,
        description: HARBOR_SKILL_METADATA.description,
        source: "builtin",
        instruction: HARBOR_SKILL_METADATA.instruction,
        runtimes: ["claude", "codex"],
        files: HARBOR_SKILL_FILES,
        dependencies: HARBOR_SKILL_METADATA.dependencies,
      },
      now,
    );
  }

  const bundleChanged =
    existing.name !== HARBOR_SKILL_METADATA.name ||
    existing.description !== HARBOR_SKILL_METADATA.description ||
    existing.instruction !== HARBOR_SKILL_METADATA.instruction ||
    existing.files.length !== HARBOR_SKILL_FILES.length ||
    existing.files.some(
      (file, index) =>
        file.path !== HARBOR_SKILL_FILES[index]?.path ||
        file.content !== HARBOR_SKILL_FILES[index]?.content,
    );
  if (bundleChanged) {
    store.updateSkill(
      existing.id,
      {
        name: HARBOR_SKILL_METADATA.name,
        description: HARBOR_SKILL_METADATA.description,
        instruction: HARBOR_SKILL_METADATA.instruction,
        runtimes: ["claude", "codex"],
        files: HARBOR_SKILL_FILES,
        dependencies: HARBOR_SKILL_METADATA.dependencies,
      },
      now,
    );
  }
  if (existing.archivedAt !== null) {
    store.setSkillArchived(existing.id, false, now);
  }
  return store.getSkill(existing.id)!;
}

export function ensureBuiltinSkills(store: HarborStore, now = Date.now()): void {
  for (const workspace of store.listWorkspaces(true)) {
    const skill = ensureBuiltinHarborSkill(store, workspace.id, now);
    for (const agent of store.listAgents(false, workspace.id)) {
      if (agent.skillIds.includes(skill.id)) continue;
      store.setAgentSkills(agent.id, [skill.id, ...agent.skillIds], now);
    }
  }
}
