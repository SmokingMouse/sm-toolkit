import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DeploymentTargetConfig } from "../config.js";
import type { DeploymentMaintenanceGate, DeploymentMaintenancePhase } from "../protocol.js";

export interface DeploymentMaintenanceSentinel {
  read(target: DeploymentTargetConfig): Promise<DeploymentMaintenanceGate | null>;
  write(target: DeploymentTargetConfig, gate: DeploymentMaintenanceGate): Promise<void>;
  clear(target: DeploymentTargetConfig, expected: DeploymentMaintenanceGate): Promise<void>;
}

export function maintenanceSentinelPath(target: DeploymentTargetConfig): string {
  return join(target.statePath, "maintenance.json");
}

export class HostMaintenanceSentinel implements DeploymentMaintenanceSentinel {
  async read(target: DeploymentTargetConfig): Promise<DeploymentMaintenanceGate | null> {
    await ensurePrivateDirectory(target.statePath);
    const path = maintenanceSentinelPath(target);
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`maintenance sentinel 无法读取：${message(error)}`);
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("maintenance sentinel 必须是 non-symlink regular file");
    const uid = process.getuid?.();
    if (uid !== undefined && metadata.uid !== uid) throw new Error("maintenance sentinel owner 不是当前 uid");
    if ((metadata.mode & 0o777) !== 0o600) throw new Error("maintenance sentinel 权限必须为 0600");
    return parseMaintenanceGate(await readFile(path, "utf8"));
  }

  async write(target: DeploymentTargetConfig, gate: DeploymentMaintenanceGate): Promise<void> {
    await ensurePrivateDirectory(target.statePath);
    const existing = await this.read(target);
    if (existing && !sameMaintenanceIdentity(existing, gate)) {
      throw new Error(`target "${target.id}" 已存在另一个 maintenance sentinel`);
    }
    const path = maintenanceSentinelPath(target);
    const temp = `${path}.tmp-${process.pid}`;
    await writeFile(temp, `${JSON.stringify(gate)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, path);
  }

  async clear(target: DeploymentTargetConfig, expected: DeploymentMaintenanceGate): Promise<void> {
    const existing = await this.read(target);
    if (!existing) return;
    if (!sameMaintenanceIdentity(existing, expected)) throw new Error("拒绝清除不匹配的 maintenance sentinel");
    await unlink(maintenanceSentinelPath(target));
  }
}

export function sameMaintenanceIdentity(left: DeploymentMaintenanceGate, right: DeploymentMaintenanceGate): boolean {
  return left.targetId === right.targetId
    && left.jobId === right.jobId
    && left.deliveryId === right.deliveryId
    && left.generation === right.generation
    && left.revision === right.revision
    && left.targetFingerprint === right.targetFingerprint
    && left.rollbackAttempt === right.rollbackAttempt
    && left.baselineRevision === right.baselineRevision;
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
  const strings = ["targetId", "jobId", "deliveryId", "revision", "targetFingerprint", "baselineRevision", "expectedRevision", "phase"] as const;
  for (const key of strings) if (typeof gate[key] !== "string" || !gate[key]) throw new Error(`maintenance sentinel ${key} 无效`);
  if (gate.version !== 1 || !Number.isInteger(gate.generation) || !Number.isInteger(gate.rollbackAttempt)
    || !Number.isFinite(gate.createdAt) || !Number.isFinite(gate.updatedAt)) {
    throw new Error("maintenance sentinel version/generation/timestamp 无效");
  }
  if (!(["deploying", "healthy", "rolling_back", "needs_recovery"] as DeploymentMaintenancePhase[]).includes(gate.phase as DeploymentMaintenancePhase)) {
    throw new Error("maintenance sentinel phase 无效");
  }
  if (!/^[a-f0-9]{40,64}$/i.test(String(gate.revision)) || !/^[a-f0-9]{40,64}$/i.test(String(gate.baselineRevision))
    || !/^[a-f0-9]{40,64}$/i.test(String(gate.expectedRevision)) || !/^[a-f0-9]{64}$/.test(String(gate.targetFingerprint))) {
    throw new Error("maintenance sentinel revision/fingerprint 无效");
  }
  return gate as unknown as DeploymentMaintenanceGate;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== resolve(parent)) throw new Error("maintenance state parent 不是 canonical path");
  const parentMetadata = await lstat(parent);
  const uid = process.getuid?.();
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || (uid !== undefined && parentMetadata.uid !== uid)) {
    throw new Error("maintenance state parent 必须是当前 uid 拥有的 non-symlink directory");
  }
  await mkdir(path, { recursive: false, mode: 0o700 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (uid !== undefined && metadata.uid !== uid)) {
    throw new Error("maintenance state path 必须是当前 uid 拥有的 non-symlink directory");
  }
  if ((metadata.mode & 0o777) !== 0o700) throw new Error("maintenance state path 权限必须为 0700");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
