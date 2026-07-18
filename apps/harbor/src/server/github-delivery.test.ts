import { describe, expect, test } from "bun:test";
import type { DeliveryCheckStatus } from "../protocol.js";
import { DeliveryService } from "./delivery.js";
import {
  GitHubDeliveryProvider,
  GitHubRestClient,
  parseGitHubPullUrl,
  parseGitHubRepository,
  resolveGitHubPullRequest,
} from "./github-delivery.js";
import { openDb } from "./db.js";
import { HarborStore } from "./store.js";

interface FakeCheckRun {
  id?: number;
  name: string;
  status: string;
  conclusion: string | null;
  app?: { id: number };
}

interface FakeCheckRunPage {
  total_count?: number;
  check_runs?: FakeCheckRun[];
}

interface FakeCommitStatus {
  id?: number;
  context: string;
  state: string;
}

interface FakeCombinedStatusPage {
  state?: string;
  sha?: string;
  total_count?: number;
  statuses?: FakeCommitStatus[];
}

interface DeferredGate {
  entered: ReturnType<typeof deferred>;
  release: ReturnType<typeof deferred>;
  sha?: string;
}

interface FakeGitHubState {
  pullState?: "open" | "closed";
  merged?: boolean;
  mergedAt?: string | null;
  mergeCommitSha?: string | null;
  headSha?: string;
  branchProtected?: boolean;
  checkRuns?: FakeCheckRun[];
  checkRunsBySha?: Record<string, FakeCheckRun[]>;
  checkRunTotal?: number;
  checkRunPages?: FakeCheckRunPage[];
  statuses?: FakeCommitStatus[];
  statusState?: string;
  statusSha?: string;
  statusTotal?: number;
  statusPages?: FakeCombinedStatusPage[];
  required?: { contexts?: string[]; checks?: { context: string; app_id?: number | null }[] } | null;
  rules?: { type: string; parameters?: { required_status_checks?: { context: string; integration_id?: number | null }[] } }[];
  mergeFailure?: boolean;
  checkGate?: DeferredGate;
  mergeGate?: Omit<DeferredGate, "sha">;
}

function fakeGitHub(initial: FakeGitHubState = {}) {
  const state: FakeGitHubState = {
    pullState: "open",
    merged: false,
    mergedAt: null,
    headSha: "abc123",
    branchProtected: false,
    checkRuns: [],
    statuses: [],
    required: null,
    rules: [],
    ...initial,
  };
  const calls: { path: string; method: string; authorization: string | null; body: string | null }[] = [];
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({
      path: url.pathname + url.search,
      method,
      authorization: headers.get("Authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (url.pathname.endsWith("/pulls/42") && method === "GET") {
      return json({
        number: 42,
        state: state.pullState,
        merged: state.merged,
        merged_at: state.mergedAt,
        merge_commit_sha: state.mergeCommitSha,
        html_url: "https://github.com/acme/harbor/pull/42",
        head: { ref: "feature/github-delivery", sha: state.headSha },
        base: { ref: "main" },
      });
    }
    const checkMatch = /\/commits\/([^/]+)\/check-runs$/.exec(url.pathname);
    if (checkMatch) {
      const sha = decodeURIComponent(checkMatch[1]!);
      if (state.checkGate && (!state.checkGate.sha || state.checkGate.sha === sha)) {
        state.checkGate.entered.resolve();
        await state.checkGate.release.promise;
      }
      const page = Number(url.searchParams.get("page") ?? "1");
      if (state.checkRunPages) {
        return json(state.checkRunPages[page - 1] ?? {
          total_count: state.checkRunPages[0]?.total_count,
          check_runs: [],
        });
      }
      const all = (state.checkRunsBySha?.[sha] ?? state.checkRuns ?? [])
        .map((run, index) => ({ ...run, id: run.id ?? index + 1 }));
      return json({
        total_count: state.checkRunTotal ?? all.length,
        check_runs: all.slice((page - 1) * 100, page * 100),
      });
    }
    const statusMatch = /\/commits\/([^/]+)\/status$/.exec(url.pathname);
    if (statusMatch) {
      const sha = decodeURIComponent(statusMatch[1]!);
      const page = Number(url.searchParams.get("page") ?? "1");
      if (state.statusPages) {
        return json(state.statusPages[page - 1] ?? {
          state: state.statusPages[0]?.state,
          sha: state.statusPages[0]?.sha,
          total_count: state.statusPages[0]?.total_count,
          statuses: [],
        });
      }
      const all = (state.statuses ?? []).map((status, index) => ({ id: status.id ?? index + 1, ...status }));
      return json({
        state: state.statusState ?? fakeCombinedState(all),
        sha: state.statusSha ?? sha,
        total_count: state.statusTotal ?? all.length,
        statuses: all.slice((page - 1) * 30, page * 30),
      });
    }
    if (url.pathname.endsWith("/branches/main/protection/required_status_checks")) {
      return state.required === null ? json({ message: "Not Found" }, 404) : json(state.required);
    }
    if (url.pathname === "/repos/acme/harbor/branches/main") return json({ protected: state.branchProtected });
    if (url.pathname.endsWith("/rules/branches/main")) return json(state.rules);
    if (url.pathname.endsWith("/pulls/42/merge") && method === "PUT") {
      if (state.mergeGate) {
        state.mergeGate.entered.resolve();
        await state.mergeGate.release.promise;
      }
      if (state.mergeFailure) return json({ message: "merge conflict for fake-token" }, 409);
      state.merged = true;
      state.pullState = "closed";
      state.mergedAt = "2026-07-18T12:00:00Z";
      state.mergeCommitSha = "b".repeat(40);
      return json({ merged: true, sha: state.mergeCommitSha, message: "Pull Request successfully merged" });
    }
    return json({ message: `unexpected ${method} ${url.pathname}` }, 500);
  }) as typeof fetch;
  return { state, calls, fetch: fetchImpl };
}

