import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { DeploymentTargetConfig } from "../config.js";
import { openDb } from "../server/db.js";
import { HarborStore } from "../server/store.js";
import type { DeploymentJobStore } from "./worker.js";
import type {
  DeploymentClock,
  DeploymentFileSystem,
  DeploymentProcess,
  DeploymentProcessOptions,
  HealthClient,
  LaunchdControl,
  LaunchdServiceState,
  SqliteBackupControl,
  DeploymentTargetValidator,
} from "./executor.js";

export class EphemeralDeploymentJobStore implements DeploymentJobStore {
  constructor(private readonly databasePath: string) {}

  claimDeploymentJob(targets: { id: string; fingerprint: string }[], now: number, leaseMs: number) {
    return this.use((store) => store.claimDeploymentJob(targets, now, leaseMs));
  }
  claimDeploymentRecovery(id: string, targetId: string, targetFingerprint: string, now: number, leaseMs: number) {
    return this.use((store) => store.claimDeploymentRecovery(id, targetId, targetFingerprint, now, leaseMs));
  }
  getDeploymentJob(id: string) { return this.use((store) => store.getDeploymentJob(id)); }
  getDeploymentMaintenance(targetId?: string) { return this.use((store) => store.getDeploymentMaintenance(targetId)); }
  renewDeploymentJob(id: string, leaseToken: string, now: number, leaseMs: number) {
    return this.use((store) => store.renewDeploymentJob(id, leaseToken, now, leaseMs));
  }
  updateDeploymentCheckpoint(id: string, leaseToken: string, checkpoint: string, now: number, metadata?: { newServicePid?: number | null }) {
    return this.use((store) => store.updateDeploymentCheckpoint(id, leaseToken, checkpoint, now, metadata));
  }
  activateDeploymentMaintenance(id: string, leaseToken: string, input: { rollbackAttempt: number; baselineRevision: string }, now: number) {
    return this.use((store) => store.activateDeploymentMaintenance(id, leaseToken, input, now));
  }
  updateDeploymentMaintenance(
    id: string,
    leaseToken: string,
    phase: Parameters<HarborStore["updateDeploymentMaintenance"]>[2],
    expectedRevision: string,
    now: number,
    metadata?: Parameters<HarborStore["updateDeploymentMaintenance"]>[5],
  ) {
    return this.use((store) => store.updateDeploymentMaintenance(id, leaseToken, phase, expectedRevision, now, metadata));
  }
  restoreDeploymentMaintenance(
    gate: Parameters<HarborStore["restoreDeploymentMaintenance"]>[0],
    phase: Parameters<HarborStore["restoreDeploymentMaintenance"]>[1],
    expectedRevision: string,
    now: number,
  ) {
    return this.use((store) => store.restoreDeploymentMaintenance(gate, phase, expectedRevision, now));
  }
  completeDeploymentJob(id: string, leaseToken: string, result: Parameters<HarborStore["completeDeploymentJob"]>[2], now: number) {
    return this.use((store) => store.completeDeploymentJob(id, leaseToken, result, now));
  }
  completeRecoveredDeploymentJob(
    gate: Parameters<HarborStore["completeRecoveredDeploymentJob"]>[0],
    result: Parameters<HarborStore["completeRecoveredDeploymentJob"]>[1],
    now: number,
  ) {
    return this.use((store) => store.completeRecoveredDeploymentJob(gate, result, now));
  }

  private use<T>(action: (store: HarborStore) => T): T {
    const db = openDb(this.databasePath);
    try {
      return action(new HarborStore(db));
    } finally {
      db.close();
    }
  }
}

