# RFC: Orchestra —— 基于 Herdr + sm-toolkit 的 Multi-Agent 编排与闭环治理

> 状态：draft · 2026-08-26 · 源：吸收 Alioth (workflow-os) 架构拆解（/tmp/alioth_handoff_briefing.md）
> 一句话：**herdr 出肌肉（进程/终端/状态机），packages/agent 出神经（事件流/权限回调），本 RFC 只新建大脑皮层（契约/信箱/结算/档位）——四个模块一个包一个 bin，约 2k 行以内落地 Alioth 4 万行的治理精华。**

---

## 0. 结论先行

| Alioth 层 | Alioth 实现 | 我们的对应物 | 处置 |
|---|---|---|---|
| 终端容器化（zellij-io.sh，屏幕 hash 判活/wait_ready/send/close） | ~8.5k 行 Shell 黑魔法 | **herdr 原生**：`agent start` 阻塞到 ready、`agent prompt --wait`、生命周期状态机 idle/working/blocked/done、`send-keys`、两阶段关闭 | **不吸收，直接用 herdr** |
| Headless SDK 桥（Codex App-Server JSON-RPC / DSH 双通道） | scripts/runner/ | **packages/agent 存量**：ClaudeBackend（stream-json control protocol）+ CodexAppServerBackend（thread/fork、turn/interrupt 已实现） | **不吸收，存量已更强** |
| 机械护栏 guards.mjs（旁路审计 tool_call 路径，违规强杀） | Runner 层旁听 | **可升级一代**：`RunOptions.askTools + onCanUseTool` 在工具执行**前** deny 且 deny message 回流模型（模型知道为何被拒能改道），优于事后强杀 | **吸收思想，换实现**（Phase 3 headless 模式） |
| 环境隔离（profiles.toml + SANITIZE_ENV） | spawn.sh 矩阵 | endpoints.yaml + `RunOptions.env` 已有一半；本仓 5610dfd 修的"父进程代理变量污染"证明消毒痛点真实存在 | **吸收 → `sm profile`** |
| 契约派发（contract-only、scope/stop_when/DOD 强制） | Hub 手写 | 无 | **吸收 → `sm contract`** |
| 文件总线信箱（inbox.mjs，progress/blocker/result 三动词 + 游标） | Relay | 无（herdr 只有过程信号无语义信号） | **吸收 → `sm relay`** |
| 闭环结算（落账 DECISIONS.md、指纹、只提交本轮文件） | Settlement | **用户已有同构物**：progress-protocol（facts/sessions/decisions 台账） | **吸收 → `sm settle`，账本直接写 progress/，不另造** |

Alioth 的体量大部分是在补"没有 agent-native 基础设施"的洞。我们不缺基础设施，缺的只是**治理协议**。

---

## 1. 设计哲学对齐

沿用 sm-toolkit 既有信条（均可在现有代码注释中找到出处）：

1. **机制与策略分离**（backend.ts："纯机制字段——策略全留给调用方"）。orchestra 是策略层，依赖 agent 的机制层；agent 不知道 orchestra 存在。
2. **薄门面 + 归一信封**（events.ts："接口层统一即可，工具细节看各自工作环境"）。信箱消息是归一信封，不抹平各 agent 的工具细节。
3. **fail loud**（maxTurns "非法值直接抛错"）。preflight 硬闸机械可查，不留判断余地——与用户 progress-protocol 的"三条硬闸"同一血统。
4. **配置驱动**（endpoints.yaml）。profiles.yaml 同形态、同搜索路径。
5. **双通道不重复**：herdr 状态机 = 免费实时的**过程信号**（working/idle/blocked）；relay 信箱 = agent 主动写的**语义信号**（里程碑/带 fallback 的回问/结构化收尾）。互补，不是谁替代谁。

---

## 2. 架构与模块设计

### 2.1 归属判断

