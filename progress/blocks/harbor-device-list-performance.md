# Harbor Device List Performance

## Current Focus

v24 持久化 Device list projection 已通过全量验证，待合并并再次部署精确 revision；不改变 daemon hello、完整 capabilities、Skill import 或 credential。

## Log

### 2026-07-19

- 生产实测 `/api/devices` 为 13,550,524 bytes，Mac mini loopback 320–380ms、公网 2.43s；`/api/agents` 仅 8,165 bytes / loopback 3–10ms。
- 三台 Device 的完整 capabilities 含 165 个 runtime Skills、1,553 个 bundle files；浏览器所需 metadata projection 预计约 203KB，可减少约 98.5%。
- `/api/repositories` 为每个 mount 调用 `getDevice()`，仅取 name 却解析整块 capabilities，loopback 固定约 280ms。
- 新增 `DeviceSummary`，`/api/devices` 只返回 Skill metadata 与 `fileCount`；完整 `instruction` / `files` 仍留在 server-side snapshot，Skills import 语义不变。
- Repository view 改为单列查询 Device name，不再 hydrate capabilities。
- 验证通过：projection regression 2/2、相关回归 16/16、workspace typecheck、全量生产 build、全量测试 418 pass / 0 fail / 2150 assertions。
- `main@3ad4d3e1dccfeba6da9900c0b8ae062f84ca5192` 经 Issue `c_33wrbmsp3t` / Delivery `del_ekqo6vprcw` / Retry Job `depjob_3w3vh4n3vh` exact-revision 部署成功；首个 Job stop-proof fail-closed 后通过受支持 recovery 恢复 baseline，再由 Retry 完成上线。
- 首轮生产验收确认 payload 从 13,550,524 bytes 降至 207,353 bytes，且不含 `instruction/files`；但 loopback `/api/devices` 仍需 249–272ms，因为 `listDevices()` 每次仍解析完整 13MB blob，并发 Agent 请求会被同一事件循环阻塞。
- 新增 schema v24 `devices.capabilities_summary`：v23→v24 在 deployment maintenance transaction 内一次性回填；后续 hello 同一 SQL 原子更新完整 snapshot 与 summary。高频列表只读 summary 列，旧 schema worker 保留兼容 fallback。
- v24 验证通过：migration/projection 4/4、identity/deployment/migration lineage 定向回归 44/44、workspace typecheck、production build、全量测试 422 pass / 0 fail / 2168 assertions。

## Decisions

- `DeviceCapabilities` 是 daemon→server 的完整可信快照；新增 `DeviceSummary` 作为 REST/CLI/Web 列表投影，Skill `instruction` 与 `files` 均不得越过该边界。
- Skills import 继续从 server-side 完整 snapshot 读取；不删除或截断数据库中的 bundle。
- Repository view 只查询 Device name，不 hydrate DeviceCapabilities。
- summary 必须持久化而非仅做进程内 cache：重启后的第一次列表同样要快，且与每次 daemon hello 的完整 snapshot 在一个 SQLite statement 中保持一致。

## Next

- 合并、推送 v24；经 Harbor 审计部署链发布到 Mac mini，复测 schema/integrity、公网与 loopback 延迟后回写共享 progress。
