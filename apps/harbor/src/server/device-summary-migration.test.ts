import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LATEST_SCHEMA_VERSION,
  openDb,
  openV23MigrationFixtureDb,
} from "./db.js";
import { HarborStore } from "./store.js";

test("v24 backfills a compact Device list projection without changing the full snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "harbor-device-summary-v24-"));
  const path = join(dir, "fixture.db");
  const body = "runtime Skill body".repeat(20_000);
  try {
    const legacy = openV23MigrationFixtureDb(path);
    const device = new HarborStore(legacy).upsertDevice("worker", "hash", {
      clis: { claude: "2.1.0" },
      endpoints: ["claude-sonnet-4-5"],
      installedSkills: [{
        name: "runtime-review",
        description: "Review a change",
        path: "/skills/runtime-review",
        runtimes: ["claude"],
        instruction: body,
        files: [{ path: "references/policy.md", content: body }],
      }],
    }, 1);
    expect(legacy.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(23);
    legacy.close();

    const migrated = openDb(path);
    try {
      expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(LATEST_SCHEMA_VERSION);
      const lengths = migrated.query<{ full: number; summary: number }, [string]>(
        "SELECT length(capabilities) AS full, length(capabilities_summary) AS summary FROM devices WHERE id = ?",
      ).get(device.id)!;
      expect(lengths.full).toBeGreaterThan(700_000);
      expect(lengths.summary).toBeLessThan(1_000);

      const store = new HarborStore(migrated);
      expect(store.getDevice(device.id, true)?.capabilities.installedSkills?.[0]?.files?.[0]?.content).toBe(body);
      expect(store.listDeviceSummaries(new Set([device.id]))).toEqual([
        expect.objectContaining({
          id: device.id,
          online: true,
          capabilities: expect.objectContaining({
            installedSkills: [expect.objectContaining({
              name: "runtime-review",
              fileCount: 1,
            })],
          }),
        }),
      ]);
      expect(migrated.query<unknown, []>("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
