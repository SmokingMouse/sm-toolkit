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
import { type DeploymentTargetConfig } from "../config.js";
import {
  isTransientLaunchdBootstrapEio,
  LAUNCHD_BOOTSTRAP_RETRY_ATTEMPTS,
  LAUNCHD_BOOTSTRAP_RETRY_INTERVAL_MS,
} from "../daemon/service.js";
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
import { exactPlistRootLabel } from "./plist.js";
import { redactStructured } from "./redaction.js";

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
  assertDeploymentRestoreFence(gate: Parameters<HarborStore["assertDeploymentRestoreFence"]>[0]) {
    return this.use((store) => store.assertDeploymentRestoreFence(gate));
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
    await validateDirectory(path, process.getuid?.(), mode);
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
  async rename(from: string, to: string) {
    await validateOwnedParent(from, process.getuid?.());
    await validateOwnedParent(to, process.getuid?.());
    const source = await lstat(from);
    if (source.isDirectory() || (process.getuid && source.uid !== process.getuid())) throw new Error(`${from} rename source 不可信`);
    if (!source.isSymbolicLink() && (source.mode & 0o022) !== 0) throw new Error(`${from} rename source 不能 group/world writable`);
    try {
      const destination = await lstat(to);
      if (destination.isDirectory() || (process.getuid && destination.uid !== process.getuid())) throw new Error(`${to} rename destination 不可信`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(from, to);
  }
  async exists(path: string) {
    try { await lstat(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async readLink(path: string) {
    return readLinkOrMissing(() => readlink(path));
  }
  async symlink(target: string, path: string) {
    await validateOwnedParent(path, process.getuid?.());
    await symlink(target, path);
  }
  async remove(path: string) {
    await validateOwnedParent(path, process.getuid?.());
    try {
      const metadata = await lstat(path);
      if (metadata.isDirectory() || (process.getuid && metadata.uid !== process.getuid())) throw new Error(`${path} remove target 不可信`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try { await unlink(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export class HostProcess implements DeploymentProcess {
  private readonly baseEnvironment: Record<string, string>;

  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    private readonly processGroup: ProcessGroupControl = new MacOsProcessGroupControl(),
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
        (pid, signal) => this.processGroup.signal(pid, signal),
        this.graceMs,
        (pid) => this.processGroup.exists(pid),
      );
    } else if (await this.processGroup.exists(child.pid)) {
      // A successful direct child may have daemonized descendants that still
      // own stdout/stderr pipes.  Success is not a licence to leak the group.
      await terminateProcessGroup(
        { pid: child.pid, exited: child.exited },
        (pid, signal) => this.processGroup.signal(pid, signal),
        this.graceMs,
        (pid) => this.processGroup.exists(pid),
      );
    }
    const [stdout, stderr] = await Promise.all([
      finishDrain(stdoutDrain, this.drainDeadlineMs),
      finishDrain(stderrDrain, this.drainDeadlineMs),
    ]);
    return {
      exitCode: exitCode ?? -1,
      stdout,
      stderr,
      timedOut,
      stdoutMatched: stdoutDrain.expectedMatched(),
    };
  }

}

export interface ProcessGroupControl {
  signal(pgid: number, signal: NodeJS.Signals): Promise<void>;
  exists(pgid: number): Promise<boolean>;
}

/** Bun 1.1 on macOS rejects negative PIDs in process.kill(). */
export class MacOsProcessGroupControl implements ProcessGroupControl {
  async signal(pgid: number, signal: NodeJS.Signals): Promise<void> {
    await this.kill([signal === "SIGKILL" ? "-KILL" : "-TERM", "--", `-${positivePgid(pgid)}`], true);
  }

  async exists(pgid: number): Promise<boolean> {
    return (await this.kill(["-0", "--", `-${positivePgid(pgid)}`], false)) === 0;
  }

  private async kill(argv: string[], missingIsSuccess: boolean): Promise<number> {
    const child = Bun.spawn(["/bin/kill", ...argv], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exitCode === 0 || (missingIsSuccess && /no such process/i.test(stderr))) return exitCode;
    if (!missingIsSuccess && /no such process/i.test(stderr)) return exitCode;
    throw new Error(`/bin/kill process-group primitive failed (${exitCode}): ${stderr.trim()}`);
  }
}

export class HostLaunchd implements LaunchdControl {
  constructor(
    private readonly processRunner: DeploymentProcess,
    private readonly pause: (ms: number) => Promise<void> = Bun.sleep,
  ) {}

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
    const argv = ["launchctl", "bootstrap", domain, plistPath];
    let lastOutput = "";
    for (let attempt = 0; attempt < LAUNCHD_BOOTSTRAP_RETRY_ATTEMPTS; attempt++) {
      const result = await raw(this.processRunner, argv);
      if (result.exitCode === 0 && !result.timedOut) return;
      lastOutput = [result.stdout, result.stderr].filter(Boolean).join("\n")
        || (result.timedOut ? "timeout" : `exit ${result.exitCode}`);
      if (!isTransientLaunchdBootstrapEio(lastOutput)) {
        throw new Error(`launchctl bootstrap failed: ${lastOutput}`);
      }
      if (attempt < LAUNCHD_BOOTSTRAP_RETRY_ATTEMPTS - 1) {
        await this.pause(LAUNCHD_BOOTSTRAP_RETRY_INTERVAL_MS);
      }
    }
    throw new Error(`launchctl bootstrap remained EIO after bounded retry: ${lastOutput}`);
  }
  async isPidAlive(pid: number) {
    const safePid = positivePgid(pid);
    const result = await raw(this.processRunner, ["/bin/kill", "-0", "--", String(safePid)]);
    if (result.exitCode === 0) return true;
    const output = `${result.stdout}\n${result.stderr}`;
    if (/no such process/i.test(output)) return false;
    if (/operation not permitted/i.test(output)) return true;
    throw new Error(`exact PID liveness probe failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
  }
}

export class HostSqliteBackup implements SqliteBackupControl {
  async backup(databasePath: string, backupPath: string): Promise<void> {
    await validateRegularFile(databasePath, process.getuid?.(), 0o600);
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
      const label = exactPlistRootLabel(template);
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
): { promise: Promise<string>; cancel: () => Promise<void>; expectedMatched: () => boolean | null } {
  const reader = stream.getReader();
  const matcher = name === "stdout" && options.expectedStdout !== undefined
    ? new ExactTrimmedOutputMatcher(options.expectedStdout)
    : null;
  let expectedMatched: boolean | null = null;
  const promise = (async () => {
    const streamDecoder = new TextDecoder();
    const secrets = options.redactValues ?? [];
    const lookahead = Math.min(65_536, Math.max(8_192, ...secrets.map((value) => value.length + 256)));
    const rawLimit = options.maxCaptureBytes + lookahead;
    let raw = "";
    let rawTruncated = false;
    const appendRaw = (chunk: string) => {
      if (!chunk) return;
      const room = Math.max(0, rawLimit - Buffer.byteLength(raw));
      if (room <= 0) { rawTruncated = true; return; }
      const bytes = Buffer.from(chunk);
      raw += new TextDecoder().decode(bytes.subarray(0, room));
      if (bytes.byteLength > room) rawTruncated = true;
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = streamDecoder.decode(value, { stream: true });
      matcher?.append(chunk);
      appendRaw(chunk);
    }
    const tail = streamDecoder.decode();
    matcher?.append(tail);
    appendRaw(tail);
    expectedMatched = matcher?.finish() ?? null;
    const safe = redactStructured(raw, secrets);
    options.onOutput(name, safe);
    const safeBytes = Buffer.from(safe);
    const truncated = rawTruncated || safeBytes.byteLength > options.maxCaptureBytes;
    const bytes = safeBytes.subarray(0, options.maxCaptureBytes);
    if (!truncated) return new TextDecoder().decode(bytes);
    const marker = Buffer.from("…[truncated]");
    const bodyBytes = Math.max(0, options.maxCaptureBytes - marker.byteLength);
    return `${new TextDecoder().decode(bytes.subarray(0, bodyBytes))}${marker.toString()}`;
  })();
  return {
    promise,
    cancel: async () => { try { await reader.cancel(); } catch { /* already closed */ } },
    expectedMatched: () => expectedMatched,
  };
}

/** Incrementally implements `stdout.trim() === expected` without retaining stdout. */
class ExactTrimmedOutputMatcher {
  private position = 0;
  private started = false;
  private mismatched = false;

  constructor(private readonly expected: string) {}

  append(chunk: string): void {
    if (this.mismatched) return;
    for (let index = 0; index < chunk.length; index++) {
      const character = chunk[index]!;
      if (!this.started && isTrimWhitespace(character)) continue;
      this.started = true;
      if (this.position < this.expected.length) {
        if (character !== this.expected[this.position]) {
          this.mismatched = true;
          return;
        }
        this.position++;
      } else if (!isTrimWhitespace(character)) {
        this.mismatched = true;
        return;
      }
    }
  }

  finish(): boolean {
    return !this.mismatched && this.position === this.expected.length;
  }
}

function isTrimWhitespace(character: string): boolean {
  return character.trim() === "";
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
  signalGroup: (pid: number, signal: NodeJS.Signals) => void | Promise<void>,
  graceMs: number,
  groupExists?: (pid: number) => boolean | Promise<boolean>,
): Promise<number | null> {
  await signalGroup(child.pid, "SIGTERM");
  if (groupExists) {
    if (!await waitForGroupExit(child.pid, groupExists, graceMs)) {
      await signalGroup(child.pid, "SIGKILL");
      if (!await waitForGroupExit(child.pid, groupExists, graceMs)) {
        throw new Error(`process group ${child.pid} 在 KILL 后仍无法证明已停止`);
      }
    }
    return deadline(child.exited, graceMs);
  }
  let exitCode = await deadline(child.exited, graceMs);
  if (exitCode !== null) return exitCode;
  await signalGroup(child.pid, "SIGKILL");
  exitCode = await deadline(child.exited, graceMs);
  return exitCode;
}

async function waitForGroupExit(
  pid: number,
  exists: (pid: number) => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  do {
    if (!await exists(pid)) return true;
    await Bun.sleep(Math.min(20, Math.max(1, timeoutMs)));
  } while (Date.now() <= end);
  return !await exists(pid);
}

function positivePgid(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 1) throw new Error("process group id 无效");
  return value;
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
  await validateCanonicalComponents(path, uid);
  const metadata = await lstat(path);
  assertRuntimePathMetadata(path, metadata, "directory", uid, exactMode);
  if (await realpath(path) !== path) throw new Error(`${path} 含 symlink/non-canonical component`);
}

async function validateRegularFile(path: string, uid: number | undefined, exactMode: number | null = null): Promise<void> {
  await validateOwnedParent(path, uid);
  await validateCanonicalComponents(path, uid);
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
  if ((metadata.mode & 0o022) !== 0) throw new Error(`${label} 不能 group/world writable`);
  if (exactMode !== null && (metadata.mode & 0o777) !== exactMode) throw new Error(`${label} 权限必须为 0${exactMode.toString(8)}`);
}

async function validateCanonicalComponents(path: string, expectedUid: number | undefined): Promise<void> {
  const components: string[] = [];
  let current = path;
  while (true) {
    components.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  components.reverse();
  for (let index = 0; index < components.length; index++) {
    const component = components[index]!;
    const metadata = await lstat(component);
    const leaf = index === components.length - 1;
    if (metadata.isSymbolicLink()) throw new Error(`${path} 含 symlink component ${component}`);
    if (!leaf && !metadata.isDirectory()) throw new Error(`${path} parent component ${component} 不是 directory`);
    if (expectedUid !== undefined && metadata.uid !== expectedUid && metadata.uid !== 0) {
      throw new Error(`${path} component ${component} owner 不可信`);
    }
    if ((metadata.mode & 0o022) !== 0) {
      const rootOwnedStickySystemParent = !leaf && metadata.uid === 0 && (metadata.mode & 0o1000) !== 0;
      if (!rootOwnedStickySystemParent) throw new Error(`${path} component ${component} 不能 group/world writable`);
    }
  }
}
