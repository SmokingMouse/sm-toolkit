# Harbor 账户、Workspace、Device 与 Agent 访问体系方案

> 状态：Approved for implementation（2026-07-19）
>
> 读者：下一轮负责 Harbor 身份与多用户能力的开发者、Reviewer 及部署维护者
>
> 决策 ADR：[`decisions/2026-07-19-harbor-identity-and-resource-ownership.md`](decisions/2026-07-19-harbor-identity-and-resource-ownership.md)

## 结论

Harbor 下一阶段引入全局 `Account`，但不建立 `Account → Device → Agent → Workspace` 的所有权树。终态采用四条正交关系：

1. `Account` 是全局的人类登录身份。
2. `Workspace` 是协作、资源与授权边界；`WorkspaceMembership` 连接 Account 与 Workspace。
3. `Device` 是 Account 拥有的执行主体；`WorkspaceDeviceGrant` 决定某个 Workspace 能否调度它。
4. `Agent`、Repository、Skill、Issue、Automation 均归 Workspace；Agent 只能绑定已经授权给该 Workspace 的 Device。
5. Automation 使用 Workspace 内的 `ServicePrincipal` 执行，不能借用创建者 Session 或 server owner token。

```text
Account ──< WorkspaceMembership >── Workspace ──owns── Agent / Issue / Automation
   │                                      │
   └──owns── Device ──< DeviceGrant >─────┘

Human / ServicePrincipal ── AgentAccessGrant ──> Agent ──binds──> granted Device
```

该方案保留 Harbor 当前“开放编排”的边界：Harbor 只负责认证、授权、事件、Run 和安全校验，不内置 Orchestrator、Reviewer Pool 或 Agent 选择策略。

## 1. 问题与成功标准

### 1.1 当前阻塞

当前实现已经有 Workspace RBAC 和 Agent `private | workspace` visibility，但身份仍然是 Workspace 内的 `WorkspaceMember` 副本：

- 同一个人加入多个 Workspace 时没有稳定的全局 ID。
- 浏览器依赖手工粘贴 Bearer token，无法登录、邀请、切换账户或安全退出。
- daemon 与普通 REST 共用 `HARBOR_TOKEN`；任何 Device 都持有系统级凭证。
- Device 是全局无主资源，无法解释“谁能看、谁能授权、成员离开后怎么办”。
- Agent 的 `private` 依赖 `created_by_member_id`，跨 Workspace 无法识别同一创建者，也没有 restricted ACL。
- Automation 没有独立执行身份，Run 审计不能稳定回答“是谁授权这次执行”。

代码证据：`apps/harbor/src/protocol.ts` 的 `Device` 无 owner、`WorkspaceMember` 直接保存身份字段；`apps/harbor/src/server/db.ts` v13 创建 Workspace-scoped member/token；`apps/harbor/src/server/ws.ts` 用全局 token 完成 daemon hello；`apps/harbor/src/server/rest.ts` 的 `canSeeAgent` 只处理 workspace/private。

### 1.2 成功标准

- 两个 Account 可以加入同一 Workspace，也可以处于互不相交的 Workspace，所有 REST、SSE、WS 和 Run action 都不能越界。
- 一个 Account 可以拥有多台 Device；一台 Device 可以显式授权给多个 Workspace，但不会泄漏其他 Workspace、绝对路径、环境变量或凭证。
- Workspace 中的 Agent 可设为 `private | workspace | restricted`，并独立控制 discover/run/edit/manage/audit 权限。
- Workspace 成员离开后，其 Session、PAT 和 Agent ACL 立即失效；Workspace 资源与历史不被级联删除。
- Device credential 只能连接 daemon 端点，不能调用普通 Workspace API；撤销后不能创建新连接或接收新 Run。
- Automation 以可审计的 Service Principal 执行；它只能调用显式授权的 Agent。
- 现有单用户生产库、两个 Device、所有 Workspace/Agent/Run/Delivery 历史可无损迁移。
- 正常 Web 使用不再把长期 token 写进 localStorage；`HARBOR_TOKEN` 只保留 bootstrap/break-glass 用途。

## 2. 目标与非目标

### 2.1 目标

