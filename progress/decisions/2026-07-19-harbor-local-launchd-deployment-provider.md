# Harbor Local launchd Deployment Provider

## 结论

Harbor 把代码合并与部署拆成两条正交轴：现有 `manual | github` 只表示 SCM Provider；Delivery 另存一个可空的管理员配置 `deploymentTargetId`。没有 target 时沿用既有 manual deployment；选择 `local-launchd` target 后，Harbor 只在人工验收、checks 和 merge 三个 gate 同时成立且拿到 exact committed revision 时，向 SQLite durable queue 幂等入队。独立 `harbor-deploy-worker` host service 领取 job，完成 release checkout、build/test、SQLite 一致性备份、launchd definition 原子切换、重启和 health check；失败时恢复旧 definition/release/DB。

任何缺证据、陈旧 generation、lease 丢失、health 失败或 rollback 不完整都只能得到 `Deployment failed`，Issue 保持 Review。Agent prompt、Issue 文本和 Web 请求都不能提供命令、路径、凭证或 launchd 参数。

## 背景与现状审计

- `DeliveryService` 已确定性校验 human review、checks 和 merge，并用 `revision` CAS 隔离慢 GitHub 响应。
- `manual | github` 当前既被称为 Delivery Provider，又承担 deployment；GitHub 明确拒绝 `deploymentRequired=true`，说明 SCM/CD 尚未真正正交。
- v13 `deliveries` 只有 `pending/running/succeeded/failed` 事实；`/deploy` 与 `/deployment-result` 都依赖人工确认，没有 durable job 或 host executor。
- `harbor-server`、`harbord` 都是业务生命周期进程。把部署放进任一进程会在其自身被重启时丢失执行上下文，也无法安全部署 Harbor 本身。
- daemon service 已有 launchd definition 生成与 PATH 规则，但它管理的是 Agent daemon，不拥有 Delivery policy 或 release rollback。

## 目标与非目标

目标：自动部署已通过 Harbor gates 的 exact merged revision；server/daemon 重启不丢 job/result；失败自动回滚；日志可审计且不泄密；v13 无损升级；manual fallback 保持可用。

非目标：自动创建/推送 GitHub PR、webhook、配置真实 token、实际操作本机 launchd、通用远程 CD、多环境编排或允许用户提交任意 shell。

## 领域模型与状态机

`Deployment target` 是 server/worker 从 env 或 `~/.harbor.yaml` 读取的管理员配置。DB 只保存稳定 `target id`，REST 只返回 `id/name/provider`；repository/release/DB/plist 路径、step argv、环境变量和凭证永不持久化或回显。

`Deployment job` 与 Delivery 是多对一；每次首次 enqueue 或 Retry 创建一个新 generation。Delivery 只认 `activeDeploymentJobId + deploymentGeneration + deploymentRevision` 对应的结果。

| 当前事实 | 触发 | 下一状态 | 持久化/恢复语义 |
|---|---|---|---|
| merged + gates passed + target + exact revision | reconcile | queued | 单事务推进 generation、插 job、写 audit；重复 reconcile 返回现有 job |
| queued / expired running lease | worker claim | running | 新 lease token fencing；server/daemon 不参与执行 |
| running | health passed | succeeded | token、job、generation、revision 全匹配才落 Delivery；重复同 callback 幂等 |
| running | 任一步失败且 rollback 完整 | failed | 截断/脱敏日志进入 job 与 Delivery audit |
| running | rollback/DB restore 不确定 | failed | 明确 `rollbackComplete=false`；禁止 Done，等待人工处理/Retry |
| failed | human Retry | queued(new generation) | 旧 job/result 永远不能更新新 generation |

Worker 崩溃留下的 running job 在 lease 到期后可被重新领取；每次领取换 lease token，旧 worker 的晚结果被 fencing 拒绝。执行使用 attempt 独立 release 路径，重复 checkout/build 不覆盖旧 release。

## 信任边界