function harness(fake = fakeGitHub()) {
  const store = new HarborStore(openDb(":memory:"));
  const device = store.upsertDevice("github-worker", "hash", { clis: { claude: "2.1" }, endpoints: [] }, 1);
  const repository = store.createRepository(
    { workspaceId: store.defaultWorkspace().id, name: "harbor", remoteUrl: "git@github.com:acme/harbor.git" },
    2,
  );
  store.setRepositoryMount(repository.id, device.id, "/repo", 3);
  const agent = store.createAgent(
    { name: "builder", deviceId: device.id, backend: "claude", repositoryId: repository.id },
    4,
  );
  const issue = store.createConversation(
    { kind: "issue", title: "GitHub delivery", agentId: agent.id, origin: "web" },
    5,
  );
  store.setConversationStatus(issue.id, "review", 6);
  const provider = new GitHubDeliveryProvider(
    new GitHubRestClient("fake-token", { baseUrl: "https://api.github.test/", fetch: fake.fetch }),
  );
  const service = new DeliveryService(store, [provider]);
  const conversation = store.getConversation(issue.id)!;
  const delivery = service.create(
    conversation,
    { provider: "github", changeUrl: "https://github.com/acme/harbor/pull/42", deploymentRequired: false },
    7,
  );
  return { store, service, conversation, delivery, fake };
}