- 自托管实例内的多账户登录、邀请、Workspace 切换与成员管理。
- 人类 Account、Device Principal、Service Principal 三类调用者的统一授权与审计。
- Device 所有权、注册、轮换、撤销及 Workspace 授权。
- Agent 可见性与可执行权限分离。
- 兼容现有开放式 Run/Automation 编排、SCM Delivery 和确定性 Deployment Provider。

### 2.2 非目标

- 不做跨 Harbor 实例的联邦身份或 Agent 市场。
- 不做组织计费、套餐、席位或 SaaS 控制台。
- 首期不支持一台 Device 多 Account 共同拥有，也不支持 Workspace-owned runner；需要时另建 `DeviceOwnership` 模型，不能塞进 owner 字段。
- 不允许一个 Agent 跨 Workspace 共享；跨 Workspace 复用通过 clone/import 显式复制配置。
- 不把 Device grant 等同于 SSH、Shell 或文件浏览权限；它只允许 Harbor 经已授权 Agent 派发 Run。
- 外部 Feishu/SCM 发言者不会因一条消息自动成为 Account。

## 3. 领域模型与不变量

| 实体 | 定义 | 基数与硬约束 | 删除/失效语义 |
|---|---|---|---|
| Account | Harbor 实例内稳定的人类身份 | 1 Account 可有 N Identity、N Session、N Device、N Membership | 只做 suspend/soft delete；不级联删除 Workspace 资源 |
| AuthIdentity | 登录方式与外部 subject 的绑定 | `(provider, subject)` 全局唯一；一个 Account 可绑定多个 | 解绑不能删除最后一种可恢复身份 |
| Workspace | 资源与授权边界 | `personal | team`；资源只归一个 Workspace | archive 后禁新写；历史保留 |
| WorkspaceMembership | Account 在 Workspace 的资格与角色 | `(workspace, account)` 唯一；role=`owner|admin|member` | disable 后动态撤销访问；不改历史 actor |
| WorkspaceInvitation | 尚未成为成员的邀请 | token hash 唯一；状态 pending/accepted/revoked/expired | 接受后事务内创建 Membership 并终结邀请 |
| Device | 运行一个 harbord 的机器身份 | 首期恰好一个 owner Account；可授权 N Workspace | revoke 后断连并拒绝新 Run；历史快照保留 |
| DeviceCredential | daemon 专用长期凭证 | 一台 Device 可有多个版本但同一时刻只保留有限 active credential | 只存 hash；rotate/revoke；不能访问普通 API |
| DeviceEnrollment | 短期单次注册凭证 | 10 分钟过期、单次消费、绑定发起 Account | 成功换取 DeviceCredential 后立即失效 |
| WorkspaceDeviceGrant | Workspace 对 Device 的使用许可 | `(workspace, device)` 唯一；Device owner 必须是 active member | revoke 立即阻止新 Run并 best-effort cancel 运行中 Run |
| Agent | Workspace 内的可执行配置 | 恰好一个 Workspace；当前绑定一个已授权 Device | archive/blocked 不删除历史 Run |
| AgentAccessGrant | 对 restricted/private Agent 的加法 ACL | principal 只能是同 Workspace Account 或 ServicePrincipal | Membership/Principal 失效时动态失效 |
| ServicePrincipal | Workspace 内非人类执行身份 | 首期每个 Automation 自动拥有一个 | Automation archive 后 disable；历史保留 |
| RunPrincipal | Run 创建时冻结的调用者快照 | account/service/system/external 四类之一 | 永久审计，不随成员改名或离开重写 |

### 3.1 核心不变量

1. `Agent.workspace_id == WorkspaceDeviceGrant.workspace_id`，且 grant active，才允许 Agent 绑定 Device 或创建新 Run。
2. Device owner 必须是目标 Workspace 的 active member，才能新建 WorkspaceDeviceGrant。
3. Device owner Membership 被禁用时，该 owner 在此 Workspace 的全部 Device grant 自动 revoke；需要保留机器时必须先转移 Device ownership。
4. Workspace 必须至少有一个 active owner；最后一位 owner 不能退出、被禁用或删除 Account。
5. `personal` Workspace 只允许它的 owner Membership；团队协作使用 `team` Workspace。
6. Agent ACL 只能引用同 Workspace 的 active principal，不允许跨 Workspace ID。
7. 授权在 Run 入队和实际 dispatch 两处都重新校验；排队期间权限被撤销的 Run 不得继续执行。
8. Run 的 Repository、mount、execution root、Device 和 principal 都是快照，后续迁移或成员变更不重写历史。

