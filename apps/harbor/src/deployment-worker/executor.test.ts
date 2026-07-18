import { describe, expect, test } from "bun:test";
import type { DeploymentTargetConfig } from "../config.js";
import type { DeploymentJob, DeploymentMaintenanceGate } from "../protocol.js";
import {
  LocalLaunchdDeploymentExecutor,
  type DeploymentClock,
  type DeploymentExecutionHooks,
  type DeploymentFileSystem,
  type DeploymentProcess,
  type DeploymentProcessOptions,
  type HealthClient,
  type LaunchdControl,
  type LaunchdServiceState,
  type SqliteBackupControl,
} from "./executor.js";
import type { DeploymentMaintenanceSentinel } from "./maintenance.js";
import { assertRuntimePathMetadata, minimalProcessEnvironment, parseLaunchctlPrint, readLinkOrMissing } from "./runtime.js";
import { renderDeploymentWorkerLaunchAgent } from "./service.js";

const REVISION = "a".repeat(40);
const BASELINE = "b".repeat(40);
const FINGERPRINT = "c".repeat(64);
const SECRET = "super-secret-health-token";

class FakeFs implements DeploymentFileSystem {
  files = new Map<string, string>([
    ["/plist", "old plist {{revision}}"],
    ["/template", "new {{release_path}} {{revision}} {{target_fingerprint}}"],
  ]);
  links = new Map<string, string>([["/current", "/releases/old-release"]]);
  modes = new Map<string, number>();
  writes: string[] = [];
  async mkdir(path: string, mode: number) { this.modes.set(path, mode); }
  async readText(path: string) { const value = this.files.get(path); if (value === undefined) throw new Error(`missing ${path}`); return value; }
  async writeText(path: string, value: string, mode: number) { this.files.set(path, value); this.modes.set(path, mode); this.writes.push(path); }
  async rename(from: string, to: string) {
    if (this.files.has(from)) { this.files.set(to, this.files.get(from)!); this.files.delete(from); return; }
    if (this.links.has(from)) { this.links.set(to, this.links.get(from)!); this.links.delete(from); return; }
    throw new Error(`missing ${from}`);
  }
  async exists(path: string) { return this.files.has(path) || this.links.has(path); }
  async readLink(path: string) {
    if (this.files.has(path)) throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
    return this.links.get(path) ?? null;
  }
  async symlink(target: string, path: string) { this.links.set(path, target); }
  async remove(path: string) { this.files.delete(path); this.links.delete(path); }
}

class FakeProcess implements DeploymentProcess {
  calls: { argv: string[]; options: DeploymentProcessOptions }[] = [];
  noisy = false;
  timedOut = false;
  async run(argv: string[], options: DeploymentProcessOptions) {
    this.calls.push({ argv, options });
    if (argv.includes(`${REVISION}^{commit}`)) return { exitCode: 0, stdout: `${REVISION}\n`, stderr: "", timedOut: false };
    if (argv.includes("HEAD^{commit}")) return { exitCode: 0, stdout: `${BASELINE}\n`, stderr: "", timedOut: false };
    const stdout = this.noisy ? `${SECRET} /repo ${"x".repeat(60_000)}` : "ok";
    options.onOutput("stdout", stdout);
    return { exitCode: 0, stdout, stderr: "", timedOut: this.timedOut };
  }
}

class FakeLaunchd implements LaunchdControl {
  calls: string[] = [];
  loaded = true;
  state = "running";
  pid: number | null = 10;
  alive = new Set([10]);
  failBootoutCall: number | null = null;
  keepPidAlive = false;
  wrongLabel = false;
  private bootouts = 0;
  constructor(private readonly fs: FakeFs) {}
  async inspect(_domain: string, label: string): Promise<LaunchdServiceState> {
    return { loaded: this.loaded, label: this.loaded ? (this.wrongLabel ? `${label}.other` : label) : null, state: this.state, pid: this.pid };
  }
  async bootout(domain: string, label: string) {
    this.bootouts++;
    this.calls.push(`bootout ${domain}/${label}`);
    if (this.failBootoutCall === this.bootouts) throw new Error("bootout exploded");
    const oldPid = this.pid;
    this.loaded = false;
    this.state = "unloaded";
    this.pid = null;
    if (oldPid && !this.keepPidAlive) this.alive.delete(oldPid);
  }
  async bootstrap(domain: string, plist: string) {
    this.calls.push(`bootstrap ${domain} ${plist}`);
    const nextPid = this.fs.files.get("/plist")?.startsWith("old plist") ? 30 : 20;
    this.loaded = true;
    this.state = "running";
    this.pid = nextPid;
    this.alive.add(nextPid);
  }
  async isPidAlive(pid: number) { return this.alive.has(pid); }
}

