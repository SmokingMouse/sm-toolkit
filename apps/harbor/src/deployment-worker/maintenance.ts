import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { deploymentMaintenancePath } from "../config.js";
import type { DeploymentMaintenanceGate, DeploymentMaintenancePhase } from "../protocol.js";

export interface DeploymentMaintenanceSentinel {
  readonly path: string;
  read(): Promise<DeploymentMaintenanceGate | null>;
  write(gate: DeploymentMaintenanceGate): Promise<void>;
  clear(expected: DeploymentMaintenanceGate): Promise<void>;
}

/** 稳定 host-global discovery path；不依赖 target state_path，target 删除/漂移仍 fail-closed。 */
export class HostMaintenanceSentinel implements DeploymentMaintenanceSentinel {
  readonly path: string;

  constructor(path = deploymentMaintenancePath()) {
    this.path = path;
  }

  async read(): Promise<DeploymentMaintenanceGate | null> {
    let metadata;
    try {
      metadata = await lstat(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`maintenance sentinel 无法判定：${message(error)}`);
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("maintenance sentinel 必须是 non-symlink regular file");
    const uid = process.getuid?.();
    if (uid !== undefined && metadata.uid !== uid) throw new Error("maintenance sentinel owner 不是当前 uid");
    if ((metadata.mode & 0o777) !== 0o600) throw new Error("maintenance sentinel 权限必须为 0600");
    return parseMaintenanceGate(await readFile(this.path, "utf8"));
  }

  async write(gate: DeploymentMaintenanceGate): Promise<void> {
    await ensurePrivateDirectory(dirname(this.path));
    const existing = await this.read();
    if (existing && !sameMaintenanceIdentity(existing, gate)) {
      if (!sameRollbackIdentity(existing, gate) || existing.fenceEpoch >= gate.fenceEpoch) {
        throw new Error("Harbor host 已存在另一个或更新的 fenced maintenance sentinel");
      }
    }
    const temp = `${this.path}.tmp-${process.pid}-${gate.fenceEpoch}`;
    await writeFile(temp, `${JSON.stringify(gate)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, this.path);
  }

  async clear(expected: DeploymentMaintenanceGate): Promise<void> {
    const existing = await this.read();
    if (!existing) return;
    if (!sameMaintenanceIdentity(existing, expected)) throw new Error("拒绝清除不匹配或陈旧 epoch 的 maintenance sentinel");
    await unlink(this.path);
    if (await this.read()) throw new Error("maintenance sentinel 删除后仍存在");
  }
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