## 4. 身份与认证

### 4.1 登录方式

实现可扩展 `AuthProvider`，首期提供：

- **Passkey**：Web 主登录方式，适合已有 HTTPS 域名的自托管实例。
- **Recovery code**：bootstrap 时生成一次、只展示一次，hash 后保存；用于丢失 Passkey 后恢复。
- **Personal Access Token（PAT）**：Account 自己创建，用于 CLI/API；管理员不能替别人铸造 token。
- GitHub/Feishu OAuth 后续作为额外 AuthIdentity 接入，不改变 Account/Membership 模型。

实例首次启动采用 one-time bootstrap：只有数据库中尚无可登录 owner，且请求同时持有 system bootstrap token 时，才能给迁移生成的 bootstrap Account（或全新 Account）绑定第一枚 Passkey并生成 recovery codes。之后默认 `registration_mode=invite_only`；邀请链接可以在没有邮件服务时手工复制。未来允许管理员显式切到 `open`，但不能作为默认值。

浏览器 Session 使用随机 opaque token，服务端只存 hash；Cookie 必须 `HttpOnly + Secure + SameSite=Lax`。写请求同时校验 Origin/CSRF。Session、PAT、Device credential 和 Run token 使用不同前缀与解析路径，禁止跨用途复用。

Passkey 的 RP ID 和 allowed origin 只从管理员配置的 `HARBOR_PUBLIC_URL` 派生，不能相信请求 Host header。生产使用 `https://harbor.home.smokingmouse.cn`；localhost 开发凭证与生产凭证隔离。

### 4.2 调用者模型

统一授权入口解析为 `PrincipalContext`：

```ts
type PrincipalContext =
  | { kind: "account"; accountId: string; membershipId: string; workspaceId: string }
  | { kind: "service"; servicePrincipalId: string; workspaceId: string }
  | { kind: "device"; deviceId: string }
  | { kind: "system" }
  | { kind: "external"; provider: string; subject: string; workspaceId: string };
```

- Account Session/PAT 进入 Workspace API 时必须解析 active Membership。
- Service Principal 只能由 server 内部 Automation/Integration 启动，首期不发通用 bearer token。
- Device Principal 只能访问 daemon hello、heartbeat、Run event/result、capability sync 等白名单接口。
- External Principal 只通过 Integration policy 创建 Issue/Message/SCM fact，不能直接调用 Agent 管理 API。
- System Principal 对应 `HARBOR_TOKEN`，只用于首次 bootstrap、灾难恢复和兼容窗口；每次使用写 security audit。

### 4.3 PAT scope

PAT 同时受三层约束：token scopes、实时 Membership、资源 ACL。建议首期 scopes：

- `workspace:read`
- `workspace:write`
- `agent:run`
- `agent:manage`
- `device:manage`

PAT 可绑定一个 Workspace；未绑定时仍需每个请求显式选择 Workspace 并通过 Membership。PAT 永不包含 system 权限。

## 5. Workspace 与成员生命周期

### 5.1 Workspace 类型

- Account 首次 bootstrap/注册后自动创建一个 `personal` Workspace。
- 多人协作必须创建 `team` Workspace，再通过邀请加入。
- Account 与 Workspace 是多对多；前端 Workspace switcher 只展示 active Membership。
- Workspace 资源属于 Workspace，而不是创建者。创建者离开不会删除 Agent、Issue、Automation 或 Delivery。
- Account suspend 会在一个事务内撤销 Session/PAT、禁用 Membership、撤销其 Device credential 与 Workspace Device grant；Account delete 只做软删除，并要求先转移所有 team Workspace ownership。personal Workspace 随 Account archive，但历史保留。

### 5.2 邀请和角色

邀请流程：owner/admin 创建 invitation → 接收者登录或注册 → 校验邀请目标 → 事务内创建 Membership → invitation accepted。未知邮箱不提前创建 Account，也不再使用“没有登录身份的 invited Member”。

