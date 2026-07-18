# Harbor Local launchd Deployment Provider

## 决策

Harbor 继续把 SCM 与 Deployment 建成正交轴：`manual | github` 只提供 PR/check/merge 外部事实；Delivery 另选管理员配置的 `local-launchd` target。自动部署只消费 human review、Harbor checks、merge 与 exact committed revision，不接受 Agent、Issue、UI 或任意 shell 输入自报成功。

第二轮 Review 后采用 v17 应用 schema 与 v3 host-fence 协议：一个 target 是显式的多 service manifest，至少包含一个 `server` 与一个 `daemon`；整台 Harbor host 只有一个 deployment maintenance lock。worker 可并行 build 多个 job，但 claim、recovery、cutover 与 SQLite restore 都经过同一个跨进程 host-fence 临界区。每次 claim/recovery 分配单调 fencing epoch 与随机 nonce；所有 checkpoint 和不可逆 host 边界都必须 CAS 当前 job/generation/revision/epoch/nonce。SQLite restore 只能在该临界区内同时证明 immutable active fence 与当前 DB high-water 精确一致后执行；较新 claim 已推进 high-water 时旧 restore 必须被阻断，绝不能恢复旧 lease或覆盖新 fence。

新 release health 阶段只启动 server。server 在双 gate 存在期间只允许 exact revision-aware health，REST/WS/automation 全部拒绝；daemon 入口先读取稳定 sentinel，存在或不可判定时不连接、不接 Run。server health 与 terminal result 成立后，worker 先 CAS 保留 DB gate、清除并确认 host sentinel，再启动 daemon；最后 CAS 删除 DB gate。任一崩溃窗口至少保留一闸。

## 现状与 Review 证据

- v15 target 只有一个 launchd label，无法证明 server 与 daemon 同时停止，也会在 health 前错误启动 daemon。
- v15 sentinel 位于 `target.statePath`；删除 target 或修改 state path 会让 server/daemon看不到仍在生效的 host gate。
- v15 lease token 只保护 store callback；host mutation 前没有 generation/revision/epoch CAS，SQLite restore 还会把 fence 回退。
- v15 `finishDeploymentJob` 先删 DB gate、worker 再清 sentinel；CLI 只报告“执行过”，不能证明最终 DB/file 真相。
- v15 fingerprint 不含 env values、health contract、timeouts、template content、remote 与多 service manifest；配置漂移的 queued job会永久无人 claim。
- deploy worker 通过 `openDb()` 自动运行应用迁移；旧 server/daemon 尚未安全停机时可能迁移活跃 DB。
- v15 把 v13/v14 所有 `running` 一律迁成 needs recovery，误伤没有 automatic target/job/anchor 的合法 manual deployment。
- 当前 `HostProcess` 只 kill direct child；grandchild 持有 pipe 时 stdout/stderr drain 可以永久不结束。
- v16 host sentinel 是一个可覆盖文件，read→rename/unlink 有 TOCTOU；旧 A 可在 B reclaim 后覆盖或删除 B。
- worker 把应用 `user_version` 当自身协议版本；新 server 迁移业务 schema 后，旧 worker 会失去 health finalize/rollback 能力。
- REST middleware只在请求入口看gate；gate在检查后激活时，handler仍可在真正DB写边界提交。

Repository mount 是 Agent/Run 的仓库身份锚点，execution root 是一次 coding Run 的 cwd；Deployment target repository 是管理员 host capability。三者保持独立，任何 Delivery/Issue 请求都不能改写物理路径、remote、service 或命令。

## 目标与非目标

目标：部署 gate 已通过的 exact merged commit；server/daemon/worker 重启不丢 job/result；全部 Harbor service 停净后才改 DB/plist/symlink；health 前零业务写入；失败使用冻结 baseline manifest 回滚；日志/展示无 secret；v13 manual 事实无损；旧 v14 有明确人工处置。

非目标：自动 push/创建 GitHub PR、webhook、配置真实 token、执行真实 bootstrap/launchd/用户 DB/YAML、远程 CD、多环境编排或通用 UI shell。

