import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoUint8Array } from "@simplewebauthn/server/helpers";
import { createHash, randomBytes } from "node:crypto";
import type { HarborPublicAuthConfig } from "../config.js";
import type { Account, PersonalAccessTokenScope } from "../protocol.js";
import { HarborStore } from "./store.js";

const CHALLENGE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const RECOVERY_CODE_COUNT = 10;

export interface WebAuthnRegistrationResult {
  verified: boolean;
  credential?: {
    id: string;
    publicKey: Uint8Array;
    counter: number;
    transports: string[];
  };
}

export interface WebAuthnAuthenticationResult {
  verified: boolean;
  newCounter?: number;
}

export interface WebAuthnAdapter {
  registrationOptions(input: {
    account: Account;
    rpName: string;
    rpId: string;
    excludeCredentials: { id: string; transports: string[] }[];
  }): Promise<PublicKeyCredentialCreationOptionsJSON>;
  authenticationOptions(input: { rpId: string }): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyRegistration(input: {
    response: RegistrationResponseJSON;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
  }): Promise<WebAuthnRegistrationResult>;
  verifyAuthentication(input: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
    credential: { id: string; publicKey: Uint8Array; counter: number; transports: string[] };
  }): Promise<WebAuthnAuthenticationResult>;
}

export class SimpleWebAuthnAdapter implements WebAuthnAdapter {
  registrationOptions(input: Parameters<WebAuthnAdapter["registrationOptions"]>[0]) {
    return generateRegistrationOptions({
      rpName: input.rpName,
      rpID: input.rpId,
      userName: input.account.id,
      userDisplayName: input.account.displayName,
      userID: isoUint8Array.fromUTF8String(input.account.id),
      attestationType: "none",
      excludeCredentials: input.excludeCredentials.map((credential) => ({
        id: credential.id,
        transports: credential.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      supportedAlgorithmIDs: [-7, -257],
    });
  }

  authenticationOptions(input: Parameters<WebAuthnAdapter["authenticationOptions"]>[0]) {
    return generateAuthenticationOptions({
      rpID: input.rpId,
      allowCredentials: [],
      userVerification: "required",
    });
  }

  async verifyRegistration(input: Parameters<WebAuthnAdapter["verifyRegistration"]>[0]): Promise<WebAuthnRegistrationResult> {
    const verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    });
    if (!verification.verified) return { verified: false };
    return {
      verified: true,
      credential: {
        id: verification.registrationInfo.credential.id,
        publicKey: new Uint8Array(verification.registrationInfo.credential.publicKey),
        counter: verification.registrationInfo.credential.counter,
        transports: verification.registrationInfo.credential.transports ?? [],
      },
    };
  }

  async verifyAuthentication(input: Parameters<WebAuthnAdapter["verifyAuthentication"]>[0]): Promise<WebAuthnAuthenticationResult> {
    const verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRpId,
      credential: {
        id: input.credential.id,
        publicKey: Uint8Array.from(input.credential.publicKey),
        counter: input.credential.counter,
        transports: input.credential.transports as AuthenticatorTransportFuture[],
      },
      requireUserVerification: true,
    });
    return {
      verified: verification.verified,
      newCounter: verification.verified ? verification.authenticationInfo.newCounter : undefined,
    };
  }
}