| 动作 | member | admin | owner |
|---|---:|---:|---:|
| 读取 Workspace 常规资源 | ✓ | ✓ | ✓ |
| 创建 Issue/Chat、运行 workspace Agent | 按 Agent policy | 按 Agent policy | 按 Agent policy |
| 管理 Repository/Skill/Automation | — | ✓ | ✓ |
| 邀请/禁用 member | — | ✓ | ✓ |
| 授予/revoke admin | — | — | ✓ |
| 转移 ownership、archive Workspace | — | — | ✓ |
| 授权自己的 Device 给 Workspace | ✓ | ✓ | ✓ |

Workspace role 只提供资源管理基线；Agent 能否被发现、运行和编辑仍由 Agent policy 决定。

## 6. Device 注册、可见性与授权

### 6.1 注册流程

1. Account 在 Web/CLI 创建一次性 DeviceEnrollment。
2. UI 展示 `harbor daemon enroll --server <url> --token <one-time-token>`。
3. daemon 提交 token、设备名和能力摘要；新设备由 server 分配 Device ID，丢失凭证的已有设备只能由同一 owner 创建定向 recovery enrollment。
4. server 原子消费 enrollment，创建/认领 Device，返回只展示一次的 DeviceCredential。
5. daemon 写入 0600 本地配置；之后 WS hello 使用 `deviceId + credential`。
6. rotate 时新旧 credential 短暂重叠，首次新 credential 成功连接后撤销旧 credential。

设备名只用于展示，Device ID 与 credential 才是身份；同名不再 upsert 或踢掉另一个账户的机器。

### 6.2 两层可见性

- **My Devices**：Account 看见自己拥有的全部 Device、完整连接状态、credential 状态和它授权过的 Workspace。
- **Workspace Devices**：成员只看见 grant 给当前 Workspace 的 Device 安全投影：展示名、online、可用 Runtime/model、与当前 Workspace 的 Agent/Repository mount 是否就绪。

Workspace projection 不返回：owner 的其他 Workspace、绝对路径、原始 installed Skill 正文、环境变量、credential hash/prefix、系统服务配置。

### 6.3 grant 与 Repository mount

- 只有 Device owner 可以创建 grant；Device owner 或目标 Workspace 的 admin/owner 可以 revoke。Workspace admin 不能单方面征用或重新启用成员机器。
- grant 只允许 Harbor 调度，不自动授予文件浏览、Shell 或任意仓库权限。
- RepositoryMount 仍属于 `(Workspace Repository, Device)`，但绝对路径只能由 Device owner/daemon 设置；Workspace admin 只看到“已就绪/未就绪”。
- 创建或迁移 Agent 时必须同时验证 active grant、Runtime/model 能力和对应 RepositoryMount。
- revoke grant 后：停止新入队、取消 queued Run、best-effort cancel running Run、将相关 Agent 标记 `blocked_device_access`；不会删除 Agent、mount 记录或历史 Run。恢复 grant 后由显式确认解除 blocked。

## 7. Agent 可见性与授权

### 7.1 visibility

| visibility | 默认 discover/run | 管理员能力 | 适用场景 |
|---|---|---|---|
| workspace | 所有 active member | admin/owner 可 edit/manage/audit | 团队公共开发、Review Agent |
| private | 创建者 | admin/owner 只看安全 metadata，可 manage/audit；无默认 run/edit | 个人实验、私有 prompt |
| restricted | ACL 指定 principal | admin/owner 可 manage/audit；无默认 run/edit | 指定成员或 Automation 专用 Agent |

`private` 不是对 Workspace owner 的密码学保密：owner 可以通过显式、带审计的 ACL 变更取得权限，但不能无痕读取或运行。Agent environment 的旧值在任何权限下都不回传，始终 write-only。

### 7.2 独立权限

- `discover`：能在列表/选择器看到名称和安全摘要。
- `run`：能创建直接 Run 或作为 Automation/child dispatch 的目标。
- `edit`：能修改 instruction、model、skills、repository 与非敏感配置；secret 仍不可读取。
- `manage`：能改 visibility/ACL、Device binding、archive/block；不自动包含 run/edit。
- `audit`：能看 Run 和授权事件，但不暴露 secret。

ACL 是加法授权；禁用 Membership/ServicePrincipal 后即使 ACL 行仍在也不生效。所有 direct Automation 和 coordination child dispatch 在创建与 dispatch 时检查 `run`。

### 7.3 Agent 与 Device 不互相泄漏

