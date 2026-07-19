# Harbor Device List Performance

## Current Focus

实现已通过全量验证，待合并并部署精确 revision；不改变 daemon hello、capabilities 持久化、Skill import 或 credential。

## Log

### 2026-07-19

- 生产实测 `/api/devices` 为 13,550,524 bytes，Mac mini loopback 320–380ms、公网 2.43s；`/api/agents` 仅 8,165 bytes / loopback 3–10ms。
- 三台 Device 的完整 capabilities 含 165 个 runtime Skills、1,553 个 bundle files；浏览器所需 metadata projection 预计约 203KB，可减少约 98.5%。
- `/api/repositories` 为每个 mount 调用 `getDevice()`，仅取 name 却解析整块 capabilities，loopback 固定约 280ms。
- 新增 `DeviceSummary`，`/api/devices` 只返回 Skill metadata 与 `fileCount`；完整 `instruction` / `files` 仍留在 server-side snapshot，Skills import 语义不变。
- Repository view 改为单列查询 Device name，不再 hydrate capabilities。
- 验证通过：projection regression 2/2、相关回归 16/16、workspace typecheck、全量生产 build、全量测试 418 pass / 0 fail / 2150 assertions。

## Decisions

- `DeviceCapabilities` 是 daemon→server 的完整可信快照；新增 `DeviceSummary` 作为 REST/CLI/Web 列表投影，Skill `instruction` 与 `files` 均不得越过该边界。
- Skills import 继续从 server-side 完整 snapshot 读取；不删除或截断数据库中的 bundle。
- Repository view 只查询 Device name，不 hydrate DeviceCapabilities。

## Next

- 合并、推送，经 Harbor 审计部署链发布到 Mac mini；复测公网与 loopback 延迟后回写共享 progress。
