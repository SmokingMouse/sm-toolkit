import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeploymentServiceConfig, DeploymentTargetConfig } from "../config.js";
import {
  LAUNCHD_BOOTSTRAP_RETRY_ATTEMPTS,
  LAUNCHD_BOOTSTRAP_RETRY_INTERVAL_MS,
} from "../daemon/service.js";
import type { DeploymentJob, DeploymentMaintenanceGate } from "../protocol.js";
import {
  LocalLaunchdDeploymentExecutor,
  releaseManifestHash,
  type DeploymentClock,
  type DeploymentExecutionHooks,
  type DeploymentFileSystem,
  type DeploymentProcess,
  type DeploymentProcessOptions,
  type DeploymentReleaseManifest,
  type HealthClient,
  type LaunchdControl,
  type LaunchdServiceState,
  type SqliteBackupControl,
} from "./executor.js";
import type { DeploymentMaintenanceSentinel } from "./maintenance.js";
import { assertNoCredentialMaterial, assertSafeArgv, redactStructured } from "./redaction.js";
import { exactPlistRootLabel } from "./plist.js";
import {
  finishDrainBeforeDeadline,
  assertRuntimePathMetadata,
  HostFileSystem,
  HostLaunchd,
  HostProcess,
  minimalProcessEnvironment,
  parseLaunchctlPrint,
  readLinkOrMissing,
  terminateProcessGroup,
} from "./runtime.js";

const REVISION = "a".repeat(40);
const BASELINE = "b".repeat(40);
const FINGERPRINT = "c".repeat(64);
const BASELINE_FINGERPRINT = "d".repeat(64);
const SECRET = "TOPSECRET";
const REMOTE_URL = "https://example.test/harbor.git";

const serverTemplate = `<?xml version="1.0"?><plist><dict><key>Label</key><string>com.test.server</string><key>Args</key><string>{{release_path}} {{revision}} {{target_fingerprint}}</string></dict></plist>`;
const daemonTemplate = `<?xml version="1.0"?><plist><dict><key>Label</key><string>com.test.daemon</string><key>Args</key><string>{{release_path}} {{revision}} {{target_fingerprint}}</string></dict></plist>`;
const oldServerPlist = serverTemplate.replace("{{release_path}}", "/releases/old").replace("{{revision}}", BASELINE).replace("{{target_fingerprint}}", BASELINE_FINGERPRINT);
const oldDaemonPlist = daemonTemplate.replace("{{release_path}}", "/releases/old").replace("{{revision}}", BASELINE).replace("{{target_fingerprint}}", BASELINE_FINGERPRINT);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const services: DeploymentServiceConfig[] = [
  { id: "server", role: "server", label: "com.test.server", domain: "gui/1", plistPath: "/server.plist", templatePath: "/server.tpl", templateSha256: sha(serverTemplate) },
  { id: "daemon", role: "daemon", label: "com.test.daemon", domain: "gui/1", plistPath: "/daemon.plist", templatePath: "/daemon.tpl", templateSha256: sha(daemonTemplate) },
];

function healthContract(timeoutMs = 2) {
  return {
    url: "http://127.0.0.1/health", timeoutMs, intervalMs: 1,
    headerRefs: { Authorization: { env: "HEALTH_TOKEN" } },
  };
}

function releaseManifest(
  revision = BASELINE,
  fingerprint = BASELINE_FINGERPRINT,
  manifestServices = services,
  timeoutMs = 10,
): DeploymentReleaseManifest {
  const health = healthContract(timeoutMs);
  const base = {
    version: 1 as const,
    targetId: "local",
    repositoryId: "repo_1",
    revision,
    targetFingerprint: fingerprint,
    targetManifestHash: "",
    healthFingerprint: sha(JSON.stringify(health)),
    source: { remote: "origin", remoteUrl: REMOTE_URL, allowedRefs: ["refs/heads/main"] },
    paths: { repositoryPath: "/repo", releasesPath: "/releases", currentSymlinkPath: "/current", sqlitePath: "/db", statePath: "/state" },
    health,
    services: manifestServices,
  };
  return { ...base, targetManifestHash: releaseManifestHash(base) };
}

function target(): DeploymentTargetConfig {
  const base: DeploymentTargetConfig = {
    id: "local", name: "Local", provider: "local-launchd", repositoryId: "repo_1",
    repositoryPath: "/repo", releasesPath: "/releases", currentSymlinkPath: "/current",
    sqlitePath: "/db", statePath: "/state",
    source: { remote: "origin", remoteUrl: REMOTE_URL, allowedRefs: ["refs/heads/main"] },
    environment: { BUILD_MODE: "production" }, steps: { install: [], build: [["build", "--production"]], test: [] },
    services,
    health: { ...healthContract(), headers: { Authorization: `Bearer ${SECRET}` } },
    commandTimeoutMs: 100, fingerprint: FINGERPRINT, manifestHash: "",
  };
  return { ...base, manifestHash: releaseManifestHash(releaseManifest(REVISION, FINGERPRINT, services, 2)) };
}

function job(overrides: Partial<DeploymentJob> = {}): DeploymentJob {
  const configured = target();
  return {
    id: "depjob_1", deliveryId: "del_1", generation: 1, targetId: "local", revision: REVISION,
    targetFingerprint: FINGERPRINT, targetManifestHash: configured.manifestHash,
    status: "running", attempt: 1, fenceEpoch: 1, fenceNonce: "nonce-1", leaseToken: "lease-1", leaseExpiresAt: 100,
    checkpoint: "queued", log: null, error: null, failureKind: null, rollbackComplete: null,
    rollbackAttempt: null, baselineRevision: null, baselineFingerprint: null, baselineManifestHash: null,
    baselineHealthFingerprint: null, databaseBackupCreated: false, newServicePids: {}, createdAt: 0, startedAt: 0, finishedAt: null, updatedAt: 0,
    ...overrides,
  };
}