## 领域模型

### Deployment service manifest

每个 target 必须有且只有一个 `role=server`，并至少一个 `role=daemon`。每项冻结 `role + exact label + gui/<uid> domain + plist path + template path + template SHA-256`。worker用严格 plist/XML 语义解析器验证模板、rendered plist与baseline plist：document root必须是唯一 plist dict，root `Label` key恰好一个、value类型为string且与配置exact相同；注释、字符实体、nested key或regex命中都不构成证明。baseline/new manifest 之外的 configured service不得保持loaded。

### Target identity

`targetFingerprint` 是非敏感 topology 的 SHA-256，覆盖 repository/current/releases/SQLite/state、fixed remote/allowed refs、完整 steps、非敏感 env key+value、health URL/timeout/interval/header names+secret refs、command timeout、全部 service manifest 与 template content hashes。header secret value不进入 fingerprint/DB/UI/log。

每个 queued job冻结 target fingerprint 与安全 target manifest hash。worker发现 target missing/drift 时，显式把 active queued job落为 `failed/config_drift`；用户修正配置后 Retry 创建新 generation，不能永久挂起。

### Release/baseline manifest

每个可信 current release 必须有私有 `deployment-manifest.json`，包含 exact revision、target fingerprint、health contract fingerprint、fixed remote identity、完整 server/daemon service manifest及无 secret 的 health header refs。首次自动部署没有 manifest时以 `failed/bootstrap_required` 拒绝 cutover。

worker 进入 maintenance 前把 current manifest、旧 plists、current link 和 manifest hash复制到 attempt anchor。DB job只持久化 baseline revision/fingerprint/manifest hash/health fingerprint等非敏感 identity；rollback读取原 attempt 的 host anchor，绝不能用新 target fingerprint验证旧 release。

### Host-global maintenance fence

SQLite `deployment_maintenance` 是 singleton mirror row；稳定发现根位于全局管理员路径（默认 `~/.harbor/deployment/maintenance.json`，实际 v3 journal为相邻私有目录），不依赖任何 target。v3不再覆盖单文件，而是在0700 journal中以`O_EXCL`写入0600 immutable per-fence records与单调release markers；跨进程操作用同目录原子lock串行化。server/daemon扫描完整journal，任一未retire的合法record或读取不确定都fail-closed。旧v1/v2单文件只读兼容并在受锁release时退休，绝不由旧worker覆盖新record。

claim/recovery在同一host lock内先推进SQLite high-water、分配epoch+nonce，再CAS job；进入cutover后把同一identity写成immutable active fence。worker heartbeat、checkpoint、result与terminal release也使用该lock，restore期间不会有另一个worker连接旧DB/WAL。restore从“journal active fence exact匹配 + 当前DB high-water必须等于该epoch”的最后检查、DB file replace到gate重建全程持锁。若较新并行build claim先取得锁并推进DB high-water，旧restore在替换文件前失败；若restore先取得锁，它会从immutable active fence重建DB gate/high-water，较新claim只能在重建完成后推进。release在锁内先写immutable release marker，再清理当前owner record，最后确认journal无active fence；等待中的旧A写/清在取得锁后会因release high-water或更高epoch失败。这样journal提供不可回退的active/release真相，DB high-water提供尚未cutover的claim真相，二者受同一个host lock线性化，备份不能回退任一已取得所有权的fence。

`same anchor` 比较 job/delivery/generation/revision/target/baseline identities；`same fence` 还必须比较 epoch/nonce。旧 A 被 B reclaim 后，A 无法 checkpoint/result/release DB gate，也不能创建、覆盖或删除 B 的host record。

## 状态机

