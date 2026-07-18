import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { deploymentMaintenancePath } from "../config.js";
import type { DeploymentMaintenanceGate, DeploymentMaintenancePhase } from "../protocol.js";

export interface DeploymentMaintenanceSentinel {
  readonly path: string;
  read(): Promise<DeploymentMaintenanceGate | null>;
  write(gate: DeploymentMaintenanceGate): Promise<void>;
  clear(expected: DeploymentMaintenanceGate): Promise<void>;
  withLock<T>(action: () => Promise<T> | T): Promise<T>;
}

/** 稳定 host-global discovery path；不依赖 target state_path，target 删除/漂移仍 fail-closed。 */
export class HostMaintenanceSentinel implements DeploymentMaintenanceSentinel {
  readonly path: string;
  private readonly lockContext = new AsyncLocalStorage<boolean>();

  constructor(path = deploymentMaintenancePath()) {
    this.path = path;
  }

  async read(): Promise<DeploymentMaintenanceGate | null> {
    const snapshot = await this.readJournal();
    return selectActiveGate(snapshot.records, snapshot.releases);
  }

  async write(gate: DeploymentMaintenanceGate): Promise<void> {
    await this.withLock(async () => {
      await ensurePrivateDirectory(dirname(this.path));
      await ensurePrivateDirectory(this.journalPath());
      const snapshot = await this.readJournal();
      const current = selectActiveGate(snapshot.records, snapshot.releases);
      if (current && !sameMaintenanceIdentity(current, gate)) {
        if (!sameRollbackIdentity(current, gate) || current.fenceEpoch >= gate.fenceEpoch) {
          throw new Error("Harbor host 已存在另一个或更新的 fenced maintenance record");
        }
      }
      if (snapshot.releases.some((release) => releaseRetires(release, gate))) {
        throw new Error("拒绝写入已被 immutable release high-water 退休的 maintenance fence");
      }
      const path = `${this.journalPath()}/${recordName(gate)}`;
      try {
        await writeFile(path, `${JSON.stringify(gate)}\n`, { mode: 0o600, flag: "wx" });
        await chmod(path, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = parseMaintenanceGate(await readFile(path, "utf8"));
        if (!sameMaintenanceIdentity(existing, gate) || existing.phase !== gate.phase || existing.updatedAt !== gate.updatedAt) {
          throw new Error("immutable maintenance record filename collision");
        }
      }
    });
  }

  async clear(expected: DeploymentMaintenanceGate): Promise<void> {
    await this.withLock(async () => {
      const snapshot = await this.readJournal();
      const existing = selectActiveGate(snapshot.records, snapshot.releases);
      if (!existing) return;
      if (!sameMaintenanceIdentity(existing, expected)) throw new Error("拒绝清除不匹配或陈旧 epoch 的 maintenance record");
      await ensurePrivateDirectory(this.journalPath());
      const release: ReleaseRecord = {
        version: 3,
        kind: "release",
        fenceEpoch: expected.fenceEpoch,
        fenceNonce: expected.fenceNonce,
        releasedAt: Date.now(),
        gate: expected,
      };
      const releasePath = `${this.journalPath()}/${releaseName(release)}`;
      try {
        await writeFile(releasePath, `${JSON.stringify(release)}\n`, { mode: 0o600, flag: "wx" });
        await chmod(releasePath, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      for (const record of snapshot.files) {
        if (record.gate && releaseRetires(release, record.gate)) await unlink(record.path).catch(missingOnly);
      }
      const legacy = await this.readLegacy();
      if (legacy && releaseRetires(release, legacy)) await unlink(this.path).catch(missingOnly);
      if (await this.read()) throw new Error("maintenance release 后仍存在 active host fence");
    });
  }

  async withLock<T>(action: () => Promise<T> | T): Promise<T> {
    if (this.lockContext.getStore()) return action();
    await ensurePrivateDirectory(dirname(this.path));
    const lockPath = `${this.path}.lock`;
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        await chmod(lockPath, 0o700);
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await Bun.sleep(20);
      }
    }
    if (!acquired) throw new Error("maintenance host lock 已占用或遗留；需要管理员 recovery");
    try {
      return await this.lockContext.run(true, action);
    } finally {
      await rmdir(lockPath).catch((error) => {
        throw new Error(`maintenance host lock 无法释放：${message(error)}`);
      });
    }
  }

  private journalPath(): string {
    return `${this.path}.d`;
  }

  private async readJournal(): Promise<JournalSnapshot> {
    const records: DeploymentMaintenanceGate[] = [];
    const releases: ReleaseRecord[] = [];
    const files: JournalFile[] = [];
    const legacy = await this.readLegacy();
    if (legacy) records.push(legacy);
    let names: string[];
    try {
      const metadata = await lstat(this.journalPath());
      const uid = process.getuid?.();
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("maintenance journal 必须是 non-symlink directory");
      if (uid !== undefined && metadata.uid !== uid) throw new Error("maintenance journal owner 不是当前 uid");
      if ((metadata.mode & 0o777) !== 0o700) throw new Error("maintenance journal 权限必须为 0700");
      names = await readdir(this.journalPath());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records, releases, files };
      throw new Error(`maintenance journal 无法判定：${message(error)}`);
    }
    for (const name of names) {
      if (!/^(?:fence|released)-[A-Za-z0-9._-]+\.json$/.test(name)) throw new Error(`maintenance journal 含未知 entry ${name}`);
      const path = `${this.journalPath()}/${name}`;
      const metadata = await lstat(path);
      const uid = process.getuid?.();
      if (metadata.isSymbolicLink() || !metadata.isFile() || (uid !== undefined && metadata.uid !== uid) || (metadata.mode & 0o777) !== 0o600) {
        throw new Error(`maintenance journal entry ${name} 必须是当前 uid 的 0600 regular file`);
      }
      const raw = await readFile(path, "utf8");
      if (name.startsWith("fence-")) {
        const gate = parseMaintenanceGate(raw);
        records.push(gate);
        files.push({ path, gate });
      } else {
        const release = parseReleaseRecord(raw);
        releases.push(release);
        files.push({ path, release });
      }
    }
    return { records, releases, files };
  }

