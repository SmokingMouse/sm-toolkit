#!/usr/bin/env bun

import { databasePath, harborSelfDeployTarget, validateDeploymentWorkerConfigFile } from "../config.js";
import { LocalLaunchdDeploymentExecutor } from "./executor.js";
import { DeploymentWorker } from "./worker.js";
import {
  EphemeralDeploymentJobStore,
  FetchHealthClient,
  HostFileSystem,
  HostDeploymentTargetValidator,
  HostLaunchd,
  HostProcess,
  HostSqliteBackup,
  hostClock,
} from "./runtime.js";
import { HostMaintenanceSentinel } from "./maintenance.js";
import { redactStructured, targetSensitiveValues } from "./redaction.js";

validateDeploymentWorkerConfigFile();
const target = harborSelfDeployTarget();
if (!target) throw new Error("没有配置 self_deploy_target，Harbor self-deployer 拒绝启动");
const targets = [target];
const dbPath = databasePath();
const processRunner = new HostProcess();
const executor = new LocalLaunchdDeploymentExecutor({
  fs: new HostFileSystem(),
  process: processRunner,
  launchd: new HostLaunchd(processRunner),
  sqlite: new HostSqliteBackup(),
  health: new FetchHealthClient(),
  clock: hostClock,
  validator: new HostDeploymentTargetValidator(),
  maintenance: new HostMaintenanceSentinel(),
});
const worker = new DeploymentWorker(new EphemeralDeploymentJobStore(dbPath), targets, executor, hostClock);

console.log(`[harbor-self-deployer] started target=${target.id}`);
// launchd starts this one-shot drainer every few seconds.  Exiting after the
// queue is empty avoids depending on a long-lived Bun.sleep timer surviving a
// macOS host sleep; StartInterval supplies the next durable wakeup.
while (true) {
  try {
    const result = await worker.runOnce();
    if (!result.worked) break;
  } catch (error) {
    console.error(`[harbor-self-deployer] ${safeWorkerError(error, targets)}`);
    process.exitCode = 1;
    break;
  }
}

function safeWorkerError(error: unknown, configured: typeof targets): string {
  const value = error instanceof Error ? error.message : String(error);
  return redactStructured(value, configured.flatMap(targetSensitiveValues)).slice(0, 4_000);
}