- 看见 Agent 不等于看见它所在 Device 的本地路径、Skill 来源或其他 Agent。
- 看见 Device 不等于看见所有绑定在该 Device 上的 Agent；只能看到当前 Workspace 且通过 Agent visibility 的资源。
- 同一 Account 在两个 Workspace 创建的 Agent 仍是两个资源，不提供跨 Workspace 全局 Agent 列表。

## 8. Automation 与 Run 审计身份

每个 Automation 创建时自动创建一个一对一 ServicePrincipal；Automation archive 时 principal disabled。Automation 目标 Agent 必须向该 principal 授予 `discover + run`，否则保存/启用时 fail loudly。

Run 增加不可变调用者字段：

- `principal_type`: account/service/system/external
- `principal_id`
- `membership_id`：Account 发起时保存，其他类型为空
- `initiator_snapshot`：有界 JSON，仅保存显示名/provider 等非敏感审计信息

child Run 继承 root Run 的 principal，另外保留 `parent_run_id` 和实际 dispatching Agent；Agent 不是新的授权主体，不能通过“由 Agent 发起”提升权限。

外部 Issue/PR/消息保留 External Principal。只有用户显式 link external identity 后，后续事件才映射为 Account；不能按同名或未验证邮箱自动合并。

## 9. 数据模型

下列为目标表及关键字段；实现时沿用 Harbor string ID、SQLite FK 与应用层 fail-closed 风格。

```sql
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  primary_email TEXT, primary_email_normalized TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active','suspended','deleted')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);

CREATE TABLE auth_identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT, verified_at INTEGER, created_at INTEGER NOT NULL,
  UNIQUE(provider, subject)
);

CREATE TABLE passkey_credentials (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]', label TEXT,
  created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
);

CREATE TABLE account_recovery_codes (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  code_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, used_at INTEGER,
  PRIMARY KEY(account_id, code_hash)
);

CREATE TABLE account_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL, last_used_at INTEGER,
  created_at INTEGER NOT NULL, revoked_at INTEGER
);

CREATE TABLE personal_access_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  workspace_id TEXT REFERENCES workspaces(id),
  label TEXT NOT NULL, prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER,
  last_used_at INTEGER, revoked_at INTEGER
);

CREATE TABLE workspace_memberships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  status TEXT NOT NULL CHECK (status IN ('active','disabled')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(workspace_id, account_id)
);

CREATE TABLE workspace_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT, role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','revoked','expired')),
  invited_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, accepted_at INTEGER
);

CREATE TABLE device_enrollments (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, consumed_at INTEGER
);

CREATE TABLE device_credentials (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
);

CREATE TABLE workspace_device_grants (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  granted_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_at INTEGER NOT NULL, revoked_at INTEGER,
  PRIMARY KEY(workspace_id, device_id)
);

CREATE TABLE service_principals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('automation','integration')),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','disabled')),
  created_at INTEGER NOT NULL
);

CREATE TABLE agent_access_grants (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  principal_type TEXT NOT NULL CHECK (principal_type IN ('account','service')),
  principal_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('discover','run','edit','manage','audit')),
  granted_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(agent_id, principal_type, principal_id, permission)
);

CREATE TABLE security_audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id),
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT, resource_id TEXT,
  result TEXT NOT NULL CHECK (result IN ('allowed','denied','failed')),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
```

`agent_access_grants.principal_id` 是 Account/ServicePrincipal 多态引用，SQLite 无法同时声明两个 FK；Store 必须在同一事务内校验 principal 类型、存在性和 Workspace 一致性，并用 migration/test 保证孤儿行为 fail-closed。

现有表调整：

- `workspaces` 增加 `kind`、`created_by_account_id`。
- `devices` 增加 `owner_account_id`、`status`；不再依赖 `name UNIQUE` 识别机器。
- `agents.visibility` 增加 `restricted`，`created_by_member_id` 迁为稳定的 `created_by_account_id`。
- `automations` 增加 `service_principal_id`。
- `runs` 增加 principal snapshot 字段。
- `workspace_api_tokens` 迁为 Account 自助创建的 `personal_access_tokens`，保存 scopes 与可选 workspace binding。
- 新增统一 `security_audit_events`，覆盖登录、token、成员、Device、grant、Agent ACL、break-glass 和 Automation dispatch。