1. SCM Provider 只提供 PR/check/merge 事实和 exact merged revision；Deployment Provider 不调用 SCM，也不信 Agent 自报。
2. Harbor control plane 决定是否 enqueue；worker 只能领取已持久化且 gate snapshot 完整的 job，不能改变 review/check/merge。
3. Web/REST 只可选择 server 公布的 target id 和发起 Retry。命令、路径、health URL、launchd label/domain、plist template、SQLite 路径和 secret env 全来自管理员配置。
4. Worker 以 argv + `shell=false` 执行配置步骤；revision 必须是完整十六进制 commit id，并在 configured repository 中解析为同一 commit。
5. Job 日志先替换 secrets/敏感路径，再按固定上限截断；DB/audit 只接收处理后的文本。

## Local launchd 执行与回滚

执行顺序：

1. 在 attempt 专属 release 目录 checkout exact revision；执行管理员配置的 install/build/test argv。
2. 读取旧 plist 和 current release 指针；bootout 旧 service。
3. 在 service 停止后创建 SQLite 一致性 backup。
4. 原子写入指向新 release 的 plist，并原子切换 current symlink；bootstrap 新 service。
5. 在 deadline 内轮询 health URL；成功才提交 job success。

失败回滚顺序：bootout 新 service → 原子恢复旧 plist/current symlink → 从一致性 backup 原子恢复 DB（并清理 WAL/SHM）→ bootstrap 旧 service → health 旧 service。任一步失败都聚合进失败原因；尤其 DB restore 失败时不启动可能读取不兼容 DB 的旧程序，并标记 rollback 不完整。

## 崩溃恢复

- Queue、lease、attempt、result 和 audit 都在 Harbor SQLite；server 只负责 enqueue/展示，worker 可在 server/daemon 停止时继续。
- worker 在每个外部步骤前后续租。进程消失后，lease 过期才允许下一 attempt 领取。
- cutover 的旧 plist、旧 symlink 和 SQLite backup 放在 worker 私有 job/attempt rollback 目录，不写 Delivery event。
- 若 worker 在 cutover 中间崩溃，下一 attempt 先按持久化 checkpoint 恢复旧 service，再从头部署；无法证明恢复完成则 job failed，不继续切换。

## 迁移与兼容

v14 重建 `deliveries` 的 deployment CHECK 以加入 `queued`，并新增 target/generation/revision/active job/error 字段及 `deployment_jobs`。从 v13 逐列复制所有既有事实：`not_required/pending/running/succeeded/failed`、SHA、revision、时间戳和 events 均保持。旧 `running` 的 target id 为空，因此继续属于既有 manual fallback，不会被自动 worker 领取或伪装成 durable job。

未配置 target 时：创建 Delivery、manual merge、manual deploy start/result 与 Issue 完成语义不变。配置 target 也不改变 manual fallback；用户可以选择不绑定 target。

## 主要替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| Agent prompt 执行部署 | 实现快 | 可自报成功、无幂等/审计/恢复，权限边界错误 | 拒绝 |
| server/harbord 内执行 | 少一个进程 | 部署自身会重启执行者，崩溃恢复困难 | 拒绝 |
| 独立 worker + SQLite queue | 生命周期独立、事务/CAS 可证、适合单机 Harbor | 仅适合同 host SQLite | 采用 |
| 通用 shell pipeline | 灵活 | UI/Issue 注入面过大，日志难脱敏 | 拒绝；只允许管理员配置 argv |

## 验证计划

- Store/service：server restart、重复 enqueue、lease reclaim、duplicate callback、stale generation/revision、Retry。
- Executor 全 fake：exact checkout、health success、health failure rollback、backup restore failure、日志截断/脱敏；不调用真实 FS/process/launchd/HTTP/clock。
- REST/UI：target descriptor、自动进度、失败原因、Retry、未配置 manual fallback、拒绝未知 target/任意命令字段。
- Migration：构造真实 v13 fixture，升级 v14 后逐字段/事件/foreign key 对比。
- 最终：Harbor 定向测试、全量 test、root/Web typecheck、Web production build、`git diff --check`。
