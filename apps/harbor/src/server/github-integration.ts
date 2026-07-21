import { createHash, randomBytes } from "node:crypto";
import type {
  Account,
  AuthIdentity,
  GitHubAccountAuthorization,
  GitHubInstallation,
  GitHubRepositoryConnection,
  GitHubWorkspaceInstallation,
  HarborRepository,
  HarborWorkspace,
  WorkspaceMember,
} from "../protocol.js";
import type { AuthSessionMaterial, AuthService } from "./auth.js";
import { parseGitHubRepository } from "./github-delivery.js";
import type {
  GitHubInstallationSnapshot,
  GitHubRepositorySnapshot,
  GitHubUserProfile,
  GitHubUserTokenBundle,
} from "./github-app.js";
import { GitHubAppClient } from "./github-app.js";
import type { GitHubOAuthState, HarborStore } from "./store.js";
import {
  MemoryGitHubUserCredentialStore,
  type GitHubUserCredentialStore,
} from "./github-user-credentials.js";

const OAUTH_STATE_TTL_MS = 10 * 60_000;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rawState(): string {
  return `hgho_${randomBytes(32).toString("base64url")}`;
}

function canonicalRemote(repository: HarborRepository): string | null {
  if (!repository.remoteUrl) return null;
  try {
    const parsed = parseGitHubRepository(repository.remoteUrl);
    return `${parsed.owner}/${parsed.repo}`.toLowerCase();
  } catch {
    return null;
  }
}

export interface GitHubInstallationView {
  installation: GitHubInstallation;
  connection: GitHubWorkspaceInstallation;
  repositories: GitHubRepositoryConnection[];
}

export interface GitHubIntegrationView {
  configured: true;
  appSlug: string;
  identity: AuthIdentity | null;
  authorization: Omit<GitHubAccountAuthorization, "credentialRef"> | null;
  installations: GitHubInstallationView[];
}

export interface GitHubRepositorySyncResult {
  installationId: string;
  connected: number;
  created: number;
  reused: number;
  aliases: number;
  removed: number;
}

export interface GitHubOAuthCompletion {
  flow: GitHubOAuthState["flow"];
  account: Account;
  session: AuthSessionMaterial;
  returnTo: string;
  identity: AuthIdentity;
  membership?: WorkspaceMember;
  personalWorkspace?: HarborWorkspace;
  installation?: GitHubInstallation;
  sync?: GitHubRepositorySyncResult;
}

/** Account OAuth 与 Workspace App installation 的应用层；user token 只进入 server credential store。 */
export class GitHubIntegrationService {
  constructor(
    private readonly store: HarborStore,
    private readonly auth: AuthService,
    readonly client: GitHubAppClient,
    private readonly now: () => number = Date.now,
    private readonly credentials: GitHubUserCredentialStore = new MemoryGitHubUserCredentialStore(),
  ) {}

  view(accountId: string, workspaceId: string): GitHubIntegrationView {
    const identity = this.store.listAuthIdentities(accountId)
      .find((candidate) => candidate.provider === "github") ?? null;
    const authorization = this.store.getGitHubAccountAuthorization(accountId);
    const installations = this.store.listGitHubWorkspaceInstallations(workspaceId).map((connection) => {
      const installation = this.store.getGitHubInstallation(connection.installationId);
      if (!installation) throw new Error(`GitHub installation ${connection.installationId} 数据不完整`);
      return {
        installation,
        connection,
        repositories: this.store.listGitHubRepositoryConnections(workspaceId, connection.installationId),
      };
    });
    const safeAuthorization = authorization ? (({ credentialRef: _credentialRef, ...safe }) => safe)(authorization) : null;
    return { configured: true, appSlug: this.client.config.slug, identity, authorization: safeAuthorization, installations };
  }

  beginLogin(invitationToken?: string | null): { state: string; url: string } {
    const now = this.now();
    const state = rawState();
    if (invitationToken?.trim()) {
      const invitation = this.store.workspaceInvitationForToken(hash(invitationToken.trim()), now);
      if (!invitation) throw new Error("Invitation 不存在、已过期或已结束");
      this.store.createGitHubOAuthState({
        tokenHash: hash(state),
        flow: "invite",
        invitationId: invitation.id,
        returnTo: "/",
        expiresAt: now + OAUTH_STATE_TTL_MS,
      }, now);
    } else {
      this.store.createGitHubOAuthState({
        tokenHash: hash(state),
        flow: "login",
        returnTo: "/",
        expiresAt: now + OAUTH_STATE_TTL_MS,
      }, now);
    }
    return { state, url: this.client.authorizationUrl(state) };
  }

