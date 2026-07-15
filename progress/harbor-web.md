# harbor-web — 可操作 Web 平台技术方案

> 2026-07-16 起草。触发：P4 只读看板上线后 dogfood 第一反馈就是「要能直接在平台上操作」
> （用户给了 Mew 界面截图对标）。原 P4「写操作按体感再加」的判断点已到——升级为完整操作台。
> 本方案自包含，可另开 session 直接执行；执行前只需读本文件 + 引用到的源码位置。

## 0. 已定决策（含理由，不再重议）

| 决策 | 理由 |
|---|---|
| 栈 = **Next.js 15 (app router, `output: 'export'`) + React 19 + Tailwind v4**，落 `apps/harbor-web/` | 用户默认栈（全局 CLAUDE.md）；纯 CSR 场景只用它当 bundler，静态导出后仍单进程部署 |
| 产物由 **harbor-server 静态 serve**（`apps/harbor-web/out/`），**删除现有单文件看板** `apps/harbor/src/server/dashboard.ts`，不留双版本 | 单进程/单端口/Tailscale 一个地址的部署形态不变；fallback 双版本 = 双维护，违背不留双版本原则。out/ 缺失时 GET / 返回一行提示「bun run --filter harbor-web build」 |
| 范围 = Issues / Chats / Agents / Automations / Approvals / Usage / Settings(token) 七块 | 对标 Mew 截图的 Harbor 领域映射。**不做** Skills/Integrations（Harbor 无此领域，skill 是设备全局的，见 harbor.md §10.2）、**不做**拖拽换列（按钮/菜单切状态，拖拽后置）、不做 Docs |
| 认证沿用 **token → localStorage → Bearer**，页面壳不鉴权、API 全鉴权 | 与现状一致（个人 Tailscale 内网）；dev 期用 next rewrites 代理免 CORS |
| UI 风格：浅色 Linear 风（对标截图气质），信息密度优先 | — |

## 1. 现状盘点（后端已就绪，前端是主体工程）

- server = `apps/harbor/src/server/`（bun + Hono，端口 7777）。REST 全集在 `rest.ts`，
  已覆盖本方案 95% 需求：devices GET（含 `capabilities.endpoints` 模型清单，供表单下拉）/
  agents GET·POST / conversations GET·POST·PATCH(status)·GET :id（含 runs+statusLog）/
  POST :id/runs（**串行闸**：同会话有活跃 run 时 400）/ runs GET·POST :id/cancel·
  GET :id/events（SSE）/ approvals GET·POST :id(allow|deny) / automations CRUD+log / usage 两个端点。
- 领域类型三端共享：`apps/harbor/src/protocol.ts`（前端可直接 import type——harbor-web 不进
  根 tsconfig references（next 自带 tsc，与 composite 不兼容），用相对路径 import type 零运行时依赖）。
- 现有只读看板 `dashboard.ts` 里有可搬运的参考实现：fetch-based SSE reader（EventSource
  不能带 Authorization header，必须 fetch+ReadableStream 手解 `data:` 帧、忽略 `: ping`）、
  事件渲染分层（text/thinking/tool/approval 帧）、usage SVG 柱图。
- 本机运行态：`harbor-server`/`harbord` 已在跑（nohup，日志 `~/.harbor/*.log`），
  token 在 `~/.harbor.yaml`。e2e 参考资产在 `/tmp/harbor-e2e/`（含 mock 测试脚本）。

## 2. 后端补丁（小，随本 feature 一起做）

1. **runs 附结果文本**：`GET /api/conversations/:id` 的 runs[] 增加 `resultText`
   （`store.getRunResultText()` 已有）。Chat 历史渲染必需。注意 run_events 7 天 prune 后为
   null——UI 显示「（记录已过期）」。
2. **agent 归档**：`PATCH /api/agents/:id {archived: boolean}`（软删除字段 `archived_at`
   已在 schema，store 加 `setAgentArchived`）。Web 上建错 agent 目前无法处理，这是真实缺口。
   归档 agent 不出现在派活下拉，历史引用不悬空。
