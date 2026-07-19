import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  bootstrapLaunchAgentWithRetry,
  buildDaemonServicePath,
  prepareDaemonConfig,
  renderLaunchAgent,
  renderSystemdUnit,
} from "./service.js";

describe("daemon service definitions", () => {
  test("launchd definition escapes paths and never contains a token", () => {
    const plist = renderLaunchAgent({
      home: "/Users/a&b",
      bunPath: "/opt/Bun <runtime>/bun",
      daemonEntry: "/repo/harbord.ts",
      pathEnv: "/bin:/opt/Bun <runtime>/:/opt/bin:/bin",
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log",
    });
    expect(plist).toContain("/Users/a&amp;b");
    expect(plist).toContain("/opt/Bun &lt;runtime&gt;/bun");
    expect(plist).toContain(
      "<key>PATH</key><string>/opt/Bun &lt;runtime&gt;:/bin:/opt/bin</string>",
    );
    expect(plist).not.toContain("token");
  });

  test("systemd definition quotes paths with spaces and restarts", () => {
    const unit = renderSystemdUnit({
      home: "/home/Harbor User",
      bunPath: "/home/Harbor User/.bun/bin/bun",
      daemonEntry: "/repo with spaces/main.ts",
      pathEnv: "/bin:/home/Harbor User/.bun/bin:/usr/bin:/bin",
    });
    expect(unit).toContain('ExecStart="/home/Harbor User/.bun/bin/bun" "/repo with spaces/main.ts"');
    expect(unit).toContain('Environment="PATH=/home/Harbor User/.bun/bin:/bin:/usr/bin"');
    expect(unit).toContain("Restart=always");
    expect(unit).not.toContain("token");
  });

  test("PATH construction keeps bun dirname first and removes normalized duplicates", () => {
    expect(buildDaemonServicePath("/home/me/.bun/bin/bun", "/usr/bin:/home/me/.bun/bin/:/bin:/usr/bin")).toBe(
      "/home/me/.bun/bin:/usr/bin:/bin",
    );
  });

  test("launchd bootstrap retries only the bounded post-bootout EIO race", () => {
    const results = [
      { ok: false, out: "Bootstrap failed: 5: Input/output error" },
      { ok: false, out: "Bootstrap failed: 5: Input/output error" },
      { ok: true, out: "" },
    ];
    const calls: string[][] = [];
    const pauses: number[] = [];
    bootstrapLaunchAgentWithRetry(
      "gui/501",
      "/tmp/worker.plist",
      (argv) => { calls.push(argv); return results.shift()!; },
      (ms) => { pauses.push(ms); },
    );
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(["launchctl", "bootstrap", "gui/501", "/tmp/worker.plist"]);
    expect(pauses).toEqual([50, 50]);
  });

  test("launchd bootstrap does not retry an ambiguous non-EIO failure", () => {
    let calls = 0;
    expect(() => bootstrapLaunchAgentWithRetry(
      "gui/501",
      "/tmp/worker.plist",
      () => { calls++; return { ok: false, out: "Bootstrap failed: 37: Operation already in progress" }; },
      () => { throw new Error("must not pause"); },
    )).toThrow("Operation already in progress");
    expect(calls).toBe(1);
  });
});

describe("daemon config", () => {
  test("preserves unrelated config and writes service fields", () => {
    const home = mkdtempSync(resolve(tmpdir(), "harbor-service-"));
    try {
      writeFileSync(resolve(home, ".harbor.yaml"), "feishu:\n  bot_name: Harbor\n");
      const path = prepareDaemonConfig(home, {
        serverUrl: "http://100.64.0.1:7777",
        token: "secret",
        deviceName: "worker-1",
      });
      const config = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(config.server_url).toBe("http://100.64.0.1:7777");
      expect(config.device_name).toBe("worker-1");
      expect(config.token).toBe("secret");
      expect(config.feishu).toEqual({ bot_name: "Harbor" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
