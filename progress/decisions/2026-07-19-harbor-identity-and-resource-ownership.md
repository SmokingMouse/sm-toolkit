# ADR：Harbor 身份与资源所有权边界

- **日期**：2026-07-19
- **状态**：Accepted
- **关联方案**：[`../harbor-account-system.md`](../harbor-account-system.md)

## Context

Harbor 已有 Workspace RBAC、Workspace API token、Agent `private | workspace` visibility 和创建者 Member，但仍以单实例 owner token 为认证根：WorkspaceMember 同时承担身份与成员关系，Device 无 owner 且 daemon 使用系统 token，Automation 无独立 principal。这套模型满足个人部署，不能安全表达多账户、多 Workspace 与用户自带 Device。

## Decision

1. 引入全局 `Account`；`WorkspaceMembership` 只表达 Account 在 Workspace 的角色和状态。
2. Workspace 升级为资源与授权边界，拥有 Agent、Repository、Skill、Conversation、Automation 和 Integration。
3. Device 首期恰好由一个 Account 拥有；通过 `WorkspaceDeviceGrant` 授权 Workspace 调度，不直接归 Workspace。
4. Agent 只归一个 Workspace，并只能绑定已 grant 的 Device；不允许跨 Workspace 共享 Agent。
5. Agent visibility 扩为 `private | workspace | restricted`，权限拆为 discover/run/edit/manage/audit。
6. Automation 使用 Workspace ServicePrincipal；Run 冻结真正调用 principal，Agent child dispatch 不产生权限提升。
7. Browser Session、PAT、DeviceCredential、Run token 和 system break-glass token 分离用途与解析路径。
8. `HARBOR_TOKEN` 从日常万能凭证降为 bootstrap/break-glass；迁移完成后不再用于普通数据面和 daemon。

## Rationale

- Account 与 Membership 分离后，一个人可以稳定加入多个 Workspace，离开 Workspace 也不会丢失身份或历史。
- Device 所有权与 Workspace 使用权分离，既保护个人机器，也允许一台机器参与多个团队。
- Agent 归 Workspace，保证其 Repository、Skill、Issue、Automation 和审计处在同一安全边界。
- ServicePrincipal 消除 Automation 借用创建者长期权限的问题。
- 分离 credential 类型能阻止 Device token 横向调用 Workspace API。

## Alternatives

- **Account 直接拥有全部资源**：成员离开、Agent 协作和 Workspace 生命周期无法成立，拒绝。
- **Device 属于单个 Workspace**：个人机器参与多个 Workspace 时必须复制身份，拒绝。
- **Workspace 拥有 Device**：更适合企业 runner，但会让 Workspace admin 可控制个人机器；首期拒绝，未来另建 Workspace-owned runner。
- **继续 WorkspaceMember 即身份**：短期改动小，但跨 Workspace 账户、登录与 Device owner 仍无法表达，拒绝。

## Consequences

- Workspace 从“非租户的逻辑分组”升级为实例内的安全租户边界，但仍不承担计费或跨实例组织能力。
- 账户方案仍按四个独立阶段 migration；因性能与 Automation schema 已占用 v24/v25，当前编号顺延为 v23、v26–v28。Web 登录面和 daemon 换证的边界不变；live migration 窗口会短暂存在兼容读路径。
- Device owner 离开 Workspace 时其 grant 自动 revoke；首期若要保留机器，必须先转移 Device ownership。
- Workspace owner 对 private Agent 不是密码学不可见，但任何提权必须显式且可审计。
- Harbor 的开放编排决策不变：身份层授权“能否调用”，用户仍定义“调用哪个 Agent、如何流转”。