class FakeSqlite implements SqliteBackupControl {
  backedUp = false;
  restored = false;
  failRestore = false;
  async backup(_database: string, backup: string) { this.backedUp = true; fsForBackup?.files.set(backup, "backup"); fsForBackup?.modes.set(backup, 0o600); }
  async restore() { this.restored = true; if (this.failRestore) throw new Error("restore exploded"); }
}
let fsForBackup: FakeFs | null = null;

class FakeHealth implements HealthClient {
  calls: { url: string; headers: Record<string, string> }[] = [];
  wrongNewRevision = false;
  constructor(private readonly statuses: number[]) {}
  async get(url: string, headers: Record<string, string>) {
    this.calls.push({ url, headers });
    const status = this.statuses.shift() ?? 500;
    const query = new URL(url).searchParams;
    return {
      status,
      body: status >= 200 && status < 300 ? {
        ok: true,
        revision: this.wrongNewRevision && query.get("revision") === REVISION ? BASELINE : query.get("revision"),
        targetFingerprint: query.get("target_fingerprint"),
        deploymentJobId: query.get("deployment_job_id"),
        maintenance: true,
      } : null,
    };
  }
}

class FakeClock implements DeploymentClock {
  value = 0;
  now() { return this.value; }
  async sleep(ms: number) { this.value += ms; }
}

class FakeSentinel implements DeploymentMaintenanceSentinel {
  gate: DeploymentMaintenanceGate | null = null;
  async read() { return this.gate; }
  async write(_target: DeploymentTargetConfig, gate: DeploymentMaintenanceGate) { this.gate = { ...gate }; }
  async clear(_target: DeploymentTargetConfig, expected: DeploymentMaintenanceGate) {
    if (this.gate?.jobId !== expected.jobId) throw new Error("wrong sentinel");
    this.gate = null;
  }
}

function target(): DeploymentTargetConfig {
  return {
    id: "local", name: "Local", provider: "local-launchd", repositoryId: "repo_1",
    repositoryPath: "/repo", releasesPath: "/releases", currentSymlinkPath: "/current",
    sqlitePath: "/db", statePath: "/state", environment: { BUILD_MODE: "production" },
    steps: { install: [], build: [["build", "--production"]], test: [] },
    launchd: { label: "com.test", domain: "gui/1", plistPath: "/plist", templatePath: "/template" },
    health: { url: "http://127.0.0.1/health", headers: { Authorization: `Bearer ${SECRET}` }, timeoutMs: 2, intervalMs: 1 },
    commandTimeoutMs: 100,
    fingerprint: FINGERPRINT,
  };
}

function job(overrides: Partial<DeploymentJob> = {}): DeploymentJob {
  return {
    id: "depjob_1", deliveryId: "del_1", generation: 1, targetId: "local", revision: REVISION,
    targetFingerprint: FINGERPRINT, status: "running", attempt: 1, leaseToken: "lease_1", leaseExpiresAt: 100,
    checkpoint: "queued", log: null, error: null, rollbackComplete: null,
    rollbackAttempt: null, baselineRevision: null, newServicePid: null,
    createdAt: 0, startedAt: 0, finishedAt: null, updatedAt: 0,
    ...overrides,
  };
}

function gate(phase: DeploymentMaintenanceGate["phase"] = "deploying", expectedRevision = REVISION): DeploymentMaintenanceGate {
  return {
    version: 1, targetId: "local", jobId: "depjob_1", deliveryId: "del_1", generation: 1,
    revision: REVISION, targetFingerprint: FINGERPRINT, rollbackAttempt: 1, baselineRevision: BASELINE,
    expectedRevision, phase, createdAt: 1, updatedAt: 1,
  };
}

function fakeHooks(initial: DeploymentMaintenanceGate | null = null) {
  let current = initial;
  const checkpoints: string[] = [];
  const hooks: DeploymentExecutionHooks = {
    checkpoint: async (value) => { checkpoints.push(value); },
    getMaintenance: async () => current,
    activateMaintenance: async ({ rollbackAttempt, baselineRevision }) => {
      current = { ...gate(), rollbackAttempt, baselineRevision };
      return current;
    },
    updateMaintenance: async (phase, expectedRevision) => {
      if (!current) throw new Error("missing gate");
      current = { ...current, phase, expectedRevision, updatedAt: current.updatedAt + 1 };
      return current;
    },
    restoreMaintenance: async (original, phase, expectedRevision) => {
      current = { ...original, phase, expectedRevision, updatedAt: original.updatedAt + 1 };
      return current;
    },
  };
  return { hooks, checkpoints, current: () => current };
}

