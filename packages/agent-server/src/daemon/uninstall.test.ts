import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("uninstall is idempotent for an absent LaunchAgent and preserves state", () => {
  const home = mkdtempSync(join(tmpdir(), "as-uninstall-"));
  try {
    const bin = join(home, "bin"), agents = join(home, "Library/LaunchAgents"); mkdirSync(bin); mkdirSync(agents, { recursive: true });
    // Never invoke the real launchctl or touch the user's LaunchAgents.
    writeFileSync(join(bin, "launchctl"), "#!/bin/sh\nexit 113\n", { mode: 0o755 });
    const plist = "com.smokingmouse.agent-server.plist";
    writeFileSync(join(agents, plist), "fixture"); writeFileSync(join(home, "token"), "preserve");
    for (let i = 0; i < 2; i++) {
      const result = Bun.spawnSync(["sh", join(import.meta.dir, "../../../../scripts/agent-server/uninstall.sh")], { env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
    }
    expect(existsSync(join(agents, plist))).toBe(false); expect(readdirSync(agents).filter(f => f.startsWith(plist + ".disabled-"))).toHaveLength(1);
    expect(existsSync(join(home, "token"))).toBe(true);
    writeFileSync(join(bin, "launchctl"), '#!/bin/sh\n[ "$1" = print ]\n');
    writeFileSync(join(agents, plist), "fixture");
    const failed = Bun.spawnSync(["sh", join(import.meta.dir, "../../../../scripts/agent-server/uninstall.sh")], { env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
    expect(failed.exitCode).toBe(1); expect(existsSync(join(agents, plist))).toBe(true);
  } finally { rmSync(home, { recursive: true }); }
});