  beginLink(accountId: string): { state: string; url: string } {
    const account = this.store.getAccount(accountId);
    if (!account || account.status !== "active") throw new Error("Account 不存在或不可用");
    const now = this.now();
    const state = rawState();
    this.store.createGitHubOAuthState({
      tokenHash: hash(state),
      flow: "link",
      accountId,
      returnTo: "/settings?tab=account&github=linked",
      expiresAt: now + OAUTH_STATE_TTL_MS,
    }, now);
    return { state, url: this.client.authorizationUrl(state) };
  }

  beginInstall(accountId: string, workspaceId: string): { state: string; url: string } {
    const member = this.store.membershipForAccount(accountId, workspaceId);
    if (!member || member.status !== "active" || member.role === "member") {
      throw new Error("连接 GitHub App installation 需要 Workspace admin/owner");
    }
    const now = this.now();
    const state = rawState();
    this.store.createGitHubOAuthState({
      tokenHash: hash(state),
      flow: "install",
      accountId,
      workspaceId,
      returnTo: "/settings?tab=integrations&github=connected",
      expiresAt: now + OAUTH_STATE_TTL_MS,
    }, now);
    return { state, url: this.client.installationUrl(state) };
  }

  continueInstallation(state: string, installationId: string): string {
    const stored = this.store.attachGitHubInstallationToOAuthState(hash(state), installationId, this.now());
    if (!stored) throw new Error("GitHub installation setup state 无效、过期或已使用");
    return this.client.authorizationUrl(state);
  }

  async complete(state: string, code: string): Promise<GitHubOAuthCompletion> {
    const now = this.now();
    const stored = this.store.consumeGitHubOAuthState(hash(state), now);
    if (!stored) throw new Error("GitHub OAuth state 无效、过期或已使用");
    const tokenBundle = await this.client.exchangeUserCode(code);
    const user = await this.client.user(tokenBundle.accessToken);
    if (!/^[1-9][0-9]*$/.test(user.id)) throw new Error("GitHub user id 不是可信数字 subject");

    if (stored.flow === "login") {
      const identity = this.store.getAuthIdentity("github", user.id);
      if (!identity) throw new Error("该 GitHub 账号尚未绑定 Harbor Account");
      const account = this.activeAccount(identity.accountId);
      this.persistUserAuthorization(account.id, user.id, tokenBundle, now);
      return {
        flow: stored.flow,
        account,
        session: this.auth.createSession(account.id, now),
        returnTo: stored.returnTo,
        identity: this.store.upsertAuthIdentity({
          accountId: account.id,
          provider: "github",
          subject: user.id,
          email: user.email,
          verifiedAt: now,
        }, now),
      };
    }

    if (stored.flow === "invite") {
      if (!stored.invitationId) throw new Error("GitHub invitation OAuth state 缺少 invitation");
      const invitation = this.store.getWorkspaceInvitation(stored.invitationId);
      if (!invitation) throw new Error("Invitation 不存在");
      const verifiedEmails = invitation.email
        ? await this.client.verifiedUserEmails(tokenBundle.accessToken)
        : [];
      const completed = this.store.completeExternalInvitation({
        invitationId: invitation.id,
        provider: "github",
        subject: user.id,
        displayName: user.name ?? user.login,
        verifiedEmails,
      }, now);
      const identity = this.store.getAuthIdentity("github", user.id);
      if (!identity) throw new Error("GitHub invitation registration 未创建 AuthIdentity");
      this.persistUserAuthorization(completed.account.id, user.id, tokenBundle, now);
      return {
        flow: stored.flow,
        ...completed,
        session: this.auth.createSession(completed.account.id, now),
        returnTo: stored.returnTo,
        identity,
      };
    }

    if (!stored.accountId) throw new Error("GitHub OAuth state 缺少 Account");
    const account = this.activeAccount(stored.accountId);
    const linked = this.store.listAuthIdentities(account.id).find((candidate) => candidate.provider === "github");
    if (linked && linked.subject !== user.id) {
      throw new Error("Harbor Account 已绑定其他 GitHub identity；请先使用原 GitHub 账号授权");
    }
    const identity = this.store.upsertAuthIdentity({
      accountId: account.id,
      provider: "github",
      subject: user.id,
      email: user.email,
      verifiedAt: now,
    }, now);
    this.persistUserAuthorization(account.id, user.id, tokenBundle, now);
    if (stored.flow === "link") {
      return {
        flow: stored.flow,
        account,
        session: this.auth.createSession(account.id, now),
        returnTo: stored.returnTo,
        identity,
      };
    }

    if (!stored.workspaceId || !stored.installationId) {
      throw new Error("GitHub installation OAuth state 缺少 Workspace/installation");
    }
    const member = this.store.membershipForAccount(account.id, stored.workspaceId);
    if (!member || member.status !== "active" || member.role === "member") {
      throw new Error("OAuth callback 时 Account 已失去 Workspace admin/owner 权限");
    }
    const candidate = (await this.client.userInstallations(tokenBundle.accessToken))
      .find((installation) => installation.installationId === stored.installationId);
    if (!candidate) throw new Error("当前 GitHub 用户无权访问该 App installation");
    if (candidate.appId !== this.client.config.appId) throw new Error("GitHub installation 不属于当前 Harbor App");
    if (candidate.suspended) throw new Error("GitHub installation 已 suspended，不能连接");
    const installation = this.persistInstallation(candidate, account.id, stored.workspaceId, now);
    const sync = await this.syncInstallation(stored.workspaceId, installation.installationId, now);
    return {
      flow: stored.flow,
      account,
      session: this.auth.createSession(account.id, now),
      returnTo: stored.returnTo,
      identity,
      installation,
      sync,
    };
  }