3. **静态 serve**：rest.ts 删 DASHBOARD_HTML；GET `/` 及非 `/api|/ws` 路径 → `Bun.file`
   映射到 `apps/harbor-web/out/`（路径解析相对 server 源码目录定位仓库根，勿依赖 cwd），
   miss 时 fallback `out/index.html`（客户端路由用 query param，无动态路由，理论不触发）。

## 3. 信息架构与交互

左侧导航（截图同构）：**Issues · Chats · Agents · Automations · Approvals · Usage · Settings**。
顶栏：server 连接状态点 + Approvals pending 红点徽标（30s 轮询）。

- **Issues**：五列 kanban（backlog/doing/review/done/canceled，状态色沿用现看板）。
  `+ New`：弹窗选 agent（下拉=未归档 agents）+ title（可空，缺省取 prompt 前 60 字）+ prompt →
  POST conversations(kind=issue) + POST runs。卡片点开右侧抽屉：
  状态时间线（statusLog）、runs 流水（prompt/status/cost/resultText 摘要）、
  **事件回放面板**（SSE，进行中直播）、底部 continue 输入框（串行闸 400 时 toast 提示「上一轮还在跑」）、
  头部操作：done / cancel（cancel 需确认，会级联杀 run）/ 状态菜单（任意回退，PATCH status）。
- **Chats**：左列会话列表（GET conversations?kind=chat，title 即首条 prompt——**前端创建时传
  title=prompt.slice(0,60)**，POST 已支持，零后端改动）；右侧聊天区：历史 = runs 的
  prompt(右气泡)/resultText(左气泡)，发送 = POST runs + SSE 流式渲染（thinking 灰斜体折叠，
  tool_call 一行摘要）；流结束前发送框禁用（串行闸）。`+ New Chat` 选 agent。
- **Agents**：卡片列表（name/device/backend/model/permission/isolation/workdir + 在线状态）。
  `+ New`：device 下拉（GET devices）→ 联动 model 下拉（该 device 的 capabilities.endpoints +
  opus/sonnet/haiku 原生项 + 「CLI 默认」空值）+ workdir + permission 四档 + isolation +
  instruction。服务端校验错误（model 不在清单等）原样 toast。归档按钮（补丁 2）。
- **Automations**：表格（name/agent/cron/mode/enabled/lastFired）+ enable·disable·删除 +
  行展开看 log（fired/missed）。`+ New`：agent 下拉 + cron 文本（附 5 段语法提示与常用例）+
  prompt + mode（append 时 target 会话下拉）+ notifyChat（可空，提示需 server 白名单）。
- **Approvals**：pending 列表（tool/input 预览/所属 run 链接/等待时长 + 30min 倒计时感）+
  批准/拒绝按钮（幂等：已决议 toast 现状）；历史区折叠。
- **Usage**：现看板的 $/日柱图 + agent×model 明细表移植成组件；天数切换（7/14/30）。
- **Settings**：token 输入（存 localStorage）+ server 地址显示 + 连接自检按钮。

数据刷新：列表页 10s 轮询（React Query 或手写 hook 皆可，别引重状态库）；
表单编辑中不被轮询覆盖（受控组件天然隔离，勿把列表数据直接当表单初值引用）。

## 4. 工程要点（执行顺序即步骤）

