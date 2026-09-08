# 官方 TUI 冷启动修复

- 契约：fj-ingress-fresh-start-01bb；生产 thread/start 因默认 config 携带 model_reasoning_effort 被整体拒绝。
- config 按项映射到 AS 选项，本地偏好只记录键名审计；模型/路径/权限/服务档守卫保留。personality、webSearch 增加线程选项与引擎映射，schema 同步生成。resume/fork 沿用保存的启动偏好。
- 冒烟增加 fresh_tui_session_ok（每后端三次真实 TUI 不带 resume 新建并完成一轮）；prod 模式连接已有 endpoint，默认双后端，保留用户 config，不启停 daemon。
- 实测：agent-server 1214 pass，typecheck 通过；D3/D4 原样命令通过。本机默认用户 config 连接临时源码 daemon，Codex/Claude 各三次通过；升级回归进行中。
- Next：完成升级检查、提交并请求主控推送；创建/合并 PR，主仓快进与构建，生产重启及后验由主控执行。
