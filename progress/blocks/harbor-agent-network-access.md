# Harbor Agent Sandbox Network Access

## Current Focus

v28 已完成开发、PR merge、Agent-driven self-deploy、目标 Device daemon rollout 与生产 Codex HTTPS probe；本 block 无剩余 migration/deployment item。

## Contract

- 仅 Codex `workspace-write` Run 可按 Agent 显式配置直接联网；旧 Agent 默认关闭。
- read-only 不为联网扩大文件写权限，full 不伪装为受控网络。
- self-deploy merged coordination 无条件断网，继续走 isolated outbox + daemon sidecar。
- 生产只给确有需要的 Codex Agent 开启，不批量改变 Claude 或所有历史 Agent。

## Verification

- [x] Codex CLI 0.144.5 本机真实 `workspace-write + network_access=true` 访问 `https://github.com` 返回 HTTP/2 200。
- [x] v27 fixture → v28 migration 保留 Agent 并默认关闭，布尔 CHECK 与 FK/integrity 通过。
- [x] 生产 schema v27 在线 backup migration drill → v28：12 Agents 全保留、enabled=0、3 条历史 self-deploy jobs 保留、integrity=ok、FK=0；原生产 DB 复核仍是 v27/12 Agents/gate=0。
- [x] REST create/patch、Claude 负向校验、scheduler RunSpec、Codex initial/resume args 和 self-deploy override 定向覆盖。
- [x] root 与 Harbor Web typecheck。
- [x] 全量 421 tests / 2143 assertions、root/Web typecheck、全部 workspace production build（Next 13 static pages）与 diff check。
- [x] 生产 feature revision `fcc8185575a80f37512ae5f8c98a46da67c20357` / schema v28，integrity=ok、FK=0、gate=0；Release Run `r_3ota11tnil` → sidecar Job `depjob_10dvwaarbs` attempt 1 healthy。
- [x] 仅 `Harbor Feature Builder` 开启 direct network；Reviewer 与 Release Builder 保持关闭，MacBook Device daemon 同步滚到 exact feature revision。
- [x] 旧 Device daemon 上的反例 Run `r_2hxh4hjh64` 仍 DNS blocked；rollout 后真实 Harbor Run `r_3lfwjxskdb` 访问 GitHub 返回 HTTP/2 200，两个验收 worktree 已清理。

## Log

- 2026-07-20：用户明确要求 Harbor Codex Agent 能访问网络；采用显式 Agent capability，而非全局开网或 full access。
- 2026-07-20：PR #1 merge 后首次 GitHub delivery 超时 500；确认未落 Run 后 redelivery=202，Release Agent 与 sidecar 完成 exact cutover。生产反例证明 RunSpec capability 变更必须同步 rollout 实际执行 Device daemon，补齐后通过 HTTPS acceptance。

## Next

本 block 已完成。下一阶段按 `progress/harbor-account-system.md` 进入 schema v29 的 P6.2 Device ownership/enrollment；daemon credential 仍未改。