export interface AuthSessionMaterial {
  sessionId: string;
  sessionToken: string;
  csrfToken: string;
  expiresAt: number;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secret(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

function recoveryCode(): string {
  const raw = randomBytes(10).toString("hex").toUpperCase();
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
}

export class AuthService {
  constructor(
    private store: HarborStore,
    readonly config: HarborPublicAuthConfig,
    private webauthn: WebAuthnAdapter = new SimpleWebAuthnAdapter(),
  ) {}

  bootstrapState(): { required: boolean } {
    return { required: !this.store.hasLoginOwner() };
  }

  private accountForBootstrap(displayName?: string): Account {
    const account = this.store.getAccount("acc_bootstrap");
    if (!account || account.status !== "active") throw new Error("bootstrap Account 不存在或不可用");
    if (displayName?.trim() && displayName.trim() !== account.displayName) {
      // 迁移 Account 的名称更新由 profile API 在完成登录后处理；ceremony 使用当前稳定记录。
      return { ...account, displayName: displayName.trim() };
    }
    return account;
  }

  async beginRegistration(input: {
    flow: "bootstrap" | "register";
    accountId?: string;
    displayName?: string;
  }, now = Date.now()): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeToken: string; account: Account }> {
    if (input.flow === "bootstrap" && this.store.hasLoginOwner()) throw new Error("bootstrap 已完成");
    const account = input.flow === "bootstrap"
      ? this.accountForBootstrap(input.displayName)
      : this.store.getAccount(input.accountId ?? "");
    if (!account || account.status !== "active") throw new Error("Account 不存在或不可用");
    const options = await this.webauthn.registrationOptions({
      account,
      rpName: this.config.rpName,
      rpId: this.config.rpId,
      excludeCredentials: this.store.listPasskeys(account.id)
        .filter((passkey) => passkey.revokedAt === null)
        .map((passkey) => ({ id: passkey.credentialId, transports: passkey.transports })),
    });
    const challengeToken = secret("hchal_");
    this.store.createAuthChallenge({
      tokenHash: hash(challengeToken),
      flow: input.flow,
      accountId: account.id,
      displayName: input.flow === "bootstrap" ? account.displayName : null,
      challenge: options.challenge,
      expiresAt: now + CHALLENGE_TTL_MS,
    }, now);
    return { options, challengeToken, account };
  }

  async finishRegistration(input: {
    flow: "bootstrap" | "register";
    challengeToken: string;
    accountId?: string;
    response: RegistrationResponseJSON;
    label?: string | null;
  }, now = Date.now()): Promise<{ account: Account; recoveryCodes: string[]; session: AuthSessionMaterial | null }> {
    const challenge = this.store.consumeAuthChallenge(hash(input.challengeToken), input.flow, now);
    if (!challenge?.accountId) throw new Error("Passkey registration challenge 无效、过期或已使用");
    if (input.flow === "register" && challenge.accountId !== input.accountId) {
      throw new Error("Passkey registration challenge 与当前 Account 不匹配");
    }
    if (input.flow === "bootstrap" && this.store.hasLoginOwner()) throw new Error("bootstrap 已完成");
    const verification = await this.webauthn.verifyRegistration({
      response: input.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.config.origin,
      expectedRpId: this.config.rpId,
    });
    if (!verification.verified || !verification.credential) throw new Error("Passkey registration verification 失败");
    this.store.createPasskey({
      accountId: challenge.accountId,
      credentialId: verification.credential.id,
      publicKey: verification.credential.publicKey,
      signCount: verification.credential.counter,
      transports: verification.credential.transports,
      label: input.label ?? null,
    }, now);
    if (input.flow === "bootstrap" && challenge.displayName) {
      this.store.updateAccountDisplayName(challenge.accountId, challenge.displayName, now);
    }
    const recoveryCodes = input.flow === "bootstrap"
      ? Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode)
      : [];
    if (recoveryCodes.length) this.store.createRecoveryCodes(challenge.accountId, recoveryCodes.map(hash), now);
    const account = this.store.getAccount(challenge.accountId)!;
    return {
      account,
      recoveryCodes,
      session: input.flow === "bootstrap" ? this.createSession(account.id, now) : null,
    };
  }

