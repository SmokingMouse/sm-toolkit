# fj TUI 交接与部署工具

TUI 新增显式 model/service-tier、稳定 client-thread-id、ready-file/nonce、await-first-turn 和 fj-root/cid/seat。生产 handoff helper 被跨仓 fake Herdr 测试调用；ready 写入为 0600，身份和状态不符不发布，首轮由 fj 持输入 lease 提交。Herdr 相同状态也周期重报。

新增 scripts/agent-server 用户级 LaunchAgent 模板、dry-run 安装工具与卸载脚本；plist 已经 plutil -lint 验证。没有安装或启动 launchd，所有 daemon/engine 测试使用临时环境和 fake/MockEngine。

验证：workspace `bun run typecheck`、`bun test`（473 pass / 0 fail）；后续 handoff helper 提取与 ready 权限测试由最终全量再次覆盖。跨仓 fj 验证了唯一首轮、双 root/cid mail 路由及 SIGKILL 后同 thread 恢复，未冒充真实 CLI 后代清理证据。

Next：主控将完整 workspace 构建产物置于稳定 release；核对 PATH/认证/allowed_roots 后独立进行 Codex 再 Claude 试点。Trellis 不属于本契约。
