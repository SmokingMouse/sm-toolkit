import { createHash } from "node:crypto";
import type { HarborStore } from "./store.js";
import { importedSkillMetadata, type SkillImportService } from "./skill-import.js";

/** Remote Skill auto-sync；runtime source 由 daemon hello 同步，这里只轮询 Codebase/GitHub。 */
export class SkillSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly store: HarborStore,
    private readonly imports: SkillImportService,
    private readonly intervalMs = 10 * 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.syncOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async syncOnce(now = Date.now()): Promise<{ synced: string[]; failed: { id: string; error: string }[] }> {
    if (this.running) return { synced: [], failed: [] };
    this.running = true;
    const synced: string[] = [];
    const failed: { id: string; error: string }[] = [];
    try {
      const candidates = this.store.listSkills(false).filter((skill) =>
        skill.autoSync && (skill.source === "codebase" || skill.source === "github") && !!skill.originUrl);
      for (const skill of candidates) {
        try {
          const bundle = await this.imports.refresh({
            source: skill.source as "codebase" | "github",
            originUrl: skill.originUrl!,
            sourcePath: skill.sourcePath,
            sourceRef: skill.sourceRef,
            workspaceId: skill.workspaceId,
          });
          const metadata = importedSkillMetadata(bundle.files, skill.name);
          if (skill.bundleHash !== bundleHash(bundle.files)) {
            this.store.updateSkill(skill.id, {
              description: metadata.description,
              instruction: metadata.instruction,
              files: bundle.files,
              dependencies: metadata.dependencies,
              sourceRef: bundle.sourceRef,
            }, now);
          } else {
            this.store.updateSkill(skill.id, { sourceRef: bundle.sourceRef }, now);
          }
          synced.push(skill.id);
        } catch (error) {
          failed.push({ id: skill.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { synced, failed };
    } finally {
      this.running = false;
    }
  }
}

function bundleHash(files: { path: string; content: string }[]): string {
  const rows = files.map((file) => {
    const digest = createHash("sha256").update(file.content).digest("hex");
    return `${file.path}\0${digest}`;
  });
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}
