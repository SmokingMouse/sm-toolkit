import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
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
import { exactLaunchdTemplateLabel, type DeploymentTargetConfig } from "../config.js";
import { openDeploymentDb } from "../server/db.js";
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

  claimDeploymentJob(targets: { id: string; fingerprint: string; manifestHash: string }[], now: number, leaseMs: number) {
    return this.use((store) => store.claimDeploymentJob(targets, now, leaseMs));
  }
  failDeploymentConfigDrift(targets: { id: string; fingerprint: string; manifestHash: string }[], now: number) {
    return this.use((store) => store.failDeploymentConfigDrift(targets, now));
  }
  claimDeploymentRecovery(id: string, targetId: string, targetFingerprint: string, targetManifestHash: string, now: number, leaseMs: number) {
    return this.use((store) => store.claimDeploymentRecovery(id, targetId, targetFingerprint, targetManifestHash, now, leaseMs));
  }
  getDeploymentJob(id: string) { return this.use((store) => store.getDeploymentJob(id)); }
  getDeploymentMaintenance(targetId?: string) { return this.use((store) => store.getDeploymentMaintenance(targetId)); }
  assertDeploymentReleaseFence(gate: Parameters<HarborStore["assertDeploymentReleaseFence"]>[0]) {
    return this.use((store) => store.assertDeploymentReleaseFence(gate));
  }
  renewDeploymentJob(id: string, fence: Parameters<HarborStore["renewDeploymentJob"]>[1], now: number, leaseMs: number) {
    return this.use((store) => store.renewDeploymentJob(id, fence, now, leaseMs));
  }
  updateDeploymentCheckpoint(id: string, fence: Parameters<HarborStore["updateDeploymentCheckpoint"]>[1], checkpoint: string, now: number, metadata?: Parameters<HarborStore["updateDeploymentCheckpoint"]>[4]) {
    return this.use((store) => store.updateDeploymentCheckpoint(id, fence, checkpoint, now, metadata));
  }
  activateDeploymentMaintenance(id: string, fence: Parameters<HarborStore["activateDeploymentMaintenance"]>[1], input: Parameters<HarborStore["activateDeploymentMaintenance"]>[2], now: number) {
    return this.use((store) => store.activateDeploymentMaintenance(id, fence, input, now));
  }
  updateDeploymentMaintenance(
    id: string,
    fence: Parameters<HarborStore["updateDeploymentMaintenance"]>[1],
    phase: Parameters<HarborStore["updateDeploymentMaintenance"]>[2],
    expectedRevision: string,
    expectedFingerprint: string,
    now: number,
    metadata?: Parameters<HarborStore["updateDeploymentMaintenance"]>[6],
  ) {
    return this.use((store) => store.updateDeploymentMaintenance(id, fence, phase, expectedRevision, expectedFingerprint, now, metadata));
  }
  restoreDeploymentMaintenance(
    gate: Parameters<HarborStore["restoreDeploymentMaintenance"]>[0],
    fence: Parameters<HarborStore["restoreDeploymentMaintenance"]>[1],
    phase: Parameters<HarborStore["restoreDeploymentMaintenance"]>[2],
    expectedRevision: string,
    expectedFingerprint: string,
    now: number,
  ) {
    return this.use((store) => store.restoreDeploymentMaintenance(gate, fence, phase, expectedRevision, expectedFingerprint, now));
  }
  completeDeploymentJob(id: string, fence: Parameters<HarborStore["completeDeploymentJob"]>[1], result: Parameters<HarborStore["completeDeploymentJob"]>[2], now: number) {
    return this.use((store) => store.completeDeploymentJob(id, fence, result, now));
  }
  completeRecoveredDeploymentJob(
    gate: Parameters<HarborStore["completeRecoveredDeploymentJob"]>[0],
    fence: Parameters<HarborStore["completeRecoveredDeploymentJob"]>[1],
    result: Parameters<HarborStore["completeRecoveredDeploymentJob"]>[2],
    now: number,
  ) {
    return this.use((store) => store.completeRecoveredDeploymentJob(gate, fence, result, now));
  }
  releaseDeploymentMaintenance(gate: Parameters<HarborStore["releaseDeploymentMaintenance"]>[0], now: number) {
    return this.use((store) => store.releaseDeploymentMaintenance(gate, now));
  }
  failDeploymentRelease(gate: Parameters<HarborStore["failDeploymentRelease"]>[0], error: string, now: number) {
    return this.use((store) => store.failDeploymentRelease(gate, error, now));
  }

  private use<T>(action: (store: HarborStore) => T): T {
    const db = openDeploymentDb(this.databasePath);
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

  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    private readonly killGroup: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => process.kill(-pid, signal),
    private readonly graceMs = 2_000,
    private readonly drainDeadlineMs = 2_000,
  ) {
    this.baseEnvironment = minimalProcessEnvironment(environment, {});
  }

  async run(argv: string[], options: DeploymentProcessOptions) {
    const child = Bun.spawn(argv, {
      cwd: options.cwd,
      env: minimalProcessEnvironment(this.baseEnvironment, options.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    const stdoutDrain = startDrain(child.stdout, "stdout", options);
    const stderrDrain = startDrain(child.stderr, "stderr", options);
    let timedOut = false;
    let exitCode = await deadline(child.exited, options.timeoutMs);
    if (exitCode === null) {
      timedOut = true;
      exitCode = await terminateProcessGroup(
        { pid: child.pid, exited: child.exited },
        (pid, signal) => this.signalGroup(pid, signal),
        this.graceMs,
      );
    }
    const [stdout, stderr] = await Promise.all([
      finishDrain(stdoutDrain, this.drainDeadlineMs),
      finishDrain(stderrDrain, this.drainDeadlineMs),
    ]);
    return { exitCode: exitCode ?? -1, stdout, stderr, timedOut };
  }

  private signalGroup(pid: number, signal: NodeJS.Signals): void {
    try { this.killGroup(pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}

export class HostLaunchd implements LaunchdControl {
  constructor(private readonly processRunner: DeploymentProcess) {}

  async inspect(domain: string, label: string): Promise<LaunchdServiceState> {
    const result = await raw(this.processRunner, ["launchctl", "print", `${domain}/${label}`]);
    if (result.exitCode !== 0) {
      const output = `${result.stdout}\n${result.stderr}`;
      // 只承认launchctl对这个exact label的标准missing事实；泛化的“not found”
      // 可能是domain/DB/config错误，不能冒充unloaded证明。
      if (/could not find service/i.test(output) && output.includes(label)) {
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
    await chmod(dirname(backupPath), 0o700);
    await validateDirectory(dirname(backupPath), process.getuid?.(), 0o700);
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
    if (((await lstat(backupPath)).mode & 0o777) !== 0o600) throw new Error("SQLite backup 权限必须精确为 0600");
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
    for (const service of target.services) {
      if (uid !== undefined && service.domain !== `gui/${uid}`) throw new Error("launchd domain 必须等于当前 worker gui/<uid>");
    }
    await validateDirectory(target.repositoryPath, uid, null);
    await ensurePrivateTargetDirectory(target.releasesPath, uid);
    await ensurePrivateTargetDirectory(target.statePath, uid);
    await validateRegularFile(target.sqlitePath, uid, 0o600);
    for (const service of target.services) {
      await validateOwnedParent(service.plistPath, uid);
      try { await validateRegularFile(service.plistPath, uid); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await validateRegularFile(service.templatePath, uid);
      const template = await readFile(service.templatePath, "utf8");
      if (createHash("sha256").update(template).digest("hex") !== service.templateSha256) {
        throw new Error(`launchd template ${service.id} 内容 hash 漂移`);
      }
      const label = exactLaunchdTemplateLabel(template);
      if (label !== service.label) throw new Error(`launchd template ${service.id} Label 与配置不匹配`);
    }
    await validateOwnedParent(target.currentSymlinkPath, uid);
    // current 本身可能正处于待恢复的 partial cutover；普通 execute/recovery 分别用
    // trusted manifest/anchor 判定，validator 不能在领取 recovery 前先把修复入口堵死。
  }
}

export const hostClock: DeploymentClock = {
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
};

export function targetRegistrations(targets: DeploymentTargetConfig[]) {
  return targets.map(({ id, name, provider, repositoryId, fingerprint, manifestHash }) => ({
    id, name, provider, repositoryId, fingerprint, manifestHash,
  }));
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

function startDrain(
  stream: ReadableStream<Uint8Array>,
  name: "stdout" | "stderr",
  options: DeploymentProcessOptions,
): { promise: Promise<string>; cancel: () => Promise<void> } {
  const reader = stream.getReader();
  const promise = (async () => {
    const streamDecoder = new TextDecoder();
    const captured: Uint8Array[] = [];
    let capturedBytes = 0;
    let truncated = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = streamDecoder.decode(value, { stream: true });
      options.onOutput(name, chunk);
      const room = Math.max(0, options.maxCaptureBytes - capturedBytes);
      if (room > 0) {
        const part = value.slice(0, room);
        captured.push(part);
        capturedBytes += part.byteLength;
      }
      if (value.byteLength > room) truncated = true;
    }
    const tail = streamDecoder.decode();
    if (tail) options.onOutput(name, tail);
    const bytes = Buffer.concat(captured.map((part) => Buffer.from(part)));
    if (!truncated) return new TextDecoder().decode(bytes);
    const marker = Buffer.from("…[truncated]");
    const bodyBytes = Math.max(0, options.maxCaptureBytes - marker.byteLength);
    return `${new TextDecoder().decode(bytes.subarray(0, bodyBytes))}${marker.toString()}`;
  })();
  return { promise, cancel: async () => { try { await reader.cancel(); } catch { /* already closed */ } } };
}

async function finishDrain(drain: ReturnType<typeof startDrain>, timeoutMs: number): Promise<string> {
  return finishDrainBeforeDeadline(drain.promise, drain.cancel, timeoutMs);
}

export async function finishDrainBeforeDeadline(
  promise: Promise<string>,
  cancel: () => Promise<void>,
  timeoutMs: number,
): Promise<string> {
  const result = await deadline(promise, timeoutMs);
  if (result !== null) return result;
  await cancel();
  return "…[drain deadline]";
}

export async function terminateProcessGroup(
  child: { pid: number; exited: Promise<number> },
  signalGroup: (pid: number, signal: NodeJS.Signals) => void,
  graceMs: number,
): Promise<number | null> {
  signalGroup(child.pid, "SIGTERM");
  let exitCode = await deadline(child.exited, graceMs);
  if (exitCode !== null) return exitCode;
  signalGroup(child.pid, "SIGKILL");
  exitCode = await deadline(child.exited, graceMs);
  return exitCode;
}

async function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try { return await Promise.race([promise, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error("health response exceeds bounded capture limit");
    }
    parts.push(next.value);
  }
  return decoder.decode(Buffer.concat(parts.map((part) => Buffer.from(part)))) + decoder.decode();
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

async function validateRegularFile(path: string, uid: number | undefined, exactMode: number | null = null): Promise<void> {
  await validateOwnedParent(path, uid);
  const metadata = await lstat(path);
  assertRuntimePathMetadata(path, metadata, "file", uid, exactMode);
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
