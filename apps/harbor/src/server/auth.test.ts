import { expect, test } from "bun:test";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { AuthService, type WebAuthnAdapter } from "./auth.js";
import { openDb } from "./db.js";
import { HarborStore } from "./store.js";

const config = {
  origin: "https://harbor.example.test",
  rpId: "harbor.example.test",
  rpName: "Harbor Test",
  secureCookie: true,
};

class FakeWebAuthn implements WebAuthnAdapter {
  registrationChallenge = "registration-challenge";
  authenticationChallenge = "authentication-challenge";
  registrationExpected: string[] = [];
  authenticationExpected: string[] = [];

  async registrationOptions(input: Parameters<WebAuthnAdapter["registrationOptions"]>[0]) {
    expect(input.account.id).toBe("acc_bootstrap");
    return {
      challenge: this.registrationChallenge,
      rp: { id: input.rpId, name: input.rpName },
      user: { id: "YWNfYm9vdHN0cmFw", name: input.account.id, displayName: input.account.displayName },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
    } as PublicKeyCredentialCreationOptionsJSON;
  }

  async authenticationOptions(input: Parameters<WebAuthnAdapter["authenticationOptions"]>[0]) {
    return {
      challenge: this.authenticationChallenge,
      rpId: input.rpId,
      allowCredentials: [],
    } as PublicKeyCredentialRequestOptionsJSON;
  }

  async verifyRegistration(input: Parameters<WebAuthnAdapter["verifyRegistration"]>[0]) {
    this.registrationExpected.push(input.expectedChallenge, input.expectedOrigin, input.expectedRpId);
    return {
      verified: true,
      credential: {
        id: "credential_fixture",
        publicKey: Uint8Array.from([1, 2, 3]),
        counter: 7,
        transports: ["internal"],
      },
    };
  }

  async verifyAuthentication(input: Parameters<WebAuthnAdapter["verifyAuthentication"]>[0]) {
    this.authenticationExpected.push(input.expectedChallenge, input.expectedOrigin, input.expectedRpId);
    expect(input.credential.counter).toBe(7);
    return { verified: true, newCounter: 8 };
  }
}

const registrationResponse = { id: "credential_fixture" } as RegistrationResponseJSON;
const authenticationResponse = { id: "credential_fixture" } as AuthenticationResponseJSON;

test("bootstrap passkey creates one-time recovery codes and opaque hash-backed session", async () => {
  const store = new HarborStore(openDb(":memory:"));
  const adapter = new FakeWebAuthn();
  const auth = new AuthService(store, config, adapter);
  expect(auth.bootstrapState()).toEqual({ required: true });

  const begin = await auth.beginRegistration({ flow: "bootstrap", displayName: "Owner" }, 1_000);
  expect(begin.options.challenge).toBe(adapter.registrationChallenge);
  expect(begin.challengeToken).toStartWith("hchal_");
  const completed = await auth.finishRegistration({
    flow: "bootstrap",
    challengeToken: begin.challengeToken,
    response: registrationResponse,
    label: "Touch ID",
  }, 2_000);
  if (!completed.session) throw new Error("bootstrap test expected Session");
  expect(completed.account.id).toBe("acc_bootstrap");
  expect(completed.recoveryCodes).toHaveLength(10);
  expect(new Set(completed.recoveryCodes).size).toBe(10);
  expect(completed.session.sessionToken).toStartWith("hsess_");
  expect(completed.session.csrfToken).toStartWith("hcsrf_");
  expect(adapter.registrationExpected).toEqual([
    adapter.registrationChallenge,
    config.origin,
    config.rpId,
  ]);
  expect(auth.bootstrapState()).toEqual({ required: false });

  const session = auth.session(completed.session.sessionToken, 2_001);
  expect(session?.account.id).toBe("acc_bootstrap");
  expect(auth.verifyCsrf(session!.csrfTokenHash, completed.session.csrfToken)).toBe(true);
  expect(auth.verifyCsrf(session!.csrfTokenHash, "wrong")).toBe(false);
  await expect(auth.finishRegistration({
    flow: "bootstrap",
    challengeToken: begin.challengeToken,
    response: registrationResponse,
  }, 2_002)).rejects.toThrow("challenge");
  await expect(auth.beginRegistration({ flow: "bootstrap" }, 2_003)).rejects.toThrow("bootstrap 已完成");
});

