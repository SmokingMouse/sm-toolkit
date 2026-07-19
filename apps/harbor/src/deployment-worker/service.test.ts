import { expect, test } from "bun:test";
import { renderDeploymentWorkerLaunchAgent } from "./service.js";

test("deployment worker is a launchd-scheduled one-shot drainer", () => {
  const plist = renderDeploymentWorkerLaunchAgent({
    home: "/Users/Harbor",
    bunPath: "/opt/bun/bin/bun",
    workerEntry: "/repo/deployment-worker/main.ts",
    pathEnv: "/usr/bin:/bin",
    databasePath: "/Users/Harbor/.harbor/control-plane/harbor.db",
    maintenancePath: "/Users/Harbor/.harbor/deployment/maintenance.json",
    stdoutPath: "/Users/Harbor/.harbor/deploy-worker.log",
    stderrPath: "/Users/Harbor/.harbor/deploy-worker.err.log",
  });

  expect(plist).toContain("<key>RunAtLoad</key><true/>");
  expect(plist).toContain("<key>StartInterval</key><integer>3</integer>");
  expect(plist).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
  expect(plist).not.toContain("<key>KeepAlive</key><true/>");
});
