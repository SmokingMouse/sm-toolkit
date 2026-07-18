# Harbor Mew Parity — Completion Track

## Current Focus

Mew parity 的个人部署边界已全部实现并通过全仓、生产构建与真实浏览器验收；等待提交、合并和 dashboard 收口。

## Scope

- Codebase MR / review / checks / merge 作为真实 Delivery Provider；webhook 与主动 refresh 都走同一事件归一化层。
- Codebase Issue / MR 可映射为 Harbor Issue，保留外部引用、作者、事件和幂等键；Agent 能在 Run 内创建后续 Issue。
- Agent 补齐 Mew 实站已验证的 concurrency、visibility、environment、setup commands 与多 Repository 可见性。
- Skill 补齐 group、多文件 bundle、source import、dependency、hash 与 auto-sync，不再只保存一段 SKILL.md 文本。
- Lark Integration 补齐 Workspace 群绑定、默认 Agent、thread/chat 映射、mention-only/all-message 与 thread/new-message 回复策略。
- Workspace 补齐 Basic、Members、Owner/Admin/Member 权限边界；仍保持 Harbor 是个人部署，不实现公司 SSO 或 Mew 云端 managed Device。
- Issues 补齐 owner、labels、mentions、外部来源与 Agent 创建 follow-up Issue 的受控 API。

## Verified Mew Evidence

- 2026-07-19 只读实站：Agent 详情包含 Provider/model/permission/concurrency/device/workdir/visibility/skills/repositories/environment/setup；一个 Agent 可见多个 Repository。
- 2026-07-19 只读实站：Skills 支持 group、多文件包、entry/bundle hash、dependencies、local runtime/local upload/platform preset、auto-sync 与 source import（Codebase/GitHub/AgentBuddy/ZIP）。
- 2026-07-19 官方文档：Workspace 是资源与权限隔离单位，角色为 Owner/Admin/Member；飞书群绑定 Workspace + 默认 Agent，thread 映射 Chat，支持引用/附件上下文与成功/失败回流。
- 2026-07-19 Mew workflow Skill：todo 才是可消费队列；实现完成后进入 review 并 mention creator，不由执行 Agent 直接置 done；交付循环包含本地验证、commit、验收环境、rebase/push 与 review handoff。

## Decisions

- Harbor 保留确定性 control plane：Agent 可以请求 Issue/Delivery 动作，但不能绕过 review/check/merge policy；外部平台事件是事实输入，不直接成为权限来源。
- SCM Provider 接口不绑定 Codebase payload；所有 webhook/refresh/CLI 输出先归一化为 repository / issue / merge-request / review / check / merge events，再投影到 Harbor。
- Codebase 凭证不进入 Agent prompt、Run event 或数据库明文。首个实现允许 server 侧调用 `bitscli codebase`，命令可配置并以 fake runner 测试；后续可把同一 RPC 下沉 daemon，不改领域模型。
- “完整复刻”以个人部署可用的产品能力为边界；Mew 的 ByteDance SSO、公司通讯录全量邀请、云端 managed runtime 不做伪实现。

## Validation

- 每个 migration 跑 legacy upgrade + foreign key check。
- Provider 使用 fake CLI + webhook fixture 覆盖 MR/review/check/merge、幂等、乱序和失败恢复。
- REST 覆盖 Workspace scope / RBAC / secret redaction；Web 做桌面与 390px 验收。
- 合并前根 test/typecheck、Harbor build、harbor-web production build、`git diff --check` 全过。

## Environment Blockers

- 当前机器没有 `bitscli`；真实 Codebase 账号冒烟需要安装 `@byted/bits-cli` 并完成 `bitscli codebase auth login`，实现与 fake CLI 验证继续进行。

## Session Log

- 2026-07-19 Done：新增 v13 schema（SCM 事件/外部对象、Members/API token、Agent 多仓库与执行配置、Skill bundle、Issue labels/messages、Lark binding）；Codebase Delivery Provider 用显式 `-N/-R` 调 bitscli，只有已确认 merge 才加 `--yes`；主动 refresh 投影 Review/CI/Merge。
- 2026-07-19 Done：Codebase webhook 先幂等落 `scm_events`，再创建/更新 Harbor Issue、Delivery、评论和状态；Repository 显式开启 auto-dispatch 后，外部 Issue 或 `@harbor` 评论才派活；Run 结果可回写原 Codebase Issue/MR。
- 2026-07-19 Done：v14 增加 Run attachments 与 2 小时、单 Run、hash-only action token；Lark 文件实际下载并安全落临时目录，Agent 仅能创建同 Workspace 的 backlog follow-up Issue，不能越权派发或改状态。
- 2026-07-19 Done：Agent 调度实现 Device 总并发 + Agent 独立并发、setup hash cache、env 仅进子进程、多 Repository mount 和 private visibility；管理端可完整编辑对应配置，Device 页面显示真实 Assigned Agents。
- 2026-07-19 Done：Skills 支持 group、多文件 bundle/dependencies/hash、runtime/Codebase/GitHub/ZIP import、auto-sync；Workspace 支持 Owner/Admin/Member、一次性 member token、private Agent 与 env redaction。
- 2026-07-19 Done：Lark 支持 Workspace 群绑定、mention/all、thread/message 回流、DM 禁止执行、附件与讨论持久化；global/custom 多 Bot profile 按 binding 唯一路由，secret 只留 server YAML。
- 2026-07-19 Done：Issues 支持 creator/owner/labels/messages/source ref、外部 Issue/MR ingress、Codebase Delivery refresh/review/check/merge；Prompt pipeline 暴露 owner/labels/recent discussion/SCM/Agent 变量。
- 2026-07-19 Verify：`bun test` 108 pass / 574 assertions；根 `tsc --build` 与全部 workspace production build 通过；`git diff --check` 通过。
- 2026-07-19 Verify：真实浏览器在隔离 DB 上走通 Member/Label 创建、Issue owner+label 落库、Agent config、Skill import、Device→Agent 映射；1440px 与 390px 页面验收，浏览器 page errors 为 0。
- Next：合并回 main 后把本 block 提炼进 `progress/README.md`，删除 block/worktree；安装并登录 `bitscli codebase` 后补一次真实账号 smoke test。
