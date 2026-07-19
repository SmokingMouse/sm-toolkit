import { databasePath, harborSelfDeployTarget, validateDeploymentWorkerConfigFile } from "../config.js";
import { LocalLaunchdDeploymentExecutor } from "./executor.js";
import { HostMaintenanceSentinel } from "./maintenance.js";
import {
  EphemeralDeploymentJobStore,
  FetchHealthClient,
  HostDeploymentTargetValidator,
  HostFileSystem,
  HostLaunchd,
  HostProcess,
  HostSqliteBackup,
  hostClock,
} from "./runtime.js";
import { DeploymentWorker } from "./worker.js";
import type { DeploymentWorkerResult } from "./worker.js";
import { openDeploymentDb } from "../server/db.js";
import { HarborStore } from "../server/store.js";

/** 管理员显式 recovery：执行原 rollback anchor，验证旧 revision + launchd PID + health 后才解除 gate。 */
export async function recoverLocalDeployment(jobId: string, targetId: string): Promise<DeploymentWorkerResult> {
  validateDeploymentWorkerConfigFile();
  const target = harborSelfDeployTarget();
  if (!target) throw new Error("Harbor self-deployer target 未配置");
  const targets = [target];
  const runner = new HostProcess();
  const executor = new LocalLaunchdDeploymentExecutor({
    fs: new HostFileSystem(),
    process: runner,
    launchd: new HostLaunchd(runner),
    sqlite: new HostSqliteBackup(),
    health: new FetchHealthClient(),
    clock: hostClock,
    validator: new HostDeploymentTargetValidator(),
    maintenance: new HostMaintenanceSentinel(),
  });
  const worker = new DeploymentWorker(new EphemeralDeploymentJobStore(databasePath()), targets, executor, hostClock);
  await worker.recover(jobId, targetId);
  // CLI 不信任“执行函数返回过”：重新打开 durable DB，并从稳定 host path 重新读取 sentinel。
  const result = await readFinalRecoveryTruth(jobId);
  assertSafeRecoveryTruth(result);
  return result;
}

export function assertSafeRecoveryTruth(result: DeploymentWorkerResult): void {
  if (result.job?.status !== "failed" || result.job.rollbackComplete !== true
    || result.databaseGate !== null || result.sentinel !== null) {
    throw new Error(
      `recovery 未达到安全终态：job=${result.job?.status ?? "missing"} rollbackComplete=${String(result.job?.rollbackComplete)} dbGate=${!!result.databaseGate} sentinel=${!!result.sentinel}`,
    );
  }
}

async function readFinalRecoveryTruth(jobId: string): Promise<DeploymentWorkerResult> {
  const db = openDeploymentDb(databasePath());
  try {
    const store = new HarborStore(db);
    return {
      worked: true,
      job: store.getDeploymentJob(jobId),
      databaseGate: store.getDeploymentMaintenance(),
      sentinel: await new HostMaintenanceSentinel().read(),
    };
  } finally {
    db.close();
  }
}