## 10. API 与 Web 交互面

### 10.1 API 分组

- `/api/auth/*`：bootstrap、Passkey register/login、Session logout、recovery。
- `/api/accounts/me/*`：profile、linked identities、PAT、My Devices。
- `/api/workspaces/:workspaceId/memberships|invitations`：成员关系与邀请。
- `/api/device-enrollments`：创建单次 token；daemon 使用独立 enrollment endpoint 消费。
- `/api/devices/:deviceId/grants`：Device owner 管理 Workspace grant。
- `/api/workspaces/:workspaceId/devices`：只返回安全 projection。
- `/api/agents/:agentId/access`：visibility 与 ACL。
- `/api/security-audit`：owner/admin 的安全审计投影。

Workspace 资源路由逐步改为显式 `/api/workspaces/:workspaceId/...`；兼容期仍可接受 header/query workspace，但服务端必须从 Membership 验证，不能只信客户端选择。

### 10.2 Web 信息架构

- 未登录：First owner bootstrap / Login。
- 顶栏：Account menu + Workspace switcher，替代手工 token 连接状态。
- Account settings：Passkeys、Recovery、PAT、My Devices。
- Workspace settings：General、Members、Devices、Prompts、Integrations、Audit。
- Agent detail：Visibility、Access、Execution Device、Repository、Skills；Device picker 只展示 active grant。
- Device detail：连接状态、credential rotation、Workspace grants、各 Workspace 的安全 mount readiness。

## 11. 迁移与发布计划

兼容层只服务 live migration，每一阶段都写明删除点，不长期保留双模型。

### P6.1 Identity normalization（schema v23）

- 新增 Account/AuthIdentity/Session/Invitation/PAT。
- 把现有 `workspace_members` 身份字段归一化：synthetic `member_system_*` 统一映射到 bootstrap Account；有可信 `(provider, external_id)` 的成员按该键映射；仅同邮箱不自动合并。
- Membership 复用原 member ID，避免 Agent/Conversation/Message 历史引用漂移。
- invited row 迁为 Invitation；异常引用先在 dry-run report 中 fail migration。
- Web 增加 bootstrap、Passkey、Workspace switcher；系统 token 暂时仍可访问数据面。

验收：现有生产数据计数/引用不变；两个测试 Account 的 Workspace 隔离、Session revoke、最后 owner 保护全部通过。

实施状态（2026-07-19）：代码、fixtures、dry-run report、全量回归与生产 v22→v23 exact-revision 部署已完成。生产为 Account=1 / Membership=1，legacy Membership ID 保持不变；first-owner Passkey=1、unused recovery codes=10、active Session=1，bootstrap 不再 waiting。两台 legacy-token Device 仍在线且 daemon credential 未改。server 只保存 recovery-code hash，因此明文是否已由用户离线保存只能由用户本人确认。

### P6.2 Device ownership and enrollment（schema v29）

- 现有 Device owner 回填为 bootstrap Account。
- 根据现有 Agent、RepositoryMount 和 runtime Skill 关系，为相关 Workspace backfill active grant。
- 新增 enrollment/credential、daemon enroll/rotate/revoke；server 临时同时接受 legacy device token 与新 credential。
- 两台生产 Device 人工换证成功后，将 `allow_legacy_device_token=false`；兼容代码在 P6.5 删除。

验收：不同 Account 同名 Device 不冲突；未 grant 的 Workspace 无法创建/迁移 Agent；credential revoke 后 WS 重连失败。

### P6.3 Agent ACL and Automation principal（schema v30）

- 增加 restricted visibility、AgentAccessGrant、ServicePrincipal 和 Run principal snapshot。
- 现有 workspace Agent 保持 workspace；private Agent 给创建 Account 回填 discover/run/edit。
- 每个现有 Automation 自动创建 ServicePrincipal，并按当前 target 回填最小 discover/run grant。
- 所有 direct/child Run 在 enqueue + dispatch 双重授权。

验收：private/restricted 负向矩阵、Automation 越权、权限排队期间撤销、child Run 不提权全部通过。

### P6.4 UI, external identity and audit（schema v31）

- 完成 Members/Devices/Agent Access/Audit UI，移除浏览器 localStorage token。
- Feishu/SCM external identity 支持显式 link；未 link 的继续以 External Principal 留痕。
- 安全审计、过期 Session/PAT/enrollment 清理任务上线。

