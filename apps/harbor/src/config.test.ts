import { expect, test } from "bun:test";
import { parseDeploymentTargets } from "./config.js";

test("deployment target parser accepts only configured argv and absolute sensitive paths", () => {
  const target = parseDeploymentTargets([{
    id: "local-harbor", name: "Local Harbor", provider: "local-launchd", repository_id: "repo_1",
    repository_path: "/repo", releases_path: "/releases", current_symlink_path: "/current",
    sqlite_path: "/db", state_path: "/state", steps: { build: [["bun", "run", "build"]] },
    environment: { TOKEN: "secret" },
    launchd: { label: "com.test", domain: "gui/1", plist_path: "/plist", template_path: "/template" },
    health: { url: "http://127.0.0.1:7777/api/health", headers: { Authorization: "Bearer secret" } },
  }])[0]!;
  expect(target).toEqual(expect.objectContaining({ id: "local-harbor", provider: "local-launchd", repositoryPath: "/repo" }));
  expect(target.steps.build).toEqual([["bun", "run", "build"]]);
  expect(target.environment).toEqual({ TOKEN: "secret" });
  expect(target.health.headers).toEqual({ Authorization: "Bearer secret" });
  expect(() => parseDeploymentTargets([{ ...target, repository_id: "repo_1", repository_path: "relative" }])).toThrow("必须是绝对路径");
});