test("discoverable passkey login consumes challenge, advances counter, and logout revokes session", async () => {
  const store = new HarborStore(openDb(":memory:"));
  const adapter = new FakeWebAuthn();
  const auth = new AuthService(store, config, adapter);
  const register = await auth.beginRegistration({ flow: "bootstrap" }, 1_000);
  const bootstrap = await auth.finishRegistration({
    flow: "bootstrap", challengeToken: register.challengeToken, response: registrationResponse,
  }, 1_100);
  if (!bootstrap.session) throw new Error("bootstrap test expected Session");
  auth.logout(bootstrap.session.sessionId, 1_200);
  expect(auth.session(bootstrap.session.sessionToken, 1_201)).toBeNull();

  const begin = await auth.beginAuthentication(1_300);
  const login = await auth.finishAuthentication({ challengeToken: begin.challengeToken, response: authenticationResponse }, 1_400);
  expect(login.account.id).toBe("acc_bootstrap");
  expect(store.getPasskeyByCredentialId("credential_fixture")?.signCount).toBe(8);
  expect(adapter.authenticationExpected).toEqual([
    adapter.authenticationChallenge,
    config.origin,
    config.rpId,
  ]);
  await expect(auth.finishAuthentication({ challengeToken: begin.challengeToken, response: authenticationResponse }, 1_401)).rejects.toThrow("challenge");
});

test("PAT remains constrained by live Membership and recovery code is single use", async () => {
  const store = new HarborStore(openDb(":memory:"));
  const adapter = new FakeWebAuthn();
  const auth = new AuthService(store, config, adapter);
  const register = await auth.beginRegistration({ flow: "bootstrap" }, 1_000);
  const bootstrap = await auth.finishRegistration({
    flow: "bootstrap", challengeToken: register.challengeToken, response: registrationResponse,
  }, 1_100);

  const issued = auth.issuePat({
    accountId: bootstrap.account.id,
    workspaceId: "ws_personal",
    label: "CLI",
    scopes: ["workspace:read", "agent:run"],
  }, 1_200);
  expect(issued.raw).toStartWith("hpat_");
  expect(auth.pat(issued.raw, 1_201)).toEqual(expect.objectContaining({
    account: expect.objectContaining({ id: "acc_bootstrap" }),
    token: expect.objectContaining({ workspaceId: "ws_personal", scopes: ["workspace:read", "agent:run"] }),
  }));
  expect(store.revokePersonalAccessToken(issued.token.id, bootstrap.account.id, 1_202)).toBe(true);
  expect(auth.pat(issued.raw, 1_203)).toBeNull();

  const recovered = auth.recover(bootstrap.account.id, bootstrap.recoveryCodes[0]!, 1_300);
  expect(recovered.account.id).toBe("acc_bootstrap");
  expect(() => auth.recover(bootstrap.account.id, bootstrap.recoveryCodes[0]!, 1_301)).toThrow("无效或已使用");
});

test("production SimpleWebAuthn adapter generates a discoverable RP-bound registration option under Bun", async () => {
  const store = new HarborStore(openDb(":memory:"));
  const auth = new AuthService(store, config);
  const begin = await auth.beginRegistration({ flow: "bootstrap" }, 1_000);
  expect(begin.options.rp.id).toBe(config.rpId);
  expect(begin.options.authenticatorSelection?.residentKey).toBe("required");
  expect(begin.options.authenticatorSelection?.userVerification).toBe("required");
  expect(begin.options.user.name).toBe("acc_bootstrap");
});
