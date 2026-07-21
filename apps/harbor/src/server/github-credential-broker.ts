import type { HarborRepository, RunPrincipal } from "../protocol.js";
import type { HarborStore } from "./store.js";
import type { GitHubAppClient } from "./github-app.js";
import type { GitHubIntegrationService } from "./github-integration.js";

/**
 * GitHub credential decision point.
 * Repository connection 只做 Workspace allowlist/context；credential 始终由 Run principal 决定。
 */
export class GitHubCredentialBroker {
  constructor(
    private readonly store: HarborStore,
    private readonly integration: GitHubIntegrationService,
    private readonly client: GitHubAppClient,
  ) {}

  async tokenForRepository(
    repository: HarborRepository,
    principal: RunPrincipal,
    forceRefresh = false,
  ): Promise<string> {
    if (repository.scmProvider !== "github") {
      throw new Error(`Repository "${repository.name}" SCM provider 不是 GitHub`);
    }
    const connection = this.store.githubRepositoryConnectionForRepository(repository.id);
    if (!connection || connection.workspaceId !== repository.workspaceId) {
      throw new Error(`Repository "${repository.name}" 尚未连接可用的 GitHub App installation`);
    }
    if (principal.type === "account") {
      const membership = this.store.membershipForAccount(principal.id, repository.workspaceId);
      if (!membership || membership.id !== principal.membershipId) {
        throw new Error("Run Account principal 已不再拥有 Repository Workspace 的 active Membership");
      }
      return this.integration.userAccessToken(principal.id, forceRefresh);
    }
    if (principal.type === "service") {
      if (!this.store.isActiveServicePrincipal(principal.id, repository.workspaceId)) {
        throw new Error("Run ServicePrincipal 不属于 Repository Workspace 或已停用");
      }
      return this.client.installationToken(connection.installationId, forceRefresh);
    }
    throw new Error(
      principal.type === "external"
        ? "外部触发者没有 Harbor Account GitHub authorization，不能执行 GitHub 写操作"
        : "system principal 不得隐式借用 Workspace installation credential",
    );
  }
}