- **新包 `packages/orchestra`**（`@smokingmouse/orchestra`）：契约 schema/解析/preflight、信箱读写、结算校验、profile 编译。纯库，四个模块四个文件，不拆四个 npm 包（发版/依赖管理开销不值）。
- **`apps/cli` 增加第二个 bin `sm`**：薄 CLI 门面（argv 解析 + 调 orchestra），与 `llm` bin 同构同包——一次全局安装两个命令，安装故事不变。
- **`packages/agent` 不动**（Phase 3 例外：headless 派发模式会新增一个消费 orchestra 契约的 guard 工厂函数，依赖方向仍是 orchestra → agent）。

依赖图：`apps/cli(sm)` → `packages/orchestra` → （Phase 3 起）`packages/agent`。

### 2.2 目录与状态布局

```
packages/orchestra/src/
  contract.ts    # schema + parse(frontmatter) + preflight + render(dispatch prompt)
  relay.ts       # 信箱读写：append / drain(游标) / 归档
  settle.ts      # scope diff 审计 + DOD 执行 + progress/ 落账 + 指纹
  profile.ts     # profiles.yaml 解析 + 编译成 herdr 原生 args / RunOptions
  ids.ts         # cid / msgid 生成

<目标 repo>/.sm/               # 项目级运行时状态（类比 .git）
  contracts/C-<date>-<rand>.md # 契约本体（建议纳入 git —— 审计留档）
  mail/<cid>.ndjsonl           # 信箱，一约一文件（gitignore）
  mail/blobs/<msgid>.json      # 超长 payload sidecar（gitignore）
  mail/archive/                # 结算后归档
  cursor.json                  # Supervisor 单消费者游标 { <cid>: lastMsgId }
```

**一约一文件**而非全局单 bus：多契约并行时游标各自独立、结算即整文件归档、GC 零成本。写入原子性：`O_APPEND` 单行写入 < PIPE_BUF(4KB) 由 POSIX 保证原子；超限 payload 落 blobs/ sidecar，行内只写指针——主会话永远只读结构化短行，上下文不被长日志污染（Alioth inbox 的核心价值，原样保留）。

---

## 3. 契约 Schema（`sm contract`）

### 3.1 形态判断：markdown frontmatter，不是纯 yaml

契约有三个读者：机器（preflight/guard/settle 读结构化字段）、执行 agent（body 就是 dispatch prompt 的正文）、人（review）。frontmatter 承载机器字段，body 承载任务叙事——与 SKILL.md 同构，符合本生态习惯。

### 3.2 完整示例

```markdown
---
v: 1
cid: C-20260826-a3f1
title: 修复 llm bench 并发超时
profile: worker                    # 引用 profiles.yaml 档位
workspace: /Users/smokingmouse/sm-toolkit   # 或 herdr worktree 路径
scope:
  write:                          # 允许写的 glob（settle 逐文件比对 git diff）
    - "packages/llm/src/**"
    - "packages/llm/*.md"
  deny:                           # 显式禁区，优先级高于 write
    - "**/.env*"
    - "**/endpoints*.yaml"
stop_when:
  max_wall_minutes: 45            # Supervisor 侧闹钟，超时读现场后决定终止
  max_blocker_rounds: 2           # 回问轮数上限，防无限乒乓
dod:                              # Definition of Done —— settle 逐条执行留 proof
  - cmd: "bun test packages/llm"
  - cmd: "tsc --build"
  - assert: diff-in-scope         # 内置断言：改动文件全部落在 scope 内
deliverables:                     # 预期产物（settle 对照 result 汇报）
  - "packages/llm/src/bench.ts"
report:
  relay: required                 # worker 必须经 sm relay 汇报（守则注入 dispatch prompt）
status: draft                     # draft → dispatched → blocked → settling → settled | void
agent: null                       # 派发后回填 herdr agent name
---

# 任务

`llm bench --concurrency 4` 在 provider 内并发时偶发 …（背景、复现、参考文件）

## 约束

- 不改 provider 接口签名
- 失败重试逻辑维持在 retry.ts，不下沉

## 禁区

- 不碰 endpoints 配置解析
```

