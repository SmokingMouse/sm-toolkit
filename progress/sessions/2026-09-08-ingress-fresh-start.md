# 官方 TUI 冷启动修复

- 契约：fj-ingress-fresh-start-01bb；生产 thread/start 因默认 config 携带 model_reasoning_effort 被整体拒绝。
- config 按项映射到 AS 选项，本地偏好只记录键名审计；模型/路径/权限/服务档守卫保留。personality、webSearch 增加线程选项与引擎映射，schema 同步生成。resume/fork 沿用保存的启动偏好。
- 冒烟增加 fresh_tui_session_ok（每后端三次真实 TUI 不带 resume 新建并完成一轮）；prod 模式连接已有 endpoint，默认双后端，保留用户 config，不启停 daemon。
- 实测：agent-server 1214 pass，typecheck 通过；D3/D4 原样命令通过。本机默认用户 config 连接临时源码 daemon，Codex/Claude 各三次通过；升级矩阵未通过。
- 回归暴露 Claude 拒绝诊断命令或长输出，以及目标 turn 在 TUI interrupt 前结束的问题。审批/中断等待已检查精确终局并快速失败；改为用途明确的 200 句输出后 D4 通过，但扩展矩阵仍失败。尝试重按物理 Esc 也失败，已撤销该未通过改动；按同一错误三次停机条款停止修复与复跑。
- PR #17 已创建；主控推送至 51d45f7，后续本地提交待主控补推。未合并、未对主仓 pull/build、未重启生产。picker 的 config/batchWrite 仍按全局写禁令拒绝，已上报待裁决。
- Next：主控接管中断冒烟与 picker 范围裁决，验证通过后补推并合并 PR、主仓快进/构建、重启后跑 prod 双后端各三轮。证据与命令见契约 out/result.md。
