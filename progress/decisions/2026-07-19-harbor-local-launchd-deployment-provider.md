# Harbor Local launchd Deployment Provider

## 决策

Harbor 把 SCM 与 Deployment 建成两条正交轴：`manual | github` 只提供 PR/check/merge 外部事实；Delivery 另选一个管理员配置的 `local-launchd` target。没有 target 时，既有 manual deployment 完全不变。绑定 target 后，只有 human review、Harbor checks、merge 与 exact committed revision 同时成立，control plane 才向 SQLite durable queue 幂等入队。

部署由独立 `harbor-deploy-worker` host service 执行。worker 不能改变 review/check/merge，Agent prompt、Issue、REST 与 Web 不能提供命令、路径、launchd 参数或 secret。任何 stop、identity、health、rollback 或 crash recovery 证据不完整，都保持 Issue Review 并落 `needs_recovery`；不能靠 Agent 自报或任意新 2xx 标 Done。

## 现状审计

- `DeliveryService` 已用确定性 policy 校验 human review、checks 与 merge，并用 Delivery revision CAS 隔离慢 GitHub 响应。
- v13 `deliveries` 只保存人工 deployment 事实；没有 durable job、host executor、maintenance gate 或 rollback anchor。
- `harbor-server` 与 `harbord` 都是被部署对象的业务生命周期进程；把部署放进任一进程，会在自重启时丢失执行上下文。
- daemon 的 service helper 只管理 Agent daemon，不拥有 Delivery policy、SQLite backup 或 release rollback。
- Repository mount 是 Agent/Run 的仓库身份锚点，execution root 是一次 Run 的 cwd；Deployment target 的管理员 repository path 是独立 host capability。三者不能互相覆盖或由 Issue 输入改写。

## 目标与非目标

目标：部署 gate 已通过的 exact merged revision；server/daemon 重启不丢 job/result；切换前可靠停机；新 revision health 前禁止业务写入；失败恢复原 definition/release/DB；日志有界脱敏；v13 用户无损升级；manual fallback 不回归。

非目标：自动 push/创建 GitHub PR、webhook、配置真实 token、实际操作本机 launchd/用户 DB/`~/.harbor.yaml`、远程 CD、多环境编排或通用 shell endpoint。

## 领域模型

`Deployment target` 来自 server/worker 的 env JSON 或管理员 `~/.harbor.yaml`。DB/REST/Web 只保存或返回 `id/name/provider` 与不可逆的非敏感 topology fingerprint；repository/release/SQLite/state/plist 路径、argv、health URL/header 与 env values 不进入 DB/前端。

`Deployment job` 冻结 `delivery + generation + target id + target fingerprint + exact revision`。首次 enqueue 与每次普通 Retry 都创建新 generation；claim 再加 lease token。结果必须同时匹配 active job、generation、revision、fingerprint 与 lease/rollback identity，旧 implementation、旧 worker callback 和重复 callback 不能覆盖新事实。

`Rollback anchor` 在第一次切换前冻结：原 plist、原 current symlink target、原 release exact revision、rollback attempt，以及停机后创建的 SQLite 一致性 backup。后续 lease reclaim 只能复用该 anchor，禁止重新采样当前 release；否则可能把新 release 错当旧基线。

`Maintenance gate` 有两份持久证据：SQLite `deployment_maintenance` 与 target 私有目录中的 `maintenance.json`。identity 包含 target/job/delivery/generation/revision/fingerprint/rollback attempt/baseline revision；phase 与 expected revision 描述当前应接受的唯一 runtime。任一 gate 存在、读取失败或两份不一致，Harbor 都 fail-closed。

## 状态机

| 当前事实 | 触发/证明 | 下一状态 | 语义 |
|---|---|---|---|
| merged + approved + checks passed + target | reconcile exact revision/fingerprint | `queued` | 单事务推进 generation、插 job、写 audit；重复 reconcile 返回原 job |
| `queued` / lease 过期的 `running` | matching target id+fingerprint claim | `running` | 新 lease fencing；若已有 rollback anchor 则恢复，不创建新 baseline |
| `running` + exact healthy gate | active identity + label/PID + revision-aware health | `succeeded` | DB terminal commit 后才清 host sentinel；Issue 才可由 control plane Done |
| 任一步失败且旧 baseline 已完整恢复 | exact baseline label/PID/health | `failed` | maintenance 清除，允许普通 Retry 创建新 generation |
| stop/restore/identity 任一不确定 | `rollbackComplete=false` | `needs_recovery` | checkpoint=`rollback_incomplete`；maintenance 保留，普通 Retry 禁止 |
| `needs_recovery` | 管理员 CLI claim + 原 anchor rollback + exact baseline verification | `failed` | 只有验证旧 baseline 后才解除 maintenance/恢复 Retry 能力 |

