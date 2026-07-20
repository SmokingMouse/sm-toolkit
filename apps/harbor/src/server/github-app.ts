import { createPrivateKey, sign } from "node:crypto";
import type { GitHubAppConfig } from "../config.js";

const API_VERSION = "2026-03-10";
const MAX_PAGES = 100;

export interface GitHubUserProfile {
  id: string;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface GitHubInstallationSnapshot {
  installationId: string;
  appId: string;
  targetId: string;
  targetType: "User" | "Organization";
  targetLogin: string;
  repositorySelection: "all" | "selected";
  permissions: Record<string, string>;
  suspended: boolean;
}

export interface GitHubRepositorySnapshot {
  repositoryId: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
}

interface GitHubAppClientOptions {
  fetch?: typeof fetch;
  apiBaseUrl?: string;
  webBaseUrl?: string;
  now?: () => number;
}

interface CachedInstallationToken {
  token: string;
  expiresAt: number;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`GitHub ${label} 缺失或格式不正确`);
  return value.trim();
}

function identifier(value: unknown, label: string): string {
  const result = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string" && /^[1-9][0-9]*$/.test(value)
      ? value
      : null;
  if (!result) throw new Error(`GitHub ${label} 缺失或超出安全整数范围`);
  return result;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`GitHub ${label} 不是 object`);
  return value as Record<string, unknown>;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** GitHub App 机器身份与短期凭证 client；user/installation token 只存进程内存。 */
export class GitHubAppClient {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: URL;
  private readonly webBaseUrl: URL;
  private readonly now: () => number;
  private readonly privateKey: ReturnType<typeof createPrivateKey>;
  private readonly installationTokens = new Map<string, CachedInstallationToken>();

  constructor(readonly config: GitHubAppConfig, options: GitHubAppClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.apiBaseUrl = new URL(options.apiBaseUrl ?? "https://api.github.com/");
    this.webBaseUrl = new URL(options.webBaseUrl ?? "https://github.com/");
    this.now = options.now ?? Date.now;
    try {
      this.privateKey = createPrivateKey(config.privateKey);
    } catch {
      throw new Error("GitHub App private key 无法解析");
    }
  }

  authorizationUrl(state: string): string {
    const url = new URL("login/oauth/authorize", this.webBaseUrl);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("state", state);
    return url.toString();
  }

  installationUrl(state: string): string {
    const url = new URL(`apps/${encodeURIComponent(this.config.slug)}/installations/new`, this.webBaseUrl);
    url.searchParams.set("state", state);
    return url.toString();
  }

