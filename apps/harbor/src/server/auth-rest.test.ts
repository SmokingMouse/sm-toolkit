import { expect, test } from "bun:test";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { ApprovalService } from "./approvals.js";
import type { AutomationService } from "./automation.js";
import { AuthService, type WebAuthnAdapter } from "./auth.js";
import { RunBus } from "./bus.js";
import { openDb } from "./db.js";
import { buildRest } from "./rest.js";
import { RunCoordinator } from "./scheduler.js";
import { HarborStore } from "./store.js";
import type { DeviceHub } from "./ws.js";

class RestFakeWebAuthn implements WebAuthnAdapter {
  private registrationCount = 0;
  async registrationOptions(input: Parameters<WebAuthnAdapter["registrationOptions"]>[0]) {
    return {
      challenge: "rest-register-challenge",
      rp: { id: input.rpId, name: input.rpName },
      user: { id: "YWNfYm9vdHN0cmFw", name: input.account.id, displayName: input.account.displayName },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
    } as PublicKeyCredentialCreationOptionsJSON;
  }
  async authenticationOptions(input: Parameters<WebAuthnAdapter["authenticationOptions"]>[0]) {
    return { challenge: "rest-auth-challenge", rpId: input.rpId, allowCredentials: [] } as PublicKeyCredentialRequestOptionsJSON;
  }
  async verifyRegistration() {
    this.registrationCount += 1;
    return {
      verified: true,
      credential: { id: `rest-credential-${this.registrationCount}`, publicKey: Uint8Array.from([1]), counter: 0, transports: ["internal"] },
    };
  }
  async verifyAuthentication() {
    return { verified: true, newCounter: 1 };
  }
}

function cookieMap(response: Response): Map<string, string> {
  const raw = response.headers.get("set-cookie") ?? "";
  const map = new Map<string, string>();
  for (const match of raw.matchAll(/(?:^|,\s*)([a-zA-Z0-9_]+)=([^;,]*)/g)) {
    map.set(match[1]!, match[2]!);
  }
  return map;
}

