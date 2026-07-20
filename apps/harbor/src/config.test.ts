import { expect, test } from "bun:test";
import { assertPrivateConfigMetadata, githubWebhookSecret, parseGitHubAppConfig, parsePublicAuthConfig, parseSelfDeployTarget } from "./config.js";

const SECRETS = { HEALTH_TOKEN: "TOPSECRET", OTHER_HEALTH_TOKEN: "OTHERSECRET" };

test("public auth origin is admin-pinned and only permits HTTPS or localhost development", () => {
  expect(parsePublicAuthConfig("https://harbor.example.test")).toEqual({
    origin: "https://harbor.example.test",
    rpId: "harbor.example.test",
    rpName: "Harbor",
    secureCookie: true,
  });
  expect(parsePublicAuthConfig("http://localhost:7777")).toEqual(expect.objectContaining({
    origin: "http://localhost:7777", rpId: "localhost", secureCookie: false,
  }));
  expect(() => parsePublicAuthConfig(undefined)).toThrow("HARBOR_PUBLIC_URL 未设置");
  expect(() => parsePublicAuthConfig("http://harbor.example.test")).toThrow("必须是 https");
  expect(() => parsePublicAuthConfig("https://harbor.example.test/login")).toThrow("只能包含 origin");
  expect(() => parsePublicAuthConfig("https://user:secret@harbor.example.test")).toThrow("只能包含 origin");
});

test("GitHub webhook secret is independent from the API token", () => {
  const previousSecret = process.env.HARBOR_GITHUB_WEBHOOK_SECRET;
  const previousToken = process.env.HARBOR_GITHUB_TOKEN;
  try {
    process.env.HARBOR_GITHUB_WEBHOOK_SECRET = "webhook-only-secret";
    process.env.HARBOR_GITHUB_TOKEN = "api-token";
    expect(githubWebhookSecret()).toBe("webhook-only-secret");
  } finally {
    if (previousSecret === undefined) delete process.env.HARBOR_GITHUB_WEBHOOK_SECRET;
    else process.env.HARBOR_GITHUB_WEBHOOK_SECRET = previousSecret;
    if (previousToken === undefined) delete process.env.HARBOR_GITHUB_TOKEN;
    else process.env.HARBOR_GITHUB_TOKEN = previousToken;
  }
});

test("GitHub App config is all-or-nothing and reads private key through a file boundary", () => {
  const key = "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n";
  const configured = parseGitHubAppConfig({
    app: {
      app_id: "12345",
      client_id: "Iv1.fixture",
      client_secret: "client-secret-fixture",
      slug: "harbor-automation",
      private_key_path: "/secure/github-app.pem",
    },
    webhook_secret: "webhook-secret-fixture",
  }, {}, (path) => {
    expect(path).toBe("/secure/github-app.pem");
    return key;
  });
  expect(configured).toEqual({
    appId: "12345",
    clientId: "Iv1.fixture",
    clientSecret: "client-secret-fixture",
    slug: "harbor-automation",
    privateKey: key,
    privateKeyPath: "/secure/github-app.pem",
    webhookSecret: "webhook-secret-fixture",
  });
  expect(parseGitHubAppConfig(undefined, {})).toBeNull();
  expect(parseGitHubAppConfig({ webhook_secret: "legacy-webhook-secret" }, {})).toBeNull();
  expect(parseGitHubAppConfig(undefined, {
    HARBOR_GITHUB_WEBHOOK_SECRET: "legacy-webhook-secret",
  })).toBeNull();
  expect(() => parseGitHubAppConfig({ app: { app_id: "123" } }, {})).toThrow("配置不完整");
  expect(() => parseGitHubAppConfig({
    app: {
      app_id: "not-an-id",
      client_id: "Iv1.fixture",
      client_secret: "client-secret-fixture",
      slug: "harbor-automation",
      private_key_path: "/secure/github-app.pem",
    },
    webhook_secret: "webhook-secret-fixture",
  }, {}, () => key)).toThrow("app_id");
});