class FakeFs implements DeploymentFileSystem {
  files = new Map<string, string>([
    ["/server.tpl", serverTemplate], ["/daemon.tpl", daemonTemplate],
    ["/server.plist", oldServerPlist], ["/daemon.plist", oldDaemonPlist],
    ["/releases/old/.harbor-deployment.json", `${JSON.stringify(releaseManifest())}\n`],
  ]);
  links = new Map<string, string>([["/current", "/releases/old"]]);
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
  async readLink(path: string) { if (this.files.has(path)) throw Object.assign(new Error("EINVAL"), { code: "EINVAL" }); return this.links.get(path) ?? null; }
  async symlink(value: string, path: string) { this.links.set(path, value); }
  async remove(path: string) { this.files.delete(path); this.links.delete(path); }
}

class FakeProcess implements DeploymentProcess {
  calls: string[][] = [];
  fetched = false;
  missingUntilFetch = false;
  timedOut = false;
  noisy = false;
  remoteDrift = false;
  unreachable = false;
  async run(argv: string[], options: DeploymentProcessOptions) {
    this.calls.push(argv);
    if (argv.includes("get-url")) {
      const stdout = `${this.remoteDrift ? "https://evil.test/repo" : REMOTE_URL}\n`;
      return {
        ...result(0, stdout),
        stdoutMatched: options.expectedStdout === undefined ? null : stdout.trim() === options.expectedStdout,
      };
    }
    if (argv.includes("fetch")) { this.fetched = true; return result(); }
    if (argv.includes("rev-parse")) {
      if (this.missingUntilFetch && !this.fetched) return result(1, "", "missing");
      return result(0, `${REVISION}\n`);
    }
    if (argv.includes("merge-base")) return result(this.unreachable ? 1 : 0);
    if (this.noisy) return { ...result(0, `Authorization: Bearer ${SECRET} ${"x".repeat(40_000)}`), timedOut: this.timedOut };
    return { ...result(), timedOut: this.timedOut };
  }
}

class FakeLaunchd implements LaunchdControl {
  states = new Map<string, LaunchdServiceState>([
    ["gui/1/com.test.server", { loaded: true, label: "com.test.server", state: "running", pid: 10 }],
    ["gui/1/com.test.daemon", { loaded: true, label: "com.test.daemon", state: "running", pid: 11 }],
  ]);
  alive = new Set([10, 11]);
  calls: string[] = [];
  failBootoutAt: number | null = null;
  keepPidAlive = false;
  wrongLabel = false;
  private bootoutCount = 0;
  private nextPid = 20;
  async inspect(domain: string, label: string) {
    const state = this.states.get(`${domain}/${label}`) ?? { loaded: false, label: null, state: "unloaded", pid: null };
    return this.wrongLabel && state.loaded ? { ...state, label: `${label}.wrong` } : { ...state };
  }
  async bootout(domain: string, label: string) {
    this.bootoutCount++;
    this.calls.push(`bootout ${domain}/${label}`);
    if (this.failBootoutAt === this.bootoutCount) throw new Error("ambiguous bootout failure");
    const key = `${domain}/${label}`;
    const state = this.states.get(key);
    if (state?.pid && !this.keepPidAlive) this.alive.delete(state.pid);
    this.states.set(key, { loaded: false, label: null, state: "unloaded", pid: null });
  }
  async bootstrap(domain: string, plistPath: string) {
    const service = plistPath.includes("daemon") ? services[1]! : services[0]!;
    const pid = this.nextPid++;
    this.calls.push(`bootstrap ${domain} ${plistPath}`);
    this.states.set(`${domain}/${service.label}`, { loaded: true, label: service.label, state: "running", pid });
    this.alive.add(pid);
  }
  async isPidAlive(pid: number) { return this.alive.has(pid); }
}

class FakeSqlite implements SqliteBackupControl {
  backedUp = false;
  restored = false;
  failRestore = false;
  constructor(private readonly fs: FakeFs) {}
  async backup(_database: string, backup: string) { this.backedUp = true; this.fs.files.set(backup, "backup"); this.fs.modes.set(backup, 0o600); }
  async restore() { this.restored = true; if (this.failRestore) throw new Error("restore failed"); }
}