1. 脚手架：`apps/harbor-web/`（package.json scripts: dev=`next dev -p 3777`、build、typecheck；
   deps: next/react/react-dom；dev: tailwindcss v4 + @tailwindcss/postcss + @types/*）。
   `next.config.ts`：`output: 'export'`、`images.unoptimized: true`、dev rewrites
   `/api/:path* → http://127.0.0.1:7777/api/:path*`。Tailwind v4 无需 config 文件，
   globals.css 首行 `@import "tailwindcss";`。bun workspaces `apps/*` 自动纳入，
   **不加**根 tsconfig references。
2. `lib/api.ts`：fetch 封装（Bearer from localStorage，401 → 跳 Settings）+ SSE reader
   （参考 `apps/harbor/src/cli/client.ts` watchRun 的实现，AbortController 收流）+
   `RunStreamFrame`/领域类型从 `../../harbor/src/protocol` import type。
3. 布局壳 + token 门 + 导航路由（app router，页面全 `'use client'`）。
4. Issues → Chats → Agents/Automations/Approvals/Usage/Settings（按依赖递进）。
5. 后端补丁三项（§2）+ 删 dashboard.ts。
6. build 产物接线冒烟：`bun run --filter harbor-web build` → 重启 harbor-server →
   `http://127.0.0.1:7777/` 出新界面。
7. e2e（§5）→ 回写 progress → 分组 commit（web 一个、server 补丁一个、docs 一个）。

## 5. 验收判据（agent-browser 可全自动，本机即可）

前置：server+daemon 在跑（见 §1 运行态）；审批场景需隔离 config 的 daemon
（`CLAUDE_CONFIG_DIR=/tmp/harbor-clean harbord`——本机全局 settings allowlist 了 Bash/Write，
不隔离则审批永不触发，见 README Verified Facts）。

1. 全新浏览器 profile：打开 / → 被引到 Settings 输 token → 七个导航页全部可达。
2. Agents 页建 agent（device/model 下拉数据来自能力清单；故意选无效 model 名验证报错 toast）。
3. Issues 页 New Issue 派活 → 卡片 backlog→doing→review 自动流转（轮询）→ 抽屉回放事件流 →
   continue 追加一轮（上下文连续）→ done 收尾。
4. Chats 页新聊天 → 流式回复逐 token 渲染 → 第二条消息证明 resume → 刷新页面历史仍在
   （resultText 补丁生效）。
5. 审批：permission=default agent 派需授权任务 → Approvals 红点 → 网页批准 → 回放里 run 续跑；
   拒绝路径同验。
6. Automations 建每分钟 cron → 2 分钟内 log 出 fired → disable 止血。
7. Usage 图表/明细渲染且与 `harbor usage` CLI 数字一致。
8. 杀 next dev，纯 harbor-server 单进程 serve 静态产物跑通 1–7 的抽样（同源无 CORS）。

## 6. Known pitfalls（前人踩过/可预见）

- **EventSource 带不了 Authorization header** → 必须 fetch 流式解析 SSE；`: ping` 注释帧忽略
  （thinking 长空窗保活用）。
- **串行闸**：同会话并行 POST runs 会 400（by design，防 resume 分叉）——聊天发送键在流未收
  done 帧前禁用；400 文案直接展示 server 消息（已是人话）。
- **轮询与操作竞态**：单文件版踩过「刷新重建 DOM 吃掉点击」（当时用事件委托修复）；React 无此
  问题，但注意别把轮询结果直接绑进正在编辑的受控表单。
- **run_events 7 天 prune**：旧 run 无回放/无 resultText，UI 给「记录已过期」而非空白。
- **`--settings ask 规则**（2026-07-16 已进 @sm/agent claude.ts：`opts.askTools`）：与本方案
  无直接耦合，但若后续把 askTools 暴露到 agent 表单，直接加字段即可，后端 RunOptions 已支持。
- bun 跑 `next build` 异常时改 `node node_modules/.bin/next build`（bun 1.3 一般没问题）。
- issue cancel 是破坏性操作（级联杀 run）——UI 要二次确认；done/cancel 触发 worktree 收尾，
  dirty 时 server 日志会 warn 且目录保留（预期，UI 无需处理）。

## 7. 明确不做（本期）

拖拽换列、暗色主题切换、移动端专门布局（响应式够用即可）、多用户/权限、
WebSocket 推送（轮询 10s 够个人用）、agent 编辑（只建/归档——改配置 = 建新的，与模型语义一致）。
