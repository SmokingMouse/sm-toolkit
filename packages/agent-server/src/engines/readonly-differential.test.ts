import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import review4 from "./readonly-review4-vectors.json";
import { classifyReadonlyCommand } from "./readonly-commands.js";

function snapshot(root: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      const hash = stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : "";
      entries.push(`${relative(root, path)}|${stat.mode}|${stat.size}|${stat.mtimeMs}|${hash}`);
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(root); return entries;
}

// Exact 67-command corpus from review-d2fb/diffexec.ts, frozen before changing the policy.
// Some rows now require approval; still execute their historical literal commands in the
// same non-repository fixture to preserve the original differential experiment, rather than
// silently shrinking it to today's allow subset. Nonzero tool exits are recorded, not skipped.
test("fourth review: all 67 real-tool differential rows leave bytes and metadata unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "readonly-differential-"));
  const statuses: Record<string, number> = {};
  let approvals = 0;
  expect(review4.differential).toHaveLength(67);
  for (const [index, command] of review4.differential.entries()) {
    const box = join(root, String(index));
    mkdirSync(join(box, "sub"), { recursive: true });
    for (const [name, content] of [["a.txt", "foo bar\n"], ["b.ts", "const foo = 1\n"], ["sub/c.txt", "foo\n"], ["--output=PWN", "decoy argv file\n"], ["-delete", "decoy argv file\n"], ["sentinel", "alive\n"]]) {
      writeFileSync(join(box, name!), content!);
    }
    const decision = classifyReadonlyCommand(command, undefined, { cwd: box, allowedRoots: [box], pathDirs: ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] });
    if (!decision.readonly) { approvals++; expect(decision.matchedRules).toEqual([]); }
    const before = snapshot(root);
    let status = 0;
    try {
      execFileSync("/bin/sh", ["-c", command], { cwd: box, stdio: "ignore", timeout: 1500,
        env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
    } catch (error) { status = (error as { status: number | null }).status ?? -1; }
    statuses[String(status)] = (statuses[String(status)] ?? 0) + 1;
    expect(snapshot(root), command).toEqual(before);
    expect(existsSync(join(box, "sentinel")), command).toBe(true);
  }
  console.log(`readonly differential: executed=67 mutations=0 sentinelAlive=true approvalsNow=${approvals} toolExits=${JSON.stringify(statuses)}`);
}, 120_000);
