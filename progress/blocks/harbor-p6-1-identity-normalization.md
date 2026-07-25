# Harbor P6.1 Identity Normalization

## Current Focus

schema v23 identity normalization、Account auth 与 Web 登录面已合入 `main@4a08789` 并 exact-revision 部署到 Mac mini；生产 migration、health、Web、双 Device、rollback anchor 全部通过。本阶段未修改 daemon credential 或 WS hello；仅余用户在生产 origin 完成 first-owner Passkey ceremony并保存 recovery codes。

## Log

### 2026-07-19

- 从 `main@59911de` 创建 `codex/harbor-p6-1-identity-normalization`。
- 已读取 `progress/README.md`、`progress/harbor-account-system.md`、glossary、领域语言与 worktree 规则。
- 新增 canonical v22 fixture：单 owner/multi-Workspace、重复邮箱、跨 Workspace trusted external identity、disabled token、invited row，以及 Agent/Conversation/Message/token 全部 legacy member reference 面。
- 新增只读 `harbor db identity-report [--database <v22.db>] [--json]`。健康 fixture 投影 `9 members → 5 Accounts / 8 Memberships / 1 Invitation / 1 AuthIdentity / 2 PATs`；异常 invited reference 返回 exit 2 并列出稳定 blocker code/ref。
- schema v23 新增 Account/AuthIdentity/Passkey/RecoveryCode/Session/PAT/Invitation，迁移前强制消费同一 dry-run report；synthetic owner 与 trusted external identity 归一化，legacy Membership/reference ID 保持不变。
- REST principal 统一为 Account Session/PAT 或 system compatibility gate；Session 使用 opaque hash + HttpOnly cookie，写操作校验 pinned Origin/CSRF；PAT 同时受 scope、实时 Membership 与 Workspace binding 约束。
- 完成 first-owner bootstrap、discoverable Passkey login、recovery、额外 Passkey、PAT 自助、invite-only 注册、Workspace switcher、last-owner 保护；浏览器已移除长期 token localStorage 路径。
- Web 新增 `/login`，Settings 分为 Workspace / Account / Membership+Invitation；构建输出 13 个静态页面。
- 生产 v22 在线一致性 backup 已落 `/Users/smokingmouse/.harbor/backups/pre-v23-identity-20260719/harbor.db`（SHA-256 `4650f9ec2f88bc833bd8dca425cb0f1537ddb3048c97e0c19e8aa6a345756aba`，integrity=ok，FK=0）。
- 生产 backup 的只读 identity report PASS：`1 legacy member → 1 Account / 1 Membership`，无 blocker/warning，report 前后 SHA 不变；另在一次性本地副本真实演练 v22→v23，schema=23、`ws_personal → acc_bootstrap`、132 个 maintenance triggers、integrity=ok、FK=0，副本已删除。
- 首次 production deployment attempt 在 maintenance 前卡于 fresh `bun install`；根因是本机默认 registry 把新 WebAuthn tarball 锁到 Mac mini 不可达的 `bnpm.byted.org`。在 gate=0 时终止 child，job 安全落为 failed/rollback_complete；随后重锁到公共 npm 并新增 repo-local `bunfig.toml` 防回归。
- `main@4a0878905e7290232745f74eceebb8e0fd2aba03` 经 Issue `c_1rqznin12z` / Delivery `del_1jatzxy50i` 部署。首次 cutover 的 exact launchd stop proof fail-closed 到 `needs_recovery`；显式 recovery 验证旧 baseline、恢复服务并清闸，Retry Job `depjob_nkfdb6bmm1` 随后 succeeded/healthy。
- 生产 DB 已是 v23：Account=1、Membership=1、`ws_personal.created_by_account_id=acc_bootstrap`、legacy member ID 保持不变、integrity=ok、FK=0；public root/login=200、unauth API=401，MacBook/Mac mini 两台 Device 在线。部署前 v22 backup 与 rollback anchor 均为 0600。

## Decisions

- identity normalization 只按可信 `(provider, external_id)` 合并；仅重复邮箱不能触发 Account 合并。
- legacy Membership 继续复用原 `workspace_members.id`；invited row 转 Invitation；异常引用必须在 dry-run 阶段阻断 migration。
- P6.1 保留 system token 数据面兼容闸；daemon credential 留到 P6.2。
- Invitation 注册只在接收者主动开始 ceremony 后创建 suspended Account；Invitation ID 绑定进一次性 WebAuthn challenge，验证成功后事务内激活 Account、创建 personal Workspace/target Membership/recovery codes。
- Passkey RP ID/Origin 只从管理员配置 `HARBOR_PUBLIC_URL` 或 `public_url` 派生；非 localhost 强制 HTTPS，禁止从请求 Host 推断。
- 已登录 Account 绑定 Passkey 沿用当前 Session，不额外铸造长期 Session。

## Verified

- `harbor db identity-report` 的 PASS 与 BLOCKED fixture 前后 SQLite SHA-256 一致；BLOCKED path 精确返回 exit 2。
- `bun test`：414 pass / 0 fail / 2136 assertions（src + build dist）；生产 backup migration drill 同样通过。
- root `bun run typecheck`、root build、Harbor Web typecheck/build、`git diff --check` 全绿。
- public-registry lock 验证 `bnpm=0`；无显式 `--registry` 的 frozen install 由 repo `bunfig.toml` 固定到 `https://registry.npmjs.org`。
- daemon、`server/ws.ts`、deployment-worker 无 diff；未修改 credential/hello contract。
- current release、health 与 Delivery 的 revision 均精确为 `4a0878905e7290232745f74eceebb8e0fd2aba03`；maintenance DB/host gate 均为空。

## Next

- 用户访问 `https://harbor.home.smokingmouse.cn/login`，输入 system bootstrap token，用 Touch ID 创建 first-owner Passkey，并离线保存 10 个一次性 recovery codes。
- 完成后复核 bootstrap.required=false、Passkey=1、RecoveryCode=10，再移除 worktree/feature branch并关闭本 block。
- P6.2 才迁移 daemon credential / Device enrollment；不要在本分支追加。长驻 deploy-worker 未及时领取 queued Job 的 wakeup 根因另行处理。