export class HostFileSystem implements DeploymentFileSystem {
  async mkdir(path: string, mode: number) {
    await mkdir(path, { recursive: true, mode });
    await chmod(path, mode);
  }
  async readText(path: string) {
    await validateRegularFile(path, process.getuid?.());
    return readFile(path, "utf8");
  }
  async writeText(path: string, content: string, mode: number) {
    await validateOwnedParent(path, process.getuid?.());
    try { await validateRegularFile(path, process.getuid?.()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode);
    try {
      await handle.writeFile(content);
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
  }
  async rename(from: string, to: string) { await rename(from, to); }
  async exists(path: string) {
    try { await lstat(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async readLink(path: string) {
    return readLinkOrMissing(() => readlink(path));
  }
  async symlink(target: string, path: string) { await symlink(target, path); }
  async remove(path: string) {
    try { await unlink(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export class HostProcess implements DeploymentProcess {
  private readonly baseEnvironment: Record<string, string>;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.baseEnvironment = minimalProcessEnvironment(environment, {});
  }

  async run(argv: string[], options: DeploymentProcessOptions) {
    const child = Bun.spawn(argv, {
      cwd: options.cwd,
      env: minimalProcessEnvironment(this.baseEnvironment, options.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, options.timeoutMs);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      drain(child.stdout, "stdout", options),
      drain(child.stderr, "stderr", options),
    ]);
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    return { exitCode, stdout, stderr, timedOut };
  }
}

export class HostLaunchd implements LaunchdControl {
  constructor(private readonly processRunner: DeploymentProcess) {}

  async inspect(domain: string, label: string): Promise<LaunchdServiceState> {
    const result = await raw(this.processRunner, ["launchctl", "print", `${domain}/${label}`]);
    if (result.exitCode !== 0) {
      if (/could not find service|service not found|not found/i.test(`${result.stdout}\n${result.stderr}`)) {
        return { loaded: false, label: null, state: "unloaded", pid: null };
      }
      throw new Error(`launchctl print ambiguous failure: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
    }
    return parseLaunchctlPrint(`${result.stdout}\n${result.stderr}`, domain, label);
  }

  async bootout(domain: string, label: string) {
    await required(this.processRunner, ["launchctl", "bootout", `${domain}/${label}`]);
  }
  async bootstrap(domain: string, plistPath: string) {
    await required(this.processRunner, ["launchctl", "bootstrap", domain, plistPath]);
  }
  async isPidAlive(pid: number) {
    try { process.kill(pid, 0); return true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      if (code === "EPERM") return true;
      throw error;
    }
  }
}

export class HostSqliteBackup implements SqliteBackupControl {
  async backup(databasePath: string, backupPath: string): Promise<void> {
    await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
    try { await unlink(backupPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const db = new Database(databasePath);
    try {
      db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
    await chmod(backupPath, 0o600);
  }

  async restore(backupPath: string, databasePath: string): Promise<void> {
    await validateRegularFile(backupPath, process.getuid?.());
    await validateRegularFile(databasePath, process.getuid?.());
    const temp = `${databasePath}.restore-${process.pid}`;
    try { await unlink(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await copyFile(backupPath, temp, constants.COPYFILE_EXCL);
    await chmod(temp, 0o600);
    for (const suffix of ["-wal", "-shm"]) {
      try { await unlink(`${databasePath}${suffix}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await rename(temp, databasePath);
    await chmod(databasePath, 0o600);
  }
}

export class FetchHealthClient implements HealthClient {
  async get(url: string, headers: Record<string, string>, timeoutMs: number) {
    const response = await fetch(url, { redirect: "error", headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await boundedResponseText(response, 16_384);
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* exact health validator rejects non-JSON */ }
    return { status: response.status, body };
  }
}

export class HostDeploymentTargetValidator implements DeploymentTargetValidator {
  async validate(target: DeploymentTargetConfig): Promise<void> {
    const uid = process.getuid?.();
    if (uid !== undefined && target.launchd.domain !== `gui/${uid}`) throw new Error("launchd domain 必须等于当前 worker gui/<uid>");
    await validateDirectory(target.repositoryPath, uid, null);
    await ensurePrivateTargetDirectory(target.releasesPath, uid);
    await ensurePrivateTargetDirectory(target.statePath, uid);
    await validateRegularFile(target.sqlitePath, uid);
    await validateRegularFile(target.launchd.plistPath, uid);
    await validateRegularFile(target.launchd.templatePath, uid);
    await validateOwnedParent(target.currentSymlinkPath, uid);
    const linkMetadata = await lstat(target.currentSymlinkPath);
    if (!linkMetadata.isSymbolicLink() || (uid !== undefined && linkMetadata.uid !== uid)) {
      throw new Error("current release 必须是当前 uid 拥有的 symlink");
    }
    const rawTarget = await readlink(target.currentSymlinkPath);
    const resolvedTarget = resolve(dirname(target.currentSymlinkPath), rawTarget);
    const canonicalTarget = await realpath(resolvedTarget);
    if (canonicalTarget !== resolvedTarget) throw new Error("current release target 必须是 canonical non-symlink directory");
    const insideReleases = relative(target.releasesPath, canonicalTarget);
    if (!insideReleases || insideReleases.startsWith("..") || isAbsolute(insideReleases)) {
      throw new Error("current release target 必须是 releases_path 的直接/间接子目录");
    }
    await validateDirectory(canonicalTarget, uid, null);
  }
}

export const hostClock: DeploymentClock = {
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
};

export function targetRegistrations(targets: DeploymentTargetConfig[]) {
  return targets.map(({ id, name, provider, repositoryId, fingerprint }) => ({ id, name, provider, repositoryId, fingerprint }));
}

export function parseLaunchctlPrint(output: string, domain: string, expectedLabel: string): LaunchdServiceState {
  const first = output.split("\n").find((line) => line.trim())?.trim() ?? "";
  const expectedPrefix = `${domain}/${expectedLabel} = {`;
  if (first !== expectedPrefix) throw new Error(`launchctl print label mismatch: expected "${expectedPrefix}", got "${first}"`);
  const state = output.match(/\bstate = ([^\n]+)/)?.[1]?.trim() ?? "unknown";
  const pidText = output.match(/\bpid = (\d+)/)?.[1];
  const pid = pidText ? Number(pidText) : null;
  if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 0)) throw new Error("launchctl print PID 无效");
  return { loaded: true, label: expectedLabel, state, pid };
}

export function minimalProcessEnvironment(
  inherited: NodeJS.ProcessEnv | Record<string, string>,
  explicit: Record<string, string>,
): Record<string, string> {
  const safe = Object.fromEntries(
    ["PATH", "TMPDIR", "LANG", "LC_ALL"]
      .flatMap((key) => inherited[key] === undefined ? [] : [[key, inherited[key]!]]),
  );
  return { ...safe, ...explicit };
}

export async function readLinkOrMissing(read: () => Promise<string>): Promise<string | null> {
  try { return await read(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function required(processRunner: DeploymentProcess, argv: string[]): Promise<void> {
  const result = await raw(processRunner, argv);
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`${argv[0]} ${argv[1]} failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
}

async function raw(processRunner: DeploymentProcess, argv: string[]) {
  return processRunner.run(argv, {
    env: {},
    timeoutMs: 30_000,
    maxCaptureBytes: 16_384,
    onOutput: () => {},
  });
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  name: "stdout" | "stderr",
  options: DeploymentProcessOptions,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let captured = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    options.onOutput(name, chunk);
    if (captured.length < options.maxCaptureBytes) captured += chunk.slice(0, options.maxCaptureBytes - captured.length);
  }
  const tail = decoder.decode();
  if (tail) {
    options.onOutput(name, tail);
    if (captured.length < options.maxCaptureBytes) captured += tail.slice(0, options.maxCaptureBytes - captured.length);
  }
  return captured;
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let value = "";
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    value += decoder.decode(next.value, { stream: true });
    if (value.length > maxBytes) {
      await reader.cancel();
      throw new Error("health response exceeds bounded capture limit");
    }
  }
  return value + decoder.decode();
}

async function ensurePrivateTargetDirectory(path: string, uid: number | undefined): Promise<void> {
  await validateOwnedParent(path, uid);
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await validateDirectory(path, uid, 0o700);
}

async function validateOwnedParent(path: string, uid: number | undefined): Promise<void> {
  await validateDirectory(dirname(path), uid, null);
}

async function validateDirectory(path: string, uid: number | undefined, exactMode: number | null): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${path} 不是 lexical canonical absolute path`);
  const metadata = await lstat(path);
  assertRuntimePathMetadata(path, metadata, "directory", uid, exactMode);
  if (await realpath(path) !== path) throw new Error(`${path} 含 symlink/non-canonical component`);
}

async function validateRegularFile(path: string, uid: number | undefined): Promise<void> {
  await validateOwnedParent(path, uid);
  const metadata = await lstat(path);
  assertRuntimePathMetadata(path, metadata, "file", uid, null);
  if (await realpath(path) !== path) throw new Error(`${path} 含 symlink/non-canonical component`);
  if ((metadata.mode & 0o022) !== 0) throw new Error(`${path} 不能 group/world writable`);
}

export function assertRuntimePathMetadata(
  label: string,
  metadata: {
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
    isFile(): boolean;
    uid: number;
    mode: number;
  },
  kind: "directory" | "file",
  expectedUid: number | undefined,
  exactMode: number | null,
): void {
  if (metadata.isSymbolicLink() || (kind === "directory" ? !metadata.isDirectory() : !metadata.isFile())) {
    throw new Error(`${label} 必须是 non-symlink ${kind === "directory" ? "directory" : "regular file"}`);
  }
  if (expectedUid !== undefined && metadata.uid !== expectedUid) throw new Error(`${label} owner 不是当前 uid`);
  if (exactMode !== null && (metadata.mode & 0o777) !== exactMode) throw new Error(`${label} 权限必须为 0${exactMode.toString(8)}`);
}
