/**
 * 后端契约 —— 移植自 agent-gateway src/backends.ts 的类型部分(RunOptions/Backend/
 * PermissionPolicy),spawn 实现拆到 ./backends/*.ts。
 */

import type { AgentEvent } from "./events.js";

/**
 * 统一权限策略(静态四档)。前三档归一到两家可落地的策略:
 *   readonly  → 不允许改文件   (claude: 禁 Write/Edit 工具)
 *   auto-edit → 自动批准文件编辑 (claude: acceptEdits)
 *   full      → 全放行          (claude: skip-permissions)
 * "default" 是第四档,专为兼容 CLIRunner 的历史行为保留:纯 `--permission-mode
 * default`(claude 自己的默认交互式审批),不像 readonly 那样额外禁工具 —— 两者
 * 语义不同,不能合并(self-agent 生产 harness 用的正是 default,见 runner.ts)。
 * 注:逐次动态回调(canUseTool)需换接入层(stream-json control / app-server),见下方 onCanUseTool。
 */
export type PermissionPolicy = "readonly" | "auto-edit" | "full" | "default";

export interface RunOptions {
  /** 文件工具可达范围(--add-dir + 权限);null/缺省 = 无(纯对话,无文件工具) */
  workspace?: string | null;
  /**
   * workspace 之外显式授权的额外可写目录。Codex 初次 exec 映射为重复
   * `--add-dir`；resume 因 CLI 不接受该 flag，改用等价的 workspace-write
   * writable_roots config override。readonly/default 策略始终忽略此字段。
   */
  additionalWritableDirs?: string[];
  /** 同一 Agent 可见的额外 Repository checkout；主 cwd 仍由 workspace 决定。 */
  additionalWorkspaces?: string[];
  /**
   * Codex workspace-write sandbox 是否允许直接网络访问。缺省 false；readonly
   * 没有对应的安全组合，full 本来就绕过 sandbox，因此这两档忽略该字段。
   */
  sandboxNetworkAccess?: boolean;
  /** 进程工作目录 —— 决定 CLI session transcript 落盘路径,与 workspace 正交。
   * 纯对话需要稳定落盘目录(供 fork resume 校验 + 清理路径一致)却不要文件工具,
   * 故 cwd 独立于 workspace。缺省回退 workspace,再回退继承父进程。 */
  cwd?: string | null;
  /** 替换默认 system prompt */
  systemPrompt?: string | null;
  /** 续会话:上一轮的 session/thread id(多轮) */
  resume?: string | null;
  /** fork 续会话:resume 时创建新 session id 而非复用原始(claude --fork-session)。
   * 仅在 resume 存在时生效。用于树形对话——每个分支 fork 出独立 session,
   * 继承父历史的 KV cache 但互不污染。默认 false(复用原 session,线性续接)。 */
  forkSession?: boolean;
  /** 权限策略,默认 auto-edit(有 workspace 时) */
  permission?: PermissionPolicy;
  /** 工具白名单:[] = 无工具,["WebSearch","WebFetch"] = 仅这些,"all"/缺省 = 后端默认全部 */
  tools?: string[] | "all";
  /** 是否加载项目/全局配置(claude CLAUDE.md)。false = 砍掉省 context。默认 true */
  settingSources?: boolean;
  /**
   * 是否暴露 Runtime 所在机器的 Skills。默认 true，保持通用 Backend 的历史行为。
   * false 时调用方提供的 systemPrompt 仍会生效，但 Claude/Codex 不再向模型暴露
   * 用户目录、项目目录、插件或 Runtime bundled Skills。
   */
  environmentSkills?: boolean;
  /**
   * Runtime 启动时已发现的环境 Skill 名称。Codex 没有单一 safe-mode 参数，
   * environmentSkills=false 时用这份快照禁用显式 `$skill` 注入；Claude 忽略此字段。
   */
  environmentSkillNames?: string[];
  /** 会话持久化。false = 不落盘(claude --no-session-persistence / codex --ephemeral)。默认 true */
  persistence?: boolean;
  /**
   * 模型 —— 后端各自的名字。claude 后端接受三种形式:
   *   ① 裸 tier 别名("opus"/"sonnet"/"haiku"/"claude-opus"/"claude-sonnet"/"claude-haiku")
   *      → 直通给 claude CLI 自己的别名表解析,不查 endpoints.yaml。
   *   ② endpoints.yaml 里的模型名或 "<provider>:<model>" 限定 id(如
   *      "deepseek:deepseek-v4-flash")→ 解析出 base_url/api key,自动注入 env
   *      切到第三方 Anthropic 兼容端点。
   *   ③ 都不匹配 → 原样透传给 --model,让 claude CLI 自己校验(前向兼容 CLI
   *      新增的别名,也是过期 legacy id 的兜底,不在这一层生降级用户的请求)。
   */
  model?: string;
  /** vision 图片附件(已解析的本地路径 + mime) */
  attachments?: { path: string; mime: string }[];
  /** 取消信号 */
  signal?: AbortSignal;
  /** 逐 token 流(claude --include-partial-messages)。默认 true */
  partialMessages?: boolean;
  /** 采样温度。仅裸 API backend(@sm/llm 的 LLMClient)消费;claude/codex 惰性忽略。 */
  temperature?: number;
  /** 要求 JSON 输出(OpenAI response_format)。仅裸 API backend 消费;claude/codex 惰性忽略。 */
  jsonMode?: boolean;
  /**
   * 额外 env 覆盖,merge 进 spawn 的进程 env(caller 提供的优先级高于后端内部按
   * model 解析出的 env)。纯机制字段 —— 这个类型本身不认识 endpoints.yaml/协议,
   * 谁传 env、传哪些 key,策略全留给调用方或后端内部的 model 解析逻辑。
   */
  env?: Record<string, string>;
  /**
   * 强制询问的工具名列表(claude permissions.ask 规则,经 --settings 内联注入)。
   * ask 优先级高于用户 settings.json 的 allow 规则 —— 没有它,机器上全局 allowlist
   * (如裸 "Bash")会让 can_use_tool 永远不触发、审批形同虚设(2026-07-15 实测)。
   * 仅 claude 后端消费;通常与 onCanUseTool + permission:"default" 搭配。
   */
  askTools?: string[];
  /**
   * 双向交互回调:claude 调用需用户输入的工具(AskUserQuestion / 工具权限 / ExitPlanMode)时,
   * 后端走 stream-json control protocol 暂停、调此回调拿决策、原地续上。
   * 传入即开启交互模式(args 加 --permission-prompt-tool stdio + prompt 走 stdin 常开)。
   * 回调可长时间不 resolve(等用户),期间进程活着、stdin 开着 —— 这是预期。
   * 返回 behavior:"deny" 拒绝;updatedInput 覆盖工具入参(如 AskUserQuestion 的 answers map)。
   */
  onCanUseTool?: (req: {
    toolName: string;
    toolUseId: string;
    requestId: string;
    input: unknown;
  }) => Promise<{ behavior: "allow" | "deny"; updatedInput?: unknown; message?: string }>;
}

export interface Backend {
  readonly name: string;
  capabilities(): Record<string, unknown>;
  run(prompt: string, opts: RunOptions): AsyncGenerator<AgentEvent>;
}
