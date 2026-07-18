import { describe, expect, test } from "bun:test";
import type { DeploymentTargetConfig } from "../config.js";
import type { DeploymentJob } from "../protocol.js";
import {
  LocalLaunchdDeploymentExecutor,
  type DeploymentClock,
  type DeploymentFileSystem,
  type DeploymentProcess,
  type HealthClient,
  type LaunchdControl,
  type SqliteBackupControl,
} from "./executor.js";
import { renderDeploymentWorkerLaunchAgent } from "./service.js";

const REVISION = "a".repeat(40);
const SECRET = "super-secret-token";

class FakeFs implements DeploymentFileSystem {
  files = new Map<string, string>([["/plist", "old plist"], ["/template", "new {{release_path}}"]]);
  links = new Map<string, string>([["/current", "/old-release"]]);
  async mkdir() {}
  async readText(path: string) { const value = this.files.get(path); if (value === undefined) throw new Error(`missing ${path}`); return value; }
  async writeText(path: string, value: string) { this.files.set(path, value); }
  async rename(from: string, to: string) {
    if (this.files.has(from)) { this.files.set(to, this.files.get(from)!); this.files.delete(from); return; }
    if (this.links.has(from)) { this.links.set(to, this.links.get(from)!); this.links.delete(from); return; }
    throw new Error(`missing ${from}`);
  }
  async exists(path: string) { return this.files.has(path) || this.links.has(path); }
  async readLink(path: string) { return this.links.get(path) ?? null; }
  async symlink(target: string, path: string) { this.links.set(path, target); }
  async remove(path: string) { this.files.delete(path); this.links.delete(path); }
}

class FakeProcess implements DeploymentProcess {
  calls: string[][] = [];
  constructor(private readonly noisy = false) {}
  async run(argv: string[]) {
    this.calls.push(argv);
    if (argv.includes("rev-parse")) return { exitCode: 0, stdout: `${REVISION}\n`, stderr: "" };
    return { exitCode: 0, stdout: this.noisy ? `${SECRET} /repo ${"x".repeat(40_000)}` : "ok", stderr: "" };
  }
}

class FakeLaunchd implements LaunchdControl {
  calls: string[] = [];
  async bootout(domain: string, label: string) { this.calls.push(`bootout ${domain}/${label}`); }
  async bootstrap(domain: string, plist: string) { this.calls.push(`bootstrap ${domain} ${plist}`); }
}

class FakeSqlite implements SqliteBackupControl {
  backedUp = false;
  restored = false;
  failRestore = false;
  async backup() { this.backedUp = true; }
  async restore() { this.restored = true; if (this.failRestore) throw new Error("restore exploded"); }
}

class FakeHealth implements HealthClient {
  constructor(private readonly statuses: number[]) {}
  async get() { return { status: this.statuses.shift() ?? 500 }; }
}

class FakeClock implements DeploymentClock {
  value = 0;
  now() { return this.value; }
  async sleep(ms: number) { this.value += ms; }
}

function target(): DeploymentTargetConfig {
  return {
    id: "local", name: "Local", provider: "local-launchd", repositoryId: "repo_1",
    repositoryPath: "/repo", releasesPath: "/releases", currentSymlinkPath: "/current",
    sqlitePath: "/db", statePath: "/state", environment: { TOKEN: SECRET },
    steps: { install: [], build: [["build", SECRET]], test: [] },
    launchd: { label: "com.test", domain: "gui/1", plistPath: "/plist", templatePath: "/template" },
    health: { url: "http://health.test/", headers: { Authorization: `Bearer ${SECRET}` }, timeoutMs: 2, intervalMs: 1 },
  };
}

function job(): DeploymentJob {
  return {
    id: "depjob_1", deliveryId: "del_1", generation: 1, targetId: "local", revision: REVISION,
    status: "running", attempt: 1, leaseToken: "lease_1", leaseExpiresAt: 100,
    checkpoint: "queued", log: null, error: null, rollbackComplete: null,
    createdAt: 0, startedAt: 0, finishedAt: null, updatedAt: 0,
  };
}