| 当前事实 | 触发/证明 | 下一状态 | 持久化语义 |
|---|---|---|---|
| merged + approved + checks passed + target | enqueue exact revision/fingerprint/manifest hash | `queued` | generation、job、audit 同事务 |
| queued / lease expired running | host lock内reserve+worker claim | `running` | DB epoch high-water+1、随机nonce、attempt+1；进入cutover才发布immutable active record |
| queued target missing/drift | worker reconciliation | `failed/config_drift` | 不进入 maintenance，可 Retry 新 generation |
| no trusted current manifest | prepare | `failed/bootstrap_required` | 无 host mutation，提示管理员 bootstrap |
| prepared + active generation | global gate CAS | `running/maintenance` | singleton DB gate，再写 immutable fence record |
| 全部 old/new manifest services 停净 | per-service label/PID/unloaded proof | `old_stopped` | 每个 bootout 前后 fence CAS；任一 ambiguity → needs recovery |
| server bootstrap + exact health | label/PID + job/revision/baseline-aware fingerprint | `healthy` | DB phase/checkpoint先写，sentinel同 fence补写 |
| healthy terminal commit | active identity + current fence | `succeeded/releasing` | DB gate仍保留 |
| rollback exact baseline health | old server exact identity | `failed/releasing` | DB gate仍保留 |
| releasing | 写release marker并确认host journal无active fence → 启动daemon → CAS delete DB gate | terminal/unlocked | 先释放host gate、最后删DB gate；任一窗口至少一闸 |
| stop/restore/fence/daemon 任一不确定 | `rollbackComplete=false` | `needs_recovery` | 双 gate尽力保留，普通 Retry/Done禁止 |
| needs recovery | 管理员 recovery + exact baseline + final gate audit | `failed` | CLI只有重读 job failed、rollbackComplete=true、DB/file gate均无时才 exit 0 |

旧 v14 空 fingerprint/无 anchor job使用 `legacy_ack_required`，不显示永远不可能执行的自动 rollback。管理员确认 host 已人工恢复后用独立 acknowledge 命令把它转为 failed/retryable；此例外有明确 audit，不能标 succeeded。

## Multi-service cutover

1. 受控 fetch 固定 remote：先校验 `git remote get-url` 与配置一致，再把管理员允许的remote `refs/heads/*`用显式refspec fetch到每attempt唯一的临时namespace。解析exact SHA为commit，并只以本次fetch得到的临时refs做ancestor证明；本地branch、旧remote-tracking ref或本地已有object都不能提供可达性。凭证只走host git credential mechanism，不进argv/env/audit；验证后worktree add exact SHA并删除临时refs。
2. build/install/test 全部完成后读取可信 current manifest，验证 revision、baseline fingerprint、health contract与旧 service集合；冻结 host anchor。
3. 激活host-global DB gate与immutable host fence。对baseline/new manifest service并集逐项执行bootout-adjacent inspect；initial PID、bootout前current PID及随后每次observed PID全部加入proof set，只有exact label unloaded/no PID且每个PID已死亡才继续。任一PID transition或inspect/bootout歧义都进入needs recovery且不触碰DB/plist/symlink。
4. 在fence CAS下创建0600 SQLite backup，严格语义验证template、rendered与baseline plist；再原子替换new manifest需要的plists、移除old-only plist、切换current symlink。
5. 只 bootstrap new server，证明 exact label/PID，执行 revision-aware health。daemon保持 unloaded。
6. terminal result仍保留 DB gate；清/确认 sentinel后 bootstrap manifest内全部 daemon，证明 exact label/PID running；最后 CAS删除 singleton DB gate。daemon即使提前运行，也因 DB gate仍在而不能完成 server hello/接 Run。

## Rollback

rollback 首先把 expected identity改为冻结 baseline，再对 baseline/new service并集逐项可靠停机。任一 bootout/inspect/PID不确定时绝不恢复 DB/plist/symlink。

停净后恢复旧 plists、移除 new-only plist、切回 old current；若已创建一致性 backup，再恢复 DB并清 WAL/SHM。SQLite restore从最终fence验证到file replace与gate重建全程持有host lock；验证同时要求immutable active record与DB high-water均精确等于B的epoch。C若先claim epoch3，B在replace前被阻断；B若先持锁，C只能在B从active record重建DB gate/high-water后claim。因此不存在“B读epoch2→C写epoch3→B仍restore”的窗口，旧DB中的lease/epoch永不复活。