function configured(overrides: Record<string, unknown> = {}) {
  return {
    id: "local-harbor", name: "Local Harbor", provider: "local-launchd", repository_id: "repo_1",
    repository_path: "/repo", releases_path: "/releases", current_symlink_path: "/current",
    sqlite_path: "/db", state_path: "/state",
    source: { remote: "origin", url: "https://example.test/harbor.git", allowed_refs: ["refs/heads/main"] },
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
  const target = parseSelfDeployTarget(configured(), SECRETS)!;
  expect(target).toEqual(expect.objectContaining({
    id: "local-harbor", provider: "local-launchd", repositoryPath: "/repo",
    commandTimeoutMs: 30 * 60_000,
  }));
  expect(target.services.map(({ role }) => role)).toEqual(["server", "daemon"]);
  expect(target.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(target.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify({ fingerprint: target.fingerprint, manifestHash: target.manifestHash })).not.toContain("TOPSECRET");

  const rotatedSecret = parseSelfDeployTarget(configured(), { ...SECRETS, HEALTH_TOKEN: "ROTATED" })!;
  expect(rotatedSecret.fingerprint).toBe(target.fingerprint);
  const serverProjection = parseSelfDeployTarget(configured(), {}, { resolveSecrets: false })!;
  expect(serverProjection.health.headers).toEqual({});
  expect(serverProjection.fingerprint).toBe(target.fingerprint);
  expect(parseSelfDeployTarget(configured({ environment: { BUILD_MODE: "debug" } }), SECRETS)!.fingerprint).not.toBe(target.fingerprint);
  expect(parseSelfDeployTarget(configured({ command_timeout_ms: 42 }), SECRETS)!.fingerprint).not.toBe(target.fingerprint);
  expect(parseSelfDeployTarget(configured({
    health: { url: "http://127.0.0.1:7777/api/health", timeout_ms: 99, headers: { Authorization: { env: "HEALTH_TOKEN" } } },
  }), SECRETS)!.fingerprint).not.toBe(target.fingerprint);
});

test("self-deploy parser accepts one target and requires exactly one server plus daemon", () => {
  expect(() => parseSelfDeployTarget([configured()], SECRETS)).toThrow("单个 object");
  expect(() => parseSelfDeployTarget(configured({ services: [] }), SECRETS)).toThrow("server + daemon");
  expect(() => parseSelfDeployTarget(configured({ services: [configured().services[0]] }), SECRETS)).toThrow("server + daemon");
  expect(() => parseSelfDeployTarget(configured({
    services: [configured().services[0], { ...(configured().services as Record<string, unknown>[])[1], role: "server" }],
  }), SECRETS)).toThrow("恰有一个 server");
});

test("parser rejects non-canonical paths, remote health, reserved env, missing secret refs and credential argv", () => {
  expect(() => parseSelfDeployTarget(configured({ repository_path: "/repo/../repo" }), SECRETS)).toThrow("lexical canonical");
  expect(() => parseSelfDeployTarget(configured({ state_path: "/releases/state" }), SECRETS)).toThrow("必须互不包含");
  expect(() => parseSelfDeployTarget(configured({ health: { url: "https://example.com/health" } }), SECRETS)).toThrow("loopback");
  expect(() => parseSelfDeployTarget(configured({ environment: { HARBOR_TOKEN: "secret" } }), SECRETS)).toThrow("保留/敏感变量");
  expect(() => parseSelfDeployTarget(configured({ environment: { BUILD_MODE: "Authorization: Bearer TOPSECRET" } }), SECRETS)).toThrow("credential-like");
  expect(() => parseSelfDeployTarget(configured({ environment: { BUILD_MODE: "TOPSECRET" } }), SECRETS)).toThrow("配置 secret");
  expect(() => parseSelfDeployTarget(configured(), {})).toThrow("HEALTH_TOKEN 未配置");
  expect(() => parseSelfDeployTarget(configured({ steps: { build: [["curl", "Authorization: Bearer TOPSECRET"]] } }), SECRETS)).toThrow("credential-like");
  expect(() => parseSelfDeployTarget(configured({ steps: { build: [["curl", "-H", "Authorization:", "Bearer", "TOPSECRET"]] } }), SECRETS)).toThrow("credential-like");
  expect(() => parseSelfDeployTarget(configured({ steps: { build: [["tool", "--password", "not-a-configured-secret"]] } }), SECRETS)).toThrow("credential-like");
  expect(() => parseSelfDeployTarget(configured({ source: {
    remote: "origin", url: "https://example.test/harbor.git", allowed_refs: ["refs/remotes/origin/main"],
  } }), SECRETS)).toThrow("固定 remote refs/heads");
  expect(() => parseSelfDeployTarget(configured({ source: { remote: "origin", url: "https://user:pass@example.test/repo", allowed_refs: ["refs/heads/main"] } }), SECRETS)).toThrow("credential");
  expect(() => parseSelfDeployTarget(configured(), SECRETS, { maintenancePath: "/state/global-maintenance.json" })).toThrow("maintenance sentinel");
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
