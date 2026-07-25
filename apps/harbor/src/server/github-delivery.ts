import type {
  Delivery,
  DeliveryCheckStatus,
  DeliveryMergeStatus,
  HarborRepository,
  RunPrincipal,
} from "../protocol.js";
import type {
  DeliveryChangeInput,
  DeliveryProvider,
  DeliveryProviderAction,
  DeliveryProviderContext,
  DeliveryProviderResult,
  DeliveryProviderSyncResult,
} from "./delivery.js";

export interface GitHubPullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

interface GitHubRepositoryRef {
  owner: string;
  repo: string;
}

interface GitHubPullResponse {
  number: number;
  state: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha?: string | null;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
}

interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  app?: { id?: number | null } | null;
}

interface GitHubBranchResponse {
  protected: boolean;
}

interface GitHubCommitStatus {
  id: number;
  context: string;
  state: string;
}

type GitHubCombinedStatusState = "failure" | "pending" | "success";

interface GitHubCommitStatusSnapshot {
  statuses: GitHubCommitStatus[];
  state: GitHubCombinedStatusState;
}

interface GitHubRequiredCheck {
  context: string;
  appId: number | null;
}

interface GitHubBranchRule {
  type: string;
  parameters?: {
    required_status_checks?: { context: string; integration_id?: number | null }[];
  };
}

interface GitHubCheckSnapshot {
  checkRuns: GitHubCheckRun[];
  statuses: GitHubCommitStatus[];
  combinedStatusState: GitHubCombinedStatusState;
  required: GitHubRequiredCheck[] | null;
}

export interface GitHubClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

export type GitHubAccessTokenProvider = (forceRefresh?: boolean) => string | Promise<string>;

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