  async beginInvitationRegistration(input: {
    invitationToken: string;
    displayName: string;
  }, now = Date.now()): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeToken: string }> {
    const invitation = this.store.workspaceInvitationForToken(hash(input.invitationToken), now);
    if (!invitation) throw new Error("Invitation 不存在、已过期或已结束");
    if (!input.displayName.trim()) throw new Error("displayName 不能为空");
    if (invitation.email && this.store.hasActiveAccountWithEmail(invitation.email)) {
      throw new Error("该邮箱已有 Account，请先用 Passkey 登录再接受 Invitation");
    }
    const account = this.store.invitationRegistrationAccount(invitation.id) ?? this.store.createAccount({
      displayName: input.displayName.trim(),
      primaryEmail: invitation.email,
      status: "suspended",
    }, now);
    const options = await this.webauthn.registrationOptions({
      account,
      rpName: this.config.rpName,
      rpId: this.config.rpId,
      excludeCredentials: [],
    });
    const challengeToken = secret("hchal_");
    this.store.createAuthChallenge({
      tokenHash: hash(challengeToken),
      flow: "invite",
      accountId: account.id,
      invitationId: invitation.id,
      challenge: options.challenge,
      expiresAt: now + CHALLENGE_TTL_MS,
    }, now);
    return { options, challengeToken };
  }

  async finishInvitationRegistration(input: {
    challengeToken: string;
    response: RegistrationResponseJSON;
    label?: string | null;
  }, now = Date.now()) {
    const challenge = this.store.consumeAuthChallenge(hash(input.challengeToken), "invite", now);
    if (!challenge?.accountId || !challenge.invitationId) {
      throw new Error("Invitation registration challenge 无效、过期或已使用");
    }
    const verification = await this.webauthn.verifyRegistration({
      response: input.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.config.origin,
      expectedRpId: this.config.rpId,
    });
    if (!verification.verified || !verification.credential) throw new Error("Passkey registration verification 失败");
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
    const completed = this.store.completeInvitationRegistration({
      invitationId: challenge.invitationId,
      accountId: challenge.accountId,
      credential: verification.credential,
      passkeyLabel: input.label,
      recoveryCodeHashes: recoveryCodes.map(hash),
    }, now);
    return {
      ...completed,
      recoveryCodes,
      session: this.createSession(completed.account.id, now),
    };
  }

  async beginAuthentication(now = Date.now()): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challengeToken: string }> {
    if (!this.store.hasLoginOwner()) throw new Error("Harbor 尚未完成 first-owner bootstrap");
    const options = await this.webauthn.authenticationOptions({ rpId: this.config.rpId });
    const challengeToken = secret("hchal_");
    this.store.createAuthChallenge({
      tokenHash: hash(challengeToken),
      flow: "authenticate",
      challenge: options.challenge,
      expiresAt: now + CHALLENGE_TTL_MS,
    }, now);
    return { options, challengeToken };
  }

  async finishAuthentication(input: {
    challengeToken: string;
    response: AuthenticationResponseJSON;
  }, now = Date.now()): Promise<{ account: Account; session: AuthSessionMaterial }> {
    const challenge = this.store.consumeAuthChallenge(hash(input.challengeToken), "authenticate", now);
    if (!challenge) throw new Error("Passkey authentication challenge 无效、过期或已使用");
    const passkey = this.store.getPasskeyByCredentialId(input.response.id);
    if (!passkey) throw new Error("Passkey credential 不存在或已撤销");
    const verification = await this.webauthn.verifyAuthentication({
      response: input.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.config.origin,
      expectedRpId: this.config.rpId,
      credential: {
        id: passkey.credentialId,
        publicKey: passkey.publicKey,
        counter: passkey.signCount,
        transports: passkey.transports,
      },
    });
    if (!verification.verified || verification.newCounter === undefined) throw new Error("Passkey authentication verification 失败");
    this.store.updatePasskeyCounter(passkey.credentialId, verification.newCounter, now);
    const account = this.store.getAccount(passkey.accountId);
    if (!account || account.status !== "active") throw new Error("Account 不存在或已停用");
    return { account, session: this.createSession(account.id, now) };
  }

  recover(accountId: string, rawCode: string, now = Date.now()): { account: Account; session: AuthSessionMaterial } {
    const account = this.store.getAccount(accountId);
    if (!account || account.status !== "active") throw new Error("Account 不存在或已停用");
    if (!this.store.consumeRecoveryCode(accountId, hash(rawCode.trim().toUpperCase()), now)) {
      throw new Error("Recovery code 无效或已使用");
    }
    return { account, session: this.createSession(account.id, now) };
  }

  createSession(accountId: string, now = Date.now()): AuthSessionMaterial {
    const sessionToken = secret("hsess_");
    const csrfToken = secret("hcsrf_", 24);
    const expiresAt = now + SESSION_TTL_MS;
    const sessionId = this.store.createSession({
      accountId,
      tokenHash: hash(sessionToken),
      csrfTokenHash: hash(csrfToken),
      expiresAt,
    }, now);
    return { sessionId, sessionToken, csrfToken, expiresAt };
  }

  session(rawToken: string, now = Date.now()) {
    return this.store.accountForSession(hash(rawToken), now);
  }

  verifyCsrf(expectedHash: string, rawToken: string): boolean {
    return hash(rawToken) === expectedHash;
  }

  logout(sessionId: string, now = Date.now()): void {
    this.store.revokeSession(sessionId, now);
  }

  issuePat(input: {
    accountId: string;
    workspaceId?: string | null;
    label: string;
    scopes: PersonalAccessTokenScope[];
    expiresAt?: number | null;
  }, now = Date.now()) {
    const raw = secret("hpat_");
    const prefix = `${raw.slice(0, 12)}…`;
    const token = this.store.createPersonalAccessToken({
      ...input,
      prefix,
      tokenHash: hash(raw),
    }, now);
    return { token, raw };
  }

  pat(rawToken: string, now = Date.now()) {
    return this.store.accountForPersonalAccessToken(hash(rawToken), now);
  }
}
