# readonly 解析器展开闸修复

契约：fj-as-readonly-p2-whitelist-fix-4742；基线：7421aab。

- `readonly-commands.ts` 在 tokenizer 统一拒绝未引号/转义的展开字符，覆盖 git 及自定义名单；保留引号内模式，`$`/反引号沿用原全局拒绝规则。
- `grep/rg/file` 仅允许全部由无值白名单 flag 组成的短选项合并；`-f` 及长别名的输入路径按服务端 allowed_roots 校验，逐组件 realpath 防 symlink/`..` 混淆。ThreadManager 在 spawn/resume 时注入当前服务端范围，两条 Bash 入口共用检查。
- 保留 rg 默认条目；native model/list description 与协议文档说明二进制不可解析时恒审批。协议新增常用写法对照与输入边界说明。
- 固化四审原始 194 行及 67 条真工具差分命令；前三轮 377 行不改预期。四审政策变化保留原预期和理由。
- 验证：agent-server 全套 1190 pass / 0 fail；typecheck 通过；67 条差分 executed=67、mutations=0。命令见契约 result.md；测试入口为 `readonly-commands.test.ts`、`readonly-differential.test.ts` 和 `claude.test.ts`。
- 真机：`bun packages/agent-server/scripts/readonly-expansion-smoke.ts /tmp/x`，同线程 init model=`claude-sonnet-5`；`git log {--output=/tmp/x,HEAD}` pendingRequests=1、new readonly_auto_allow=0、fileExists=false，关闭 daemon 后仍不存在。

Next：主控独立复跑契约验收。
