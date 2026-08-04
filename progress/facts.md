# Facts（已验证事实，每条必带来源指针）

- **codex CLI ≥0.146.0 废弃 `wire_api = "chat"`，只认 `responses`**：config 含 chat 直接启动报错 `Error loading config.toml: wire_api = "chat" is no longer supported`，官方指向 openai/codex discussions#7782。推论：endpoints.yaml 里 chat-only 的 openai_url（deepseek / gemini / ark-coding）从协议上给不了 codex，故 `codex:` 块设计为显式 opt-in。来源：2026-08-04 本机 `codex exec -c 'model_providers.sm_ep.wire_api="chat"' …` 实测（codex-cli 0.146.0）。
- **codex `-c model_provider` per-run 注入真实生效（非静默 fallback 全局 config.toml）**：注入 `env_key="NONEXISTENT_KEY_XYZ"` 报 `Missing environment variable`；正常 key 走通、坏 key 401 且报错 url = 注入的 base_url。来源：2026-08-04 实测，详见 sessions.md 当日条目。
- **`codex exec resume` 不接受 `--sandbox`/`--add-dir` 但接受 `-c` overrides**（codex 0.144.2 实测）——endpoint 注入参数放 common 对 resume 路径同样可用。来源：`packages/agent/src/backends/codex.ts` buildCodexArgs 注释。
- **codex headless fork 可由 rollout copy 模拟**:复制 `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` 并全文替换 uuid,resume 新 id 即继承完整历史、与父线双向隔离的新 thread(交互版 `codex fork` 的等价物,exec 无该子命令);前缀相同还命中 provider prompt cache。约束:resume 需带录制时的 -m;rollout 格式为内部实现,codex 升级需回归。来源:2026-08-04 codex 0.146.0 三步实测(继承/隔离/负向),见 sessions.md 当日条目。

## 迁移自 README「Verified Facts」区

- **claude CLI 的路由优先级**：env 注入的 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 优先于本机 OAuth 登录态——本地假服务器实测（2026-07-14），所有 `/v1/messages` 请求均打到 env 指定的 base_url 且带 `Bearer <token>`，零请求流向官方；`--bare` 有无不影响路由归属。因此"指定三方 endpoint 却悄悄用官方模型"在 env 齐全时不存在。
- **super-relay 等字节内部代理认 `ANTHROPIC_AUTH_TOKEN`（Bearer），不认 `ANTHROPIC_API_KEY`**；两个都设可兼容不同版本 claude CLI。
- **claude 2.1.207 的 can_use_tool 双向审批需要 initialize 握手**（2026-07-15 实测）：spawn 后客户端必须先向 stdin 发 `{"request_id":...,"type":"control_request","request":{"subtype":"initialize","hooks":{}}}`，claude 回 success 后才把权限请求以 `control_request(can_use_tool)` 下发 stdout；不握手则 `--permission-prompt-tool stdio` 被静默忽略、headless 对需授权工具直接 auto-deny（agent-gateway 时代 2.1.167 无此要求，属行为漂移）。该 flag 已从 `--help` 隐藏；`--permission-mode` 选项改为 acceptEdits/auto/bypassPermissions/manual/dontAsk/plan，旧值 `default` 仍兼容（=manual）。修复落在 `@sm/agent` ClaudeBackend。
- **设备全局 `~/.claude/settings.json` 的 permissions.allow 优先于审批链路**：allowlist 的工具（本机 Bash/Read/Edit/Write/WebFetch 全在）永不触发 can_use_tool——审批只覆盖「未 allowlist 且当前模式要求确认」的工具，是机器级信任的预期行为。e2e 测审批必须隔离 `CLAUDE_CONFIG_DIR`。
- **croner 的模式回溯 `previousRuns(n)` 是 v10 才有的 API**；v9 的 `previousRun()` 返回实例自身运行历史（新实例恒 null），拿它做停机 missed 检测形同虚设。另：bun 对 workspace 外的脚本会回退解析全局缓存里的别版本包——调试依赖行为先 `require.resolve` 确认实际加载路径。