### 3.3 Preflight 硬闸（`sm contract check`，机械可查）

1. `scope.write` 非空且 glob 可编译——**无 scope 不派发**；
2. `stop_when` 至少一条上限——**无止损不派发**；
3. `dod` 至少一条且含 `diff-in-scope` 断言——**无验收不派发**；
4. `profile` 在 profiles.yaml 中存在；`workspace` 目录存在且是 git repo（diff 审计的前提）；
5. `deny` 与 `write` 求交集告警（人常写出自相矛盾的 glob）。

违反任何一条 exit 2 并逐条报错。这是 Alioth "contract-only" 权限观的落点：**约束不靠模型自觉，靠派发前的机械闸 + 结算时的机械审计。**

### 3.4 渲染（`sm contract render <cid> --dispatch`）

输出 = 契约 body + 自动追加的**汇报守则尾注**（模板固定，不让 Supervisor 每次手写）：

```
── 汇报守则（必须遵守）──
你在契约 C-20260826-a3f1 下工作。用以下命令汇报，不要用普通文本对我喊话：
  阶段里程碑：  sm relay send C-20260826-a3f1 progress --milestone "..." [--pct 40]
  遇到卡点：    sm relay send C-20260826-a3f1 blocker --question "..." --safe-fallback "..." [--blocking]
    · safe_fallback = 不等我答复也能继续推进的方案；发完非 blocking 的 blocker 后按 fallback 继续干
    · 只有真正无法继续（缺凭证/缺决策）才加 --blocking 然后停下等待
  收尾：        sm relay send C-20260826-a3f1 result --status done --summary "..." \
                  --deliverable path[:lines] ... --proof "cmd => exit0" ...
改动只允许落在：packages/llm/src/**, packages/llm/*.md（禁区：**/.env*, **/endpoints*.yaml）
完成判定（我会逐条验证）：bun test packages/llm ✓ · tsc --build ✓ · diff 全部在 scope 内
```

---

## 4. 信箱协议（`sm relay`）

### 4.1 消息信封（NDJSON，每行一条）

```jsonc
{
  "v": 1,
  "id": "m-000007",              // 文件内单调递增
  "cid": "C-20260826-a3f1",
  "ts": "2026-08-26T12:34:56Z",
  "from": "worker-a3f1",         // herdr agent name（或 "supervisor"）
  "kind": "progress",            // progress | blocker | result | ack
  "payload": { ... },
  "blob": null                   // payload 超 3KB 时置 "blobs/m-000007.json"，payload 置摘要
}
```

**payload 各动词：**

```jsonc
// progress —— 心跳 + 里程碑
{ "milestone": "定位到竞态在 stream reader", "pct": 40, "note": "可选" }

// blocker —— 回问；safe_fallback 是 CLI 级必填（缺参 exit 2，机械闸而非文档约定）
{
  "question": "重试上限提到 5 还是维持 3？",
  "options": ["提到 5", "维持 3 + 指数退避"],
  "safe_fallback": "维持 3 + 指数退避，参数抽成常量便于日后改",
  "blocking": false
}

// result —— 结构化收尾
{
  "status": "done",              // done | partial | failed
  "summary": "竞态修复，root cause 是 …",
  "deliverables": [{ "path": "packages/llm/src/bench.ts", "lines": "+42/-11" }],
  "proof": [{ "cmd": "bun test packages/llm", "exit": 0, "tail": "18 pass 0 fail" }]
}

// ack —— Supervisor 对 blocker 的裁决留档（真正的送达走 herdr，见 4.3）
{ "re": "m-000004", "decision": "维持 3 + 指数退避；常量放 retry.ts 顶部" }
```

