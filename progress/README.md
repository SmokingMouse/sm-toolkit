# SM-Toolkit Progress

## Current Focus

LLM 调用层统一完成。三个日常服务（content-studio / monitor-hub / news-radar）已迁移到 llm CLI → @sm/llm。

## Goals

### Short-term
- [x] 建 monorepo 骨架（bun workspaces + tsconfig）
- [x] @sm/llm：config 加载 + OpenAI/Anthropic provider + retry
- [x] llm CLI：argparse + 直调 API + 交互模式（exec claude）+ 交互式模型选择器
- [x] endpoints.yaml 初始配置（5 endpoint）
- [x] CLI 安装到 PATH + cron 脚本切换验证

### Mid-long
- [x] @sm/agent：CLIRunner + Session + Channel + Orchestrator
- [x] @sm/store：SQLite / PG / Memory 三后端
- [x] @sm/audit：日志 + 定价 + 汇总
- [x] @sm/sandbox：Local + Docker 后端
- [x] @sm/guardrails：runOnce + RateLimiter + CostGate
- [x] SelfAgent 迁移到 @sm/agent（已完成，通过 symlink 依赖 + endpoint 配置替换）
- [x] 日常服务 LLM 调用层统一到 llm CLI（content-studio / monitor-hub / news-radar）
- [ ] agent-gateway 统一配置源（需实际迁移）

## Session Log

### 2026-06-28 — 架构设计
- **Done**: 完成完整技术方案（`~/.claude/plans/silly-discovering-pixel.md`）
  - 讨论确定：Claude Code CLI 为唯一 agent runtime，endpoint 通过 env vars 切换模型
  - 双路径 CLI：有 -p → 直调 API（@sm/llm）；无 -p → exec claude（@sm/agent）
  - 六个共享包：llm / agent / store / audit / sandbox / guardrails
  - 共享 vs 隔离模型：endpoints.yaml 共享，agent.yaml 项目隔离
  - 复用来源索引：agent-gateway / agent-core / SelfAgent 各提取什么
- **Decisions**: 见方案文件
- **Next**: Phase 1 实现——monorepo 骨架 → @sm/llm → CLI → endpoints.yaml → 验证

### 2026-06-28 — 全实现
- **Done**: Phase 1-3 全部代码实现
  - monorepo 骨架：bun workspaces + tsconfig project references
  - @sm/llm：endpoints.yaml 加载 + env file、OpenAI-compat provider（DeepSeek/Gemini/Qwen）、Anthropic provider、retry with linear backoff
  - @sm/store：SessionTable + MessageTable 接口，SQLite（bun:sqlite）/ Postgres / Memory 三后端
  - @sm/audit：AuditLogger（SQLite 后端）、定价表（5 模型）、按 endpoint 汇总查询
  - @sm/agent：CLIRunner（spawn claude + NDJSON 解析 + 事件映射）、SessionStore、Channel 接口、Orchestrator
  - @sm/sandbox：Local + Docker 后端，统一 exec/readFile/writeFile 接口
  - @sm/guardrails：runOnce（幂等）、RateLimiter（滑动窗口）、CostGate（per-call + daily 预算）
  - llm CLI：双路径（有 -p → 直调 API，无 -p → exec claude）、--list / --json / --stream / -s / -f
  - endpoints.yaml：5 endpoint（claude/deepseek-chat/deepseek-reasoner/gemini-flash/qwen-plus）
  - CLI `bun link` 全局安装到 PATH
- **Verified**:
  - `bunx tsc --build` 类型检查通过
  - `llm --list` 显示 5 个 endpoint + key 状态（✓/✗）
  - `llm deepseek-chat -p "say hello"` 直调 API 返回响应
  - `echo "1+1=?" | llm deepseek-chat -s "answer with just the number"` 管道正常
  - `llm deepseek-chat -p "say hi" --json` 含 usage 的 JSON
  - `llm -p "hello"` 用 default endpoint（deepseek-chat）
  - `llm deepseek-chat -p "count 1 to 5" --stream` 流式输出
- **Next**: 实际迁移验证——cron 脚本切换、agent-gateway 统一配置源

### 2026-06-28 — Git 初始化 + SelfAgent 迁移
- **Done**:
  - Git 初始化（.gitignore + 初始提交 ff27363）
  - SelfAgent 替换完成：
    - 删除 `runtime/cli-runner.ts` + `runtime/types.ts`，替换为 @sm/agent CLIRunner + CLIEvent
    - Profile 简化：去掉 model/env 字段，改为引用 endpoints.yaml 的 endpoint 名
    - 新增 `glm` endpoint 到 endpoints.yaml
    - renderer/manager/bot 适配新类型
    - 类型检查通过
  - 依赖方式：node_modules/@sm/ → ~/sdk/packages/ symlink（bun install 后需重建）
- **Decisions**: SelfAgent session/store.ts 保留不迁 @sm/store（ACL 表结构是 self-agent 特有的）
- **Next**: content-studio LLM 配置统一、agent-gateway 能力迁移评估

### 2026-06-28 — CLI 交互式模型选择器
- **Done**: `llm` 无参数在 TTY 下弹出厂商分组选择器（Anthropic/DeepSeek/Google/Alibaba/Zhipu），上下键选模型，Enter 启动 Claude Code session；非 TTY 回退 help
- **Next**: content-studio LLM 配置统一、agent-gateway 能力迁移评估

### 2026-06-29 — LLM 调用层统一
- **Done**:
  - llm CLI 增强：`--temperature` + `--json-mode` flag，provider 名自动解析到首个模型
  - content-studio：`llm/_client.py` 从 requests HTTP 改为 subprocess llm CLI，`_config.py` 精简为纯 TASK_ROUTING dict
  - monitor-hub：`engine.py` judge() 外部模型分支从 ai-legion/agent-gateway 改为 llm CLI，删除 paths.py 中 ASK_PY/AI_LEGION_PY
  - news-radar：`analyze.py` 从 endpoints.yaml 读 Claude 模型名，替代硬编码 claude-opus-4-7
- **Verified**:
  - `llm deepseek -p "hello" --temperature 0.3` ✓
  - `llm deepseek -p '...' --json-mode` 返回 JSON ✓
  - content-studio `chat()` / `chat_json()` 通过 llm CLI 正常调用 ✓
  - monitor-hub `judge()` deepseek 后端通过 llm CLI 正常调用 ✓
  - news-radar 从 endpoints.yaml 解析到 claude-opus-4-6 ✓
- **Scope note**: content-studio `analyzer/vision.py`（多模态/图片）不在日常管道中，未迁移
- **Next**: agent-gateway 能力迁移评估