管理员 recovery 是实际恢复动作，不是 blind ack：`harbor deploy-worker recover <job-id> --target <id> --confirm <job-id>`。它复验 target fingerprint、配置/路径、双 gate 与原 anchor，可靠停止目标 label/PID；存在部署前 DB backup 才恢复 DB，不存在表示尚未越过 backup/cutover 边界；最后 bootstrap 并验证 exact baseline revision、label 与 live PID。任何一步失败仍是 `needs_recovery`。

## 停机与主机副作用边界

build/test 完成后，worker 先证明旧 service 为配置的 exact launchd label、`loaded/running` 且 PID 存活，再持久化原 anchor 与双 maintenance gate。此后执行 `bootout`，并持续同时证明：

1. `launchctl print gui/<uid>/<label>` 明确返回 unloaded；普通 print failure 不视为 unloaded。
2. launchctl 不再报告 PID。
3. bootout 前冻结的 PID 已不存在；`EPERM` 视为仍存活。
4. label、PID 不能漂移；loaded-without-PID、unloaded-with-PID、PID change 都是 ambiguous failure。

只要 `bootout` 报错或上述任一证明缺失，worker 绝不 backup/restore/replace DB、plist 或 symlink，直接保留 maintenance 并进入 `needs_recovery`。rollback 同样先可靠停止新/目标 service；未证明停止前禁止恢复旧 DB/plist/symlink。

## 执行、maintenance 与 health

1. 在 attempt release 目录解析并 checkout job 的完整 commit id，验证 repository `rev-parse` 与 job revision 完全相同；按管理员 argv 执行 install/build/test。
2. 冻结原 rollback anchor；先原子写 SQLite gate，再写 0600 host sentinel；可靠停止旧 service。
3. 在目标进程已停止后创建 0600 SQLite backup；从含 `release_path/revision/target_fingerprint` 的管理员 plist template 生成 0600 definition，原子替换 plist/current symlink。
4. bootstrap 后验证 exact label、running state 与 live PID；把新 PID 持久化到 job/gate。
5. 新 server 在 plist 注入 `HARBOR_RELEASE_REVISION` 与 `HARBOR_TARGET_FINGERPRINT`。maintenance 期间所有 REST（包括 read/mutation）、WebSocket、automation、审批后台任务与飞书 mutation 都 503/拒绝；Device daemon 不能完成 `/ws` 连接，已有连接关闭。唯一放行的是带 exact job/revision/fingerprint query 的 `/api/health`。
6. worker 的 health client 同时验证 HTTP 2xx、JSON 中 exact expected revision/job/fingerprint、`maintenance=true`，并在每次 probe 前复验相同 launchd label/PID 仍存活。普通 2xx、旧 revision 或 PID 漂移都失败。
7. health 通过后先把 DB gate/checkpoint 原子改为 `healthy`，再写 host sentinel。worker 重新验证后提交 terminal result，最后 identity-safe 清 sentinel；在此之前业务写入始终关闭。

## 失败回滚

rollback 先把 expected revision 改为冻结 baseline，再可靠停止 target service。只有停机证明完成，才原子恢复旧 plist/current symlink；若已生成部署前 SQLite backup，再恢复 DB 并移除 WAL/SHM。SQLite restore 会回退 lease/checkpoint，因此 worker 只凭冻结 maintenance identity 恢复 gate，不能接受恢复后 DB 中的旧 lease 作为新证据。随后 bootstrap 旧 service，并验证 exact baseline revision、label、live PID 与 revision-aware health。

DB restore 失败时不启动可能读取不兼容 DB 的旧程序；bootout/restore/bootstrap/health 任一失败都保留双 gate，状态为 `needs_recovery`。只有上述完整证据成立，结果才是 rollbackComplete 的 `failed`。

## 崩溃恢复矩阵

| 崩溃窗口 | 重启后的处理 |
|---|---|
| enqueue/claim 前后 | SQLite queue + lease reclaim；旧 lease callback 被拒绝 |
| DB gate 后、sentinel 前 | server 因 DB-only gate fail-closed；worker 用同一 identity 补写 sentinel，再用原 anchor rollback |
| bootout 前/中 | 不越过 DB/plist/symlink mutation boundary；recovery 重新可靠停机并验证原 baseline |
| backup/cutover/health 中 | reclaim 发现冻结 rollback attempt，直接用原 anchor rollback，不创建新 release baseline |
| DB `healthy` 后、sentinel `healthy` 前 | 仅当 identity 完全一致且两者都指向 job revision，补写 sentinel；再验 exact revision + label/PID + health 后 finalize，否则原 anchor rollback |
| rollback 中 DB restore 后、gate restore 前 | host sentinel 保留更晚的 baseline rollback phase；用同一 identity 恢复 DB gate并继续原 rollback |
| terminal DB commit 后、sentinel clear 前 | server 仍因 file-only sentinel 拒绝写；worker复验 terminal expected revision + label/PID + health 后只清 sentinel，不重写 Delivery |
| 任意 identity/phase 无法解释 | `needs_recovery`，不清 gate、不 Retry、不 Done |