  async syncInstallation(workspaceId: string, installationId: string, now = this.now()): Promise<GitHubRepositorySyncResult> {
    const connection = this.store.getGitHubWorkspaceInstallation(workspaceId, installationId);
    const installation = this.store.getGitHubInstallation(installationId);
    if (!connection || connection.status !== "active" || !installation || installation.status !== "active") {
      throw new Error("GitHub installation 未连接或不可用");
    }
    const repositories = await this.client.installationRepositories(installationId);
    let created = 0;
    let reused = 0;
    let aliases = 0;
    let connected = 0;
    for (const github of repositories) {
      const existingAliases = this.store.listGitHubRepositoryAliases(workspaceId, github.repositoryId);
      const selected = new Map<string, HarborRepository>();
      for (const existing of existingAliases) {
        const repository = this.store.getRepository(existing.repositoryId);
        if (repository && !repository.archivedAt && repository.scmProvider !== "codebase") {
          selected.set(repository.id, repository);
        }
      }
      for (const candidate of this.store.listRepositories(workspaceId)) {
        if (
          candidate.archivedAt ||
          candidate.scmProvider === "codebase" ||
          canonicalRemote(candidate) !== github.fullName.toLowerCase()
        ) continue;
        const current = this.store.githubRepositoryConnectionByRepository(candidate.id);
        if (current && current.githubRepositoryId !== github.repositoryId) continue;
        if (!selected.has(candidate.id)) reused++;
        selected.set(candidate.id, candidate);
      }
      if (selected.size === 0) {
        const repository = this.store.createRepository({
          workspaceId,
          name: this.uniqueRepositoryName(workspaceId, github),
          remoteUrl: `https://github.com/${github.fullName}.git`,
          defaultBranch: github.defaultBranch,
        }, now);
        selected.set(repository.id, repository);
        created++;
      }
      aliases += Math.max(0, selected.size - 1);
      connected += selected.size;
      for (const repository of selected.values()) {
        this.store.updateRepository(repository.id, {
          remoteUrl: `https://github.com/${github.fullName}.git`,
          defaultBranch: github.defaultBranch,
        }, now);
        this.store.upsertGitHubRepositoryConnection({
          workspaceId,
          repositoryId: repository.id,
          installationId,
          githubRepositoryId: github.repositoryId,
          fullName: github.fullName,
          defaultBranch: github.defaultBranch,
          private: github.private,
        }, now);
      }
    }
    const removed = this.store.markMissingGitHubRepositoriesRemoved(
      workspaceId,
      installationId,
      repositories.map((repository) => repository.repositoryId),
      now,
    );
    return {
      installationId,
      connected,
      created,
      reused,
      aliases,
      removed,
    };
  }