### 4.2 消费端（Supervisor 侧）

- `sm relay drain <cid>`：读游标之后的新消息，输出 JSON 数组，**推进游标**（单消费者，cursor.json）。
- `sm relay peek <cid>`：只读不动游标（调试/旁观用）。
- `sm relay log <cid>`：全量含 ack，人读格式（审计视图）。

### 4.3 上下行不对称（关键设计）

**上行（worker → Supervisor）走文件总线**：worker 在任何状态都能 append，天然异步。
**下行（Supervisor → worker）走 herdr 注入**：worker 是 TUI 交互态，不会轮询文件；`herdr agent prompt <name> "..."` 直达输入框。信箱里的 `ack` 只是**留档**，不是送达通道。（Phase 3 headless 模式下行改走 backend 的 steer/queueTurn，信箱角色不变。）

### 4.4 `safe_fallback` 交互协议（时序）

`safe_fallback` 的本义：**回问不阻塞执行**。协议分两支：

**非 blocking（默认，覆盖 90% 场景）：**
1. worker 发 blocker 后**不等**，立刻按 fallback 方案继续干；
2. Supervisor 主循环 drain 到该 blocker 时分两种时机：
   - **赶上了**（worker 还在做受该决策影响的部分）→ `herdr agent prompt` 注入裁决 + `sm relay send <cid> ack --re m-4` 留档；worker 收到后就地转向；
   - **过期了**（worker 已按 fallback 走完）→ 不注入，把该 blocker 转为**结算检查项**：验收时审 fallback 分支是否可接受，不可接受则追加返工契约。fallback 方案本身要求"留扩展点"，正是为了让过期裁决的返工成本趋近于零。
3. ack 留档使每个 blocker 都有闭环记录——没有"问了没人答"的悬案。

**blocking（少数：缺凭证、缺不可逆决策）：**
1. worker 发完停下（TUI 转 idle）——herdr 侧表现为 `idle` 而非 `blocked`（herdr 的 blocked 专指审批 UI），所以 **Supervisor 判定"idle 但信箱有未 ack 的 blocking blocker" = 语义阻塞**，这正是双通道要合并判断的典型场景；
2. Supervisor 裁决注入后 worker 继续；
3. `stop_when.max_blocker_rounds` 耗尽 → Supervisor 终止契约（void）或收窄 scope 重派。

---

## 5. 环境档位（`sm profile`）

`~/.config/sm/profiles.yaml`（与 endpoints.yaml 同目录同风格）：

```yaml
profiles:
  scout:                        # 只读侦察/调研
    kind: claude
    model: sonnet
    permission: readonly
    sanitize_env: true          # 剥离父进程 ANTHROPIC_BASE_URL/AUTH_TOKEN/HTTP(S)_PROXY 等
  worker:                       # 可写执行（默认档）
    kind: claude
    model: fable
    permission: auto-edit
    sanitize_env: true
  worker-codex:
    kind: codex
    permission: auto-edit
    sandbox_network: false
  reviewer:                     # 验收评审
    kind: claude
    model: fable
    permission: readonly
```

两个消费出口：
- `sm profile args <name>` → 输出该档编译成的**原生 CLI 参数**（`--permission-mode acceptEdits --model … --disallowedTools …`），供 `herdr agent start … -- $(sm profile args worker)` 拼接；
- （Phase 3）`profileToRunOptions(name)` → 直接产出 `RunOptions`，供 headless 派发。

环境消毒是 spawn 前动作：pane 模式下由 `sm dispatch`（Phase 2）在 split pane 里先 `unset` 污染变量再 start；这正是本仓 5610dfd 已在 `llm` 直启路径修过的同一个坑，上升为档位级声明。

---

## 6. Supervisor × Herdr 标准生命周期

Supervisor = 跑在 herdr pane 里的主 Claude 会话（`HERDR_ENV=1`）。七步：**立约 → 开位 → 启动 → 下发 → 监督 → 结算 → 收位**。

