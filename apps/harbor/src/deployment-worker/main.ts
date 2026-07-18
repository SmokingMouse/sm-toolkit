#!/usr/bin/env bun

import { databasePath, deploymentTargets } from "../config.js";
import { LocalLaunchdDeploymentExecutor } from "./executor.js";
import { DeploymentWorker } from "./worker.js";
import {
  EphemeralDeploymentJobStore,
  FetchHealthClient,
  HostFileSystem,
  HostLaunchd,
  HostProcess,
  HostSqliteBackup,
  hostClock,
} from "./runtime.js";

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
});
const worker = new DeploymentWorker(new EphemeralDeploymentJobStore(dbPath), targets, executor, hostClock);

console.log(`[harbor-deploy-worker] started targets=${targets.map((target) => target.id).join(",")}`);
while (true) {
  try {
    const worked = await worker.runOnce();
    if (!worked) await hostClock.sleep(500);
  } catch (error) {
    console.error(`[harbor-deploy-worker] ${error instanceof Error ? error.message : String(error)}`);
    await hostClock.sleep(1_000);
  }
}
