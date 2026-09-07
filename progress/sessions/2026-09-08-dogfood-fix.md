# fj 复核返工

契约 fj-dogfood-fix-3342。TUI 增加显式 token 路径，ready nonce 从同用户私有文件读取并拒绝 symlink/public 文件。Codex 的持久 serviceTier 传入 start/resume/turn；Claude 显式 tier 返回 unsupported_capability。LaunchAgent 卸载允许服务已不存在，保留数据、重复执行成功，仍加载时拒绝掩盖失败。

回归使用 MockEngine/fake-codex 与 fake launchctl，未安装或启动服务。新增卸载测试最初放 scripts/ 下，被 tsc 编译成 dist 测试后重复发现；移入 agent-server 既有排除编译的测试目录，删除本次生成的四个测试产物后修复。具体全量统计见新契约 out/result.md。

Next：与 fj bundle 同步升级 TUI（新 --ready-nonce-file 协议）；主控另起真实试点。本次不 push、不改 ~/.claude。
