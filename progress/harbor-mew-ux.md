# Harbor P4.8 — Mew 交互对标与体验优化

> 2026-07-17 实施完成。目标：真实探索 Mew 网页端，把 Harbor 已有领域能支撑的高价值交互复刻进来；不制造没有后端语义的假能力。

## 对标证据

- 基准文档：Mew 使用说明 `E1qJdQ1muoIifExNzKUcYNeBnOb`；只读导出并检查 Agents、Chats、Issues、Prompt 设置等截图。
- 真实站点：复用用户已登录 SSO 的 `https://mew.bytedance.net`，只读探索 Kaboo workspace；未创建 Issue / Chat / Agent，未修改设置。
- 实机确认的核心模式：
  - 全局左栏固定 `New / Search / Workspace navigation`。
  - Issues 支持 Board / List / Gallery、Group / Fields / Filter / Sort；Filter 按创建人、状态、优先级、来源分组；详情是正文 + 右侧元数据 + 底部消息输入。
  - Chats 是会话列表 + 对话正文；可切换按 Agent 分组，Agent 回复用无气泡正文，thinking / tool 行折叠呈现，输入框携带 permission / model 上下文。
  - Agents 是 Agent 列表 + Instruction / Recent runs + Execution properties 的主从结构，创建和编辑都留在同一空间上下文内。

## 本轮取舍

| Mew 模式 | Harbor 落地 | 原因 |
|---|---|---|
| 全局 Search | `⌘/Ctrl+K` 页面跳转面板 + 侧栏入口 | 当前没有跨域搜索 API，先落真实可用的导航能力 |
| Issues Board / List | 双视图、状态/Agent/关键词筛选、更新时间/标题排序，视图写 localStorage | 全部由现有 conversation 数据支撑 |
| Gallery / Todo / Priority / Source | P4.8 暂不做；Todo / Priority / Source 已在 P4.10 补齐 | 先补领域与状态机，再开放真实交互；Gallery 仍无必要 |
| Chats 按 Agent 分组 | 可切换分组；默认保持时间序列表 | 与 Mew 一致，列表规模扩大后仍可扫视 |
| Chat 消息表现 | 用户轻灰气泡；Agent 无气泡正文；展示 Working / Worked for Ns；composer 合并提示与发送动作 | 降低“卡片套卡片”，突出执行过程 |
| Agents 三段式 | 列表 + 详情/创建上下文；执行属性、目录、instruction 分区 | Harbor 无 Agent runs 聚合与编辑 API，先建立可扩展主从骨架 |

## 实施范围

- `components/shell.tsx`：侧栏 Search、全局命令面板、`⌘/Ctrl+K`、Esc、窄视口滚动保护。
- `app/page.tsx`：Issues toolbar、Board/List、筛选、搜索、排序、视图持久化、列表详情入口。
- `app/chats/page.tsx`：按 Agent 分组开关、上下文 header、无气泡 Agent 消息、耗时状态、组合式 composer。
- `app/agents/page.tsx`：卡片网格改为主从 roster；创建表单从 Modal 移入详情面板；窄屏堆叠；保持归档与设备能力联动行为。

## 验收

- `harbor-web typecheck` ✓
- Next production build / static export ✓（11 pages）
- `harbor-server:17777` 最新静态产物 health ✓
- agent-browser 1280×720：Issues List、Agents、Chats 均 `scrollWidth === innerWidth`；List 视图持久化为 `harbor_issues_view=list` ✓
- agent-browser 760×720：Agents 创建上下文可达、全部字段和创建按钮存在，页面无横向溢出；全局 Search dialog 打开后输入框自动聚焦 ✓

## P4.9 Dogfood 反馈收口

用户首轮体验指出「模型选择没有和 sm_toolkit 打通」以及「文字密、下拉不协调」。修复不只换样式，同时补齐能力契约：

- daemon 从执行设备的 sm-toolkit `endpoints.yaml` 上报结构化 Model route；server 只接受该设备已就绪的 `provider:model`。
- Claude Runtime 展示 native / Anthropic-compatible route；缺 key route 分组展示但禁用，openai-only route 排除。Codex CLI 暂不消费 sm-toolkit route，UI 明示为本地 override。
- Agent 表单改成四段渐进结构，Runtime 用选择卡、Model route 用 provider optgroup；在线设备优先。全局 input / select / button 统一 44px 左右触控高度、圆角、留白和下拉箭头。
- 实机预览读取 `/Users/bytedance/.claude/global/endpoints.yaml`：27 routes / 13 ready，`kimi:k3` 可选，14 条 missing-key route 禁用；1280×900 与 760×720 均无页面横向溢出。

