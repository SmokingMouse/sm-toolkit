import { expect, test } from "bun:test";
import { assertPrivateConfigMetadata, exactLaunchdTemplateLabel, parseDeploymentTargets } from "./config.js";

const SECRETS = { HEALTH_TOKEN: "TOPSECRET", OTHER_HEALTH_TOKEN: "OTHERSECRET" };

function configured(overrides: Record<string, unknown> = {}) {
  return {
    id: "local-harbor", name: "Local Harbor", provider: "local-launchd", repository_id: "repo_1",
    repository_path: "/repo", releases_path: "/releases", current_symlink_path: "/current",
    sqlite_path: "/db", state_path: "/state",
    source: { remote: "origin", url: "https://example.test/harbor.git", allowed_refs: ["refs/remotes/origin/main"] },
    steps: { build: [["bun", "run", "build"]] }, environment: { BUILD_MODE: "production" },
    services: [
      { id: "server", role: "server", label: "com.test.server", domain: "gui/501", plist_path: "/server.plist", template_path: "/server.tpl", template_sha256: "a".repeat(64) },
      { id: "daemon", role: "daemon", label: "com.test.daemon", domain: "gui/501", plist_path: "/daemon.plist", template_path: "/daemon.tpl", template_sha256: "b".repeat(64) },
    ],
    health: { url: "http://127.0.0.1:7777/api/health", headers: { Authorization: { env: "HEALTH_TOKEN" } } },
    ...overrides,
  };
}

test("deployment target freezes complete non-secret topology and keeps secret values out of fingerprints", () => {
  const target = parseDeploymentTargets([configured()], SECRETS)[0]!;
  expect(target).toEqual(expect.objectContaining({
    id: "local-harbor", provider: "local-launchd", repositoryPath: "/repo",
    commandTimeoutMs: 30 * 60_000,
  }));
  expect(target.services.map(({ role }) => role)).toEqual(["server", "daemon"]);
  expect(target.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(target.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify({ fingerprint: target.fingerprint, manifestHash: target.manifestHash })).not.toContain("TOPSECRET");

  const rotatedSecret = parseDeploymentTargets([configured()], { ...SECRETS, HEALTH_TOKEN: "ROTATED" })[0]!;
  expect(rotatedSecret.fingerprint).toBe(target.fingerprint);
  const serverProjection = parseDeploymentTargets([configured()], {}, { resolveSecrets: false })[0]!;
  expect(serverProjection.health.headers).toEqual({});
  expect(serverProjection.fingerprint).toBe(target.fingerprint);
  expect(parseDeploymentTargets([configured({ environment: { BUILD_MODE: "debug" } })], SECRETS)[0]!.fingerprint).not.toBe(target.fingerprint);
  expect(parseDeploymentTargets([configured({ command_timeout_ms: 42 })], SECRETS)[0]!.fingerprint).not.toBe(target.fingerprint);
  expect(parseDeploymentTargets([configured({
    health: { url: "http://127.0.0.1:7777/api/health", timeout_ms: 99, headers: { Authorization: { env: "HEALTH_TOKEN" } } },
  })], SECRETS)[0]!.fingerprint).not.toBe(target.fingerprint);
});

test("parser requires exactly one server plus daemon and rejects path/label/health conflicts across targets", () => {
  expect(() => parseDeploymentTargets([configured({ services: [] })], SECRETS)).toThrow("server + daemon");
  expect(() => parseDeploymentTargets([configured({ services: [configured().services[0]] })], SECRETS)).toThrow("server + daemon");
  expect(() => parseDeploymentTargets([configured({
    services: [configured().services[0], { ...(configured().services as Record<string, unknown>[])[1], role: "server" }],
  })], SECRETS)).toThrow("恰有一个 server");

  const second = configured({
    id: "other", repository_id: "repo_2", repository_path: "/repo2", releases_path: "/releases2",
    current_symlink_path: "/current2", sqlite_path: "/db2", state_path: "/state2",
    services: [
      { id: "server", role: "server", label: "com.other.server", domain: "gui/501", plist_path: "/other-server.plist", template_path: "/other-server.tpl", template_sha256: "c".repeat(64) },
      { id: "daemon", role: "daemon", label: "com.other.daemon", domain: "gui/501", plist_path: "/other-daemon.plist", template_path: "/other-daemon.tpl", template_sha256: "d".repeat(64) },
    ],
    health: { url: "http://127.0.0.1:8888/health", headers: { Authorization: { env: "HEALTH_TOKEN" } } },
  });
  expect(() => parseDeploymentTargets([configured(), { ...second, repository_path: "/repo/child" }], SECRETS)).toThrow("paths 冲突");
  expect(() => parseDeploymentTargets([configured(), { ...second, services: [
    { ...((second.services as Record<string, unknown>[])[0]!), label: "com.test.server" },
    (second.services as unknown[])[1],
  ] }], SECRETS)).toThrow("launchd label 冲突");
  expect(() => parseDeploymentTargets([configured(), { ...second, services: [
    { ...((second.services as Record<string, unknown>[])[0]!), label: "com.test.server.child" },
    (second.services as unknown[])[1],
  ] }], SECRETS)).toThrow("launchd label 冲突");
  expect(() => parseDeploymentTargets([configured(), { ...second, health: { url: "http://127.0.0.1:7777/api/health/deep", headers: { Authorization: { env: "HEALTH_TOKEN" } } } }], SECRETS)).toThrow("health endpoint 冲突");
});

test("parser rejects non-canonical paths, remote health, reserved env, missing secret refs and credential argv", () => {
  expect(() => parseDeploymentTargets([configured({ repository_path: "/repo/../repo" })], SECRETS)).toThrow("lexical canonical");
  expect(() => parseDeploymentTargets([configured({ state_path: "/releases/state" })], SECRETS)).toThrow("必须互不包含");
  expect(() => parseDeploymentTargets([configured({ health: { url: "https://example.com/health" } })], SECRETS)).toThrow("loopback");
  expect(() => parseDeploymentTargets([configured({ environment: { HARBOR_TOKEN: "secret" } })], SECRETS)).toThrow("保留/敏感变量");
  expect(() => parseDeploymentTargets([configured({ environment: { BUILD_MODE: "Authorization: Bearer TOPSECRET" } })], SECRETS)).toThrow("credential-like");
  expect(() => parseDeploymentTargets([configured({ environment: { BUILD_MODE: "TOPSECRET" } })], SECRETS)).toThrow("配置 secret");
  expect(() => parseDeploymentTargets([configured()], {})).toThrow("HEALTH_TOKEN 未配置");
  expect(() => parseDeploymentTargets([configured({ steps: { build: [["curl", "Authorization: Bearer TOPSECRET"]] } })], SECRETS)).toThrow("credential-like");
  expect(() => parseDeploymentTargets([configured({ steps: { build: [["curl", "-H", "Authorization:", "Bearer", "TOPSECRET"]] } })], SECRETS)).toThrow("credential-like");
  expect(() => parseDeploymentTargets([configured({ steps: { build: [["tool", "--password", "not-a-configured-secret"]] } })], SECRETS)).toThrow("credential-like");
  expect(() => parseDeploymentTargets([configured({ source: { remote: "origin", url: "https://user:pass@example.test/repo", allowed_refs: ["refs/heads/main"] } })], SECRETS)).toThrow("credential");
  expect(() => parseDeploymentTargets([configured()], SECRETS, { maintenancePath: "/state/global-maintenance.json" })).toThrow("maintenance sentinel");
  expect(exactLaunchdTemplateLabel("<key>Label</key><string>a</string><key>Label</key><string>a</string>")).toBeNull();
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