class FakeHealth implements HealthClient {
  calls: string[] = [];
  wrongRevision = false;
  constructor(readonly statuses: Array<number | Error> = [200]) {}
  async get(url: string) {
    this.calls.push(url);
    const status = this.statuses.shift() ?? 500;
    if (status instanceof Error) throw status;
    const query = new URL(url).searchParams;
    return {
      status,
      body: status >= 200 && status < 300 ? {
        ok: true,
        revision: this.wrongRevision && query.get("revision") === REVISION ? "f".repeat(40) : query.get("revision"),
        targetFingerprint: query.get("target_fingerprint"),
        deploymentJobId: query.get("deployment_job_id"), maintenance: true,
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
  readonly path = "/global/maintenance.json";
  gate: DeploymentMaintenanceGate | null = null;
  async read() { return this.gate ? { ...this.gate } : null; }
  async write(gate: DeploymentMaintenanceGate) {
    if (this.gate && this.gate.jobId !== gate.jobId) throw new Error("other gate");
    if (this.gate && this.gate.fenceEpoch > gate.fenceEpoch) throw new Error("stale fence");
    this.gate = { ...gate };
  }
  async clear(expected: DeploymentMaintenanceGate) {
    if (!this.gate) return;
    if (this.gate.fenceEpoch !== expected.fenceEpoch || this.gate.fenceNonce !== expected.fenceNonce) throw new Error("wrong fence");
    this.gate = null;
  }
  async withLock<T>(action: () => Promise<T> | T) { return action(); }
}

function gate(jobValue = job(), phase: DeploymentMaintenanceGate["phase"] = "deploying"): DeploymentMaintenanceGate {
  const baseline = releaseManifest();
  return {
    version: 2, fenceEpoch: jobValue.fenceEpoch!, fenceNonce: jobValue.fenceNonce!,
    targetId: "local", jobId: jobValue.id, deliveryId: jobValue.deliveryId, generation: jobValue.generation,
    revision: REVISION, targetFingerprint: FINGERPRINT, targetManifestHash: target().manifestHash,
    rollbackAttempt: jobValue.rollbackAttempt ?? jobValue.attempt, baselineRevision: BASELINE,
    baselineFingerprint: BASELINE_FINGERPRINT, baselineManifestHash: releaseManifestHash(baseline),
    baselineHealthFingerprint: baseline.healthFingerprint,
    expectedRevision: phase === "rolling_back" ? BASELINE : REVISION,
    expectedFingerprint: phase === "rolling_back" ? BASELINE_FINGERPRINT : FINGERPRINT,
    phase, createdAt: 1, updatedAt: 1,
  };
}

function fakeHooks(initial: DeploymentMaintenanceGate | null = null) {
  let current = initial;
  const checkpoints: string[] = [];
  const boundaries: string[] = [];
  const hooks: DeploymentExecutionHooks = {
    assertFence: async (boundary) => { boundaries.push(boundary); },
    assertRestoreFence: async () => {},
    checkpoint: async (value, metadata) => { checkpoints.push(value); if (metadata?.newServicePids) current = current ? { ...current } : current; },
    getMaintenance: async () => current,
    activateMaintenance: async ({ rollbackAttempt, baselineRevision, baselineFingerprint, baselineManifestHash, baselineHealthFingerprint }) => {
      current = { ...gate(), rollbackAttempt, baselineRevision, baselineFingerprint, baselineManifestHash, baselineHealthFingerprint };
      return current;
    },
    updateMaintenance: async (phase, expectedRevision, expectedFingerprint) => {
      if (!current) throw new Error("missing gate");
      current = { ...current, phase, expectedRevision, expectedFingerprint, updatedAt: current.updatedAt + 1 };
      return current;
    },
    restoreMaintenance: async (original, phase, expectedRevision, expectedFingerprint) => {
      current = { ...original, phase, expectedRevision, expectedFingerprint, updatedAt: original.updatedAt + 1 };
      return current;
    },
  };
  return { hooks, checkpoints, boundaries, current: () => current };
}

function harness(statuses: Array<number | Error> = [200]) {
  const fs = new FakeFs();
  const process = new FakeProcess();
  const launchd = new FakeLaunchd();
  const sqlite = new FakeSqlite(fs);
  const health = new FakeHealth(statuses);
  const clock = new FakeClock();
  const sentinel = new FakeSentinel();
  const instance = new LocalLaunchdDeploymentExecutor({
    fs, process, launchd, sqlite, health, clock, sentinel,
    maintenance: sentinel, validator: { validate: async () => {} },
  } as unknown as ConstructorParameters<typeof LocalLaunchdDeploymentExecutor>[0]);
  return { instance, fs, process, launchd, sqlite, health, clock, sentinel };
}

function result(exitCode = 0, stdout = "ok", stderr = "") {
  return { exitCode, stdout, stderr, timedOut: false };
}

describe("local launchd v3-fenced executor", () => {
  test("fetches exact reachable commit, stops every service, starts server only, and releases daemon after sentinel clear", async () => {
    const h = harness();
    h.process.missingUntilFetch = true;
    h.process.noisy = true;
    const state = fakeHooks();
    const executed = await h.instance.execute(job(), target(), state.hooks);
    expect(executed.status).toBe("succeeded");
    expect(h.process.calls.find((argv) => argv.includes("fetch"))).toBeDefined();
    expect(h.process.calls.findIndex((argv) => argv.includes("fetch"))).toBeLessThan(h.process.calls.findIndex((argv) => argv.includes("rev-parse")));
    expect(h.launchd.calls.slice(0, 2)).toEqual([
      "bootout gui/1/com.test.server", "bootout gui/1/com.test.daemon",
    ]);
    expect(h.launchd.calls.filter((call) => call.startsWith("bootstrap"))).toEqual(["bootstrap gui/1 /server.plist"]);
    expect(executed.log).not.toContain(SECRET);
    expect(executed.log).not.toContain("--production");
    expect(executed.log).toContain("argc=");
    expect(executed.log.length).toBeLessThanOrEqual(32_000);
    expect(state.boundaries).toContain("before-db-backup");
    expect(state.boundaries).toContain("health-finalize");
    expect(state.boundaries).toContain("before-sentinel-write-activate");
    expect(state.boundaries).toContain("after-sentinel-write-healthy");

    h.health.statuses.push(200);
    await h.instance.releaseHostMaintenance(target(), executed.gate!, { assertFence: async () => {} });
    expect(h.sentinel.gate).toBeNull();
    expect(h.launchd.calls.at(-1)).toBe("bootstrap gui/1 /daemon.plist");
    h.health.statuses.push(200);
    await h.instance.releaseHostMaintenance(target(), executed.gate!, { assertFence: async () => {} });
    expect(h.launchd.calls.filter((call) => call === "bootstrap gui/1 /daemon.plist")).toHaveLength(1);
  }, 15_000);

  test("retries a transient loopback transport failure inside the bounded exact-health window", async () => {
    const h = harness([new Error("connection refused"), 200]);
    const executed = await h.instance.execute(job(), target(), fakeHooks().hooks);
    expect(executed.status).toBe("succeeded");
    expect(h.health.calls).toHaveLength(2);
    expect(executed.log).toContain("health transport unavailable; retrying exact probe");
  });

  test("any ambiguous bootout failure leaves DB/plists/symlink untouched and needs recovery", async () => {
    const h = harness();
    h.launchd.failBootoutAt = 1;
    const executed = await h.instance.execute(job(), target(), fakeHooks().hooks);
    expect(executed).toEqual(expect.objectContaining({ status: "needs_recovery", rollbackComplete: false, failureKind: "rollback_incomplete" }));
    expect(h.sqlite.backedUp).toBeFalse();
    expect(h.fs.files.get("/server.plist")).toBe(oldServerPlist);
    expect(h.fs.links.get("/current")).toBe("/releases/old");
  });

  test("unloaded state with a live old PID is ambiguous and cannot cross backup/mutation boundary", async () => {
    const h = harness();
    h.launchd.keepPidAlive = true;
    const executed = await h.instance.execute(job(), target(), fakeHooks().hooks);
    expect(executed.status).toBe("needs_recovery");
    expect(executed.error).toContain("无法证明");
    expect(h.sqlite.backedUp).toBeFalse();
    expect(h.fs.links.get("/current")).toBe("/releases/old");
  });

  test("wrong launchctl label and template Label drift fail closed before host replacement", async () => {
    const wrongLaunchctl = harness();
    wrongLaunchctl.launchd.wrongLabel = true;
    expect((await wrongLaunchctl.instance.execute(job(), target(), fakeHooks().hooks)).status).toBe("failed");
    expect(wrongLaunchctl.sqlite.backedUp).toBeFalse();

    const wrongTemplate = harness();
    wrongTemplate.fs.files.set("/server.tpl", serverTemplate.replace("com.test.server", "com.wrong"));
    const result = await wrongTemplate.instance.execute(job(), target(), fakeHooks().hooks);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/hash|Label/);
    expect(wrongTemplate.launchd.calls).toHaveLength(0);
  });

  test("health failure stops all new services before restoring DB/plists/symlink and verifies baseline health", async () => {
    const h = harness([500, 500, 500, 200]);
    const executed = await h.instance.execute(job(), target(), fakeHooks().hooks);
    expect(executed).toEqual(expect.objectContaining({ status: "failed", rollbackComplete: true }));
    expect(h.sqlite.restored).toBeTrue();
    expect(h.fs.files.get("/server.plist")).toBe(oldServerPlist);
    expect(h.fs.files.get("/daemon.plist")).toBe(oldDaemonPlist);
    expect(h.fs.links.get("/current")).toBe("/releases/old");
    expect(h.health.calls.at(-1)).toContain(`revision=${BASELINE}`);
    expect(h.health.calls.at(-1)).toContain(`target_fingerprint=${BASELINE_FINGERPRINT}`);
    expect(h.launchd.calls.at(-1)).toBe("bootstrap gui/1 /server.plist");
    h.health.statuses.push(200);
    await h.instance.releaseHostMaintenance(target(), executed.gate!, { assertFence: async () => {} });
    expect(h.launchd.calls.at(-1)).toBe("bootstrap gui/1 /daemon.plist");
  });

  test("rollback bootout or DB restore ambiguity remains gated and never replaces the baseline partially", async () => {
    const bootout = harness([500, 500, 500]);
    bootout.launchd.failBootoutAt = 3;
    const bootoutResult = await bootout.instance.execute(job(), target(), fakeHooks().hooks);
    expect(bootoutResult.status).toBe("needs_recovery");
    expect(bootout.sqlite.restored).toBeFalse();

    const restore = harness([500, 500, 500]);
    restore.sqlite.failRestore = true;
    const restoreResult = await restore.instance.execute(job(), target(), fakeHooks().hooks);
    expect(restoreResult).toEqual(expect.objectContaining({ status: "needs_recovery", rollbackComplete: false }));
    expect(restore.sentinel.gate?.phase).toBe("needs_recovery");

    const reclaimed = harness([500, 500, 500]);
    const reclaimedHooks = fakeHooks();
    reclaimedHooks.hooks.assertRestoreFence = async () => {
      throw new Error("newer epoch claimed after stale restore observation");
    };
    const reclaimedResult = await reclaimed.instance.execute(job(), target(), reclaimedHooks.hooks);
    expect(reclaimedResult).toEqual(expect.objectContaining({ status: "needs_recovery", rollbackComplete: false }));
    expect(reclaimed.sqlite.restored).toBeFalse();
  });

  test("2xx for a stale revision rolls back and can never finalize", async () => {
    const h = harness([200, 200, 200, 200]);
    h.health.wrongRevision = true;
    const executed = await h.instance.execute(job(), target(), fakeHooks().hooks);
    expect(executed.status).toBe("failed");
    expect(executed.log).toContain("2xx but revision/job/fingerprint body mismatch");
    expect(h.fs.links.get("/current")).toBe("/releases/old");
  });

  test("crash after healthy checkpoint revalidates exact manifest/server PID without taking new baseline", async () => {
    const h = harness([200]);
    const firstState = fakeHooks();
    const first = await h.instance.execute(job(), target(), firstState.hooks);
    expect(first.status).toBe("succeeded");
    const serverPid = h.launchd.states.get("gui/1/com.test.server")!.pid!;
    h.process.calls = [];
    const reclaimed = job({
      attempt: 2, fenceEpoch: 2, fenceNonce: "nonce-2", leaseToken: "lease-2", checkpoint: "healthy",
      rollbackAttempt: 1, baselineRevision: BASELINE, baselineFingerprint: BASELINE_FINGERPRINT,
      baselineManifestHash: first.gate!.baselineManifestHash, baselineHealthFingerprint: first.gate!.baselineHealthFingerprint,
      newServicePids: { "gui/1/com.test.server": serverPid },
    });
    const rotated = { ...first.gate!, fenceEpoch: 2, fenceNonce: "nonce-2" };
    h.sentinel.gate = { ...rotated };
    h.health.statuses.push(200);
    const resumed = await h.instance.execute(reclaimed, target(), fakeHooks(rotated).hooks);
    expect(resumed.status).toBe("succeeded");
    expect(h.process.calls).toHaveLength(0);
    expect(resumed.log).toContain("worker restart");
  });

  test("recovery before DB backup uses the original anchor without inventing a restore", async () => {
    const h = harness([200]);
    const baseline = releaseManifest();
    const reclaimed = job({
      attempt: 2, fenceEpoch: 2, fenceNonce: "nonce-2", leaseToken: "lease-2", checkpoint: "maintenance",
      rollbackAttempt: 1, baselineRevision: BASELINE, baselineFingerprint: BASELINE_FINGERPRINT,
      baselineManifestHash: releaseManifestHash(baseline), baselineHealthFingerprint: baseline.healthFingerprint,
      databaseBackupCreated: false,
    });
    const recoveryGate = gate(reclaimed, "rolling_back");
    h.sentinel.gate = recoveryGate;
    h.fs.files.set("/state/depjob_1/attempt-1/rollback-anchor.json", JSON.stringify({
      version: 1, current: "/releases/old", baseline, baselineManifestHash: releaseManifestHash(baseline),
      oldPlists: { "gui/1/com.test.server": oldServerPlist, "gui/1/com.test.daemon": oldDaemonPlist },
    }));
    const recovered = await h.instance.recoverOriginalBaseline(reclaimed, target(), fakeHooks(recoveryGate).hooks);
    expect(recovered).toEqual(expect.objectContaining({ status: "failed", rollbackComplete: true }));
    expect(h.sqlite.restored).toBeFalse();
    expect(h.fs.links.get("/current")).toBe("/releases/old");
  });

  test("a baseline-only extra service is stopped and its obsolete plist cannot remain", async () => {
    const h = harness([200]);
    const oldExtra = `<?xml version="1.0"?><plist><dict><key>Label</key><string>com.test.old-daemon</string></dict></plist>`;
    const extraService: DeploymentServiceConfig = {
      id: "old_daemon", role: "daemon", label: "com.test.old-daemon", domain: "gui/1",
      plistPath: "/old-daemon.plist", templatePath: "/old-daemon.tpl", templateSha256: sha(oldExtra),
    };
    const baseline = releaseManifest(BASELINE, BASELINE_FINGERPRINT, [...services, extraService]);
    h.fs.files.set("/releases/old/.harbor-deployment.json", JSON.stringify(baseline));
    h.fs.files.set("/old-daemon.plist", oldExtra);
    h.launchd.states.set("gui/1/com.test.old-daemon", { loaded: true, label: "com.test.old-daemon", state: "running", pid: 12 });
    h.launchd.alive.add(12);
    const executed = await h.instance.execute(job(), target(), fakeHooks().hooks);
    expect(executed.status).toBe("succeeded");
    expect(h.launchd.calls).toContain("bootout gui/1/com.test.old-daemon");
    expect(h.fs.files.has("/old-daemon.plist")).toBeFalse();
    expect(h.launchd.states.get("gui/1/com.test.old-daemon")?.loaded).toBeFalse();
    h.launchd.states.set("gui/1/com.test.old-daemon", {
      loaded: true, label: "com.test.old-daemon", state: "running", pid: 99,
    });
    h.launchd.alive.add(99);
    h.health.statuses.push(200);
    await expect(h.instance.releaseHostMaintenance(target(), executed.gate!, { assertFence: async () => {} }))
      .rejects.toThrow("额外 service");
    expect(h.sentinel.gate).not.toBeNull();
  });

  test("missing trusted current manifest refuses first automatic cutover with bootstrap_required", async () => {
    const h = harness();
    h.fs.files.delete("/releases/old/.harbor-deployment.json");
    const executed = await h.instance.execute(job(), target(), fakeHooks().hooks);
    expect(executed).toEqual(expect.objectContaining({ status: "failed", failureKind: "bootstrap_required" }));
    expect(h.launchd.calls).toHaveLength(0);
    expect(h.sqlite.backedUp).toBeFalse();
  });

  test("remote/config drift or an unreachable commit fails before worktree/cutover", async () => {
    const drift = harness();
    drift.process.remoteDrift = true;
    expect((await drift.instance.execute(job(), target(), fakeHooks().hooks)).error).toContain("remote URL drifted");
    expect(drift.launchd.calls).toHaveLength(0);

    const unreachable = harness();
    unreachable.process.unreachable = true;
    expect((await unreachable.instance.execute(job(), target(), fakeHooks().hooks)).error).toContain("configured remote fetch refs");
    expect(unreachable.process.calls.some((argv) => argv.includes("worktree"))).toBeFalse();
  });
});

test("launchctl parser verifies exact label/PID and readLink only maps ENOENT", async () => {
  expect(parseLaunchctlPrint("gui/1/com.test = {\n state = running\n pid = 42\n}", "gui/1", "com.test"))
    .toEqual({ loaded: true, label: "com.test", state: "running", pid: 42 });
  expect(() => parseLaunchctlPrint("gui/1/com.other = {", "gui/1", "com.test")).toThrow("label mismatch");
  expect(await readLinkOrMissing(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); })).toBeNull();
  await expect(readLinkOrMissing(async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); })).rejects.toThrow("denied");
});