function cookieHeader(cookies: Map<string, string>): string {
  return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

test("REST bootstrap/login uses HttpOnly session, CSRF origin gate, PAT self-service, and Workspace switching", async () => {
  const store = new HarborStore(openDb(":memory:"));
  const auth = new AuthService(store, {
    origin: "https://harbor.example.test",
    rpId: "harbor.example.test",
    rpName: "Harbor Test",
    secureCookie: true,
  }, new RestFakeWebAuthn());
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
  );

  expect((await app.request("/api/auth/bootstrap/status")).status).toBe(200);
  const deniedOptions = await app.request("/api/auth/bootstrap/options", { method: "POST" });
  expect(deniedOptions.status).toBe(403);
  const options = await app.request("/api/auth/bootstrap/options", {
    method: "POST",
    headers: { Authorization: "Bearer system-token", "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "Owner" }),
  });
  expect(options.status).toBe(200);
  const challengeCookies = cookieMap(options);
  expect(challengeCookies.has("harbor_auth_challenge")).toBe(true);

  const verified = await app.request("/api/auth/bootstrap/verify", {
    method: "POST",
    headers: {
      Authorization: "Bearer system-token",
      Cookie: cookieHeader(challengeCookies),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ response: { id: "rest-credential" } as RegistrationResponseJSON }),
  });
  expect(verified.status).toBe(200);
  let sessionCookies = cookieMap(verified);
  expect(sessionCookies.has("harbor_session")).toBe(true);
  expect(sessionCookies.has("harbor_csrf")).toBe(true);
  const bootstrapBody = await verified.json() as { recoveryCodes: string[]; csrfToken: string };
  expect(bootstrapBody.recoveryCodes).toHaveLength(10);
  expect(sessionCookies.get("harbor_csrf")).toBe(bootstrapBody.csrfToken);

  const me = await app.request("/api/me", { headers: { Cookie: cookieHeader(sessionCookies) } });
  expect(me.status).toBe(200);
  expect(await me.json()).toEqual(expect.objectContaining({
    kind: "account",
    account: expect.objectContaining({ id: "acc_bootstrap", displayName: "Owner" }),
    memberships: [expect.objectContaining({ workspaceId: "ws_personal", accountId: "acc_bootstrap" })],
  }));

  const firstPasskeys = await app.request("/api/accounts/me/passkeys", { headers: { Cookie: cookieHeader(sessionCookies) } });
  expect(firstPasskeys.status).toBe(200);
  expect(await firstPasskeys.json()).toHaveLength(1);
  const passkeyOptions = await app.request("/api/accounts/me/passkeys/options", {
    method: "POST",
    headers: {
      Cookie: cookieHeader(sessionCookies),
      Origin: "https://harbor.example.test",
      "X-Harbor-CSRF": sessionCookies.get("harbor_csrf")!,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  expect(passkeyOptions.status).toBe(200);
  const registrationCookies = new Map([...sessionCookies, ...cookieMap(passkeyOptions)]);
  const addedPasskey = await app.request("/api/accounts/me/passkeys/verify", {
    method: "POST",
    headers: {
      Cookie: cookieHeader(registrationCookies),
      Origin: "https://harbor.example.test",
      "X-Harbor-CSRF": sessionCookies.get("harbor_csrf")!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ response: { id: "new-passkey" } as RegistrationResponseJSON, label: "Backup" }),
  });
  expect(addedPasskey.status).toBe(200);
  sessionCookies = new Map([...sessionCookies, ...cookieMap(addedPasskey)]);
  const secondPasskeys = await app.request("/api/accounts/me/passkeys", { headers: { Cookie: cookieHeader(sessionCookies) } });
  expect(await secondPasskeys.json()).toHaveLength(2);

  const missingCsrf = await app.request("/api/workspaces", {
    method: "POST",
    headers: { Cookie: cookieHeader(sessionCookies), "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Team" }),
  });
  expect(missingCsrf.status).toBe(403);
  const writeHeaders = {
    Cookie: cookieHeader(sessionCookies),
    Origin: "https://harbor.example.test",
    "X-Harbor-CSRF": sessionCookies.get("harbor_csrf")!,
    "Content-Type": "application/json",
  };
  const runDevice = store.upsertDevice("runner", "hash", { clis: { codex: "1" }, endpoints: [] }, 20);
  const runRepository = store.createRepository({ workspaceId: "ws_personal", name: "principal-fixture" }, 21);
  store.setRepositoryMount(runRepository.id, runDevice.id, "/principal-fixture", 22);
  const runAgent = store.createAgent({
    name: "principal-agent",
    deviceId: runDevice.id,
    backend: "codex",
    repositoryId: runRepository.id,
  }, 23);
  const runConversation = store.createConversation({
    workspaceId: "ws_personal",
    kind: "issue",
    title: "Principal fixture",
    description: "Run as the logged-in caller",
    agentId: runAgent.id,
    repositoryId: runRepository.id,
  }, 24);
  const runResponse = await app.request(`/api/conversations/${runConversation.id}/runs`, {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({ prompt: "Implement it" }),
  });
  expect(runResponse.status).toBe(201);
  const accountRun = store.listRunsByConversation(runConversation.id)[0]!;
  expect(accountRun.principal).toEqual({
    type: "account",
    id: "acc_bootstrap",
    membershipId: store.membershipForAccount("acc_bootstrap", "ws_personal")!.id,
    initiator: expect.objectContaining({ kind: "api", credential: "session" }),
  });

  const createdWorkspaceResponse = await app.request("/api/workspaces", {
    method: "POST", headers: writeHeaders, body: JSON.stringify({ name: "Team", slug: "team" }),
  });
  expect(createdWorkspaceResponse.status).toBe(201);
  const team = await createdWorkspaceResponse.json() as { id: string; kind: string };
  expect(team.kind).toBe("team");
  const teamMembers = await (await app.request("/api/members", {
    headers: { Cookie: cookieHeader(sessionCookies), "X-Harbor-Workspace": team.id },
  })).json() as { id: string; role: string }[];
  const onlyOwner = teamMembers.find((member) => member.role === "owner")!;
  const removeLastOwner = await app.request(`/api/members/${onlyOwner.id}`, {
    method: "PATCH",
    headers: { ...writeHeaders, "X-Harbor-Workspace": team.id },
    body: JSON.stringify({ status: "disabled" }),
  });
  expect(removeLastOwner.status).toBe(400);
  expect(await removeLastOwner.json()).toEqual(expect.objectContaining({ error: "Workspace 必须保留至少一个 active owner" }));
  const workspaces = await (await app.request("/api/workspaces", { headers: { Cookie: cookieHeader(sessionCookies) } })).json() as unknown[];
  expect(workspaces).toHaveLength(2);

  const issuedPat = await app.request("/api/accounts/me/pats", {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({ label: "Read only", workspaceId: team.id, scopes: ["workspace:read"] }),
  });
  expect(issuedPat.status).toBe(201);
  const pat = await issuedPat.json() as { id: string; token: string };
  expect(pat.token).toStartWith("hpat_");
  expect((await app.request("/api/workspaces", { headers: { Authorization: `Bearer ${pat.token}`, "X-Harbor-Workspace": team.id } })).status).toBe(200);
  expect((await app.request("/api/workspaces", {
    method: "POST",
    headers: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Denied" }),
  })).status).toBe(403);

  const invitationResponse = await app.request("/api/invitations", {
    method: "POST",
    headers: { ...writeHeaders, "X-Harbor-Workspace": team.id },
    body: JSON.stringify({ email: "second@example.com", role: "member" }),
  });
  expect(invitationResponse.status).toBe(201);
  const invitation = await invitationResponse.json() as { token: string };
  const invitationOptions = await app.request("/api/auth/invitation/options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: invitation.token, displayName: "Second" }),
  });
  expect(invitationOptions.status).toBe(200);
  const invitationRegistrationCookies = cookieMap(invitationOptions);
  const invitationVerified = await app.request("/api/auth/invitation/verify", {
    method: "POST",
    headers: {
      Cookie: cookieHeader(invitationRegistrationCookies),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ response: { id: "second-passkey" } as RegistrationResponseJSON }),
  });
  expect(invitationVerified.status).toBe(200);
  const secondCookies = cookieMap(invitationVerified);
  const invitationRegistration = await invitationVerified.json() as {
    account: { id: string };
    membership: { accountId: string; workspaceId: string };
    personalWorkspace: { id: string; kind: string };
    recoveryCodes: string[];
  };
  expect(invitationRegistration.membership).toEqual(expect.objectContaining({
    accountId: invitationRegistration.account.id,
    workspaceId: team.id,
  }));
  expect(invitationRegistration.personalWorkspace.kind).toBe("personal");
  expect(invitationRegistration.recoveryCodes).toHaveLength(10);
  const secondWorkspaces = await (await app.request("/api/workspaces", {
    headers: { Cookie: cookieHeader(secondCookies), "X-Harbor-Workspace": team.id },
  })).json() as unknown[];
  expect(secondWorkspaces).toHaveLength(2);
  expect((await app.request("/api/agents", {
    headers: { Cookie: cookieHeader(secondCookies), "X-Harbor-Workspace": "ws_personal" },
  })).status).toBe(403);
});