  appJwt(): string {
    const nowSeconds = Math.floor(this.now() / 1_000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 9 * 60,
      iss: this.config.appId,
    }));
    const unsigned = `${header}.${payload}`;
    const signature = sign("RSA-SHA256", Buffer.from(unsigned), this.privateKey).toString("base64url");
    return `${unsigned}.${signature}`;
  }

  async exchangeUserCode(code: string): Promise<string> {
    if (!code.trim() || code.length > 512) throw new Error("GitHub OAuth code 缺失或格式不正确");
    const url = new URL("login/oauth/access_token", this.webBaseUrl);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code: code.trim(),
        }),
      });
    } catch (error) {
      throw new Error(`GitHub OAuth token exchange 网络失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const token = typeof body.access_token === "string" ? body.access_token.trim() : "";
    if (!response.ok || !token) {
      const reason = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      throw new Error(`GitHub OAuth token exchange 失败：${reason}`);
    }
    return token;
  }

  async user(token: string): Promise<GitHubUserProfile> {
    const body = await this.userRequest<Record<string, unknown>>(token, "user");
    return {
      id: identifier(body.id, "user id"),
      login: text(body.login, "user login"),
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : null,
      email: typeof body.email === "string" && body.email.trim() ? body.email.trim() : null,
      avatarUrl: typeof body.avatar_url === "string" && body.avatar_url.trim() ? body.avatar_url.trim() : null,
    };
  }

  async verifiedUserEmails(token: string): Promise<string[]> {
    const result: { email: string; primary: boolean }[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = await this.userRequest<unknown[]>(token, `user/emails?per_page=100&page=${page}`);
      if (!Array.isArray(items)) throw new Error("GitHub user emails 响应不是 array");
      for (const value of items) {
        const item = record(value, "user email");
        if (item.verified !== true) continue;
        const email = text(item.email, "verified user email").toLowerCase();
        if (seen.has(email)) continue;
        seen.add(email);
        result.push({ email, primary: item.primary === true });
      }
      if (items.length < 100) {
        return result.sort((a, b) => Number(b.primary) - Number(a.primary) || a.email.localeCompare(b.email))
          .map((entry) => entry.email);
      }
    }
    throw new Error("GitHub verified user emails 超过 10000 条，拒绝使用不完整快照");
  }

  async userInstallations(token: string): Promise<GitHubInstallationSnapshot[]> {
    const all: GitHubInstallationSnapshot[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await this.userRequest<Record<string, unknown>>(
        token,
        `user/installations?per_page=100&page=${page}`,
      );
      const items = Array.isArray(response.installations) ? response.installations : null;
      if (!items) throw new Error("GitHub user installations 响应缺少 installations");
      for (const value of items) {
        const snapshot = this.parseInstallation(value);
        if (seen.has(snapshot.installationId)) throw new Error(`GitHub user installations 重复 id ${snapshot.installationId}`);
        seen.add(snapshot.installationId);
        all.push(snapshot);
      }
      if (items.length < 100) return all;
    }
    throw new Error("GitHub user installations 超过 10000 条，拒绝使用不完整快照");
  }

  async installationToken(installationId: string, force = false): Promise<string> {
    if (!/^[1-9][0-9]*$/.test(installationId)) throw new Error("GitHub installation id 格式不正确");
    const cached = this.installationTokens.get(installationId);
    if (!force && cached && cached.expiresAt - this.now() > 60_000) return cached.token;
    const body = await this.appRequest<Record<string, unknown>>(
      `app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      { method: "POST" },
    );
    const token = text(body.token, "installation token");
    const expiresAt = Date.parse(text(body.expires_at, "installation token expiry"));
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new Error("GitHub installation token expiry 无效");
    this.installationTokens.set(installationId, { token, expiresAt });
    return token;
  }

  async installationRepositories(installationId: string): Promise<GitHubRepositorySnapshot[]> {
    const token = await this.installationToken(installationId);
    const all: GitHubRepositorySnapshot[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await this.userRequest<Record<string, unknown>>(
        token,
        `installation/repositories?per_page=100&page=${page}`,
      );
      const items = Array.isArray(response.repositories) ? response.repositories : null;
      if (!items) throw new Error("GitHub installation repositories 响应缺少 repositories");
      for (const value of items) {
        const repository = this.parseRepository(value);
        if (seen.has(repository.repositoryId)) throw new Error(`GitHub installation repositories 重复 id ${repository.repositoryId}`);
        seen.add(repository.repositoryId);
        all.push(repository);
      }
      if (items.length < 100) return all;
    }
    throw new Error("GitHub installation repositories 超过 10000 条，拒绝使用不完整快照");
  }

  clearInstallationToken(installationId: string): void {
    this.installationTokens.delete(installationId);
  }

  private parseInstallation(value: unknown): GitHubInstallationSnapshot {
    const item = record(value, "installation");
    const account = record(item.account, "installation.account");
    const targetType = item.target_type;
    const repositorySelection = item.repository_selection;
    if (targetType !== "User" && targetType !== "Organization") throw new Error("GitHub installation target_type 无效");
    if (repositorySelection !== "all" && repositorySelection !== "selected") throw new Error("GitHub installation repository_selection 无效");
    return {
      installationId: identifier(item.id, "installation id"),
      appId: identifier(item.app_id, "installation app id"),
      targetId: identifier(item.target_id ?? account.id, "installation target id"),
      targetType,
      targetLogin: text(account.login, "installation target login"),
      repositorySelection,
      permissions: stringRecord(item.permissions),
      suspended: item.suspended_at !== null && item.suspended_at !== undefined,
    };
  }

  private parseRepository(value: unknown): GitHubRepositorySnapshot {
    const item = record(value, "repository");
    const fullName = text(item.full_name, "repository full_name");
    if (!/^[^/]+\/[^/]+$/.test(fullName)) throw new Error("GitHub repository full_name 格式不正确");
    return {
      repositoryId: identifier(item.id, "repository id"),
      name: text(item.name, "repository name"),
      fullName,
      private: item.private === true,
      defaultBranch: text(item.default_branch, "repository default_branch"),
      htmlUrl: text(item.html_url, "repository html_url"),
    };
  }

  private async appRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.request<T>(path, this.appJwt(), init);
  }

  private async userRequest<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
    if (!token.trim()) throw new Error("GitHub access token 为空");
    return this.request<T>(path, token, init);
  }

  private async request<T>(path: string, token: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.apiBaseUrl), {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": API_VERSION,
          ...init.headers,
        },
      });
    } catch (error) {
      throw new Error(`GitHub API 网络失败：${this.redact(error instanceof Error ? error.message : String(error), token)}`);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      const message = typeof body.message === "string" ? body.message : response.statusText || "unknown error";
      throw new Error(`GitHub API ${response.status}：${this.redact(message, token)}`);
    }
    return await response.json() as T;
  }

  private redact(value: string, token: string): string {
    return value
      .replaceAll(token, "[redacted]")
      .replaceAll(this.config.clientSecret, "[redacted]")
      .replaceAll(this.config.privateKey, "[redacted]");
  }
}
