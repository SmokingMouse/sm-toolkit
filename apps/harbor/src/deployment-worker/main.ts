#!/usr/bin/env bun

import { databasePath, deploymentTargets, validateDeploymentWorkerConfigFile } from "../config.js";
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

validateDeploymentWorkerConfigFile();
const targets = deploymentTargets();
if (targets.length === 0) throw new Error("没有配置 deployment_targets，deploy worker 拒绝启动");
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

console.log(`[harbor-deploy-worker] started targets=${targets.map((target) => target.id).join(",")}`);
while (true) {
  try {
    const worked = await worker.runOnce();
    if (!worked) await hostClock.sleep(500);
  } catch (error) {
    console.error(`[harbor-deploy-worker] ${safeWorkerError(error, targets)}`);
    await hostClock.sleep(1_000);
  }
}

function safeWorkerError(error: unknown, configured: typeof targets): string {
  let value = error instanceof Error ? error.message : String(error);
  const sensitive = configured.flatMap((target) => [
    target.repositoryPath, target.releasesPath, target.currentSymlinkPath, target.sqlitePath, target.statePath,
    target.launchd.plistPath, target.launchd.templatePath, target.health.url,
    ...Object.values(target.environment),
    ...Object.values(target.health.headers).flatMap((header) => [header, header.replace(/^Bearer\s+/i, "")]),
  ]).filter(Boolean).sort((left, right) => right.length - left.length);
  for (const secret of sensitive) value = value.replaceAll(secret, "[redacted]");
  return value.slice(0, 4_000);
}
