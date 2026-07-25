import { expect, test } from "bun:test";
import { deploymentWorkerProgramArguments, renderDeploymentWorkerLaunchAgent } from "./service.js";

test("Harbor self-deployer is a launchd-scheduled one-shot drainer", () => {
  const plist = renderDeploymentWorkerLaunchAgent({
    home: "/Users/Harbor",
    bunPath: "/opt/bun/bin/bun",
    workerEntry: "/repo/deployment-worker/main.ts",
    pathEnv: "/usr/bin:/bin",
    databasePath: "/Users/Harbor/.harbor/control-plane/harbor.db",
    maintenancePath: "/Users/Harbor/.harbor/deployment/maintenance.json",
    stdoutPath: "/Users/Harbor/.harbor/self-deployer.log",
    stderrPath: "/Users/Harbor/.harbor/self-deployer.err.log",
  });

  expect(plist).toContain("<key>RunAtLoad</key><true/>");
  expect(plist).toContain("<key>StartInterval</key><integer>3</integer>");
  expect(plist).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
  expect(plist).not.toContain("<key>KeepAlive</key><true/>");
});

test("Harbor self-deployer preserves the private host credential wrapper", () => {
  expect(deploymentWorkerProgramArguments(
    "/opt/bun/bin/bun",
    "/Users/Harbor/.harbor/current/apps/harbor/src/deployment-worker/main.ts",
  )).toEqual([
    "/opt/bun/bin/bun",
    "/Users/Harbor/.harbor/current/apps/harbor/src/deployment-worker/main.ts",
  ]);
  expect(deploymentWorkerProgramArguments(
    "/opt/bun/bin/bun",
    "/Users/Harbor/.harbor/deployment/worker-entry.zsh",
  )).toEqual([
    "/bin/zsh",
    "/Users/Harbor/.harbor/deployment/worker-entry.zsh",
  ]);
});
