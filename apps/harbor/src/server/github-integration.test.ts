import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import type { GitHubAppConfig } from "../config.js";
import { AuthService } from "./auth.js";
import { openDb } from "./db.js";
import { GitHubAppClient } from "./github-app.js";
import { GitHubIntegrationService } from "./github-integration.js";
import { HarborStore } from "./store.js";

const NOW = 1_800_000_000_000;
const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ format: "pem", type: "pkcs8" }).toString();

function appConfig(): GitHubAppConfig {
  return {
    appId: "12345",
    clientId: "Iv1.fixture",
    clientSecret: "client-secret-fixture",
    slug: "harbor-automation",
    privateKey: PRIVATE_KEY,
    privateKeyPath: "/secure/github-app.pem",
    webhookSecret: "webhook-secret-fixture",
  };
}

function harness() {
  const db = openDb(":memory:");
  const store = new HarborStore(db);
  const workspace = store.defaultWorkspace();
  const repository = store.createRepository({
    workspaceId: workspace.id,
    name: "sm-toolkit",
    remoteUrl: "git@github.com:SmokingMouse/sm-toolkit.git",
  }, NOW - 100);
  const calls: string[] = [];
  const fetchMock = (async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === "/login/oauth/access_token") return Response.json({ access_token: "ghu_transient_secret" });
    if (url.pathname === "/user") return Response.json({ id: 42, login: "smokingmouse", name: "Smoking Mouse", email: null, avatar_url: null });
    if (url.pathname === "/user/installations") return Response.json({ installations: [{
      id: 77, app_id: 12345, target_id: 42, target_type: "User",
      account: { id: 42, login: "SmokingMouse" }, repository_selection: "selected",
      permissions: { contents: "write", pull_requests: "write" }, suspended_at: null,
    }] });
    if (url.pathname === "/app/installations/77/access_tokens") {
      return Response.json({ token: "ghs_transient_secret", expires_at: new Date(NOW + 3_600_000).toISOString() });
    }
    if (url.pathname === "/installation/repositories") return Response.json({ repositories: [{
      id: 99, name: "sm-toolkit", full_name: "SmokingMouse/sm-toolkit", private: false,
      default_branch: "main", html_url: "https://github.com/SmokingMouse/sm-toolkit",
    }] });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const auth = new AuthService(store, { origin: "https://harbor.example.test", rpId: "harbor.example.test", rpName: "Harbor", secureCookie: true });
  const client = new GitHubAppClient(appConfig(), { fetch: fetchMock, now: () => NOW });
  const integration = new GitHubIntegrationService(store, auth, client, () => NOW);
  return { db, store, workspace, repository, calls, integration };
}

describe("GitHubIntegrationService", () => {
  test("links immutable user identity, proves installation ownership, and reuses one Harbor Repository", async () => {
    const h = harness();
    try {
      const started = h.integration.beginInstall("acc_bootstrap", h.workspace.id);
      const state = new URL(started.url).searchParams.get("state")!;
      expect(h.integration.continueInstallation(state, "77")).toContain("login/oauth/authorize");
      const completed = await h.integration.complete(state, "oauth-code");
      expect(completed.identity).toEqual(expect.objectContaining({ provider: "github", subject: "42", accountId: "acc_bootstrap" }));
      expect(completed.installation).toEqual(expect.objectContaining({ installationId: "77", targetLogin: "SmokingMouse" }));
      expect(completed.sync).toEqual(expect.objectContaining({ connected: 1, reused: 1, created: 0 }));
      expect(h.store.githubRepositoryConnectionForRepository(h.repository.id)).toEqual(expect.objectContaining({
        installationId: "77",
        githubRepositoryId: "99",
        fullName: "smokingmouse/sm-toolkit",
      }));
      expect(h.store.listRepositories(h.workspace.id)).toHaveLength(1);
      const serialized = Buffer.from(h.db.serialize()).toString("utf8");
      expect(serialized).not.toContain("ghu_transient_secret");
      expect(serialized).not.toContain("ghs_transient_secret");
      expect(serialized).not.toContain("client-secret-fixture");
      expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    } finally {
      h.db.close();
    }
  });

  test("GitHub login works only after explicit identity link and OAuth state is single-use", async () => {
    const h = harness();
    try {
      const login = h.integration.beginLogin();
      const state = new URL(login.url).searchParams.get("state")!;
      await expect(h.integration.complete(state, "oauth-code")).rejects.toThrow("尚未绑定");
      await expect(h.integration.complete(state, "oauth-code")).rejects.toThrow("state 无效");

      h.store.createAuthIdentity({
        accountId: "acc_bootstrap",
        provider: "github",
        subject: "42",
        verifiedAt: NOW,
      }, NOW);
      const linkedLogin = h.integration.beginLogin();
      const linkedState = new URL(linkedLogin.url).searchParams.get("state")!;
      const completed = await h.integration.complete(linkedState, "oauth-code");
      expect(completed.account.id).toBe("acc_bootstrap");
      expect(h.store.accountForSession(
        // session raw token is returned only to the REST cookie boundary; hash lookup proves it is valid.
        createHashForTest(completed.session.sessionToken),
        NOW,
      )?.account.id).toBe("acc_bootstrap");
    } finally {
      h.db.close();
    }
  });

  test("maps one GitHub repository identity to every intentional Harbor Repository alias", async () => {
    const h = harness();
    try {
      const releaseRepository = h.store.createRepository({
        workspaceId: h.workspace.id,
        name: "harbor-self-hosting",
        remoteUrl: "https://github.com/SmokingMouse/sm-toolkit.git",
      }, NOW - 50);
      const started = h.integration.beginInstall("acc_bootstrap", h.workspace.id);
      const state = new URL(started.url).searchParams.get("state")!;
      h.integration.continueInstallation(state, "77");
      const completed = await h.integration.complete(state, "oauth-code");
      expect(completed.sync).toEqual(expect.objectContaining({
        connected: 2,
        reused: 2,
        aliases: 1,
        created: 0,
      }));
      expect(h.store.githubRepositoryConnectionForRepository(h.repository.id)?.githubRepositoryId).toBe("99");
      expect(h.store.githubRepositoryConnectionForRepository(releaseRepository.id)?.githubRepositoryId).toBe("99");
      expect(h.store.githubConnectionsForWebhook("77", "99").map((connection) => connection.repositoryId).sort())
        .toEqual([h.repository.id, releaseRepository.id].sort());
    } finally {
      h.db.close();
    }
  });
});

function createHashForTest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
