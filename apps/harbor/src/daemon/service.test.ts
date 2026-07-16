import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { prepareDaemonConfig, renderLaunchAgent, renderSystemdUnit } from "./service.js";

describe("daemon service definitions", () => {
  test("launchd definition escapes paths and never contains a token", () => {
    const plist = renderLaunchAgent({
      home: "/Users/a&b",
      bunPath: "/opt/Bun <runtime>/bun",
      daemonEntry: "/repo/harbord.ts",
      pathEnv: "/bin:/opt/bin",
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log",
    });
    expect(plist).toContain("/Users/a&amp;b");
    expect(plist).toContain("/opt/Bun &lt;runtime&gt;/bun");
    expect(plist).not.toContain("token");
  });

  test("systemd definition quotes paths with spaces and restarts", () => {
    const unit = renderSystemdUnit({
      home: "/home/Harbor User",
      bunPath: "/home/Harbor User/.bun/bin/bun",
      daemonEntry: "/repo with spaces/main.ts",
      pathEnv: "/bin:/usr/bin",
    });
    expect(unit).toContain('ExecStart="/home/Harbor User/.bun/bin/bun" "/repo with spaces/main.ts"');
    expect(unit).toContain("Restart=always");
    expect(unit).not.toContain("token");
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