## 后续边界

若继续追 Mew 的完整交互，应先补领域/API，再做 UI：labels、Agent runs 聚合与编辑、统一跨域搜索、Issue 独立详情路由。不要先画空控件。

## P4.10 — 敏捷迭代闭环

- 领域：Issue 增加可空 Assignee、description、priority、`todo`；Run 增加 `purpose`，Reviewer 与实现者彻底分离。
- 流程：Inbox / Ready → `Assign & Run` → Running → Review → 人工 `Approve & Close`；失败/停止回 Ready，`Request changes` 创建新的 implementation Run。
- Review：可选派独立 AI Reviewer，Reviewer Run 始终留在 Review，不能覆盖 implementation Assignee 或替人验收；worktree 不可见时直接拒绝。
- 交互：五列 Board 与 List、完整筛选/排序、卡片执行态、宽详情抽屉、brief 就地编辑、properties 与上下文动作、Run history / SSE / result / Activity 同屏；拖拽调用真实 action，不允许把卡片任意拖成假状态。
- 效率：Agent 下拉在线优先并明示 offline queue；流式 token 在 daemon 合并、Web 批量入 state，避免长思考拖垮回放。

## P4.11 — AI draft 与 Issue conversation

### 二次实测

- Mew 普通 New issue：`Issue title` + markdown 正文，底部依次是 Todo、Priority、Agent、Owner、Labels、附件、`AI draft` toggle，主按钮为 `Create`。
- 开启 `AI draft`：标题输入消失，placeholder 改为 “Describe the request; the Agent will triage it before creating Issues.”，主按钮改为 `Ask Agent`。这证明它是创建前分诊，不是“自动执行 Issue”的别名。
- Mew Issue 详情：顶部返回/ID/标题/完成动作；中间是可编辑正文与 Agent 评论；评论默认只显示最终回答，点击 `Worked for …` 展开 Think/Ran/Edited；底部常驻 `Write a message…`，携带 permission/model；右侧只放 Status/Priority/Assignee/Owner/Creator/Labels/时间。

### Harbor 映射

- SQLite v6 新增 `kind=issue_draft` 与 `purpose=triage`。草稿隐藏，triage 强制 readonly + isolation none；成功后前端从首个 `# title` 解析 proposed issue，允许人工编辑，确认才原位发布为 `issue`。
- 详情改为保留 Harbor 左侧导航的整页结构。Issue brief 在上，Run 按 Agent 评论展示，`Worked for` 控制轻量执行流，底部 composer 直接触发 dispatch 或 request-changes；Review 的 AI Review/Approve 保持独立按钮。
- 未复制 Mew 尚无 Harbor 领域支撑的 Owner/Labels/附件；不画不可用控件。Markdown 完整渲染另有独立 dogfood Issue，不在本轮夹带实现。

## P4.12 — Skills 配置与 Agent 绑定

- 对标证据：Mew Skills 是 Workspace 内的搜索列表 + 详情主从结构；空态直接引导 `Import local skills`。文档说明来源包含 local runtime sync / 手动上传 / Skill 市场，Agent 表单通过多选绑定已导入 Skill，并建议 2–3 个。
- Harbor 领域映射：`manual` Skill 为跨设备 `SKILL.md` 快照；`runtime` Skill 来自 daemon 对本机 `.claude/.codex/.agents` 目录的真实探测，保留来源 Device/path/Runtime，只能绑定兼容 Agent。
- 执行语义：Agent–Skill 有序多对多；scheduler dispatch 时合成 Agent instruction + Skill 正文为 system prompt。Claude 使用 `--system-prompt`，Codex Backend inline；归档解除绑定，不允许隐藏 Skill 继续生效。
- 交互：新增 Skills 主从页、搜索、来源/Runtime/使用 Agent 展示、内置编辑器、Markdown 文件上传、本机同步多选；Agent 创建与详情内复用 Skill picker，超过 3 个提示上下文/指令冲突。
- 刻意不做：没有 registry 前不展示 Skill 市场；目录内 scripts/assets/references 还没有 bundle 分发协议，本轮不宣称已支持，只执行 `SKILL.md` 指令快照。
