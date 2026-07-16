# Harbor P4.6 — 个人控制面产品化

> 2026-07-16 定稿并实施完成。触发：对标 Mew 后确认，Harbor 的核心执行闭环已齐，下一步应补齐「安装后能稳定常驻、能力选择不会配错、设备状态可见、任务上下文可治理」四个个人控制面缺口。

## 1. 范围与边界

本期固定四块：

1. `harbor daemon setup|status|logs|uninstall`：macOS launchd + Linux systemd user service。
2. Web Devices 页面：设备在线状态、provider 版本、模型 endpoint、关联 Agent 一屏可见。
3. Provider capability 校验：Agent 只能选择目标设备已安装的 `claude` / `codex`；Claude 模型继续按 endpoint/native tier 校验，Codex 模型交给 Codex CLI。
4. Prompt wrapper：按 issue/chat/automation 三种来源注入结构化上下文，Settings 可编辑、禁用和恢复默认。

明确不做：团队成员/角色/审计权限、远程安装 daemon、Skills/Integrations 市场、Provider 凭证托管、server 常驻服务、prompt workflow/触发器编排。

## 2. 领域与数据决策

- Daemon lifecycle 是本机 OS 控制面，不进 Harbor DB。`setup` 幂等覆盖本机 service definition，可选写入 `~/.harbor.yaml` 的 `server_url/token/device_name`；`uninstall` 只卸服务，保留配置和日志。
- macOS service label = `com.smokingmouse.harbor.daemon`，plist 位于 `~/Library/LaunchAgents/`；Linux unit = `harbord.service`，位于 `~/.config/systemd/user/`。
- Prompt template 是 server 级配置，SQLite v3 新增 `prompt_templates`，每个 source 一行。未落库时使用代码内默认模板，避免迁移后行为依赖初始化脚本。
- Template 必须包含 `{{prompt}}`，仅允许白名单变量；未知变量在保存时拒绝，防止静默拼错。渲染发生在 scheduler 派发前，`runs.prompt` 永远保留原始输入。
- Automation 的 source 判定优先看 `conversation.origin === "automation"`，否则按 `conversation.kind` 映射 issue/chat。

## 3. 验收判据

1. 临时 HOME 下 `daemon setup` 可生成合法 plist/unit 和 YAML，重复 setup 无重复项；`status/logs/uninstall` 不要求 Harbor token。
2. 当前 macOS 实机 setup 后 `launchctl` 显示 running，杀进程后自动拉起；logs 可读；uninstall 后 label 消失。隔离验收实例完成后卸载，不擅自接管已有生产端口/配置。
3. REST 与 Web 都不能在仅安装 Codex 的设备上创建 Claude Agent，错误包含设备名和可用 provider；Web 会随 device 联动 backend/model。
4. Devices 页面可见 online/offline、last seen、CLI 版本、endpoint、关联 Agent，并给出可复制的 daemon setup 指令。
5. 三种 prompt source 使用各自模板；禁用时原样派发；自定义模板即时生效；原始 Run prompt/API 历史不被 wrapper 污染。
6. `bun run --filter harbor build`、harbor-web typecheck/build 通过；REST/DB/prompt renderer 与浏览器关键路径均有实测证据。

## 4. 风险闸

- launchd/systemd 的命令与文件生成拆开，纯函数覆盖测试；实机只操作 Harbor 自己的 label/unit。
- 不把 token 写进 plist/unit；daemon 仍从 `~/.harbor.yaml` 或环境读取，service 文件只携带必要的 PATH/HOME。
- Prompt wrapper 不进 `systemPrompt`，避免与 Agent instruction 混淆；当前请求在模板里明确为最高优先级。

## 5. 实施结果（2026-07-16）

六项验收全部通过。launchd 用 17777 server + 临时 HOME 做真实隔离验收：重复 setup 幂等，PID 75360 被 kill 后 KeepAlive 自动拉起 PID 75529，status/logs/uninstall 正常，label 最终清除。测试 daemon 实报 claude 2.1.183 + codex 0.139.0，SQLite 自动迁移 user_version=3。

现机 7777 由 VS Code NodeService 转发 Harbor API，但本地没有对应 `~/.harbor.yaml`，因此未覆盖它。浏览器用 agent-browser 独立 session 验证 Devices、Agent provider 联动、Settings 模板保存/恢复；测试 service、server、browser 与临时文件均已清理。