  async userAccessToken(accountId: string, forceRefresh = false): Promise<string> {
    const now = this.now();
    const authorization = this.store.getGitHubAccountAuthorization(accountId);
    if (!authorization || authorization.status !== "active") {
      throw new Error("当前 Harbor Account 的 GitHub 授权不可用；请重新授权 GitHub");
    }
    let bundle: GitHubUserTokenBundle;
    try {
      bundle = this.credentials.read(authorization.credentialRef);
    } catch {
      this.store.requireGitHubReauthorization(accountId, now);
      throw new Error("GitHub Account credential 不存在或不可读；请重新授权 GitHub");
    }
    const expiring = bundle.accessExpiresAt !== null && bundle.accessExpiresAt - now <= 60_000;
    if (!forceRefresh && !expiring) return bundle.accessToken;
    const refreshUsable = !!bundle.refreshToken
      && (bundle.refreshExpiresAt === null || bundle.refreshExpiresAt - now > 60_000);
    if (!refreshUsable) {
      this.store.requireGitHubReauthorization(accountId, now);
      throw new Error("GitHub user authorization 已过期或失效；请重新授权 GitHub");
    }
    const refreshed = await this.client.refreshUserToken(bundle.refreshToken!);
    this.credentials.write(authorization.credentialRef, refreshed);
    this.store.refreshGitHubAccountAuthorization({
      accountId,
      scopes: refreshed.scopes,
      accessExpiresAt: refreshed.accessExpiresAt,
      refreshExpiresAt: refreshed.refreshExpiresAt,
    }, now);
    return refreshed.accessToken;
  }

  revokeUserAuthorization(accountId: string): boolean {
    const authorization = this.store.getGitHubAccountAuthorization(accountId);
    if (!authorization) return false;
    // 先撤销 DB capability；即使 secret 文件清理遇到 host I/O 错误，也不能继续执行。
    this.store.revokeGitHubAccountAuthorization(accountId, this.now());
    this.credentials.delete(authorization.credentialRef);
    return true;
  }

  disconnect(workspaceId: string, installationId: string): boolean {
    this.client.clearInstallationToken(installationId);
    return this.store.disconnectGitHubInstallation(workspaceId, installationId, this.now());
  }

  private persistInstallation(
    input: GitHubInstallationSnapshot,
    accountId: string,
    workspaceId: string,
    now: number,
  ): GitHubInstallation {
    const installation = this.store.upsertGitHubInstallation({
      installationId: input.installationId,
      appId: input.appId,
      targetId: input.targetId,
      targetType: input.targetType,
      targetLogin: input.targetLogin,
      repositorySelection: input.repositorySelection,
      permissions: input.permissions,
      status: input.suspended ? "suspended" : "active",
    }, now);
    this.store.connectGitHubInstallation({ workspaceId, installationId: input.installationId, connectedByAccountId: accountId }, now);
    return installation;
  }

  private activeAccount(accountId: string): Account {
    const account = this.store.getAccount(accountId);
    if (!account || account.status !== "active") throw new Error("Harbor Account 不存在或已停用");
    return account;
  }

  private persistUserAuthorization(
    accountId: string,
    githubUserId: string,
    bundle: GitHubUserTokenBundle,
    now: number,
  ): GitHubAccountAuthorization {
    const previous = this.store.getGitHubAccountAuthorization(accountId);
    const credentialRef = `github-user-${randomBytes(24).toString("base64url")}`;
    this.credentials.write(credentialRef, bundle);
    let authorization: GitHubAccountAuthorization;
    try {
      authorization = this.store.upsertGitHubAccountAuthorization({
        accountId,
        githubUserId,
        credentialRef,
        scopes: bundle.scopes,
        accessExpiresAt: bundle.accessExpiresAt,
        refreshExpiresAt: bundle.refreshExpiresAt,
      }, now);
    } catch (error) {
      this.credentials.delete(credentialRef);
      throw error;
    }
    if (previous && previous.credentialRef !== credentialRef) {
      try {
        this.credentials.delete(previous.credentialRef);
      } catch (error) {
        // 新 ref 已成为唯一可执行 credential；旧文件清理失败不能回滚成 dangling DB ref。
        console.warn(`[github] obsolete user credential cleanup failed (${previous.credentialRef}): ${
          error instanceof Error ? error.message : String(error)
        }`);
      }
    }
    return authorization;
  }

  private uniqueRepositoryName(workspaceId: string, github: GitHubRepositorySnapshot): string {
    if (!this.store.getRepositoryByName(workspaceId, github.name)) return github.name;
    const owner = github.fullName.split("/")[0]!;
    const scoped = `${owner}/${github.name}`;
    if (!this.store.getRepositoryByName(workspaceId, scoped)) return scoped;
    let index = 2;
    while (this.store.getRepositoryByName(workspaceId, `${scoped} (${index})`)) index++;
    return `${scoped} (${index})`;
  }
}