只 bootstrap baseline server，以 baseline manifest的 fingerprint/health contract验证 exact revision + label/PID。验证通过后进入 releasing：清 stable sentinel、启动 baseline daemon、CAS删除 DB gate。任何失败保持 needs recovery。

## Maintenance/daemon 边界

- server 无需target配置即可读取稳定host journal。v17在每个application-table INSERT/UPDATE/DELETE的SQLite线性化点检查singleton gate，故REST/WS/automation/approval/Feishu/daemon即使在入口检查后才遇到gate也无法提交。deployment worker连接只允许改fenced deployment bookkeeping tables；Delivery/event/conversation终态投影在gate解除后由server reconciliation补写。
- Feishu completion、approval card send/update等外部副作用在实际send/update前再次检查maintenance；gate存在或不确定时不发送。
- 唯一例外是唯一 active gate的 exact health query；runtime revision与expected release fingerprint必须同时匹配。
- harbord 在首次 connect、每次 reconnect、hello/outbox flush、收到 run_start前都读取稳定 sentinel；存在或不可判定时关闭/不建 WS，且不启动新 Run。worker也不会在 health阶段bootstrap daemon。
- target删除、state path漂移或server只剩旧配置，都不影响 gate发现。

## Fencing 与不可逆边界

下列动作前后都执行 `job id + active Delivery generation/revision + fence epoch/nonce + lease` CAS/heartbeat：受控 fetch完成、DB gate激活、每个 service bootout、全部 stop proof、DB backup前后、每个 plist replace/remove、symlink replace、server bootstrap、health finalize、每个 rollback restore、terminal result、sentinel clear、daemon bootstrap与DB gate release。

Host mutation在同一个host-lock临界区内执行紧贴的 `assertFence(checkpoint) → mutation → assertFence`；callback/DB方法也要求相同 fence。claim、recovery、heartbeat、checkpoint、result、host-journal write/release与DB restore共享该跨进程lock，消除check→mutation及restore→旧DB连接TOCTOU。reclaim B更新DB high-water；若已进入cutover还会发布immutable active record。旧A下一次边界CAS或journal操作必失败。

## 配置、credential 与审计

- 所有target/多service path必须lexical canonical，逐component lstat验证non-symlink、canonical、owner链与mode；部署私有component拒绝group/world writable，标准root-owned ancestor仅允许不可写或sticky system directory。repository、current/plist parent、template和每次host mutation前的runtime component都复验，防止config parse后component replacement。跨target repository/releases/current/SQLite/state/plist/template、label、health endpoint与remote identity均不得冲突或包含。
- health credentials只允许 `{ env: "VARIABLE" }` secret refs；解析后的 value只在worker内存。env/argv拒绝 Authorization/Bearer/Basic/token/password/secret、URL userinfo及任何configured secret直接出现。
- 子进程只继承 `PATH/TMPDIR/LANG/LC_ALL`与显式非敏感 env；argv audit只记 executable、argc与SHA-256，不回显参数。
- configured path、launchd label、header/ref name/value均按管理员敏感字段处理，不进入DB/UI/audit；target fingerprint只保存hash。统一structured redactor处理configured secrets、URL userinfo、Authorization/Bearer/Basic、token/password/secret模式。stdout/stderr先经过保留tail的连续流redactor（覆盖跨chunk secret）再做byte bound与持久化，store/UI再作defense-in-depth；绝不先截断raw secret。
- HostProcess使用独立session/process group；macOS/Bun不调用`process.kill(-pid)`，而以固定`/bin/kill` executable和严格argv向`-PGID`发送TERM，grace后KILL。无论direct child timeout还是成功退出，都检查并清理残余group；child exit与pipe drain有最终deadline，grandchild持pipe不能永久卡住lease/worker。实现与测试均不拼shell。

## Canonical schema v21、worker compatibility 与 migration/bootstrap