  private async readLegacy(): Promise<DeploymentMaintenanceGate | null> {
    let metadata;
    try { metadata = await lstat(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`maintenance legacy sentinel 无法判定：${message(error)}`);
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("maintenance legacy sentinel 必须是 non-symlink regular file");
    const uid = process.getuid?.();
    if (uid !== undefined && metadata.uid !== uid) throw new Error("maintenance legacy sentinel owner 不是当前 uid");
    if ((metadata.mode & 0o777) !== 0o600) throw new Error("maintenance legacy sentinel 权限必须为 0600");
    return parseMaintenanceGate(await readFile(this.path, "utf8"));
  }
}

interface ReleaseRecord {
  version: 3;
  kind: "release";
  fenceEpoch: number;
  fenceNonce: string;
  releasedAt: number;
  gate: DeploymentMaintenanceGate;
}

interface JournalFile { path: string; gate?: DeploymentMaintenanceGate; release?: ReleaseRecord }
interface JournalSnapshot { records: DeploymentMaintenanceGate[]; releases: ReleaseRecord[]; files: JournalFile[] }

function selectActiveGate(records: DeploymentMaintenanceGate[], releases: ReleaseRecord[]): DeploymentMaintenanceGate | null {
  const active = records.filter((gate) => !releases.some((release) => releaseRetires(release, gate)))
    .sort((left, right) => right.fenceEpoch - left.fenceEpoch || right.updatedAt - left.updatedAt);
  const current = active[0] ?? null;
  if (!current) return null;
  for (const candidate of active) {
    if (candidate.fenceEpoch === current.fenceEpoch && !sameMaintenanceIdentity(candidate, current)) {
      throw new Error("maintenance journal 同 epoch 存在冲突 fence");
    }
    if (!sameRollbackIdentity(candidate, current)) throw new Error("maintenance journal 存在冲突 rollback identity");
  }
  return current;
}

function releaseRetires(release: ReleaseRecord, gate: DeploymentMaintenanceGate): boolean {
  return sameRollbackIdentity(release.gate, gate)
    && (gate.fenceEpoch < release.fenceEpoch
      || (gate.fenceEpoch === release.fenceEpoch && gate.fenceNonce === release.fenceNonce));
}

function recordName(gate: DeploymentMaintenanceGate): string {
  return `fence-${String(gate.fenceEpoch).padStart(20, "0")}-${shortHash(gate.fenceNonce)}-${String(gate.updatedAt)}-${gate.phase}.json`;
}

function releaseName(release: ReleaseRecord): string {
  return `released-${String(release.fenceEpoch).padStart(20, "0")}-${shortHash(release.fenceNonce)}.json`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function parseReleaseRecord(value: string): ReleaseRecord {
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { throw new Error("maintenance release record JSON 无效"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("maintenance release record 必须是对象");
  const record = raw as Record<string, unknown>;
  if (record.version !== 3 || record.kind !== "release" || !Number.isInteger(record.fenceEpoch)
    || typeof record.fenceNonce !== "string" || !record.fenceNonce || !Number.isFinite(record.releasedAt)) {
    throw new Error("maintenance release record identity 无效");
  }
  const gate = parseMaintenanceGate(JSON.stringify(record.gate));
  if (gate.fenceEpoch !== record.fenceEpoch || gate.fenceNonce !== record.fenceNonce) throw new Error("maintenance release record/gate fence 不匹配");
  return { version: 3, kind: "release", fenceEpoch: Number(record.fenceEpoch), fenceNonce: record.fenceNonce, releasedAt: Number(record.releasedAt), gate };
}

function missingOnly(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

function sameRollbackIdentity(left: DeploymentMaintenanceGate, right: DeploymentMaintenanceGate): boolean {
  return left.targetId === right.targetId && left.jobId === right.jobId && left.deliveryId === right.deliveryId
    && left.generation === right.generation && left.revision === right.revision
    && left.targetFingerprint === right.targetFingerprint && left.targetManifestHash === right.targetManifestHash
    && left.rollbackAttempt === right.rollbackAttempt && left.baselineRevision === right.baselineRevision
    && left.baselineFingerprint === right.baselineFingerprint && left.baselineManifestHash === right.baselineManifestHash
    && left.baselineHealthFingerprint === right.baselineHealthFingerprint;
}

export function sameMaintenanceIdentity(left: DeploymentMaintenanceGate, right: DeploymentMaintenanceGate): boolean {
  return left.version === 2 && right.version === 2
    && left.fenceEpoch === right.fenceEpoch
    && left.fenceNonce === right.fenceNonce
    && left.targetId === right.targetId
    && left.jobId === right.jobId
    && left.deliveryId === right.deliveryId
    && left.generation === right.generation
    && left.revision === right.revision
    && left.targetFingerprint === right.targetFingerprint
    && left.targetManifestHash === right.targetManifestHash
    && left.rollbackAttempt === right.rollbackAttempt
    && left.baselineRevision === right.baselineRevision
    && left.baselineFingerprint === right.baselineFingerprint
    && left.baselineManifestHash === right.baselineManifestHash
    && left.baselineHealthFingerprint === right.baselineHealthFingerprint;
}

export function parseMaintenanceGate(value: string): DeploymentMaintenanceGate {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("maintenance sentinel JSON 无效");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("maintenance sentinel 必须是对象");
  const gate = raw as Record<string, unknown>;
  const strings = [
    "fenceNonce", "targetId", "jobId", "deliveryId", "revision", "targetFingerprint",
    "targetManifestHash", "baselineRevision", "baselineFingerprint", "baselineManifestHash",
    "baselineHealthFingerprint", "expectedRevision", "expectedFingerprint", "phase",
  ] as const;
  for (const key of strings) if (typeof gate[key] !== "string" || !gate[key]) throw new Error(`maintenance sentinel ${key} 无效`);
  if (gate.version !== 2 || !Number.isInteger(gate.fenceEpoch) || Number(gate.fenceEpoch) <= 0
    || !Number.isInteger(gate.generation) || !Number.isInteger(gate.rollbackAttempt)
    || !Number.isFinite(gate.createdAt) || !Number.isFinite(gate.updatedAt)) {
    throw new Error("maintenance sentinel version/fence/generation/timestamp 无效");
  }
  if (!(["deploying", "healthy", "rolling_back", "releasing", "needs_recovery"] as DeploymentMaintenancePhase[]).includes(gate.phase as DeploymentMaintenancePhase)) {
    throw new Error("maintenance sentinel phase 无效");
  }
  for (const key of ["revision", "baselineRevision", "expectedRevision"] as const) {
    if (!/^[a-f0-9]{40,64}$/i.test(String(gate[key]))) throw new Error(`maintenance sentinel ${key} 无效`);
  }
  for (const key of ["targetFingerprint", "targetManifestHash", "baselineFingerprint", "baselineManifestHash", "baselineHealthFingerprint", "expectedFingerprint"] as const) {
    if (!/^[a-f0-9]{64}$/.test(String(gate[key]))) throw new Error(`maintenance sentinel ${key} 无效`);
  }
  return gate as unknown as DeploymentMaintenanceGate;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== resolve(parent)) throw new Error("maintenance parent 不是 canonical path");
  const parentMetadata = await lstat(parent);
  const uid = process.getuid?.();
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || (uid !== undefined && parentMetadata.uid !== uid)) {
    throw new Error("maintenance parent 必须是当前 uid 拥有的 non-symlink directory");
  }
  await mkdir(path, { recursive: false, mode: 0o700 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (uid !== undefined && metadata.uid !== uid)) {
    throw new Error("maintenance directory 必须是当前 uid 拥有的 non-symlink directory");
  }
  if ((metadata.mode & 0o777) !== 0o700) throw new Error("maintenance directory 权限必须为 0700");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
