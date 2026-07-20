# Harbor Agent Sandbox Network Access

## Current Focus

v28 代码与本地验证已完成，待提交、PR merge、Agent-driven self-deploy 和生产 Codex HTTPS probe。

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
- [ ] 生产 schema/revision、Agent 配置和真实 Run HTTPS probe。

## Log

- 2026-07-20：用户明确要求 Harbor Codex Agent 能访问网络；采用显式 Agent capability，而非全局开网或 full access。

## Next

提交推送、PR merge，再由现有 Release Agent + self-deploy sidecar 部署 exact revision。
