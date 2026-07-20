import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { GitHubAppConfig } from "../config.js";
import type { ApprovalService } from "./approvals.js";
import type { AutomationService } from "./automation.js";
import { AuthService } from "./auth.js";
import { RunBus } from "./bus.js";
import { openDb } from "./db.js";
import { GitHubAppClient } from "./github-app.js";
import { GitHubIntegrationService } from "./github-integration.js";
import { buildRest } from "./rest.js";
import { RunCoordinator } from "./scheduler.js";
import { HarborStore } from "./store.js";
import type { DeviceHub } from "./ws.js";

const NOW = 1_800_000_000_000;
const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ format: "pem", type: "pkcs8" }).toString();

function cookie(response: Response, name: string): string {
  const match = (response.headers.get("set-cookie") ?? "").match(new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`));
  return match?.[1] ?? "";
}

function harness() {
  const store = new HarborStore(openDb(":memory:"));
  const workspace = store.defaultWorkspace();
  const repository = store.createRepository({
    workspaceId: workspace.id,
    name: "sm-toolkit",
    remoteUrl: "https://github.com/SmokingMouse/sm-toolkit.git",
  }, NOW - 100);
  const auth = new AuthService(store, {
    origin: "https://harbor.example.test",
    rpId: "harbor.example.test",
    rpName: "Harbor",
    secureCookie: true,
  });
  const config: GitHubAppConfig = {
    appId: "12345",
    clientId: "Iv1.fixture",
    clientSecret: "client-secret-fixture",
    slug: "harbor-automation",
    privateKey: PRIVATE_KEY,
    privateKeyPath: "/secure/github-app.pem",
    webhookSecret: "webhook-secret-fixture",
  };
  const fetchMock = (async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname;
    if (path === "/login/oauth/access_token") return Response.json({ access_token: "ghu_callback_only" });
    if (path === "/user") return Response.json({ id: 42, login: "SmokingMouse", name: "Owner", email: null, avatar_url: null });
    if (path === "/user/installations") return Response.json({ installations: [{
      id: 77,
      app_id: 12345,
      target_id: 42,
      target_type: "User",
      account: { id: 42, login: "SmokingMouse" },
      repository_selection: "selected",
      permissions: { contents: "write", pull_requests: "write" },
      suspended_at: null,
    }] });
    if (path === "/app/installations/77/access_tokens") {
      return Response.json({ token: "ghs_memory_only", expires_at: new Date(NOW + 3_600_000).toISOString() });
    }
    if (path === "/installation/repositories") return Response.json({ repositories: [{
      id: 99,
      name: "sm-toolkit",
      full_name: "SmokingMouse/sm-toolkit",
      private: false,
      default_branch: "main",
      html_url: "https://github.com/SmokingMouse/sm-toolkit",
    }] });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const client = new GitHubAppClient(config, { fetch: fetchMock, now: () => NOW });
  const integration = new GitHubIntegrationService(store, auth, client, () => NOW);
  const bus = new RunBus();
  const coordinator = new RunCoordinator(store, bus, { isOnline: () => false, send: () => false }, 2);
  const app = buildRest(
    store,
    bus,
    { onlineIds: () => new Set<string>(), isOnline: () => false } as unknown as DeviceHub,
    coordinator,
    {} as ApprovalService,
    {} as AutomationService,
    "system-token",
    undefined,
    undefined,
    "",
    undefined,
    undefined,
    undefined,
    auth,
    null,
    config.webhookSecret,
    integration,
  );
  return { app, auth, store, workspace, repository };
}

describe("GitHub OAuth REST boundary", () => {
  test("sets an HttpOnly state cookie and completes linked login exactly once", async () => {
    const h = harness();
    h.store.createAuthIdentity({ accountId: "acc_bootstrap", provider: "github", subject: "42", verifiedAt: NOW }, NOW);
    const started = await h.app.request("/api/auth/github/login", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(started.status).toBe(200);
    expect(started.headers.get("set-cookie")).toContain("harbor_github_state=");
    expect(started.headers.get("set-cookie")).toContain("HttpOnly");
    const state = cookie(started, "harbor_github_state");
    const callback = await h.app.request(`/api/auth/github/callback?state=${encodeURIComponent(state)}&code=fixture`, {
      headers: { Cookie: `harbor_github_state=${state}` },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/");
    expect(callback.headers.get("set-cookie")).toContain("harbor_session=");
    const replay = await h.app.request(`/api/auth/github/callback?state=${encodeURIComponent(state)}&code=fixture`, {
      headers: { Cookie: `harbor_github_state=${state}` },
    });
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toContain("github_error=");
  });

  test("installation setup keeps the same state, rechecks user access, and creates repository mapping", async () => {
    const h = harness();
    const session = h.auth.createSession("acc_bootstrap", NOW);
    const commonHeaders = {
      Cookie: `harbor_session=${session.sessionToken}; harbor_csrf=${session.csrfToken}`,
      Origin: "https://harbor.example.test",
      "X-Harbor-CSRF": session.csrfToken,
      "X-Harbor-Workspace": h.workspace.id,
      "Content-Type": "application/json",
    };
    const started = await h.app.request("/api/integrations/github/install", {
      method: "POST",
      headers: commonHeaders,
      body: "{}",
    });
    expect(started.status).toBe(200);
    const state = cookie(started, "harbor_github_state");
    const setup = await h.app.request(`/api/auth/github/setup?state=${encodeURIComponent(state)}&installation_id=77&setup_action=install`, {
      headers: { Cookie: `harbor_github_state=${state}` },
    });
    expect(setup.status).toBe(302);
    expect(setup.headers.get("location")).toContain("/login/oauth/authorize");
    const callback = await h.app.request(`/api/auth/github/callback?state=${encodeURIComponent(state)}&code=fixture`, {
      headers: { Cookie: `harbor_github_state=${state}` },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/settings?tab=integrations&github=connected");
    expect(h.store.githubRepositoryConnectionForRepository(h.repository.id)).toEqual(expect.objectContaining({
      installationId: "77",
      githubRepositoryId: "99",
    }));
  });
});