test("launchctl only treats an exact-label missing response as unloaded", async () => {
  const runner = (stderr: string): DeploymentProcess => ({
    run: async () => ({ exitCode: 1, stdout: "", stderr, timedOut: false }),
  });
  expect(await new HostLaunchd(runner('Could not find service "com.test" in domain for user gui: 1')).inspect("gui/1", "com.test"))
    .toEqual({ loaded: false, label: null, state: "unloaded", pid: null });
  await expect(new HostLaunchd(runner("launchd database not found")).inspect("gui/1", "com.test"))
    .rejects.toThrow("ambiguous failure");
  await expect(new HostLaunchd(runner('Could not find service "com.other" in domain for user gui: 1')).inspect("gui/1", "com.test"))
    .rejects.toThrow("ambiguous failure");
});

test("launchctl cutover bootstrap retries only bounded transient EIO", async () => {
  const responses = [
    result(5, "", "Bootstrap failed: 5: Input/output error"),
    result(5, "", "Bootstrap failed: 5: Input/output error"),
    result(),
  ];
  const calls: string[][] = [];
  const pauses: number[] = [];
  const runner: DeploymentProcess = {
    run: async (argv) => { calls.push(argv); return responses.shift()!; },
  };
  await new HostLaunchd(runner, async (ms) => { pauses.push(ms); }).bootstrap("gui/1", "/server.plist");
  expect(calls).toEqual(Array.from({ length: 3 }, () => ["launchctl", "bootstrap", "gui/1", "/server.plist"]));
  expect(pauses).toEqual([50, 50]);

  let ambiguousCalls = 0;
  const ambiguous: DeploymentProcess = {
    run: async () => { ambiguousCalls++; return result(1, "", "Bootstrap failed: 37: Operation already in progress"); },
  };
  await expect(new HostLaunchd(ambiguous, async () => { throw new Error("must not pause"); })
    .bootstrap("gui/1", "/server.plist")).rejects.toThrow("Operation already in progress");
  expect(ambiguousCalls).toBe(1);

  let exhaustionCalls = 0;
  let exhaustionWaitedMs = 0;
  const exhausted: DeploymentProcess = {
    run: async () => {
      exhaustionCalls++;
      return result(5, "Bootstrap failed: 5: Input/output error", "");
    },
  };
  await expect(new HostLaunchd(exhausted, async (ms) => { exhaustionWaitedMs += ms; })
    .bootstrap("gui/1", "/server.plist")).rejects.toThrow("remained EIO after bounded retry");
  expect(exhaustionCalls).toBe(LAUNCHD_BOOTSTRAP_RETRY_ATTEMPTS);
  expect(exhaustionWaitedMs).toBe(
    (LAUNCHD_BOOTSTRAP_RETRY_ATTEMPTS - 1) * LAUNCHD_BOOTSTRAP_RETRY_INTERVAL_MS,
  );
});