本 Provider 分支原先把三阶段 migration 称为 v14–v16；与 canonical main 的 Mew/GitHub/Agent-team migrations 集成后，对应版本固定为 v17–v19：v17 加 target/durable job，v18 加 recovery anchor，v19 重建 jobs/gate，加入 fence epoch/nonce、failure kind、target manifest hash、baseline fingerprint/manifest/health hash、per-service PID map，并把 maintenance 收敛为 singleton host lock + host epoch high-water row。v20 增加 versioned built-in Skills；v21 增加 application-table maintenance linearization guards 与稳定的 deployment control compatibility contract。

应用 `PRAGMA user_version` 不再等同 worker 协议版本：`openDeploymentDb()` 不创建 DB、不运行 migration，只接受 `user_version >= 19` 并逐项验证 worker 所需 deployment tables/columns。后续 server 只可对这些 control shapes 做向后兼容的 additive 变更；破坏性变更必须先升级 host worker/control protocol。

迁移只把确有 `deployment_target_id + active job` 的 automatic active deployment 转为 needs recovery。canonical v16 的 manual/GitHub no-target `running` 保留人工完成语义；v18 误迁的这类行按 target/job 为空和旧 migration error 精确修复回 running。v17 空 fingerprint/无 anchor 转为 legacy ack required。

因此 compatible worker 在 new server 把 application schema 从 v20 迁到 v21 后仍能 checkpoint、health finalize 与 rollback；恢复 pre-deploy v20 backup 后也能重开 control store 并由 external journal 重建 gate。worker 自身始终不执行应用 migration。管理员首次启用 automatic target 必须按一次性 bootstrap 协议：

1. 停止旧 daemon与server，并证明全部label/PID已退出。
2. 对当前 DB 创建 0600 一致性 backup 并记录恢复位置。
3. 安装一个已支持stable sentinel/revision-aware health但automatic target尚未启用的baseline release。
4. 显式运行server schema migration并完成`foreign_key_check`/版本验证；失败时在服务仍停机下恢复bootstrap backup。
5. 启动baseline server、验证revision-aware health；写入可信current-release manifest，再启动baseline daemon。
6. 只有 manifest、`user_version >= 19` control compatibility、v3 journal/lock 目录权限都通过后才配置/启动 automatic worker。

worker遇到旧schema、无manifest或未完成bootstrap只拒绝，不自行修复。本文提供步骤，本 Run 不执行真实bootstrap。

### 管理员 credential、恢复与 legacy 处置

- YAML中的health header只能写secret reference，例如`Authorization: { env: HARBOR_DEPLOY_HEALTH_AUTH }`，不能写literal。server使用safe projection，不解析secret；worker启动时从自己的host environment解析到内存，拒绝把它写入plist、DB、UI、argv或audit。launchd worker管理员需在独立维护窗口把该环境变量注入worker所属GUI manager，并在启动前用`launchctl getenv <NAME>`确认“存在”即可；Harbor日志不得打印value。
- 普通recovery只允许：`harbor deploy-worker recover <job-id> --target <target-id> --confirm <job-id>`。管理员必须恢复与job冻结fingerprint一致的target配置；命令结束会重新打开compatible control store并重读host journal，双闸未清或job不是`failed + rollbackComplete=true`即非零退出。
- `legacy_ack_required`没有可自动证明的anchor，先保持所有Harbor services停机，按bootstrap backup/manifest步骤人工验证旧baseline exact revision，再执行`harbor deploy-worker acknowledge <job-id> --baseline-revision <exact-sha> --confirm <job-id>`。ack只解锁为failed/bootstrap_required并写audit，绝不标succeeded/Done；stable sentinel存在或不可读时拒绝ack。
- 若bootstrap/migration失败，在旧services仍已停净的前提下恢复0600 bootstrap DB backup及其WAL/SHM一致性状态，重新验证`foreign_key_check`、baseline server exact health与stable sentinel为空；任一步不确定都不要启动daemon或automatic worker。

## Recovery truth 与 UI

`DeploymentWorker.runOnce/recover` 返回最终持久化 job、DB gate与host journal snapshot，不再返回“执行过”。CLI recovery完成后重新打开compatible control store并重读journal；只有 `job.status=failed && rollbackComplete=true && DB gate=null && active host fence=null` 才打印成功/exit 0，否则抛错并保持needs recovery。

