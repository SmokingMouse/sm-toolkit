import { databasePath, deploymentTargets, validateDeploymentWorkerConfigFile } from "../config.js";
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

/** 管理员显式 recovery：执行原 rollback anchor，验证旧 revision + launchd PID + health 后才解除 gate。 */
export async function recoverLocalDeployment(jobId: string, targetId: string): Promise<void> {
  validateDeploymentWorkerConfigFile();
  const targets = deploymentTargets();
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
}