test("launchctl PID proof uses exact /bin/kill facts and fails closed on ambiguous errors", async () => {
  const runner = (exitCode: number, stderr = ""): DeploymentProcess => ({
    run: async (argv) => {
      expect(argv.slice(0, 3)).toEqual(["/bin/kill", "-0", "--"]);
      return { exitCode, stdout: "", stderr, timedOut: false };
    },
  });
  expect(await new HostLaunchd(runner(0)).isPidAlive(42)).toBeTrue();
  expect(await new HostLaunchd(runner(1, "kill: 42: No such process")).isPidAlive(42)).toBeFalse();
  expect(await new HostLaunchd(runner(1, "kill: 42: Operation not permitted")).isPidAlive(42)).toBeTrue();
  await expect(new HostLaunchd(runner(2, "kill: invalid host state")).isPidAlive(42))
    .rejects.toThrow("exact PID liveness probe failed");
});

test("minimal process env never inherits Harbor/GitHub/credential variables", () => {
  expect(minimalProcessEnvironment({ PATH: "/bin", LANG: "C", HARBOR_TOKEN: "x", GITHUB_TOKEN: "y", HEALTH_TOKEN: SECRET }, { BUILD_MODE: "production" }))
    .toEqual({ PATH: "/bin", LANG: "C", BUILD_MODE: "production" });
});