Conversation detail增加active deployment job的安全projection：status/checkpoint/attempt/fence epoch/recovery kind/rollbackComplete/error/bounded redacted log/时间戳。UI展示这些字段与config drift/bootstrap/legacy ack动作说明；不返回nonce、lease token、paths、labels、remote、argv、header refs/values或manifest正文。

## 崩溃恢复矩阵

| 窗口 | 恢复规则 |
|---|---|
| claim A 后被 B reclaim | DB high-water与epoch/nonce归B；若已cutover则immutable active record也归B；A所有checkpoint/result/gate/journal操作失败 |
| DB gate后、sentinel前 | DB gate全局停写；B按same anchor重写B fence sentinel |
| 任一service bootout中 | 未全部stop proof不触碰DB/plist/symlink；原anchor recovery |
| DB backup/plist/symlink中 | 每个边界CAS；reclaim只用原attempt manifest/backup |
| healthy DB后、sentinel前 | same anchor + current fence才补写；否则rollback/needs recovery |
| B验证epoch2、C尝试claim epoch3、B restore | 同一host lock强制二者线性排序；C先则B失败，B先则C只能在restore/rebuild后claim |
| SQLite restore后 | immutable external fence重建DB high-water/job/gate；旧DB lease不可用 |
| terminal DB result后、sentinel clear前 | 两闸存在；重验terminal expected runtime后继续release |
| sentinel clear后、daemon bootstrap前/中 | DB gate仍停写；daemon失败则重建sentinel/needs recovery |
| daemon running后、DB gate release前 | daemon连接被server拒绝；current fence CAS后才解全局写闸 |
| target删除/state漂移 | stable sentinel仍可发现；server/daemon fail-closed |

## 被拒绝的替代方案

| 方案 | 拒绝理由 |
|---|---|
| 单label代表Harbor | 不能证明server/daemon同时停止，health期daemon可能写入 |
| target-local sentinel | target删除或path漂移后失去全局发现能力 |
| 可覆盖的单sentinel文件 | read→rename/unlink有TOCTOU，旧worker可覆盖或删除新fence |
| lease token只保护result | host不可逆动作仍可由stale worker执行 |
| DB restore沿用备份lease | fence倒退，旧worker可复活 |
| 2xx/单service health | 不能证明exact release与daemon隔离 |
| worker自动migration或exact app schema | 前者可能迁移活跃DB，后者会在new server升级后失去rollback能力 |
| health literal secret/任意argv | secret进入配置、audit或process list |
| v14无anchor强行recover | 无法证明baseline；应显式legacy人工处置 |

## 验证计划

- Config/FS：多service角色、跨target冲突、完整fingerprint、secret refs/credential argv；注释/entity/duplicate/nested/type错误plist与owned 0777/component replacement反例。
- Store/schema：global lock、parallel build/serial cutover、每边界CAS、config drift、legacy manual/ack；真实临时 SQLite v20-compatible worker → server v21 migration → health/rollback/restore 兼容。
- Executor全fake：initial PID10→adjacent PID20且20存活、daemon health期不启动、evil plist、仅local ref可达、baseline manifest/fingerprint、rollback顺序。
- Crash/recovery：old A pause→B immutable write/release→A恢复的真实FS竞态；epoch2 read→epoch3 claim→epoch2 restore交错；terminal release、target deletion、CLI truth、daemon refusal。
- Process/redaction：fake group TERM/KILL/final drain、跨chunk secret与截断边界；bounded macOS/Bun真实process-group integration验证成功返回和timeout都无descendant。
- Maintenance：middleware check后activate gate再handler write的SQLite竞态；REST/WS/automation/Feishu inbound/approval/daemon callback与Feishu completion/approval outbound均fail-closed。
- REST/UI：active job安全projection/log、nonce/path/secret不回显；manual/GitHub/Device/Repository mount/executionRoot/self-hosting regressions。
- 最终：定向测试、根`bun test`、root/Web typecheck、Harbor build、Web production build与`git diff --check`；不操作真实host资源。
