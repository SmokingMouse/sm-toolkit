# agent-server 观测面板集成

- `feat/agent-server` 从 `5451ce4` 合并 `feat/tui-observe`（`06c848a`），保留双方会话/输入/模式/观测功能。main.ts 保留所有启动参数并开启 engineEvents；options/help 与补全加观测命令；Tab 按第一步优先级保留 effort/补全，Ctrl-R 统一 reasoning 与子 agent thinking。
- 租约冲突已上报，主控明确裁决：统一 InputLease 承接发送、审批、提权；非提权切换免租约；手动接管仅在 TTL 窗口内活跃时续期；切换停止旧 thread 续期，新 thread 不复用；ExitPlanMode 仅本端获胜后切 default。实现与空闲/切换回归见 `apps/agent-tui/src/lease.ts`、`lease.test.ts`。
- 已验证：server 263 pass；观测/租约初步 15 pass；统一租约后 modes/sessions/lease 44 pass；观测 PTY 的竞态、超时恢复、嵌套/任务/重连两例通过。Codex 0.153.4 协议对齐通过。
- 合并适配失败记录：旧 session 测试 client 缺少新租约依赖回调，补齐测试接口和审批确认；旧 ExitPlanMode 竞态在获租约后让另一端审批已不可能，改为获取前抢答，保留 losing 不改模式断言。观测 PTY 使用完整 id、旧命令直接 Enter、先看到部分帧就断言，已同步短 id、补全约定和完整帧末尾；审批确认期间 footer 合并遗漏已补齐。原始失败日志在契约 out/targeted、tui-tests-first、integration-fixed 等文件，最终 proof 待全量完成。
- merge 提交 `eccdf6d`；五分支 ancestry、typecheck 均 exit 0；server 263 pass / 0 fail；TUI 普通与指定 clean-env 均 116 pass / 0 fail / 4 snapshots / 951 expect。5000 事件 PTY 键入延迟最大分别为 24.95ms、24.64ms。
- Sonnet 唯一 thread `th_6622d51c-ecef-4f38-b79e-9a55cc9c667c`，3 turn：plan 启动、持 lease 切 acceptEdits、原生图片输入后回答 Red、他端持锁时实际 PTY Ctrl-C，中断原生帧延迟 2ms（轮询确认 24ms），末 turn interrupted；50 条 engineEvent，实际 PTY 可见 hook。模型原生确认 claude-sonnet-5，无 fable。
- Codex 唯一 thread `th_f80edad8-b713-42e2-8814-74cf04bb1092`，1 turn；gpt-6-astra，thread/start 与 turn/start 均 serviceTier default，34 条 engineEvent。验证脚本 `out/verify-smoke.ts` exit 0；daemon、两引擎及 PTY 均已退出。逐帧行号与清理证据见契约 out/smoke-proof.json。
- Next：交主控独立验收；不 push，不改 main。模式 backlog 六项中的释放失败覆盖结果随统一管理器解决，其余五项及输入粘贴/后端门禁顺序留后续单，具体建议见契约 result.md；未修改主仓 backlog。