function executor(statuses: number[], noisy = false) {
  const fs = new FakeFs();
  const process = new FakeProcess(noisy);
  const launchd = new FakeLaunchd();
  const sqlite = new FakeSqlite();
  const clock = new FakeClock();
  const instance = new LocalLaunchdDeploymentExecutor({ fs, process, launchd, sqlite, health: new FakeHealth(statuses), clock });
  return { instance, fs, process, launchd, sqlite, clock };
}

describe("local launchd executor", () => {
  test("checks out exact revision, truncates/redacts logs, atomically switches, and passes health", async () => {
    const h = executor([200], true);
    const checkpoints: string[] = [];
    const result = await h.instance.execute(job(), target(), { checkpoint: async (value) => { checkpoints.push(value); } });
    expect(result.status).toBe("succeeded");
    expect(result.log.length).toBeLessThanOrEqual(32_000);
    expect(result.log).toContain("[redacted]");
    expect(result.log).toContain("…[truncated]");
    expect(result.log).not.toContain(SECRET);
    expect(result.log).not.toContain("/repo");
    expect(h.process.calls[0]).toEqual(["git", "-C", "/repo", "rev-parse", "--verify", `${REVISION}^{commit}`]);
    expect(h.fs.links.get("/current")).toContain("depjob_1-g1-a1");
    expect(h.sqlite.backedUp).toBeTrue();
    expect(checkpoints.at(-1)).toBe("healthy");
  });

  test("health failure restores old definition, release, SQLite backup, and old service", async () => {
    const h = executor([500, 500, 500, 200]);
    const result = await h.instance.execute(job(), target(), { checkpoint: async () => {} });
    expect(result).toEqual(expect.objectContaining({ status: "failed", rollbackComplete: true }));
    expect(h.fs.files.get("/plist")).toBe("old plist");
    expect(h.fs.links.get("/current")).toBe("/old-release");
    expect(h.sqlite.restored).toBeTrue();
    expect(h.launchd.calls.filter((call) => call.startsWith("bootstrap"))).toHaveLength(2);
  });

  test("backup restore failure stays failed and does not restart old service against uncertain DB", async () => {
    const h = executor([500, 500, 500]);
    h.sqlite.failRestore = true;
    const result = await h.instance.execute(job(), target(), { checkpoint: async () => {} });
    expect(result).toEqual(expect.objectContaining({ status: "failed", rollbackComplete: false }));
    expect(result.error).toContain("rollback incomplete");
    expect(h.launchd.calls.filter((call) => call.startsWith("bootstrap"))).toHaveLength(1);
  });

  test("an expired attempt recovers a persisted cutover checkpoint before retrying", async () => {
    const h = executor([200, 200]);
    h.fs.files.set("/state/depjob_1/attempt-1/old.plist", "old plist");
    h.fs.files.set("/state/depjob_1/attempt-1/old-current", "/old-release");
    h.fs.files.set("/state/depjob_1/attempt-1/database.sqlite", "backup");
    const recoveredJob = { ...job(), attempt: 2, checkpoint: "switched" };
    const result = await h.instance.execute(recoveredJob, target(), { checkpoint: async () => {} });
    expect(result.status).toBe("succeeded");
    expect(h.sqlite.restored).toBeTrue();
    expect(h.launchd.calls.filter((call) => call.startsWith("bootstrap"))).toHaveLength(2);
  });

  test("worker LaunchAgent is lifecycle-independent and contains no token or target secrets", () => {
    const plist = renderDeploymentWorkerLaunchAgent({
      home: "/Users/a&b", bunPath: "/opt/bun/bin/bun", workerEntry: "/repo/worker.ts",
      pathEnv: "/bin:/opt/bun/bin", databasePath: "/db", stdoutPath: "/tmp/out", stderrPath: "/tmp/err",
    });
    expect(plist).toContain("com.smokingmouse.harbor.deploy-worker");
    expect(plist).toContain("KeepAlive");
    expect(plist).toContain("/Users/a&amp;b");
    expect(plist).not.toContain("token");
    expect(plist).not.toContain(SECRET);
  });
});