test("structured argv/output protection rejects split credentials before process spawn", () => {
  expect(() => assertSafeArgv(["curl", "-H", "Authorization:", "Bearer", "TOPSECRET"])).toThrow("credential-like");
  expect(() => assertSafeArgv(["tool", "--password", "value"])).toThrow("credential-like");
  expect(() => assertSafeArgv(["tool", "arbitrary", SECRET], [SECRET])).toThrow("credential-like");
  expect(() => assertNoCredentialMaterial(`<key>HARBOR_TOKEN</key><string>${SECRET}</string>`, [SECRET])).toThrow("worker 内存");
  expect(() => assertNoCredentialMaterial("<string>--password</string>")).toThrow("credential-like");
  expect(redactStructured("Authorization: Bearer TOPSECRET password=hunter2")).toBe(
    "Authorization: [redacted] password=[redacted]",
  );
});

test("runtime path metadata rejects wrong owner, symlink, non-regular file and unsafe modes", () => {
  const metadata = (kind: "file" | "dir", uid = 501, mode = 0o100600, symlink = false) => ({
    uid, mode, isSymbolicLink: () => symlink, isDirectory: () => kind === "dir", isFile: () => kind === "file",
  });

  expect(() => assertRuntimePathMetadata("state", metadata("dir", 501, 0o40700), "directory", 501, 0o700)).not.toThrow();
  expect(() => assertRuntimePathMetadata("state", metadata("dir", 502, 0o40700), "directory", 501, 0o700)).toThrow("owner");
  expect(() => assertRuntimePathMetadata("plist", metadata("file", 501, 0o100600, true), "file", 501, null)).toThrow("non-symlink");
  expect(() => assertRuntimePathMetadata("plist", metadata("dir", 501, 0o40700), "file", 501, null)).toThrow("regular file");
  expect(() => assertRuntimePathMetadata("state", metadata("dir", 501, 0o40755), "directory", 501, 0o700)).toThrow("0700");
});

