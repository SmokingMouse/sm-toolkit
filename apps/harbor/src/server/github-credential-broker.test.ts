import { describe, expect, test } from "bun:test";
import { openDb } from "./db.js";
import { GitHubCredentialBroker } from "./github-credential-broker.js";
import type { GitHubAppClient } from "./github-app.js";
import type { GitHubIntegrationService } from "./github-integration.js";
import { HarborStore } from "./store.js";

test("GitHub broker treats Repository mapping as allowlist and chooses credential from principal", async () => {
  const db = openDb(":memory:");
  try {
    const store = new HarborStore(db);
    const workspace = store.defaultWorkspace();
    const repository = store.createRepository({
      workspaceId: workspace.id,
      name: "repo",
      remoteUrl: "https://github.com/acme/repo.git",
    }, 1);
    store.upsertGitHubInstallation({
      installationId: "77",
      appId: "123",
      targetId: "42",
      targetType: "User",
      targetLogin: "owner",
      repositorySelection: "selected",
      permissions: { contents: "write" },
    }, 2);
    store.connectGitHubInstallation({
      workspaceId: workspace.id,
      installationId: "77",
      connectedByAccountId: "acc_bootstrap",
    }, 2);
    store.upsertGitHubRepositoryConnection({
      workspaceId: workspace.id,
      repositoryId: repository.id,
      installationId: "77",
      githubRepositoryId: "99",
      fullName: "acme/repo",
      defaultBranch: "main",
      private: true,
    }, 2);
    const githubRepository = store.getRepository(repository.id)!;
    expect(githubRepository.scmProvider).toBe("github");
    const device = store.upsertDevice("worker", "hash", { clis: { codex: "1" }, endpoints: [] }, 2);
    const agent = store.createAgent({ name: "agent", deviceId: device.id, backend: "codex", workdir: "/repo" }, 2);
    const automation = store.createAutomation({
      name: "auto",
      agentId: agent.id,
      prompt: "run",
      trigger: { type: "schedule", cron: "0 9 * * *", timezone: "Asia/Shanghai" },
    }, 3);
    const calls: string[] = [];
    const integration = {
      userAccessToken: async (accountId: string, force: boolean) => {
        calls.push(`user:${accountId}:${force}`);
        return "ghu_user";
      },
    } as unknown as GitHubIntegrationService;
    const client = {
      installationToken: async (installationId: string, force: boolean) => {
        calls.push(`installation:${installationId}:${force}`);
        return "ghs_service";
      },
    } as unknown as GitHubAppClient;
    const broker = new GitHubCredentialBroker(store, integration, client);
    const membership = store.membershipForAccount("acc_bootstrap", workspace.id)!;

    expect(await broker.tokenForRepository(githubRepository, {
      type: "account",
      id: "acc_bootstrap",
      membershipId: membership.id,
      initiator: {},
    })).toBe("ghu_user");
    expect(await broker.tokenForRepository(githubRepository, {
      type: "service",
      id: automation.servicePrincipalId,
      membershipId: null,
      initiator: {},
    }, true)).toBe("ghs_service");
    await expect(broker.tokenForRepository(githubRepository, {
      type: "system",
      id: null,
      membershipId: null,
      initiator: {},
    })).rejects.toThrow("不得隐式借用");
    expect(calls).toEqual([
      "user:acc_bootstrap:false",
      "installation:77:true",
    ]);
  } finally {
    db.close();
  }
});