### P6.5 Contract and production acceptance

- 删除普通数据面和 daemon 对 legacy owner token 的兼容，只保留 `/api/system/*` break-glass。
- 删除旧 WorkspaceMember identity 字段、旧 token UI 和兼容路由。
- 完成双 Account、双 Workspace、双 Device、Automation、Review/merge/deploy 的生产级 dogfood。

## 12. 回滚、观测与安全

### 12.1 发布/回滚

- 每次 schema migration 继续复用现有 deployment maintenance gate、SQLite backup、exact revision health 和 fail-closed rollback。
- P6.1–P6.4 采用 expand → backfill → switch-read → contract；只有 live migration 窗口保留旧读路径。
- migration dry-run 先输出 Account dedupe、invited reference、Device grant backfill 和 orphan principal 报告；任何数量对不上即终止。
- 新版本尚未产生身份写入时可直接 restore backup + rollback release；产生新 Account/credential 后禁止旧 binary 直接打开新库，进入 maintenance 后 forward-fix 或显式 restore 并接受新写入丢失。

### 12.2 必要观测

- 登录成功/失败、Session/PAT/Device credential 创建与撤销。
- Membership/role/invitation、Device ownership/grant、Agent visibility/ACL 变化。
- 每个 Run 的 principal、Workspace、Agent、Device 与授权决策结果。
- legacy token 命中计数；只有归零后才允许 P6.5 contract。
- 401/403、cross-workspace lookup、blocked_device_access、credential replay 指标。

### 12.3 威胁与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Device credential 泄漏后被当普通 API token | 接管 Workspace | 独立前缀与解析器，只允许 daemon endpoint；hash 存储、rotate/revoke |
| Workspace admin 征用成员 Device | 执行未授权代码 | 只有 Device owner 可 grant；admin 只能看到 readiness |
| private Agent 被管理员无痕读取/运行 | 隐私边界虚假 | admin 默认只有 metadata/manage/audit；提权必须显式 ACL 并写审计 |
| Account 跨 Workspace IDOR | 数据泄漏 | 所有资源查询同时校验 workspace_id + active Membership；不存在返回 404 |
| Membership 撤销但 queued Run 继续 | 权限撤销不生效 | enqueue 与 dispatch 双检；撤销时取消 queued、best-effort cancel running |
| 仅凭邮箱自动合并 Account | 身份接管 | 只按验证过的 provider subject 合并；邮箱需显式 link 验证 |
| Automation 借创建者权限长期运行 | 离职后幽灵权限 | 每个 Automation 独立 ServicePrincipal + 最小 Agent ACL |
| system token 继续成为日常万能钥匙 | 单点高危 | 不进浏览器/daemon；break-glass 专用、使用即审计、可配置关闭 |

## 13. 方案对比

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| Account 直接拥有 Device/Agent/Workspace | 表少、直觉简单 | Agent 协作、成员离开、跨 Workspace 和 Automation 身份全部混乱 | 拒绝 |
| Device 直接属于单个 Workspace | 授权简单 | 同一台个人机器无法安全参与多个 Workspace，需要复制 Device | 拒绝 |
| 所有资源归 Workspace，Device 也归 Workspace | 类企业 runner | 不符合用户自带机器，Workspace admin 可征用个人设备 | 首期拒绝，未来可单独增加 Workspace-owned runner |
| Account owns Device + Workspace owns Agent + 显式 grant | 所有权和使用权分离，支持多账户/多 Workspace/多机 | 多一个 grant 与 ACL 层 | 采用 |

## 14. 验证矩阵

### 14.1 自动化测试

- migration fixture：v22 单 owner、多 Workspace、重复邮箱、external identity、invited row、orphan 负例。
- Auth：Passkey/recovery/Session/PAT 生命周期、CSRF、scope、suspend。
- RBAC：三角色 × Workspace resource action。
- Device：enroll 单次消费/过期/replay、rotate、revoke、同名多 owner、grant 多 Workspace。
- Agent：三 visibility × 五 permission × account/service/system principal。
- TOCTOU：enqueue 后 revoke Membership/grant/ACL，再 dispatch 必须失败。
- Automation：ServicePrincipal 最小权限、child Run 继承 principal、跨 Workspace dispatch 拒绝。
- Projection：Workspace Device API 不含 path、secret、其他 Workspace 和 credential 字段。
- 现有 Delivery/Review/Deployment 回归测试全部继续通过。