test("timeout terminates the whole process group and a grandchild-held pipe cannot hang drain", async () => {
  let resolveExit!: (value: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  const signals: NodeJS.Signals[] = [];
  const code = await terminateProcessGroup({ pid: 42, exited }, (_pid, signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") resolveExit(137);
  }, 1);
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(code).toBe(137);

  await expect(terminateProcessGroup(
    { pid: 43, exited: Promise.resolve(0) }, async () => {}, 1, async () => true,
  )).rejects.toThrow("KILL 后仍无法证明");

  let canceled = false;
  const drained = await finishDrainBeforeDeadline(new Promise<string>(() => {}), async () => { canceled = true; }, 1);
  expect(canceled).toBeTrue();
  expect(drained).toContain("drain deadline");
});

test("bootout-adjacent PID transitions are part of both deploy and rollback stop proofs", async () => {
  for (const prefix of ["deploy", "rollback"] as const) {
    let inspections = 0;
    const launchd: LaunchdControl = {
      inspect: async () => {
        inspections++;
        if (inspections === 1) return { loaded: true, label: services[0]!.label, state: "running", pid: 20 };
        return { loaded: false, label: null, state: "unloaded", pid: null };
      },
      bootout: async () => {},
      bootstrap: async () => {},
      isPidAlive: async (pid) => pid === 20,
    };
    const h = harness();
    const executor = new LocalLaunchdDeploymentExecutor({
      fs: h.fs, process: h.process, launchd, sqlite: h.sqlite, health: h.health, clock: h.clock,
      maintenance: h.sentinel, validator: { validate: async () => {} },
    });
    await expect((executor as unknown as {
      stopAndProve(
        services: DeploymentServiceConfig[], prior: Map<string, number | null>, logger: { record(value: string): void },
        hooks: Pick<DeploymentExecutionHooks, "assertFence">, prefix: string,
      ): Promise<void>;
    }).stopAndProve(
      [services[0]!], new Map([["gui/1/com.test.server", 10]]), { record: () => {} },
      { assertFence: async () => {} }, prefix,
    )).rejects.toThrow("observed PID 20 仍存活");
  }
});

test("strict plist semantics reject comments, entity duplicates, nested Label and wrong value types", () => {
  const plist = (body: string) => `<?xml version="1.0"?><plist version="1.0"><dict>${body}</dict></plist>`;
  const standard = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>com.test</string></dict></plist>`;
  expect(exactPlistRootLabel(standard)).toBe("com.test");
  expect(() => exactPlistRootLabel(plist("<!-- <key>Label</key><string>com.test</string> -->"))).toThrow("恰好一个");
  expect(() => exactPlistRootLabel(plist(
    "<key>La&#98;el</key><string>com.test</string><key>Label</key><string>com.evil</string>",
  ))).toThrow("恰好一个");
  expect(() => exactPlistRootLabel(plist("<key>ProgramArguments</key><dict><key>Label</key><string>com.evil</string></dict>"))).toThrow("恰好一个");
  expect(() => exactPlistRootLabel(plist("<key>Label</key><integer>7</integer>"))).toThrow("必须是 string");
  expect(exactPlistRootLabel(plist("<key>La&#98;el</key><string>com.test</string>"))).toBe("com.test");
});

test("controlled fetch reachability is proved only against this attempt's temporary remote refs", async () => {
  const h = harness();
  h.process.unreachable = true; // local object/refs may exist, fetched namespace does not contain it.
  const executed = await h.instance.execute(job(), target(), fakeHooks().hooks);
  expect(executed.status).toBe("failed");
  const refChecks = h.process.calls.filter((argv) => argv.includes("merge-base"));
  expect(refChecks.length).toBeGreaterThan(0);
  expect(refChecks.every((argv) => argv.at(-1)?.startsWith("refs/harbor-deploy/"))).toBeTrue();
  expect(refChecks.some((argv) => argv.at(-1) === "refs/heads/main")).toBeFalse();
  expect(h.process.calls.some((argv) => argv.includes("worktree"))).toBeFalse();
});

test("runtime path trust rejects owned 0777 components and a component replacement", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harbor-path-trust-")));
  try {
    const unsafe = join(root, "unsafe");
    const unsafeFile = join(unsafe, "config.plist");
    mkdirSync(unsafe, { mode: 0o700 });
    writeFileSync(unsafeFile, "x", { mode: 0o600 });
    chmodSync(unsafe, 0o777);
    chmodSync(unsafeFile, 0o600);
    await expect(new HostFileSystem().readText(unsafeFile)).rejects.toThrow("group/world writable");

    const stable = join(root, "stable");
    const moved = join(root, "stable-old");
    mkdirSync(stable, { mode: 0o700 });
    writeFileSync(join(stable, "template.plist"), "safe", { mode: 0o600 });
    chmodSync(stable, 0o700);
    chmodSync(join(stable, "template.plist"), 0o600);
    expect(await new HostFileSystem().readText(join(stable, "template.plist"))).toBe("safe");
    renameSync(stable, moved);
    symlinkSync(moved, stable);
    await expect(new HostFileSystem().readText(join(stable, "template.plist"))).rejects.toThrow(/symlink|canonical/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS Bun process groups are cleaned on successful parent exit and split secrets redact before truncation", async () => {
  if (process.platform !== "darwin") return;
  const runner = new HostProcess(process.env, undefined, 300, 500);
  const processRoot = realpathSync(mkdtempSync(join(tmpdir(), "harbor-process-group-")));
  const terminatedMarker = join(processRoot, "terminated");
  const supervisorMarker = join(processRoot, "supervisor-terminated");
  let descendantPid = 0;
  let supervisorPid = 0;
  try {
    const descendant = await runner.run(["/usr/bin/python3", "-c", `
import os
import signal
r, w = os.pipe()
supervisor = os.fork()
if supervisor == 0:
    os.close(r)
    worker = os.fork()
    if worker == 0:
        os.close(w)
        def worker_stopped(_signal, _frame):
            with open(${JSON.stringify(terminatedMarker)}, "w") as marker:
                marker.write("TERM")
            os._exit(0)
        signal.signal(signal.SIGTERM, worker_stopped)
        while True:
            signal.pause()
    def supervisor_stopped(_signal, _frame):
        os.waitpid(worker, 0)
        with open(${JSON.stringify(supervisorMarker)}, "w") as marker:
            marker.write("TERM")
        os._exit(0)
    signal.signal(signal.SIGTERM, supervisor_stopped)
    os.write(w, (str(worker) + "\\n").encode())
    os.close(w)
    while True:
        signal.pause()
os.close(w)
worker = int(os.read(r, 64).decode().strip())
os.close(r)
print(supervisor, worker, os.getpgid(supervisor), flush=True)
os._exit(0)
    `], {
      env: {}, timeoutMs: 2_000, maxCaptureBytes: 1024, onOutput: () => {},
    });
    const [supervisorText, pidText, pgidText] = descendant.stdout.trim().split(/\s+/);
    supervisorPid = Number(supervisorText);
    descendantPid = Number(pidText);
    expect(descendant.exitCode).toBe(0);
    expect(supervisorPid).toBeGreaterThan(1);
    expect(descendantPid).toBeGreaterThan(1);
    expect(Number(pgidText)).not.toBe(descendantPid); // descendant inherited the direct parent's PGID.
    expect(existsSync(terminatedMarker)).toBeTrue();
    expect(readFileSync(terminatedMarker, "utf8")).toBe("TERM");
    // The supervisor reaps its worker before recording its own termination.
    // Some CI pid-1 shims retain the terminated supervisor as a zombie, so
    // marker + reaped child are the bounded proof that no descendant executes.
    expect(readFileSync(supervisorMarker, "utf8")).toBe("TERM");

    const secret = await runner.run([process.execPath, "-e", `
      process.stdout.write("x".repeat(8188) + "TOP");
      setTimeout(() => process.stdout.write("SECRET"), 5);
    `], { env: {}, timeoutMs: 2_000, maxCaptureBytes: 8_192, redactValues: [SECRET], onOutput: () => {} });
    expect(secret.stdout).not.toContain("TOPSECRET");
    expect(secret.stdout).not.toContain("TOP");
    expect(secret.stdout).toContain("truncated");
  } finally {
    if (descendantPid > 1 && pidAlive(descendantPid)) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
    }
    if (supervisorPid > 1 && !existsSync(supervisorMarker) && pidAlive(supervisorPid)) {
      try { process.kill(supervisorPid, "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(processRoot, { recursive: true, force: true });
  }
}, 10_000);

test("HostProcess verifies sensitive stdout internally while returning only redacted output", async () => {
  const runner = new HostProcess(process.env);
  const sensitive = "/private/harbor/repository.git";
  const matched = await runner.run(["/bin/echo", sensitive], {
    env: {},
    timeoutMs: 2_000,
    maxCaptureBytes: 1_024,
    redactValues: [sensitive],
    expectedStdout: sensitive,
    onOutput: () => {},
  });
  expect(matched.stdout).toContain("[redacted]");
  expect(matched.stdout).not.toContain(sensitive);
  expect(matched.stdoutMatched).toBeTrue();

  const mismatched = await runner.run(["/bin/echo", `${sensitive}-drifted`], {
    env: {},
    timeoutMs: 2_000,
    maxCaptureBytes: 1_024,
    redactValues: [sensitive],
    expectedStdout: sensitive,
    onOutput: () => {},
  });
  expect(mismatched.stdout).not.toContain(sensitive);
  expect(mismatched.stdoutMatched).toBeFalse();
});

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
