# Harbor GitHub Delivery Provider

## Context

P4.13 已把 Delivery policy 与 Provider 分离，但只有 `manual` provider：CI、合并都靠人工填写，Harbor 无法验证外部事实。本阶段只接入已有 GitHub PR，不负责分支推送、PR 创建、webhook 或 deployment。

## Decision

1. `manual | github` 共存，`DeliveryService` 始终内置 manual，并通过构造参数注入其他 Provider；测试替换 HTTP，不访问真实 GitHub。
2. GitHub token 只从 harbor-server 的 `HARBOR_GITHUB_TOKEN` 或 `~/.harbor.yaml` `github.token` 读取，只进入 Authorization header，不持久化、不写事件、不回显日志/REST。缺 token 时不注册 GitHub Provider，选择 GitHub 会明确报配置错误，manual 与 server 其余入口照常启动。
3. Repository `remoteUrl` 是 owner/repo 的身份真相。GitHub Delivery 优先接受 canonical PR URL，并把 URL owner/repo 与 Repository 的 HTTPS/SSH GitHub mapping 比对；也允许由 mapping + 正整数 external id 定位 PR。非 GitHub、畸形、跨 Repository URL 一律拒绝；客户端提交的 branch/check 状态不作为 GitHub 事实。
4. 显式 sync 读取 PR、base branch classic protection + active repository/organization rulesets 的 required status checks，以及 head SHA 的完整分页 latest check-runs 与 combined commit statuses。同一 required context 同时出现 check-run/status 时聚合全部来源：任一失败即 `failed`，任一 pending 即 `pending`，全部成功才 `passed`；required 缺失或完全无 checks 也是 `pending`。check-run/status 每条都必须有唯一可信 id：check-runs 每页 `total_count` 必须是稳定的非负整数且只能在累计数精确相等时完成；combined status 所有页的顶层 `state / sha / total_count` 必须相同且能由完整 statuses 推导。页内/跨页重复、count 漂移/overshoot、快照漂移或读取不完整都拒绝。当本地 required 计算为 passed、但非空 commit statuses 的顶层 combined state 更差时，该差异可能来自 unrelated context：Harbor 不伪造 required failure，而是把本次 sync 视为外部事实不可判定并保持 DB 原事实。未知 protection capability、ruleset required workflows 同样明确失败，不猜测 passed。
5. classic required-status-checks endpoint 的 404 本身无法区分“无 classic rule”与“token 缺 Administration(read)”。先读取 base branch 的 `protected` capability：明确 unprotected 才可判定无 classic protection；protected 分支的 404 必须 fail loudly/fail-safe。active rules 继续独立读取，不能拿 ruleset 可见性替代 classic permission。
6. PR `open / closed / merged` 是独立外部事实。SQLite v12 增加 closed-but-unmerged；v13 持久化 `latestHeadSha / approvedHeadSha / revision`。human approval 只绑定被审查 SHA，sync 发现 head 改变时作废旧 review/check evidence，并用同次 sync 对新 head 重建 checks。已 merged 的 PR 可以被同步，但 Issue 完成仍要求 Harbor 自己的 human review approved + checks passed。
7. merge 始终先经过 `DeliveryService` 的 Review 阶段、无 active Run、human approved、checks passed、PR open 与 `latestHeadSha === approvedHeadSha` 校验；Provider 只重验该 SHA 的最新 checks，并把同一 SHA 传给 GitHub merge API。每个 Delivery 的 sync/merge 串行，HTTP 返回落库还需 revision compare-and-set；每次新 implementation 即使事实已是 pending/pending 也无条件推进 revision。慢 sync 属于启动时的 generation，CAS 失败后丢弃且不自动重试；merge 等待期间证据变化时，即便外部 API 返回成功也不写 `merged`，后续由显式 sync 对账。
8. GitHub provider 本阶段固定 `deploymentRequired=false`。manual 的 deployment 记录行为保持不变，避免把未实现的 GitHub Actions/CD 冒充成真实能力。

## Rationale

- Repository mapping 比 Agent 自报或任意 PR URL 更接近 Harbor 已有的数据所有权边界，也能阻止跨仓误合并。
- pull-based 显式 sync 没有 webhook 基础设施，却仍能把外部事实纳入审计；幂等语义让重复点击安全。
- SHA-bound approval 把“审过这份代码”而不是“审过这个 PR 编号”作为 merge 证据；revision CAS 则把内部证据变更与慢 HTTP 结果隔离。
- “外部已 merged”与“Harbor 允许 merge”是两件事。前者必须诚实记录，后者和 Issue Done 仍由 Harbor policy 决定。
- GitHub 未配置不应把 manual 或整个 server 变成不可用；只有用户选择 GitHub 能力时才 fail loudly。

## Alternatives

- **信任 Agent/REST 提交 CI passed**：拒绝。GitHub Provider 的价值就是移除自报外部事实。
- **缺 token 时阻止 harbor-server 启动**：拒绝。会破坏 manual fallback 与无 GitHub 仓库。
- **sync 看到 merged 就直接 Done**：拒绝。会绕过 human review/check policy。
- **本期顺带创建 PR、接 webhook/CD**：拒绝。需要分支凭证、事件投递、重放与部署领域语义，超出当前已有 PR 的闭环。

## Consequences

- GitHub token 需要具备读取目标仓库 PR/check、读取 branch protection（fine-grained token 的 Administration read）、读取 active rules（Metadata read），以及合并 PR（Contents write）的权限。protected branch 上 classic API 的模糊 404 也按权限/能力不可判定处理，错误明确提示 Administration(read)，DB 保持上次成功事实。
- 未保护分支没有 required contexts 时评估当前 latest checks；完全没有 checks 仍保持 pending，不会误判 passed。
- GitHub 在没有 commit statuses 时也会给 combined status 返回 pending；这不覆盖独立 check-runs 的成功事实。只有存在 commit statuses 且完整本地快照与顶层 combined state 矛盾时才按 unavailable/fail-safe 处理。
- Active ruleset 使用 `workflows`（required workflows）时，本期 sync/merge 会明确拒绝；后续需接 Actions workflow-run/path 映射后再支持。
- merge API 已在外部成功但 revision CAS 失败时，Harbor 返回“证据已变化”，不产生 merged event、不推进 Done；再次 sync 会记录 GitHub merged 外部事实，但仍需对相同 head 重新人工验收。
- 下一步分两条独立能力演进：①由 Harbor/daemon 受控推送分支并自动创建 PR；②webhook/poll reconciliation 与真实 CD Provider（含 deployment truth），均复用现有 Delivery policy，不扩张 Agent 自报权限。

## References

- [GitHub REST: pull requests and merge](https://docs.github.com/en/rest/pulls/pulls)
- [GitHub REST: check runs](https://docs.github.com/en/rest/checks/runs)
- [GitHub REST: required status checks protection](https://docs.github.com/en/rest/branches/branch-protection)
- [GitHub REST: active rules for a branch](https://docs.github.com/en/rest/repos/rules)