## 配置、进程与文件安全

- parser 要求 absolute lexical-canonical paths，所有 target paths 两两不同且互不包含；health 只允许无 URL credential 的 loopback HTTP(S)，launchd domain 必须是 `gui/<uid>`。
- worker 每次进程启动都用 `lstat` 复验 YAML：当前 uid owner、0600、regular file、non-symlink。target 每次 claim/recovery 前再复验 realpath、owner、type、mode、父目录归属、路径互斥与 current symlink target 位于 releases tree。
- state/attempt 目录与 releases 目录为 0700；sentinel、rollback plist/revision/current anchor、生成 plist 与 SQLite backup/restore temp 为 0600。`readLink` 只把 ENOENT 当不存在；EACCES、regular file 和其他错误 fail loudly。
- build/install/test 使用 argv + `shell=false`；子进程只继承 `PATH/TMPDIR/LANG/LC_ALL` allowlist 与显式非敏感 target env。`HARBOR_*`、`GITHUB_*`、credential-like env 被配置 parser 拒绝，health headers 只存在 worker 内存，配置 secret 禁止出现在 argv。
- audit 只记录 executable basename 与 arg count，不记录 argv；stdout/stderr 持续 drain、单命令 capture 有界、总日志 32KB 截断。所有配置 path、env values、health URL/header/Bearer token 在 job error/audit/worker error 前脱敏；进程超时 TERM/KILL，lease heartbeat 在命令期间继续。

## 迁移与兼容

v14 首次引入 durable jobs。v15 重建 Delivery/job CHECK，新增 `needs_recovery/recovering`、target fingerprint、rollback attempt/baseline/new PID 与 `deployment_maintenance`。从 v13 升级逐列保留 review/check/merge/manual deployment facts、SHA、revision、时间戳与 events；无 target 时 manual fallback 不变。

已运行的 v14 queued/running job 没有 fingerprint 或可证明的 rollback anchor，v15 一律 fail-closed 为 `needs_recovery`，不会被新 worker误领。它需要管理员按实际 host 状态处理，不能用新 2xx 冒充成功。

## 被拒绝的替代方案

| 方案 | 拒绝理由 |
|---|---|
| Agent prompt 执行/自报部署 | 无可信 gate、幂等、审计、停机与回滚证明 |
| server/harbord 内执行 | 部署自重启会杀死执行者，生命周期边界错误 |
| 单份 DB maintenance flag | DB restore 会回退 flag；无法覆盖 server DB 未启动/terminal clear crash |
| bootout 返回即视为停止 | launchctl 可失败/状态模糊，旧 PID 可能仍写 DB |
| health 2xx 即成功 | 可能来自旧进程/旧 revision，无法证明 exact release |
| `needs_recovery` 直接 Retry/ack | 会覆盖未恢复 host，可能把新 release 当 baseline |
| 通用 shell/UI commands | 注入面与 secret/日志边界不可控 |

## 验证证据

- Store/Delivery fake SQLite：server restart、lease reclaim、duplicate/stale callback、fingerprint drift、generation/revision fencing、healthy anchor 保留、needs_recovery Retry 阻断与管理员 recovery 后 Retry。
- Executor 全 fake FS/process/launchd/HTTP/clock：bootout failure、unloaded-but-live PID、label/PID 验证、rollback bootout failure、health rollback、DB restore failure、backup 前 recovery、healthy DB/sentinel crash、SQLite restore checkpoint crash、terminal sentinel crash、bounded/redacted log 与 minimal env。
- Server：maintenance 中 REST mutation 不落库、所有 REST 503、exact revision-aware health 唯一放行、automation 拒绝、durable daemon connection gate、DB/file disagreement fail-closed。
- Config/runtime：canonical/disjoint/loopback、owner/type/symlink/mode、strict readLink、secret argv 与 fingerprint drift 反例。
- Migration：真实 v3/v9/v11/v13 fixture 无损升级；active v14 job fail-closed。所有测试只用隔离 DB 与 fake host adapter，不读取/修改真实 launchd、用户 DB 或 YAML。