```bash
# ① 立约 + 预检（硬闸）
sm contract new --title "修复 llm bench 并发超时" --profile worker \
  --scope 'packages/llm/src/**' --deny '**/.env*' \
  --dod 'bun test packages/llm' --dod 'tsc --build' \
  --body-from /tmp/brief.md
# → .sm/contracts/C-20260826-a3f1.md  (status: draft)
sm contract check C-20260826-a3f1          # 任一硬闸不过 exit 2，流程终止

# ② 开位：并行写场景先隔离 worktree，再分屏（不抢焦点）
herdr worktree create --branch fix/bench-timeout --no-focus     # 可选
herdr pane split --current --direction right --cwd "$WORKDIR" --no-focus
# ← .result.pane.pane_id = w1:p7

# ③ 启动 worker（档位编译原生参数；agent start 阻塞到 ready，无需 wait_ready 黑魔法）
herdr agent start worker-a3f1 --kind claude --pane w1:p7 -- $(sm profile args worker)

# ④ 下发（渲染 = 契约 body + 汇报守则尾注）
sm contract render C-20260826-a3f1 --dispatch > /tmp/dispatch.md
herdr agent prompt worker-a3f1 "$(cat /tmp/dispatch.md)"        # 不加 --wait，转入监督循环
sm contract set C-20260826-a3f1 status=dispatched agent=worker-a3f1

# ⑤ 监督循环：herdr wait 当闹钟醒来 → drain 信箱拿语义 → 分诊
while :; do
  state=$(herdr agent wait worker-a3f1 --timeout 300000 | jq -r '.result.state')
  msgs=$(sm relay drain C-20260826-a3f1)
  # 分诊表见下；收到 result 或触发 stop_when 则 break
done

# ⑥ 结算
sm settle C-20260826-a3f1          # 详见 §7；全过 → settled，落账 progress/

# ⑦ 收位（只收自己开的）
herdr agent release worker-a3f1 2>/dev/null || true
herdr pane close w1:p7
```

**⑤ 的分诊表（过程信号 × 语义信号 合并判断）：**

| herdr state | 信箱新消息 | 判定 | 动作 |
|---|---|---|---|
| working | progress | 正常推进 | 记录，继续 wait |
| working | blocker(非blocking) | 边干边问 | 裁决仍来得及 → `agent prompt` 注入 + ack 留档 |
| blocked | （任意） | TUI 在等审批/选择 | `herdr agent read` 看现场 → `send-keys` 处理（契约内自动批，超纲的升级问用户） |
| idle/done | result | 干完了 | break → 结算 |
| idle | blocker(blocking) 未 ack | **语义阻塞**（TUI 看不出） | 裁决注入 + ack；`max_blocker_rounds` 计数 |
| idle/done | 无 result | 可疑：干完没汇报 / 跑偏 | `herdr agent read --source recent-unwrapped` 看现场 → 催报（注入"按守则发 result"）或直接进结算 |
| （wait 超时） | 无新消息 | 可能 hang / 长任务 | 读现场判断；对照 `stop_when.max_wall_minutes` 决定续等或终止 |

---

## 7. 闭环结算（`sm settle`）

四步全自动，任一步失败进入 `settling` 态并输出失败报告（Supervisor 据此选择：注入返工 prompt / 收窄 scope 重派 / void）：

