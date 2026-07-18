import { expect, test } from "bun:test";
import { assertPrivateConfigMetadata, parseDeploymentTargets } from "./config.js";

function configured(overrides: Record<string, unknown> = {}) {
  return {
    id: "local-harbor", name: "Local Harbor", provider: "local-launchd", repository_id: "repo_1",
    repository_path: "/repo", releases_path: "/releases", current_symlink_path: "/current",
    sqlite_path: "/db", state_path: "/state", steps: { build: [["bun", "run", "build"]] },
    environment: { BUILD_MODE: "production" },
    launchd: { label: "com.test", domain: "gui/501", plist_path: "/plist", template_path: "/template" },
    health: { url: "http://127.0.0.1:7777/api/health", headers: { Authorization: "Bearer secret" } },
    ...overrides,
  };
}

test("deployment target parser freezes a stable non-sensitive fingerprint", () => {
  const target = parseDeploymentTargets([configured()])[0]!;
  expect(target).toEqual(expect.objectContaining({
    id: "local-harbor", provider: "local-launchd", repositoryPath: "/repo",
    commandTimeoutMs: 30 * 60_000,
  }));
  expect(target.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(target.steps.build).toEqual([["bun", "run", "build"]]);
  expect(target.environment).toEqual({ BUILD_MODE: "production" });
  const changedSecret = parseDeploymentTargets([configured({
    health: { url: "http://127.0.0.1:7777/api/health", headers: { Authorization: "different" } },
  })])[0]!;
  expect(changedSecret.fingerprint).toBe(target.fingerprint);
});

test("deployment target config rejects non-canonical/overlapping paths, remote health, reserved env, and secret argv", () => {
  expect(() => parseDeploymentTargets([configured({ repository_path: "/repo/../repo" })])).toThrow("lexical canonical");
  expect(() => parseDeploymentTargets([configured({ state_path: "/releases/state" })])).toThrow("必须互不包含");
  expect(() => parseDeploymentTargets([configured({ health: { url: "https://example.com/health" } })])).toThrow("loopback");
  expect(() => parseDeploymentTargets([configured({ environment: { HARBOR_TOKEN: "secret" } })])).toThrow("保留/敏感变量");
  expect(() => parseDeploymentTargets([configured({
    steps: { build: [["build", "Bearer secret"]] },
  })])).toThrow("step argv 禁止包含");
});

test("worker YAML metadata must be owned 0600 non-symlink regular file", () => {
  const metadata = (mode: number, uid = 501, file = true, symlink = false) => ({
    mode, uid, isFile: () => file, isSymbolicLink: () => symlink,
  });
  expect(() => assertPrivateConfigMetadata(metadata(0o100600), 501)).not.toThrow();
  expect(() => assertPrivateConfigMetadata(metadata(0o100644), 501)).toThrow("0600");
  expect(() => assertPrivateConfigMetadata(metadata(0o100600, 502), 501)).toThrow("owner");
  expect(() => assertPrivateConfigMetadata(metadata(0o120600, 501, false, true), 501)).toThrow("non-symlink regular file");
});