describe("GitHub Delivery URL and configuration boundaries", () => {
  test("requires an explicit server token without exposing it", () => {
    expect(() => new GitHubRestClient(" ")).toThrow("HARBOR_GITHUB_TOKEN");
  });

  test("redacts the token from transport failures", async () => {
    const client = new GitHubRestClient("fake-token", {
      fetch: (async () => { throw new Error("socket failed with fake-token"); }) as unknown as typeof fetch,
    });
    let message = "";
    try {
      await client.getPullRequest({ owner: "acme", repo: "harbor", number: 42 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("[redacted]");
    expect(message).not.toContain("fake-token");
  });

  test("accepts canonical GitHub mappings and rejects malformed, non-GitHub, or cross-repository URLs", () => {
    expect(parseGitHubRepository("git@github.com:Acme/harbor.git")).toEqual({ owner: "Acme", repo: "harbor" });
    expect(parseGitHubRepository("ssh://git@github.com/Acme/harbor.git")).toEqual({ owner: "Acme", repo: "harbor" });
    expect(parseGitHubPullUrl("https://github.com/acme/harbor/pull/42")).toEqual({ owner: "acme", repo: "harbor", number: 42 });
    expect(() => parseGitHubPullUrl("https://gitlab.com/acme/harbor/pull/42")).toThrow("github.com");
    expect(() => parseGitHubPullUrl("https://github.com/acme/harbor/issues/42")).toThrow("/pull/<number>");
    expect(() => parseGitHubPullUrl("https://github.com/acme/harbor/pull/0")).toThrow("/pull/<number>");
    expect(() => parseGitHubRepository("https://example.com/acme/harbor.git")).toThrow("github.com");
    expect(resolveGitHubPullRequest(null, {
      id: "repo_1",
      workspaceId: "ws_personal",
      name: "harbor",
      remoteUrl: "https://github.com/acme/harbor.git",
      defaultBranch: "main",
      scmProvider: "local",
      scmRepository: null,
      scmAgentId: null,
      scmAutoDispatch: false,
      createdAt: 1,
      archivedAt: null,
    }, "#42")).toEqual({ owner: "acme", repo: "harbor", number: 42 });
    expect(() => resolveGitHubPullRequest("https://github.com/other/harbor/pull/42", {
      id: "repo_1",
      workspaceId: "ws_personal",
      name: "harbor",
      remoteUrl: "https://github.com/acme/harbor.git",
      defaultBranch: "main",
      scmProvider: "local",
      scmRepository: null,
      scmAgentId: null,
      scmAutoDispatch: false,
      createdAt: 1,
      archivedAt: null,
    })).toThrow("跨 Repository");
  });

  test("creates a PR server-side from the fixed Issue branch and preserves deploymentRequired", async () => {
    let request: { url: string; method: string; body: unknown; authorization: string } | null = null;
    const client = new GitHubRestClient("server-token", {
      baseUrl: "https://api.github.test/",
      fetch: (async (input, init) => {
        const headers = init?.headers as Record<string, string>;
        request = {
          url: String(input),
          method: String(init?.method),
          body: JSON.parse(String(init?.body)),
          authorization: headers.Authorization,
        };
        return new Response(JSON.stringify({
          number: 9,
          state: "open",
          merged: false,
          merged_at: null,
          html_url: "https://github.com/acme/harbor/pull/9",
          head: { ref: "harbor/c_1", sha: "abc" },
          base: { ref: "main" },
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });
    const provider = new GitHubDeliveryProvider(client);
    const repository = {
      id: "repo_1",
      workspaceId: "ws_personal",
      name: "harbor",
      remoteUrl: "https://github.com/acme/harbor.git",
      defaultBranch: "main",
      scmProvider: "local" as const,
      scmRepository: null,
      scmAgentId: null,
      scmAutoDispatch: false,
      createdAt: 1,
      archivedAt: null,
    };
    const created = await provider.createChange({
      repository,
      conversation: {
        id: "c_1",
        workspaceId: "ws_personal",
        kind: "issue",
        title: "Ship it",
        agentId: null,
        description: null,
        priority: "medium",
        status: "doing",
        repositoryId: repository.id,
        worktreePath: null,
        worktreeMountId: null,
        claudeSessionId: null,
        origin: "web",
        originRef: null,
        creatorMemberId: null,
        ownerMemberId: null,
        labelIds: [],
        createdAt: 1,
        updatedAt: 1,
      },
    }, {
      title: "Ship it",
      body: "PR body",
      headBranch: "harbor/c_1",
      baseBranch: "main",
      deploymentRequired: true,
    });
    expect(request as unknown).toEqual({
      url: "https://api.github.test/repos/acme/harbor/pulls",
      method: "POST",
      body: { title: "Ship it", body: "PR body", head: "harbor/c_1", base: "main" },
      authorization: "Bearer server-token",
    });
    expect(provider.prepareChange({ repository, conversation: {} as never }, created)).toEqual(expect.objectContaining({
      changeUrl: "https://github.com/acme/harbor/pull/9",
      externalId: "#9",
      deploymentRequired: true,
      checkStatus: "pending",
    }));
  });
});

const checkScenarios: { name: string; state: FakeGitHubState; expected: DeliveryCheckStatus }[] = [
  { name: "no checks", state: {}, expected: "pending" },
  {
    name: "missing required check",
    state: { branchProtected: true, required: { contexts: ["build"] }, checkRuns: [] },
    expected: "pending",
  },
  {
    name: "required check in progress",
    state: {
      branchProtected: true,
      required: { contexts: ["build"] },
      checkRuns: [{ name: "build", status: "in_progress", conclusion: null }],
    },
    expected: "pending",
  },
  {
    name: "required check failed",
    state: {
      branchProtected: true,
      required: { contexts: ["build"] },
      checkRuns: [{ name: "build", status: "completed", conclusion: "failure" }],
    },
    expected: "failed",
  },
  {
    name: "all required checks passed",
    state: {
      branchProtected: true,
      required: { contexts: ["build", "lint"] },
      checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
      statuses: [{ context: "lint", state: "success" }],
    },
    expected: "passed",
  },
  {
    name: "ruleset required check passed",
    state: {
      branchProtected: true,
      required: {},
      rules: [{
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "build", integration_id: 7 }] },
      }],
      checkRuns: [{ name: "build", status: "completed", conclusion: "success", app: { id: 7 } }],
    },
    expected: "passed",
  },
];

describe("GitHub Delivery sync", () => {
  for (const scenario of checkScenarios) {
    test(`maps ${scenario.name} conservatively`, async () => {
      const h = harness(fakeGitHub(scenario.state));
      const synced = await h.service.sync(h.delivery, h.conversation, 10);
      expect(synced).toEqual(expect.objectContaining({
        checkStatus: scenario.expected,
        mergeStatus: "open",
        headBranch: "feature/github-delivery",
        baseBranch: "main",
        latestHeadSha: "abc123",
      }));
      expect(h.fake.calls.every((call) => call.authorization === "Bearer fake-token")).toBe(true);
      expect(JSON.stringify(h.store.listDeliveryEvents(synced.id))).not.toContain("fake-token");
    });
  }

  test("aggregates a required context across check-runs and commit statuses", async () => {
    const states: { run: FakeCheckRun; status: string; expected: DeliveryCheckStatus }[] = [
      { run: { name: "build", status: "completed", conclusion: "success" }, status: "failure", expected: "failed" },
      { run: { name: "build", status: "completed", conclusion: "success" }, status: "pending", expected: "pending" },
      { run: { name: "build", status: "completed", conclusion: "success" }, status: "success", expected: "passed" },
    ];
    for (const state of states) {
      const h = harness(fakeGitHub({
        branchProtected: true,
        required: { contexts: ["build"] },
        checkRuns: [state.run],
        statuses: [{ context: "build", state: state.status }],
      }));
      expect((await h.service.sync(h.delivery, h.conversation, 10)).checkStatus).toBe(state.expected);
    }
  });

  test("reads the 31st commit status and lets its required-context failure override a successful check-run", async () => {
    const statuses = Array.from({ length: 30 }, (_, index) => ({
      context: `unrelated-${index}`,
      state: "success",
    }));
    statuses.push({ context: "build", state: "failure" });
    const h = harness(fakeGitHub({
      branchProtected: true,
      required: { contexts: ["build"] },
      checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
      statuses,
    }));

    expect((await h.service.sync(h.delivery, h.conversation, 10)).checkStatus).toBe("failed");
    expect(h.fake.calls.some((call) => call.path.includes("/status?per_page=30&page=2"))).toBe(true);
  });

  test("fails safely when commit-status pagination is contradictory or incomplete", async () => {
    const firstPage = Array.from({ length: 30 }, (_, index) => ({
      id: index + 1,
      context: `unrelated-${index}`,
      state: "success",
    }));
    const cases = [
      {
        pages: [
          { state: "failure", sha: "abc123", total_count: 31, statuses: firstPage },
          { state: "failure", sha: "abc123", total_count: 32, statuses: [{ id: 31, context: "build", state: "failure" }] },
        ],
        error: "漂移或矛盾",
      },
      {
        pages: [
          { state: "failure", sha: "abc123", total_count: 31, statuses: firstPage },
          { state: "failure", sha: "abc123", total_count: 31, statuses: [] },
        ],
        error: "响应不完整",
      },
    ];
    for (const scenario of cases) {
      const h = harness(fakeGitHub({
        branchProtected: true,
        required: { contexts: ["build"] },
        checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
        statusPages: scenario.pages,
      }));
      await expect(h.service.sync(h.delivery, h.conversation, 10)).rejects.toThrow(scenario.error);
      expect(h.store.getDelivery(h.delivery.id)).toEqual(expect.objectContaining({
        latestHeadSha: null,
        checkStatus: "pending",
      }));
      expect(h.store.listDeliveryEvents(h.delivery.id).map((event) => event.kind)).toEqual(["created"]);
    }
  });

  test("rejects a repeated status id that hides the 31st required-context failure", async () => {
    const firstPage = Array.from({ length: 30 }, (_, index) => ({
      id: index + 1,
      context: `unrelated-${index}`,
      state: "success",
    }));
    const h = harness(fakeGitHub({
      branchProtected: true,
      required: { contexts: ["build"] },
      checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
      statusPages: [
        { state: "failure", sha: "abc123", total_count: 31, statuses: firstPage },
        {
          state: "failure",
          sha: "abc123",
          total_count: 31,
          statuses: [{ id: 30, context: "unrelated-29", state: "success" }],
        },
      ],
    }));

    await expect(h.service.sync(h.delivery, h.conversation, 10)).rejects.toThrow("跨页重复 id 30");
    expect(h.store.getDelivery(h.delivery.id)).toEqual(expect.objectContaining({
      latestHeadSha: null,
      checkStatus: "pending",
    }));
    expect(h.store.listDeliveryEvents(h.delivery.id).map((event) => event.kind)).toEqual(["created"]);
  });

  test("rejects missing or page-local duplicate commit-status ids", async () => {
    const cases: { statuses: FakeCommitStatus[]; error: string }[] = [
      {
        statuses: [
          { id: 1, context: "build", state: "success" },
          { id: 1, context: "lint", state: "success" },
        ],
        error: "页内重复 id 1",
      },
      {
        statuses: [{ context: "build", state: "success" }],
        error: "缺少可信唯一 id",
      },
    ];
    for (const scenario of cases) {
      const h = harness(fakeGitHub({
        statusPages: [{
          state: "success",
          sha: "abc123",
          total_count: scenario.statuses.length,
          statuses: scenario.statuses,
        }],
      }));

      await expect(h.service.sync(h.delivery, h.conversation, 10)).rejects.toThrow(scenario.error);
      expect(h.store.listDeliveryEvents(h.delivery.id).map((event) => event.kind)).toEqual(["created"]);
    }
  });

  test("rejects combined status state or sha drift between pages", async () => {
    const firstPage = Array.from({ length: 30 }, (_, index) => ({
      id: index + 1,
      context: `check-${index}`,
      state: "success",
    }));
    const cases: FakeCombinedStatusPage[][] = [
      [
        { state: "success", sha: "abc123", total_count: 31, statuses: firstPage },
        { state: "pending", sha: "abc123", total_count: 31, statuses: [{ id: 31, context: "build", state: "success" }] },
      ],
      [
        { state: "success", sha: "abc123", total_count: 31, statuses: firstPage },
        { state: "success", sha: "def456", total_count: 31, statuses: [{ id: 31, context: "build", state: "success" }] },
      ],
    ];
    for (const pages of cases) {
      const h = harness(fakeGitHub({ statusPages: pages }));

      await expect(h.service.sync(h.delivery, h.conversation, 10)).rejects.toThrow(
        "顶层 state/sha/total_count 漂移或矛盾",
      );
      expect(h.store.listDeliveryEvents(h.delivery.id).map((event) => event.kind)).toEqual(["created"]);
    }
  });

  test("fails safely when non-required commit statuses make combined state looser than local required checks", async () => {
    for (const state of ["failure", "error", "pending"]) {
      const h = harness(fakeGitHub({
        branchProtected: true,
        required: { contexts: ["build"] },
        checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
        statuses: [{ context: "unrelated", state }],
      }));

      await expect(h.service.sync(h.delivery, h.conversation, 10)).rejects.toThrow(
        "Harbor 不伪造 required failure，但按 fail-safe 拒绝",
      );
      expect(h.store.getDelivery(h.delivery.id)).toEqual(expect.objectContaining({
        latestHeadSha: null,
        checkStatus: "pending",
      }));
    }
  });

  test("models GitHub combined status with failure taking precedence over pending", async () => {
    const h = harness(fakeGitHub({
      statuses: [
        { context: "lint", state: "pending" },
        { context: "build", state: "failure" },
      ],
    }));

    expect((await h.service.sync(h.delivery, h.conversation, 10)).checkStatus).toBe("failed");
  });

  test("paginates all latest check-runs before evaluating", async () => {
    const checks: FakeCheckRun[] = Array.from({ length: 100 }, (_, index) => ({
      name: `check-${index}`,
      status: "completed",
      conclusion: "success",
    }));
    checks.push({ name: "late-failure", status: "completed", conclusion: "failure" });
    const h = harness(fakeGitHub({ checkRuns: checks }));
    expect((await h.service.sync(h.delivery, h.conversation, 10)).checkStatus).toBe("failed");
    expect(h.fake.calls.some((call) => call.path.includes("check-runs?filter=latest&per_page=100&page=2"))).toBe(true);
  });

  test("rejects a repeated check-run page that hides the 101st failure", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `check-${index}`,
      status: "completed",
      conclusion: "success",
    }));
    const h = harness(fakeGitHub({
      // GitHub reports 101 runs, but page 2 maliciously repeats page 1 and hides the failed final run.
      checkRunPages: [
        { total_count: 101, check_runs: firstPage },
        { total_count: 101, check_runs: firstPage },
      ],
    }));

    await expect(h.service.sync(h.delivery, h.conversation, 10)).rejects.toThrow("跨页重复 id 1");
    expect(h.store.getDelivery(h.delivery.id)).toEqual(expect.objectContaining({
      latestHeadSha: null,
      checkStatus: "pending",
    }));
    expect(h.store.listDeliveryEvents(h.delivery.id).map((event) => event.kind)).toEqual(["created"]);
  });

  test("rejects missing or page-local duplicate check-run ids", async () => {
    const cases: { page: FakeCheckRunPage; error: string }[] = [
      {
        page: {
          total_count: 2,
          check_runs: [
            { id: 1, name: "build", status: "completed", conclusion: "success" },
            { id: 1, name: "lint", status: "completed", conclusion: "success" },
          ],
        },
        error: "页内重复 id 1",
      },
      {
        page: {
          total_count: 1,
          check_runs: [{ name: "build", status: "completed", conclusion: "success" }],
        },
        error: "缺少可信唯一 id",
      },
    ];
    for (const scenario of cases) {
      const h = harness(fakeGitHub({ checkRunPages: [scenario.page] }));

      await expect(h.service.sync(h.delivery, h.conversation, 10)).rejects.toThrow(scenario.error);
      expect(h.store.listDeliveryEvents(h.delivery.id).map((event) => event.kind)).toEqual(["created"]);
    }
  });

  test("rejects check-run total_count drift and overshoot", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `check-${index}`,
      status: "completed",
      conclusion: "success",
    }));
    const cases: { pages: FakeCheckRunPage[]; error: string }[] = [
      {
        pages: [
          { total_count: 101, check_runs: firstPage },
          {
            total_count: 102,
            check_runs: [{ id: 101, name: "late", status: "completed", conclusion: "failure" }],
          },
        ],
        error: "total_count 漂移",
      },
      {
        pages: [{
          total_count: 1,
          check_runs: [
            { id: 1, name: "build", status: "completed", conclusion: "success" },
            { id: 2, name: "lint", status: "completed", conclusion: "success" },
          ],
        }],
        error: "超过 total_count",
      },
    ];
    for (const scenario of cases) {
      const h = harness(fakeGitHub({ checkRunPages: scenario.pages }));

      await expect(h.service.sync(h.delivery, h.conversation, 10)).rejects.toThrow(scenario.error);
      expect(h.store.listDeliveryEvents(h.delivery.id).map((event) => event.kind)).toEqual(["created"]);
    }
  });

  test("fails loudly when check-runs pagination is incomplete", async () => {
    const h = harness(fakeGitHub({
      checkRunTotal: 101,
      checkRuns: [{ name: "only", status: "completed", conclusion: "success" }],
    }));
    await expect(h.service.sync(h.delivery, h.conversation, 10)).rejects.toThrow("分页响应不完整");
    expect(h.store.listDeliveryEvents(h.delivery.id).map((event) => event.kind)).toEqual(["created"]);
  });

  test("fails safely when protected branch classic capability is ambiguous", async () => {
    const h = harness(fakeGitHub({ branchProtected: true, required: null }));
    await expect(h.service.sync(h.delivery, h.conversation, 10)).rejects.toThrow("Administration(read)");
    expect(h.store.getDelivery(h.delivery.id)).toEqual(expect.objectContaining({
      latestHeadSha: null,
      checkStatus: "pending",
      mergeStatus: "open",
    }));
    expect(h.store.listDeliveryEvents(h.delivery.id).map((event) => event.kind)).toEqual(["created"]);
  });

  test("fails safely when an active ruleset requires workflows that cannot be mapped to check contexts", async () => {
    const h = harness(fakeGitHub({
      branchProtected: true,
      required: {},
      rules: [{ type: "workflows" }],
      checkRuns: [{ name: "unrelated", status: "completed", conclusion: "success" }],
    }));
    await expect(h.service.sync(h.delivery, h.conversation, 10)).rejects.toThrow("required workflows");
    expect(h.store.getDelivery(h.delivery.id)).toEqual(expect.objectContaining({ checkStatus: "pending", mergeStatus: "open" }));
    expect(h.store.listDeliveryEvents(h.delivery.id).map((event) => event.kind)).toEqual(["created"]);
  });

  test("records closed PR state without pretending it merged", async () => {
    const h = harness(fakeGitHub({ pullState: "closed" }));
    const synced = await h.service.sync(h.delivery, h.conversation, 10);
    expect(synced).toEqual(expect.objectContaining({ mergeStatus: "closed", status: "blocked" }));
  });

  test("records an already-merged PR, preserves Harbor gates, and makes repeated sync idempotent", async () => {
    const h = harness(fakeGitHub({
      merged: true,
      pullState: "closed",
      mergedAt: "2026-07-18T12:00:00Z",
      mergeCommitSha: "b".repeat(40),
      branchProtected: true,
      required: { contexts: ["build"] },
      checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
    }));
    let synced = await h.service.sync(h.delivery, h.conversation, 10);
    expect(synced).toEqual(expect.objectContaining({
      mergeStatus: "merged",
      checkStatus: "passed",
      reviewStatus: "pending",
      status: "review_pending",
      latestHeadSha: "abc123",
      mergedAt: Date.parse("2026-07-18T12:00:00Z"),
      mergedRevision: "b".repeat(40),
    }));
    const eventCount = h.store.listDeliveryEvents(synced.id).length;
    const updatedAt = synced.updatedAt;
    const revision = synced.revision;
    synced = await h.service.sync(synced, h.conversation, 20);
    expect(synced.updatedAt).toBe(updatedAt);
    expect(synced.revision).toBe(revision);
    expect(h.store.listDeliveryEvents(synced.id)).toHaveLength(eventCount);

    synced = h.service.approve(synced, h.conversation, 30);
    expect(synced.approvedHeadSha).toBe("abc123");
    expect(synced.status).toBe("succeeded");
    expect(h.service.isComplete(synced)).toBe(true);
  });

  test("invalidates approval when GitHub head changes and binds re-approval to the new SHA", async () => {
    const fake = fakeGitHub({
      branchProtected: true,
      required: { contexts: ["build"] },
      checkRunsBySha: {
        abc123: [{ name: "build", status: "completed", conclusion: "success" }],
        def456: [{ name: "build", status: "completed", conclusion: "success" }],
      },
    });
    const h = harness(fake);
    let delivery = await h.service.sync(h.delivery, h.conversation, 10);
    delivery = h.service.approve(delivery, h.conversation, 11);
    expect(delivery).toEqual(expect.objectContaining({ latestHeadSha: "abc123", approvedHeadSha: "abc123" }));

    fake.state.headSha = "def456";
    delivery = await h.service.sync(delivery, h.conversation, 12);
    expect(delivery).toEqual(expect.objectContaining({
      latestHeadSha: "def456",
      approvedHeadSha: null,
      reviewStatus: "pending",
      checkStatus: "passed",
    }));
    expect(h.store.listDeliveryEvents(delivery.id).some((event) => event.kind === "evidence_invalidated")).toBe(true);
    await expect(h.service.merge(delivery, h.conversation, {}, 13)).rejects.toThrow("人工验收");

    delivery = h.service.approve(delivery, h.conversation, 14);
    delivery = await h.service.merge(delivery, h.conversation, {}, 15);
    expect(delivery.approvedHeadSha).toBe("def456");
    expect(fake.calls.filter((call) => call.method === "PUT").at(-1)?.body).toBe(JSON.stringify({ sha: "def456" }));
  });

  test("always advances implementation revision and rejects a slow sync from the previous generation", async () => {
    const gate = { entered: deferred(), release: deferred(), sha: "abc123" };
    const fake = fakeGitHub({
      branchProtected: true,
      required: { contexts: ["build"] },
      checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
      checkGate: gate,
    });
    const h = harness(fake);
    expect(h.delivery).toEqual(expect.objectContaining({
      revision: 0,
      latestHeadSha: null,
      reviewStatus: "pending",
      checkStatus: "pending",
    }));

    const syncing = h.service.sync(h.delivery, h.conversation, 10);
    await gate.entered.promise;
    const nextGeneration = h.service.prepareImplementation(h.conversation, 11)!;
    expect(nextGeneration).toEqual(expect.objectContaining({
      revision: 1,
      reviewStatus: "pending",
      checkStatus: "pending",
    }));
    gate.release.resolve();
    await expect(syncing).rejects.toThrow("旧响应已丢弃");

    expect(h.store.getDelivery(h.delivery.id)).toEqual(expect.objectContaining({
      revision: 1,
      latestHeadSha: null,
      approvedHeadSha: null,
      reviewStatus: "pending",
      checkStatus: "pending",
      mergeStatus: "open",
    }));
    expect(h.store.listDeliveryEvents(h.delivery.id).map((event) => event.kind)).toEqual([
      "created",
      "evidence_invalidated",
    ]);
    expect(fake.calls.filter((call) => call.path.endsWith("/pulls/42") && call.method === "GET")).toHaveLength(1);
  });
});