1. **Scope 审计**：`git -C <workspace> diff --name-only <base>` 逐文件比对 `scope.write` / `scope.deny`。越界文件零容忍——这是 pane 模式下 contract-only 的最终强执行（事前只有软约束，事后是硬审计）。
2. **DOD 执行**：逐条跑 `dod.cmd`，记 `{cmd, exit, tail}` 为 proof；`diff-in-scope` 断言即第 1 步结果。
3. **对账**：`result.deliverables` ⊆ 实际 diff 文件集；缺报/虚报都标注。
4. **落账（与 progress-protocol 直接打通，不另造账本）**：
   - `progress/facts.md` 追加验证过的事实（proof 即协议要求的"来源指针"，天然合规）；
   - `progress/sessions.md` 追加条目**并在同一次编辑内轮转 >5 的旧条**（协议硬闸 2）；
   - 有决策含量（blocker 裁决）→ `progress/decisions.md` 追加；
   - 契约 `status: settled`，回填指纹（本轮 diff 的 content hash——防 rot：后续任何人能校验"结算时的代码"与"现在的代码"是否漂移）；
   - `.sm/mail/<cid>.ndjsonl` 移入 `mail/archive/`。

---

## 8. 落地路线图

每个 Phase 独立可用、独立可弃。**反对一次做全**——Alioth 4 万行的教训就是治理系统自身成为 rot 源。

### Phase 0 · relay MVP（半天）
`packages/orchestra/src/relay.ts` + `sm relay send/drain/peek`。契约先手写、派发先手动 herdr 操作。
**验证目标**：Supervisor 主会话跑一次真实派发，全程不读 worker 长日志、只 drain 结构化短行——信箱的核心价值（context 防污染）单独成立。

### Phase 1 · 契约 + 结算（1–2 天）
`contract.ts`（parse/check/render/set）+ `settle.ts`（scope diff + DOD + progress/ 落账）。
**验证目标**：一次端到端"立约→手动派发→drain→settle"，settle 抓出一次故意越界的 diff。

### Phase 2 · 档位 + 一键派发（1 天）
`profile.ts` + `sm profile args` + `sm dispatch <cid>`（= worktree? + split + sanitize + start + render + prompt 的复合动词）+ `sm watch <cid>`（把 §6-⑤ 监督循环脚本化，输出分诊建议而非全自动决策——裁决权留给 Supervisor 会话）。

### Phase 3 · headless 模式（2–3 天）
`sm work <cid>`：经 `packages/agent` 直驱（不占 pane），`profileToRunOptions` + **contract → onCanUseTool guard 工厂**：scope 校验前移到工具执行前（deny + message 回流，模型可改道）——护栏从"事后审计"升级为"事前拦截"，超越 Alioth 的旁路强杀。适合无需人看的批量 worker；与 Harbor 跨设备派发天然衔接。

### Phase 4 · 并发治理与防 rot（按需）
多契约并行的 pane/worktree 路由锁（对应 Alioth routing.json）、契约指纹漂移检测、`sm status` 总览面板、信箱 GC 策略。**触发条件：真实出现 ≥3 契约常态并行再做**，否则是过早优化。

### 明确不做
- 不复刻 zellij 驱动层/屏幕 hash 判活（herdr 全覆盖）；
- 不做 TRAE/DSH adapter（不在技术栈内）；
- 不做独立 DECISIONS.md 账本（progress-protocol 已有同构物）；
- 不做 spawn.sh 式环境矩阵（endpoints.yaml + profiles.yaml 覆盖）。

---

## 9. 开放问题

1. **契约是否入 git**：建议入（审计留档、指纹校验有锚点），但含敏感路径的 scope 可能泄露信息——先入，出问题再加 `.sm/contracts/private/`。
2. **多 Supervisor 抢占**：cursor.json 单消费者假设在"用户手动 + Supervisor 会话"双读时会乱——Phase 0 先约定 `peek` 给人、`drain` 给 Supervisor；真冲突再上锁。
3. **herdr `agent prompt` 对长 dispatch 文本的可靠性**（bracketed-paste 大段注入）：Phase 0 实测；不稳则 fallback 为"写临时文件 + prompt 只发文件路径"。
4. **worker 忘记发 result**：分诊表已兜底（idle 无 result → 催报）；若高频发生，考虑在 dispatch 尾注加"不发 result 视为未完成，结算按 failed 处理"的激励条款。