/** 最小 GitHub REST client。token 只进入 Authorization header，从不进入错误、结果或日志。 */
export class GitHubRestClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly credential: string | GitHubAccessTokenProvider,
    options: GitHubClientOptions = {},
  ) {
    if (typeof credential === "string" && !credential.trim()) {
      throw new Error(
        "GitHub Delivery provider credential 未配置",
      );
    }
    this.baseUrl = new URL(options.baseUrl ?? "https://api.github.com/");
    this.fetchImpl = options.fetch ?? fetch;
  }

  getPullRequest(ref: GitHubPullRequestRef): Promise<GitHubPullResponse> {
    return this.request<GitHubPullResponse>(`repos/${segment(ref.owner)}/${segment(ref.repo)}/pulls/${ref.number}`);
  }

  createPullRequest(
    repository: GitHubRepositoryRef,
    input: { title: string; body: string; head: string; base: string },
  ): Promise<GitHubPullResponse> {
    return this.request<GitHubPullResponse>(
      `repos/${segment(repository.owner)}/${segment(repository.repo)}/pulls`,
      { method: "POST", body: input },
    );
  }

  async getCheckSnapshot(ref: GitHubPullRequestRef, sha: string, baseBranch: string): Promise<GitHubCheckSnapshot> {
    const root = `repos/${segment(ref.owner)}/${segment(ref.repo)}`;
    const [branch, runs, combined, rules] = await Promise.all([
      this.request<GitHubBranchResponse>(`${root}/branches/${segment(baseBranch)}`),
      this.getCheckRuns(root, sha),
      this.getCommitStatuses(root, sha),
      this.getBranchRules(root, baseBranch),
    ]);
    let protectedBranchRequired: {
      contexts?: string[];
      checks?: { context: string; app_id?: number | null }[];
    } | null = null;
    if (branch.protected) {
      try {
        protectedBranchRequired = await this.request(
          `${root}/branches/${segment(baseBranch)}/protection/required_status_checks`,
        );
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 404) {
          throw new Error(
            `GitHub base branch "${baseBranch}" 已受保护，但 classic required-status-checks API 返回 404；` +
            "Harbor 无法区分未配置 classic checks 与 token 缺少 Administration(read) 权限，按 fail-safe 拒绝同步",
          );
        }
        throw error;
      }
    }
    const requiredChecks = uniqueRequiredChecks([
      ...(protectedBranchRequired?.contexts ?? []).map((context) => ({ context, appId: null })),
      ...(protectedBranchRequired?.checks ?? []).map((check) => ({
        context: check.context,
        appId: normalizeAppId(check.app_id),
      })),
      ...rules.flatMap((rule) => rule.type === "required_status_checks"
        ? (rule.parameters?.required_status_checks ?? []).map((check) => ({
            context: check.context,
            appId: normalizeAppId(check.integration_id),
          }))
        : []),
    ]);
    if (rules.some((rule) => rule.type === "workflows")) {
      throw new Error(
        "GitHub active rulesets 含 required workflows；当前 Provider 无法把 workflow path 安全映射到 head check，拒绝猜测为 passed",
      );
    }
    return {
      checkRuns: runs,
      statuses: combined.statuses,
      combinedStatusState: combined.state,
      required: requiredChecks.length > 0 ? requiredChecks : null,
    };
  }

  async mergePullRequest(ref: GitHubPullRequestRef, expectedHeadSha: string): Promise<{ sha: string | null; message: string }> {
    const result = await this.request<{ merged?: boolean; sha?: string | null; message?: string }>(
      `repos/${segment(ref.owner)}/${segment(ref.repo)}/pulls/${ref.number}/merge`,
      { method: "PUT", body: { sha: expectedHeadSha } },
    );
    if (result.merged !== true) {
      throw new Error(`GitHub 拒绝合并 PR #${ref.number}：${result.message?.trim() || "未返回原因"}`);
    }
    return { sha: result.sha ?? null, message: result.message?.trim() || `GitHub PR #${ref.number} 已合并` };
  }

  private async getBranchRules(root: string, branch: string): Promise<GitHubBranchRule[]> {
    const all: GitHubBranchRule[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await this.request<GitHubBranchRule[]>(
        `${root}/rules/branches/${segment(branch)}?per_page=100&page=${page}`,
      );
      all.push(...batch);
      if (batch.length < 100) return all;
    }
    throw new Error(`GitHub branch rules 超过 10000 条，拒绝把不完整 required checks 误判为 passed`);
  }

  private async getCheckRuns(root: string, sha: string): Promise<GitHubCheckRun[]> {
    const all: GitHubCheckRun[] = [];
    const seenIds = new Set<number>();
    let totalCount: number | null = null;
    for (let page = 1; page <= 100; page++) {
      const response = await this.request<{ total_count?: number; check_runs?: GitHubCheckRun[] }>(
        `${root}/commits/${segment(sha)}/check-runs?filter=latest&per_page=100&page=${page}`,
      );
      if (
        !Number.isSafeInteger(response.total_count) || response.total_count! < 0 ||
        !Array.isArray(response.check_runs)
      ) {
        throw new Error(
          "GitHub check-runs 分页响应缺少可信 total_count/check_runs，拒绝把不完整 checks 误判为 passed",
        );
      }
      if (totalCount === null) totalCount = response.total_count!;
      if (response.total_count !== totalCount || totalCount > 10000) {
        throw new Error("GitHub check-runs 分页 total_count 漂移或超出可信范围，拒绝使用该快照");
      }
      const batch = response.check_runs;
      const pageIds = new Set<number>();
      for (const run of batch) {
        if (!Number.isSafeInteger(run.id) || run.id <= 0) {
          throw new Error("GitHub check-run 缺少可信唯一 id，拒绝使用该分页快照");
        }
        if (pageIds.has(run.id)) {
          throw new Error(`GitHub check-runs 页内重复 id ${run.id}，拒绝使用该分页快照`);
        }
        if (seenIds.has(run.id)) {
          throw new Error(`GitHub check-runs 跨页重复 id ${run.id}，拒绝使用该分页快照`);
        }
        pageIds.add(run.id);
      }
      if (all.length + batch.length > totalCount) {
        throw new Error("GitHub check-runs 分页结果超过 total_count，拒绝使用该矛盾快照");
      }
      for (const id of pageIds) seenIds.add(id);
      all.push(...batch);
      if (all.length === totalCount) return all;
      if (batch.length < 100) {
        throw new Error("GitHub check-runs 分页响应不完整，拒绝把缺失 checks 误判为 passed");
      }
    }
    throw new Error("GitHub check-runs 超过 10000 条，拒绝把不完整 checks 误判为 passed");
  }

  private async getCommitStatuses(root: string, sha: string): Promise<GitHubCommitStatusSnapshot> {
    const all: GitHubCommitStatus[] = [];
    const seenIds = new Set<number>();
    let totalCount: number | null = null;
    let combinedState: GitHubCombinedStatusState | null = null;
    let combinedSha: string | null = null;
    for (let page = 1; page <= 334; page++) {
      const response = await this.request<{
        state?: string;
        sha?: string;
        total_count?: number;
        statuses?: GitHubCommitStatus[];
      }>(
        `${root}/commits/${segment(sha)}/status?per_page=30&page=${page}`,
      );
      if (
        !isCombinedStatusState(response.state) ||
        typeof response.sha !== "string" || !response.sha ||
        !Number.isSafeInteger(response.total_count) || response.total_count! < 0 ||
        !Array.isArray(response.statuses)
      ) {
        throw new Error(
          "GitHub combined commit statuses 分页响应缺少可信 state/sha/total_count/statuses，拒绝把不完整状态误判为 passed",
        );
      }
      if (totalCount === null) {
        totalCount = response.total_count!;
        combinedState = response.state;
        combinedSha = response.sha;
      }
      if (
        response.total_count !== totalCount ||
        response.state !== combinedState ||
        response.sha !== combinedSha ||
        response.sha !== sha ||
        totalCount > 10000 ||
        all.length + response.statuses.length > totalCount
      ) {
        throw new Error("GitHub combined commit statuses 分页顶层 state/sha/total_count 漂移或矛盾，拒绝使用该快照");
      }
      const pageIds = new Set<number>();
      for (const status of response.statuses) {
        if (!Number.isSafeInteger(status.id) || status.id <= 0) {
          throw new Error("GitHub commit status 缺少可信唯一 id，拒绝使用该分页快照");
        }
        if (pageIds.has(status.id)) {
          throw new Error(`GitHub commit statuses 页内重复 id ${status.id}，拒绝使用该分页快照`);
        }
        if (seenIds.has(status.id)) {
          throw new Error(`GitHub commit statuses 跨页重复 id ${status.id}，拒绝使用该分页快照`);
        }
        pageIds.add(status.id);
        seenIds.add(status.id);
      }
      all.push(...response.statuses);
      if (all.length === totalCount) {
        const derivedState = combinedStateForStatuses(all);
        if (combinedState !== derivedState) {
          throw new Error(
            `GitHub combined commit status 顶层 state=${combinedState} 与分页 statuses 推导的 ${derivedState} 不一致，拒绝使用该快照`,
          );
        }
        return { statuses: all, state: combinedState };
      }
      if (response.statuses.length === 0) {
        throw new Error("GitHub combined commit statuses 分页响应不完整，拒绝把缺失状态误判为 passed");
      }
    }
    throw new Error("GitHub combined commit statuses 超过 10000 条，拒绝把不完整状态误判为 passed");
  }

  private async request<T>(
    path: string,
    options: { method?: "GET" | "POST" | "PUT"; body?: unknown } = {},
  ): Promise<T> {
    const method = options.method ?? "GET";
    let token = typeof this.credential === "string"
      ? this.credential
      : await this.credential(false);
    if (!token.trim()) throw new Error("GitHub Delivery provider credential 为空");
    const issuedTokens = [token];
    const request = async (credential: string): Promise<Response> => {
      try {
        return await this.fetchImpl(new URL(path, this.baseUrl), {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${credential}`,
            "X-GitHub-Api-Version": "2026-03-10",
            ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const safeMessage = issuedTokens.reduce((result, issued) => this.redact(result, issued), message);
        throw new Error(`GitHub API ${method} /${path} 网络失败：${safeMessage}`);
      }
    };
    let response = await request(token);
    const staleToken = token;
    if (response.status === 401 && typeof this.credential === "function") {
      token = await this.credential(true);
      if (!token.trim()) throw new Error("GitHub Delivery provider refreshed credential 为空");
      issuedTokens.push(token);
      response = await request(token);
    }
    if (!response.ok) {
      let message = response.statusText;
      try {
        const body = (await response.json()) as { message?: string };
        if (body.message?.trim()) message = body.message.trim();
      } catch {
        // 非 JSON 错误仍只报告 status；绝不回显 request headers。
      }
      const safeMessage = this.redact(this.redact(message || "unknown error", token), staleToken);
      throw new GitHubApiError(
        response.status,
        `GitHub API ${method} /${path} 失败（${response.status}）：${safeMessage}`,
      );
    }
    return (await response.json()) as T;
  }

  private redact(value: string, token: string): string {
    return value.replaceAll(token, "[redacted]");
  }
}

export type GitHubRestClientResolver = (repository: HarborRepository, principal: RunPrincipal) => GitHubRestClient;

export class GitHubDeliveryProvider implements DeliveryProvider {
  readonly kind = "github" as const;
  readonly mode = "automatic" as const;

  constructor(private readonly clientOrResolver: GitHubRestClient | GitHubRestClientResolver) {}

  private client(repository: HarborRepository, principal: RunPrincipal | null): GitHubRestClient {
    if (typeof this.clientOrResolver !== "function") return this.clientOrResolver;
    if (!principal) throw new Error("GitHub action 缺少已冻结的 Run/request principal");
    return this.clientOrResolver(repository, principal);
  }

  async createChange(
    context: DeliveryProviderContext,
    input: DeliveryChangeInput,
  ): Promise<DeliveryChangeInput> {
    if (!context.repository?.remoteUrl?.trim()) {
      throw new Error("GitHub PR 创建需要 Repository remoteUrl");
    }
    const title = input.title?.trim();
    const head = input.headBranch?.trim();
    const base = input.baseBranch?.trim() || context.repository.defaultBranch;
    if (!title) throw new Error("GitHub PR 创建需要 title");
    if (!head) throw new Error("GitHub PR 创建需要 headBranch");
    const repository = parseGitHubRepository(context.repository.remoteUrl);
    const pull = await this.client(context.repository, context.principal ?? null).createPullRequest(repository, {
      title,
      body: input.body?.trim() ?? "",
      head,
      base,
    });
    if (
      !Number.isSafeInteger(pull.number) ||
      pull.number <= 0 ||
      !pull.html_url?.trim() ||
      !pull.head?.sha?.trim()
    ) {
      throw new Error("GitHub 创建 PR 的响应缺少可信 number/html_url/head SHA");
    }
    return {
      ...input,
      changeUrl: pull.html_url,
      externalId: `#${pull.number}`,
      headBranch: head,
      baseBranch: base,
      latestHeadSha: pull.head.sha.trim(),
    };
  }

  prepareChange(context: DeliveryProviderContext, input: DeliveryChangeInput): DeliveryChangeInput {
    const ref = resolveGitHubPullRequest(input.changeUrl, context.repository, input.externalId);
    return {
      ...input,
      changeUrl: canonicalPullUrl(ref),
      externalId: `#${ref.number}`,
      // server-side createChange 已从 GitHub 响应证明 head/base/SHA；外部 URL 注册则仍等 sync。
      headBranch: input.latestHeadSha ? input.headBranch ?? null : null,
      baseBranch: input.latestHeadSha ? input.baseBranch ?? null : null,
      checkStatus: "pending",
    };
  }

  async sync(delivery: Delivery, context: DeliveryProviderContext): Promise<DeliveryProviderSyncResult> {
    const ref = resolveGitHubPullRequest(delivery.changeUrl, context.repository);
    if (!context.repository) throw new Error("GitHub Delivery 需要 Issue 关联 Repository");
    const client = this.client(context.repository, context.principal ?? null);
    const pull = await client.getPullRequest(ref);
    if (
      pull.number !== ref.number ||
      (!pull.merged && pull.state !== "open" && pull.state !== "closed") ||
      !pull.head?.sha ||
      !pull.head.ref ||
      !pull.base?.ref
    ) {
      throw new Error(`GitHub PR #${ref.number} 响应缺少必要的 head/base 信息`);
    }
    const snapshot = await client.getCheckSnapshot(ref, pull.head.sha, pull.base.ref);
    const checkStatus = evaluateGitHubChecks(snapshot);
    const mergeStatus: DeliveryMergeStatus = pull.merged
      ? "merged"
      : pull.state === "closed"
        ? "closed"
        : "open";
    const mergedAt = pull.merged ? parseGitHubTime(pull.merged_at) : null;
    const observedChecks = snapshot.checkRuns.length + snapshot.statuses.length;
    return {
      message: `GitHub PR #${ref.number} 已同步`,
      metadata: {
        changeUrl: canonicalPullUrl(ref),
        externalId: `#${ref.number}`,
        headBranch: pull.head.ref,
        baseBranch: pull.base.ref,
        latestHeadSha: pull.head.sha,
      },
      checkStatus,
      mergeStatus,
      mergedAt,
      mergedRevision: pull.merged ? pull.merge_commit_sha?.trim() || null : null,
      data: {
        pullRequestState: pull.merged ? "merged" : pull.state,
        observedChecks,
        requiredChecks: snapshot.required?.length ?? null,
      },
    };
  }

  async merge(
    delivery: Delivery,
    _input: DeliveryProviderAction,
    context: DeliveryProviderContext,
  ): Promise<DeliveryProviderResult> {
    const ref = resolveGitHubPullRequest(delivery.changeUrl, context.repository);
    if (!delivery.latestHeadSha) throw new Error(`GitHub PR #${ref.number} 尚未同步 head SHA`);
    // merge 只能重验已获人工 approval 的同一 SHA，不能自动升级到 GitHub 上的新 head。
    if (!context.repository) throw new Error("GitHub Delivery 需要 Issue 关联 Repository");
    const client = this.client(context.repository, context.principal ?? null);
    const pull = await client.getPullRequest(ref);
    if (!pull.head?.sha || !pull.base?.ref) {
      throw new Error(`GitHub PR #${ref.number} 当前不可合并；请 Sync 后检查 PR 状态`);
    }
    if (pull.head.sha !== delivery.latestHeadSha) {
      throw new Error(`GitHub PR #${ref.number} head 已变化；请 Sync from GitHub 并重新验收后再合并`);
    }
    const snapshot = await client.getCheckSnapshot(ref, pull.head.sha, pull.base.ref);
    const latestChecks = evaluateGitHubChecks(snapshot);
    if (latestChecks !== "passed") {
      throw new Error(`GitHub 最新 CI checks 为 ${latestChecks}；请 Sync 并等待通过后再合并`);
    }
    if (pull.merged) {
      return {
        message: `GitHub PR #${ref.number} 已合并`,
        mergedRevision: pull.merge_commit_sha?.trim() || null,
      };
    }
    if (pull.state !== "open") {
      throw new Error(`GitHub PR #${ref.number} 当前不可合并；请 Sync 后检查 PR 状态`);
    }
    const result = await client.mergePullRequest(ref, delivery.latestHeadSha);
    return {
      message: result.message,
      mergedRevision: result.sha,
      data: { expectedHeadSha: delivery.latestHeadSha, ...(result.sha ? { mergeSha: result.sha } : {}) },
    };
  }
}

export function resolveGitHubPullRequest(
  changeUrl: string | null | undefined,
  repository: HarborRepository | null,
  externalId?: string | null,
): GitHubPullRequestRef {
  if (!repository) throw new Error("GitHub Delivery 需要 Issue 关联 Repository");
  if (!repository.remoteUrl?.trim()) {
    throw new Error(`Repository "${repository.name}" 缺少 remoteUrl，无法验证 GitHub PR 归属`);
  }
  const mapped = parseGitHubRepository(repository.remoteUrl);
  if (!changeUrl?.trim()) {
    return { ...mapped, number: parsePullNumber(externalId) };
  }
  const pull = parseGitHubPullUrl(changeUrl);
  if (mapped.owner.toLowerCase() !== pull.owner.toLowerCase() || mapped.repo.toLowerCase() !== pull.repo.toLowerCase()) {
    throw new Error(
      `GitHub PR ${pull.owner}/${pull.repo} 不属于 Repository 映射 ${mapped.owner}/${mapped.repo}，拒绝跨 Repository Delivery`,
    );
  }
  return { owner: mapped.owner, repo: mapped.repo, number: pull.number };
}

export function parseGitHubPullUrl(value: string | null | undefined): GitHubPullRequestRef {
  const raw = value?.trim();
  if (!raw) throw new Error("GitHub provider 需要填写 PR URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("GitHub PR URL 格式不正确");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("GitHub PR URL 必须是 https://github.com/<owner>/<repo>/pull/<number>");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const number = Number(parts[3]);
  if (
    parts.length !== 4 ||
    parts[2] !== "pull" ||
    !/^[1-9]\d*$/.test(parts[3]!) ||
    !Number.isSafeInteger(number)
  ) {
    throw new Error("GitHub PR URL 必须是 https://github.com/<owner>/<repo>/pull/<number>");
  }
  const [owner, repo] = parts;
  if (!validOwner(owner) || !validRepo(repo) || repo.endsWith(".git")) {
    throw new Error("GitHub PR URL 的 owner/repo 不合法");
  }
  return { owner, repo, number };
}

export function parseGitHubRepository(value: string): GitHubRepositoryRef {
  const raw = value.trim();
  let owner: string | undefined;
  let repo: string | undefined;
  const scp = /^git@github\.com:([^/]+)\/([^/]+?)\/?$/i.exec(raw);
  if (scp) {
    [, owner, repo] = scp;
  } else {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("Repository remoteUrl 不是受支持的 GitHub URL");
    }
    if (
      !["https:", "ssh:"].includes(url.protocol) ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.port ||
      url.password ||
      (url.protocol === "https:" && !!url.username) ||
      (url.protocol === "ssh:" && url.username !== "git") ||
      url.search ||
      url.hash
    ) {
      throw new Error("Repository remoteUrl 必须指向 github.com");
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) throw new Error("Repository remoteUrl 必须是单个 GitHub owner/repo");
    [owner, repo] = parts;
  }
  repo = repo?.replace(/\.git$/i, "");
  if (!validOwner(owner) || !validRepo(repo)) throw new Error("Repository remoteUrl 的 GitHub owner/repo 不合法");
  return { owner, repo };
}

export function evaluateGitHubChecks(snapshot: GitHubCheckSnapshot): DeliveryCheckStatus {
  const required = snapshot.required?.length ? snapshot.required : null;
  const results = required
    ? required.map((requirement) => resultForRequired(requirement, snapshot))
    : [
        ...snapshot.checkRuns.map(checkRunResult),
        ...snapshot.statuses.map(commitStatusResult),
      ];
  const local = aggregateCheckResults(results);
  if (local === "passed" && snapshot.statuses.length > 0 && snapshot.combinedStatusState !== "success") {
    throw new Error(
      `GitHub combined commit status 为 ${snapshot.combinedStatusState}，但 required checks 本地计算为 passed；` +
      "失败/等待中的 context 可能并非 required，Harbor 不伪造 required failure，但按 fail-safe 拒绝把 Delivery 标为 passed",
    );
  }
  return local;
}

function resultForRequired(
  required: GitHubRequiredCheck,
  snapshot: GitHubCheckSnapshot,
): Exclude<DeliveryCheckStatus, "unknown"> {
  const runResults = snapshot.checkRuns.filter((candidate) =>
    candidate.name === required.context &&
    (required.appId === null || candidate.app?.id === required.appId)).map(checkRunResult);
  const statusResults = required.appId === null
    ? snapshot.statuses.filter((candidate) => candidate.context === required.context).map(commitStatusResult)
    : [];
  return aggregateCheckResults([...runResults, ...statusResults]);
}

function aggregateCheckResults(
  results: Exclude<DeliveryCheckStatus, "unknown">[],
): Exclude<DeliveryCheckStatus, "unknown"> {
  if (results.length === 0) return "pending";
  if (results.includes("failed")) return "failed";
  if (results.includes("pending")) return "pending";
  return "passed";
}

function checkRunResult(check: GitHubCheckRun): Exclude<DeliveryCheckStatus, "unknown"> {
  if (check.status !== "completed") return "pending";
  if (["success", "neutral", "skipped"].includes(check.conclusion ?? "")) return "passed";
  if (!check.conclusion) return "pending";
  return "failed";
}

function commitStatusResult(status: GitHubCommitStatus): Exclude<DeliveryCheckStatus, "unknown"> {
  if (status.state === "success") return "passed";
  if (status.state === "failure" || status.state === "error") return "failed";
  return "pending";
}

function isCombinedStatusState(value: string | undefined): value is GitHubCombinedStatusState {
  return value === "failure" || value === "pending" || value === "success";
}

function combinedStateForStatuses(statuses: GitHubCommitStatus[]): GitHubCombinedStatusState {
  if (statuses.length === 0) return "pending";
  const results = statuses.map(commitStatusResult);
  if (results.includes("failed")) return "failure";
  if (results.includes("pending")) return "pending";
  return "success";
}

function uniqueRequiredChecks(checks: GitHubRequiredCheck[]): GitHubRequiredCheck[] {
  const seen = new Set<string>();
  return checks.filter((check) => {
    const key = `${check.context}\0${check.appId ?? "any"}`;
    if (!check.context || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeAppId(value: number | null | undefined): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

function canonicalPullUrl(ref: GitHubPullRequestRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

function parseGitHubTime(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePullNumber(value: string | null | undefined): number {
  const raw = value?.trim().replace(/^#/, "");
  if (!raw || !/^[1-9]\d*$/.test(raw)) {
    throw new Error("GitHub provider 需要 PR URL，或 Repository mapping + 正整数 externalId");
  }
  const number = Number(raw);
  if (!Number.isSafeInteger(number)) {
    throw new Error("GitHub provider 需要 PR URL，或 Repository mapping + 正整数 externalId");
  }
  return number;
}

function validOwner(value: string | undefined): value is string {
  return !!value && value.length <= 39 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value) && !value.includes("--");
}

function validRepo(value: string | undefined): value is string {
  return !!value && value.length <= 100 && value !== "." && value !== ".." && /^[A-Za-z0-9_.-]+$/.test(value);
}

function segment(value: string): string {
  return encodeURIComponent(value);
}
