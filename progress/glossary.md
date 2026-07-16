# SM-Toolkit Domain Glossary

## Harbor

- **Device**：运行一个 `harbord` 的真实机器。设备在线状态来自 WebSocket 连接，能力来自 daemon 启动时探测，不是用户手填标签。
- **Provider capability**：某台 Device 上实际可执行的 agent CLI（当前仅 `claude` / `codex`）及其版本。Agent 只能绑定设备已上报的 provider；provider 与模型 endpoint 是两类能力，不能互相代替。
- **Daemon service**：操作系统用户级的 `harbord` 常驻服务。它只管理本机 daemon 进程，不是 Harbor 数据库里的领域实体，也不管理远端 server。
- **Prompt wrapper**：server 在派发 Run 时临时包裹原始用户 prompt 的结构化上下文。原始 prompt 仍原样落库；wrapper 不替代 Agent instruction，也不改变 Conversation 历史。
- **Prompt source**：决定 wrapper 模板的来源类别：`issue`、`chat`、`automation`。Automation 优先按来源识别，即使它创建的是 issue。