function harness(statuses: number[] = [200]) {
  const fs = new FakeFs();
  fsForBackup = fs;
  const process = new FakeProcess();
  const launchd = new FakeLaunchd(fs);
  const sqlite = new FakeSqlite();
  const health = new FakeHealth(statuses);
  const clock = new FakeClock();
  const sentinel = new FakeSentinel();
  let validated = 0;
  const instance = new LocalLaunchdDeploymentExecutor({
    fs, process, launchd, sqlite, health, clock,
    validator: { validate: async () => { validated++; } },
    maintenance: sentinel,
  } as ConstructorParameters<typeof LocalLaunchdDeploymentExecutor>[0]);
  return { instance, fs, process, launchd, sqlite, health, clock, sentinel, validated: () => validated };
}

describe("local launchd executor fail-closed boundary", () => {
  test("proves old PID stopped, uses private anchors, bounded/redacted streaming log, and verifies exact health", async () => {
    const h = harness([200]);
    h.process.noisy = true;
    const state = fakeHooks();
    const result = await h.instance.execute(job(), target(), state.hooks);
    expect(result.status).toBe("succeeded");
    expect(result.log.length).toBeLessThanOrEqual(32_000);
    expect(result.log).toContain("[redacted]");
    expect(result.log).toContain("…[truncated]");
    expect(result.log).not.toContain(SECRET);
    expect(result.log).not.toContain("--production");
    expect(h.process.calls[0]?.argv).toEqual(["git", "-C", "/repo", "rev-parse", "--verify", `${REVISION}^{commit}`]);
    expect(h.process.calls.find((call) => call.argv[0] === "build")?.options.env).toEqual({ BUILD_MODE: "production" });
    expect(h.process.calls.find((call) => call.argv[0] === "build")?.options.timeoutMs).toBe(100);
    expect(h.fs.links.get("/current")).toContain("depjob_1-g1-a1");
    expect(h.sqlite.backedUp).toBeTrue();
    expect(h.launchd.calls[0]).toBe("bootout gui/1/com.test");
    expect(h.health.calls[0]?.url).toContain(`revision=${REVISION}`);
    expect(state.current()?.phase).toBe("healthy");
    expect(h.fs.modes.get("/state/depjob_1/attempt-1/old.plist")).toBe(0o600);
  });

  test("bounded streaming command remains under configured timeout before maintenance", async () => {
    const h = harness();
    h.process.timedOut = true;
    const result = await h.instance.execute(job(), target(), fakeHooks().hooks);
    expect(result).toEqual(expect.objectContaining({ status: "failed", rollbackComplete: true }));
    expect(result.error).toContain("command timeout");
    expect(h.launchd.calls).toHaveLength(0);
    expect(h.sqlite.backedUp).toBeFalse();
  });

  test("bootout failure never replaces DB/plist/symlink and becomes needs_recovery", async () => {
    const h = harness();
    h.launchd.failBootoutCall = 1;
    const state = fakeHooks();
    const result = await h.instance.execute(job(), target(), state.hooks);
    expect(result).toEqual(expect.objectContaining({ status: "needs_recovery", rollbackComplete: false }));
    expect(h.sqlite.backedUp).toBeFalse();
    expect(h.sqlite.restored).toBeFalse();
    expect(h.fs.files.get("/plist")).toBe("old plist {{revision}}");
    expect(h.fs.links.get("/current")).toBe("/releases/old-release");

    const recovered = await h.instance.recoverOriginalBaseline(job({
      status: "recovering", attempt: 2, checkpoint: "rollback_incomplete",
      rollbackAttempt: 1, baselineRevision: BASELINE,
    }), target(), state.hooks);
    expect(recovered).toEqual(expect.objectContaining({ status: "failed", rollbackComplete: true }));
    expect(h.sqlite.restored).toBeFalse();
    expect(h.fs.files.get("/plist")).toBe("old plist {{revision}}");
    expect(h.fs.links.get("/current")).toBe("/releases/old-release");
    expect(h.launchd.calls.at(-1)).toBe("bootstrap gui/1 /plist");
  });

  test("unloaded-but-live PID is ambiguous and cannot cross the mutation boundary", async () => {
    const h = harness();
    h.launchd.keepPidAlive = true;
    const result = await h.instance.execute(job(), target(), fakeHooks().hooks);
    expect(result.status).toBe("needs_recovery");
    expect(result.error).toContain("无法证明");
    expect(h.sqlite.backedUp).toBeFalse();
    expect(h.fs.files.get("/plist")).toBe("old plist {{revision}}");
    expect(h.fs.links.get("/current")).toBe("/releases/old-release");
  });

  test("rollback bootout failure does not restore DB/plist/symlink", async () => {
    const h = harness([500, 500, 500]);
    h.launchd.failBootoutCall = 2;
    const result = await h.instance.execute(job(), target(), fakeHooks().hooks);
    expect(result.status).toBe("needs_recovery");
    expect(h.sqlite.backedUp).toBeTrue();
    expect(h.sqlite.restored).toBeFalse();
    expect(h.fs.files.get("/plist")).toContain(REVISION);
    expect(h.fs.links.get("/current")).toContain("depjob_1-g1-a1");
  });

  test("health failure restores exact old baseline; DB restore failure remains gated", async () => {
    const complete = harness([500, 500, 500, 200]);
    const rolledBack = await complete.instance.execute(job(), target(), fakeHooks().hooks);
    expect(rolledBack).toEqual(expect.objectContaining({ status: "failed", rollbackComplete: true }));
    expect(complete.fs.files.get("/plist")).toBe("old plist {{revision}}");
    expect(complete.fs.links.get("/current")).toBe("/releases/old-release");
    expect(complete.sqlite.restored).toBeTrue();

    const incomplete = harness([500, 500, 500]);
    incomplete.sqlite.failRestore = true;
    const result = await incomplete.instance.execute(job(), target(), fakeHooks().hooks);
    expect(result).toEqual(expect.objectContaining({ status: "needs_recovery", rollbackComplete: false }));
    expect(incomplete.launchd.calls.filter((call) => call.startsWith("bootstrap"))).toHaveLength(1);
    expect(incomplete.sentinel.gate?.phase).toBe("needs_recovery");
  });

  test("a stale revision 2xx health response cannot succeed and rolls back to the exact baseline", async () => {
    const h = harness([200, 200, 200, 200]);
    h.health.wrongNewRevision = true;
    const result = await h.instance.execute(job(), target(), fakeHooks().hooks);
    expect(result).toEqual(expect.objectContaining({ status: "failed", rollbackComplete: true }));
    expect(result.log).toContain("2xx but revision/job/fingerprint body mismatch");
    expect(h.fs.links.get("/current")).toBe("/releases/old-release");
    expect(h.sqlite.restored).toBeTrue();
  });

  test("crash after healthy checkpoint revalidates original job/revision/PID without taking a new baseline", async () => {
    const h = harness([200]);
    h.fs.files.set("/plist", `new ${REVISION}`);
    h.fs.links.set("/current", "/releases/depjob_1-g1-a1");
    h.launchd.pid = 20;
    h.launchd.alive = new Set([20]);
    const healthyGate = gate("healthy", REVISION);
    h.sentinel.gate = gate("deploying", REVISION);
    const recovered = job({ attempt: 2, checkpoint: "healthy", rollbackAttempt: 1, baselineRevision: BASELINE, newServicePid: 20 });
    const result = await h.instance.execute(recovered, target(), fakeHooks(healthyGate).hooks);
    expect(result.status).toBe("succeeded");
    expect(h.process.calls).toHaveLength(0);
    expect(h.fs.links.get("/current")).toBe("/releases/depjob_1-g1-a1");
    expect(h.sentinel.gate?.phase).toBe("healthy");
    expect(result.log).toContain("worker restart");
  });

  test("crash after SQLite restore resumes the original rollback anchor instead of adopting the restored checkpoint", async () => {
    const h = harness([200]);
    h.fs.files.set("/plist", `new ${REVISION}`);
    h.fs.links.set("/current", "/releases/depjob_1-g1-a1");
    h.fs.files.set("/state/depjob_1/attempt-1/old.plist", "old plist {{revision}}");
    h.fs.files.set("/state/depjob_1/attempt-1/old-current", "/releases/old-release");
    h.fs.files.set("/state/depjob_1/attempt-1/baseline-revision", `${BASELINE}\n`);
    h.fs.files.set("/state/depjob_1/attempt-1/database.sqlite", "backup");
    h.launchd.pid = 20;
    h.launchd.alive = new Set([20]);
    const restoredDatabaseGate = gate("deploying", REVISION);
    h.sentinel.gate = gate("rolling_back", BASELINE);
    const result = await h.instance.recoverOriginalBaseline(job({
      status: "recovering", attempt: 2, checkpoint: "backup_created",
      rollbackAttempt: 1, baselineRevision: BASELINE, newServicePid: 20,
    }), target(), fakeHooks(restoredDatabaseGate).hooks);
    expect(result).toEqual(expect.objectContaining({ status: "failed", rollbackComplete: true }));
    expect(h.sqlite.restored).toBeTrue();
    expect(h.fs.files.get("/plist")).toBe("old plist {{revision}}");
    expect(h.fs.links.get("/current")).toBe("/releases/old-release");
  });

  test("crash after DB terminal commit keeps writes gated until sentinel cleanup revalidates exact service", async () => {
    const h = harness([200]);
    h.launchd.pid = 20;
    h.launchd.alive = new Set([20]);
    const terminalGate = gate("healthy", REVISION);
    h.sentinel.gate = terminalGate;
    await h.instance.releaseTerminalMaintenance(job({
      status: "succeeded", checkpoint: "healthy", rollbackAttempt: 1,
      baselineRevision: BASELINE, newServicePid: 20, rollbackComplete: true,
    }), target(), terminalGate);
    expect(h.sentinel.gate).toBeNull();
    expect(h.health.calls).toHaveLength(1);
  });

  test("launchctl parser validates exact label and PID", () => {
    expect(parseLaunchctlPrint("gui/501/com.test = {\n state = running\n pid = 42\n}", "gui/501", "com.test"))
      .toEqual({ loaded: true, label: "com.test", state: "running", pid: 42 });
    expect(() => parseLaunchctlPrint("gui/501/com.other = {\n state = running\n pid = 42\n}", "gui/501", "com.test"))
      .toThrow("label mismatch");
  });

  test("minimal process env and strict readLink never inherit Harbor/GitHub secrets or hide non-ENOENT", async () => {
    expect(minimalProcessEnvironment({ PATH: "/bin", HARBOR_TOKEN: "x", GITHUB_TOKEN: "y", HOME: "/secret" }, { BUILD_MODE: "prod" }))
      .toEqual({ PATH: "/bin", BUILD_MODE: "prod" });
    expect(await readLinkOrMissing(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); })).toBeNull();
    expect(readLinkOrMissing(async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); })).rejects.toThrow("denied");
    expect(readLinkOrMissing(async () => { throw Object.assign(new Error("regular"), { code: "EINVAL" }); })).rejects.toThrow("regular");
  });

  test("runtime path metadata rejects wrong owner, symlink, non-regular file, and unsafe private mode", () => {
    const metadata = (input: { uid?: number; symlink?: boolean; directory?: boolean; file?: boolean; mode?: number } = {}) => ({
      uid: input.uid ?? 501,
      mode: input.mode ?? 0o40700,
      isSymbolicLink: () => input.symlink ?? false,
      isDirectory: () => input.directory ?? true,
      isFile: () => input.file ?? false,
    });
    expect(() => assertRuntimePathMetadata("state", metadata(), "directory", 501, 0o700)).not.toThrow();
    expect(() => assertRuntimePathMetadata("state", metadata({ uid: 502 }), "directory", 501, 0o700)).toThrow("owner");
    expect(() => assertRuntimePathMetadata("state", metadata({ symlink: true }), "directory", 501, 0o700)).toThrow("non-symlink");
    expect(() => assertRuntimePathMetadata("state", metadata({ mode: 0o40755 }), "directory", 501, 0o700)).toThrow("0700");
    expect(() => assertRuntimePathMetadata("plist", metadata({ directory: false, file: false, mode: 0o100600 }), "file", 501, null)).toThrow("regular file");
  });

  test("worker LaunchAgent contains no token/target secrets and uses private definition", () => {
    const plist = renderDeploymentWorkerLaunchAgent({
      home: "/Users/a&b", bunPath: "/opt/bun/bin/bun", workerEntry: "/repo/worker.ts",
      pathEnv: "/bin:/opt/bun/bin", databasePath: "/db", stdoutPath: "/tmp/out", stderrPath: "/tmp/err",
    });
    expect(plist).toContain("com.smokingmouse.harbor.deploy-worker");
    expect(plist).toContain("KeepAlive");
    expect(plist).not.toContain("HARBOR_TOKEN");
    expect(plist).not.toContain(SECRET);
  });
});