### 14.2 生产验收场景

1. Account A 登录，拥有 Mac mini 与 MacBook；创建个人和团队 Workspace。
2. 邀请 Account B 加入团队 Workspace，但 B 看不到 A 的个人 Workspace。
3. A 只把 Mac mini grant 给团队；B 能选择团队 Agent，但看不到 MacBook 和任何绝对路径。
4. B 运行 workspace Agent；A 的 private Agent 不出现在选择器。
5. Automation ServicePrincipal 运行 restricted Reviewer Agent；未授权的 Developer Agent 调用失败。
6. A revoke Mac mini grant；新 Run 立即失败，旧历史保持可审计。
7. 重新 grant 并解除 Agent block，完成 Issue → PR → Review → merge → exact revision deploy。
8. revoke B Membership；B Session/PAT 和 ACL 立即失效，既有 Issue/Run author snapshot 不变。

## 15. 实施状态与下一轮起点

P6.1 已按既定顺序落地：

1. [x] 独立 worktree 与 feature branch。
2. [x] v22 migration fixtures 和 identity normalization dry-run report。
3. [x] Account/AuthIdentity/Session/Membership/Invitation/PAT store 与 protocol。
4. [x] REST `PrincipalContext` 与 system token compatibility gate。
5. [x] bootstrap/login/Workspace switcher、全量回归与生产 v23 部署。
6. [ ] 生产 HTTPS origin 已完成 first-owner Passkey，server 已持久化 10 个 recovery-code hash；仅剩用户确认明文 recovery codes 已离线保管。

P6.1 server-side 验收已完成，用户确认 recovery-code custody 后完成运营交接。独立 Device list 性能修复占用 schema v24，Mew Automation normalization 占用 schema v25，Agent-driven self-deploy 占用 v26/v27，Codex sandbox network capability 占用 v28，因此 P6.2 Device ownership/enrollment 从 v29 开始；届时才迁移 daemon credential，继续避免把 Web 身份迁移和双机换证耦合在同一回滚面。

## 16. 读者自检问题

- 同一个人加入两个 Workspace 时，哪个 ID 稳定？——Account ID；Membership 分别授权。
- Device 为什么不属于 Workspace？——它是用户资产，可显式 grant 给多个 Workspace。
- Workspace admin 能否直接使用成员机器？——不能，只有 Device owner 能建立 grant。
- 看见 Agent 是否等于看见 Device？——不等于，两者使用独立 projection 和 policy。
- private Agent 对 owner 是否绝对保密？——不是；owner 可显式提权，但必须留审计，默认不能 run/edit。
- Automation 在创建者离开后用谁的权限？——自己的 ServicePrincipal。
- 外部 Feishu 用户是否自动成为 Account？——不会，除非显式验证并 link identity。
- 成员离开会不会删掉他创建的 Issue/Agent？——不会，资源属于 Workspace。
- 为什么不一次完成 v23–v31？——身份、Device 换证、Agent ACL 各自有独立回滚面，分期能保持生产可用和可证伪；v24–v28 已被独立且已上线的 projection、Automation、self-deploy 与 network capability migration 占用。
- 下一轮第一步是什么？——从 schema v29 的 P6.2 Device ownership/enrollment 开始；该阶段才迁移 daemon credential。

## 17. 参考锚点

- `progress/harbor.md`：现有 Harbor 总体架构与阶段记录。
- `progress/glossary.md`：领域术语单一真相源。
- `apps/harbor/src/protocol.ts`：当前 Account、Membership、Device、Workspace 与 Agent 类型。
- `apps/harbor/src/server/db.ts`：当前 v28 schema、identity normalization、Device summary、Mew Automation、self-deploy 与 Agent network capability migrations。
- `apps/harbor/src/server/rest.ts`：当前 system/Account principal、Workspace role 和 auth ceremony 实现。
- `apps/harbor/src/server/ws.ts`：当前 daemon shared-token hello。
- `progress/decisions/2026-07-19-harbor-open-agent-orchestration.md`：Harbor 不内置 Agent 组织结构的既有边界。