describe("GitHub controlled merge", () => {
  test("keeps policy ahead of HTTP and never writes merged before a successful API response", async () => {
    const fake = fakeGitHub({
      branchProtected: true,
      required: { contexts: ["build"] },
      checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
    });
    const h = harness(fake);
    await expect(h.service.merge(h.delivery, h.conversation, {}, 10)).rejects.toThrow("人工验收");
    expect(fake.calls.filter((call) => call.method === "PUT")).toHaveLength(0);

    let delivery = await h.service.sync(h.delivery, h.conversation, 11);
    await expect(h.service.merge(delivery, h.conversation, {}, 12)).rejects.toThrow("人工验收");
    delivery = h.service.approve(delivery, h.conversation, 13);

    fake.state.checkRuns = [{ name: "build", status: "completed", conclusion: "failure" }];
    await expect(h.service.merge(delivery, h.conversation, {}, 14)).rejects.toThrow("最新 CI checks 为 failed");
    expect(fake.calls.filter((call) => call.method === "PUT")).toHaveLength(0);

    fake.state.checkRuns = [{ name: "build", status: "completed", conclusion: "success" }];
    fake.state.mergeFailure = true;
    let failure = "";
    try {
      await h.service.merge(delivery, h.conversation, {}, 15);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toContain("merge conflict");
    expect(failure).not.toContain("fake-token");
    expect(h.store.getDelivery(delivery.id)?.mergeStatus).toBe("open");
    expect(h.store.listDeliveryEvents(delivery.id).some((event) => event.kind === "merged")).toBe(false);

    fake.state.mergeFailure = false;
    delivery = await h.service.merge(delivery, h.conversation, {}, 16);
    expect(delivery).toEqual(expect.objectContaining({ mergeStatus: "merged", mergedRevision: "b".repeat(40), status: "succeeded" }));
    expect(fake.calls.filter((call) => call.method === "PUT").at(-1)?.body).toBe(JSON.stringify({ sha: "abc123" }));
    const mergeCalls = fake.calls.filter((call) => call.method === "PUT").length;
    await h.service.merge(delivery, h.conversation, {}, 17);
    expect(fake.calls.filter((call) => call.method === "PUT")).toHaveLength(mergeCalls);
  });

  test("serializes concurrent syncs so an older response cannot finish after newer facts", async () => {
    const fake = fakeGitHub({
      branchProtected: true,
      required: { contexts: ["build"] },
      checkRunsBySha: {
        abc123: [{ name: "build", status: "completed", conclusion: "success" }],
        def456: [{ name: "build", status: "completed", conclusion: "success" }],
      },
    });
    const h = harness(fake);
    let delivery = await h.service.sync(h.delivery, h.conversation, 10);
    delivery = h.service.approve(delivery, h.conversation, 11);

    const gate = { entered: deferred(), release: deferred(), sha: "abc123" };
    fake.state.checkGate = gate;
    const older = h.service.sync(delivery, h.conversation, 12);
    await gate.entered.promise;
    fake.state.headSha = "def456";
    const newer = h.service.sync(delivery, h.conversation, 13);
    const pullCallsBeforeRelease = fake.calls.filter((call) => call.path.endsWith("/pulls/42") && call.method === "GET").length;
    expect(pullCallsBeforeRelease).toBe(2); // initial sync + older sync; newer sync 尚未启动 HTTP。
    gate.release.resolve();
    fake.state.checkGate = undefined;
    await Promise.all([older, newer]);

    expect(h.store.getDelivery(delivery.id)).toEqual(expect.objectContaining({
      latestHeadSha: "def456",
      approvedHeadSha: null,
      reviewStatus: "pending",
      checkStatus: "passed",
      mergeStatus: "open",
    }));
  });

  test("does not commit merged when implementation invalidates evidence during merge HTTP", async () => {
    const fake = fakeGitHub({
      branchProtected: true,
      required: { contexts: ["build"] },
      checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
    });
    const h = harness(fake);
    let delivery = await h.service.sync(h.delivery, h.conversation, 10);
    delivery = h.service.approve(delivery, h.conversation, 11);
    const gate = { entered: deferred(), release: deferred() };
    fake.state.mergeGate = gate;
    const merging = h.service.merge(delivery, h.conversation, {}, 12);
    await gate.entered.promise;

    h.service.prepareImplementation(h.conversation, 13);
    gate.release.resolve();
    await expect(merging).rejects.toThrow("证据已变化");
    const invalidated = h.store.getDelivery(delivery.id)!;
    expect(invalidated).toEqual(expect.objectContaining({
      reviewStatus: "pending",
      approvedHeadSha: null,
      checkStatus: "pending",
      mergeStatus: "open",
    }));
    expect(h.store.listDeliveryEvents(delivery.id).some((event) => event.kind === "merged")).toBe(false);

    fake.state.mergeGate = undefined;
    const reconciled = await h.service.sync(invalidated, h.conversation, 14);
    expect(reconciled).toEqual(expect.objectContaining({
      mergeStatus: "merged",
      reviewStatus: "pending",
      checkStatus: "passed",
      status: "review_pending",
    }));
    expect(h.store.listDeliveryEvents(delivery.id).some((event) => event.kind === "merged")).toBe(false);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeCombinedState(statuses: FakeCommitStatus[]): "failure" | "pending" | "success" {
  if (statuses.some((status) => status.state === "failure" || status.state === "error")) return "failure";
  if (statuses.length === 0 || statuses.some((status) => status.state === "pending")) return "pending";
  return "success";
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
