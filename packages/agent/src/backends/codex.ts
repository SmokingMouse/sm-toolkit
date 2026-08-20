/**
 * Codex CLI 后端 —— spawn `codex` + 把 jsonl 事件归一成统一 Event。
 * 移植自 agent-gateway src/backends.ts。模型解析对齐 ClaudeBackend:接入
 * endpoints.yaml(@smokingmouse/llm),`--model` 可以是显式标记了 codex 支持的
 * 第三方端点的模型名(见 resolveCodexModel)。其余 spawn/解析逻辑保持移植原样。
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventType, type AgentEvent, type Cost } from "../events.js";
import type { Backend, RunOptions, PermissionPolicy } from "../backend.js";
import { streamLines } from "./stream-lines.js";
import { loadEndpoints, resolveEndpoint, getApiKey } from "@smokingmouse/llm";
import {
  AppServerPreflight,
  codexTransportPlan,
  runViaAppServer,
} from "./codex-app-server.js";

// 示意单价(USD / token),真实值由上游配置注入。
const CODEX_PRICE = { input: 1.25 / 1_000_000, output: 10.0 / 1_000_000 };

/**
 * headless fork —— codex exec 没有 fork 子命令(交互版 `codex fork` 有),用等价
 * 机制模拟:把父 thread 的 rollout jsonl 复制成新 uuid(文件名 + 全文替换 id),
 * 之后 resume 新 id 即是一条继承完整历史、与父线双向隔离的新线(2026-08-04
 * codex 0.146.0 实测:历史继承 ✓ 隔离 ✓;resume 需带与录制一致的 -m,否则
 * model 漂移告警且曾实测触发上游 400)。
 * 找不到父 rollout(id 不存在 / CODEX_HOME 不对 / 父线未持久化)→ throw,由
 * run() fail loud —— 静默退化成线性 resume 会让两个"分支"共写同一 thread,
 * 上游以为隔离实则互相污染,是错误行为不是降级。
 */
export function forkCodexSession(parentId: string, sessionsRoot?: string): string {
  const root =
    sessionsRoot ??
    path.join(process.env.CODEX_HOME ?? path.join(process.env.HOME ?? "", ".codex"), "sessions");
  // rollout 布局 sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl,按文件名匹配 uuid。
  const entries = fs.readdirSync(root, { recursive: true, encoding: "utf8" }) as string[];
  const rel = entries.find(
    (e) => e.includes("rollout-") && e.endsWith(`-${parentId}.jsonl`),
  );
  if (!rel) {
    throw new Error(`rollout for thread ${parentId} not found under ${root}`);
  }
  const src = path.join(root, rel);
  const newId = randomUUID();
  const dst = path.join(path.dirname(src), path.basename(src).replace(parentId, newId));
  fs.writeFileSync(dst, fs.readFileSync(src, "utf8").split(parentId).join(newId));
  return newId;
}

/**
 * 把 RunOptions.model 解析成 { model, configOverrides?, env? },对齐
 * resolveClaudeModel 的三分支语义:
 *   ① endpoints.yaml 解析出的端点带 codex.wire_api="responses" 显式标记 →
 *      真实 model 名 + `-c model_provider(s)` 注入参数 + api key env。
 *   ② 解析出的端点无 codex 标记(chat-only 的 openai_url 等)→ 原样透传,
 *      走用户全局 ~/.codex/config.toml —— codex 0.146.0 起 wire_api="chat"
 *      已废弃(openai/codex#7782),chat 端点静默注入只会 400,必须 opt-in。
 *   ③ 解析失败(codex 原生模型名如 gpt-5.5、CLI 新别名)→ 原样透传给 -m,
 *      让 codex CLI 自己校验 —— 不在这一层生降级用户的请求。
 * 注入用固定 provider id "sm_endpoint",经 `-c` 与全局 config.toml merge,
 * 不落盘不污染用户配置;鉴权走 env_key 指向 endpoints.yaml 的 api_key_env,
 * key 值显式放进 spawn env(2026-08-04 codex 0.146.0 正负向实测均通过)。
 *
 * 2026-08-05 细分失败路径 —— 此前三种"没走注入"全被一个 catch 吞成静默
 * 透传,叠加下面的登录闸后,机器间 yaml 未同步 / key 缺失都会伪装成
 * 「codex 未登录」(trellis 二号机实锅):
 *   degraded:端点在 yaml 里但没标记 codex 支持 → 仍透传(2026-08-04 定的
 *     opt-in 语义不变),但把原因带出去,登录闸失败时拼进报错;
 *   fatal:端点已标记注入、key 却缺失 → 直接报错。配置自相矛盾时静默换一条
 *     鉴权路线,是把配置错误变成别的症状,不是降级。
 */
function resolveCodexModel(model: string | undefined): {
  model: string | undefined;
  configOverrides?: string[];
  env?: Record<string, string>;
  /** 端点在 yaml 里但未走注入的原因(诊断用;登录闸失败时拼进错误信息)。 */
  degraded?: string;
  /** 配置矛盾(已标记注入但 key 缺失)→ run() 直接报错,不 spawn。 */
  fatal?: string;
} {
  if (!model) return { model: undefined };
  let endpoint;
  try {
    ({ endpoint } = resolveEndpoint(loadEndpoints(), model, "openai"));
  } catch {
    // 不在 yaml(codex 原生模型名 / 本机没有 yaml)→ 原样透传给 -m,让 codex
    // 自己校验 —— 不在这一层生降级用户的请求。
    return { model };
  }
  if (!endpoint.base_url) return { model: endpoint.model };
  if (endpoint.codex?.wire_api !== "responses") {
    return {
      model,
      degraded:
        `模型「${model}」命中的 endpoints.yaml 端点未标记 codex 支持` +
        `(codex: { wire_api: responses }),本次按原生模式透传 —— ` +
        `若该端点在别的机器上标记过,多半是这台机器的 yaml 没同步`,
    };
  }
  let key: string;
  try {
    key = getApiKey(endpoint);
  } catch (e) {
    return {
      model,
      fatal:
        `模型「${model}」的端点已标记 codex 注入,但 key 缺失:` +
        `${e instanceof Error ? e.message : String(e)}` +
        `(本机 ~/.agent-gateway.env 或 endpoints.yaml 的 env_file 未配这台机器的 key)`,
    };
  }
  const p = "model_providers.sm_endpoint";
  return {
    model: endpoint.model,
    configOverrides: [
      "-c", `model_provider="sm_endpoint"`,
      "-c", `${p}.name="sm-endpoint"`,
      "-c", `${p}.base_url="${endpoint.base_url}"`,
      "-c", `${p}.env_key="${endpoint.api_key_env}"`,
      "-c", `${p}.wire_api="${endpoint.codex.wire_api}"`,
    ],
    env: { [endpoint.api_key_env]: key },
  };
}

export interface CodexBackendOptions {
  /**
   * 传输层选择。缺省 = app-server 优先(逐 token 流 + 原生 fork/interrupt),
   * preflight 失败或选项组合不支持时自动回退 exec;"exec" = 强制走老路径
   * (行为与 0.5.x 完全一致,留作兼容逃生舱)。
   */
  transport?: "app-server" | "exec";
}

export class CodexBackend implements Backend {
  readonly name = "codex";

  constructor(private readonly options: CodexBackendOptions = {}) {}

  capabilities(): Record<string, unknown> {
    const execForced = this.options.transport === "exec";
    return {
      workspace: true,
      tools: true,
      mcp: true,
      sandboxModes: ["read-only", "workspace-write", "full-access"],
      permissionPolicies: ["readonly", "auto-edit", "full"],
      readonlyEnforcement: "os-sandbox", // OS 级只读,Bash 也无法绕过
      // app-server transport 已接 onCanUseTool:permission "default" + 回调在场时
      // approvalPolicy=untrusted,commandExecution/fileChange 逐项走回调裁决
      // (可信白名单命令 codex 自动放行)。exec 无 stdio 审批协议,强制 exec 时为 false。
      dynamicPermissionCallback: !execForced,
      vision: true, // --image FILE / localImage input
      toolAllowlist: false, // codex 无工具白名单(sandbox 决定可达)
      // app-server transport 走 item/agentMessage/delta 逐 token;exec --json
      // 的输出层有意丢 delta(2026-08-18 源码级核实),故强制 exec 时退回 block。
      // "token" 档下若 preflight 回退 exec,单次 run 实际表现为 block(降级不失败)。
      streaming: execForced ? "block" : "token",
      transport: execForced ? "exec" : "app-server+exec-fallback",
      costInStream: false, // 只给 token,$ 需上游按单价估
      structuredOutput: true, // --output-schema(经 extraArgs,走 exec 路径)
      reportsCapabilityAtRuntime: false, // thread.started 不含 tools/model
      resume: true,
      // fork:app-server 用原生 thread/fork;exec 由 rollout copy 模拟
      // (forkCodexSession)。两者共用同一份 rollout 存储,id 完全互通(2026-08-18 实测)。
      forkSession: true,
      // model 可解析 endpoints.yaml,切显式标记的第三方 Responses 端点(-c 注入);
      // 约束:codex ≥0.146 只认 wire_api="responses",chat-only 端点不可用。
      configDrivenModelSwitch: true,
    };
  }

  async *run(prompt: string, opts: RunOptions): AsyncGenerator<AgentEvent> {
    // Codex CLI 没有 Claude 的 settings source 或首条 stream-json 消息概念；
    // settingSources（含数组）与 delayFirstMessageMs 按 temperature/jsonMode 的
    // 跨 backend 契约惰性忽略，不伪造等价行为。
    const resolved = resolveCodexModel(opts.model);
    // 配置矛盾(端点标记了注入但 key 缺失)→ 报真实原因,不 spawn。
    if (resolved.fatal) {
      yield ev(this.name, EventType.Error, null, { message: resolved.fatal });
      return;
    }
    // 登录检查(便宜 ~50ms):给清晰可操作错误,避免浪费一次必 401 的往返。
    // 注入端点时跳过 —— 鉴权走 env_key(API key),不依赖 ChatGPT 登录态。
    if (!resolved.configOverrides) {
      const login = spawnSync("codex", ["login", "status"], { encoding: "utf8", timeout: 5000 });
      if (login.status !== 0) {
        // 报错必须把解析降级的原因带上:透传模式走的是 ChatGPT 登录态,而用户
        // 以为自己选了第三方端点 —— 只喊「未登录」会把配置漂移伪装成登录问题。
        const hint =
          resolved.degraded ??
          "若期望走第三方端点(不依赖 ChatGPT 登录),对应 endpoints.yaml 端点需带 codex: { wire_api: responses } 标记,且本机配有它的 key。";
        yield ev(this.name, EventType.Error, null, {
          message: `codex 未登录(ChatGPT)。原生模式需先在终端运行 \`codex login\`。\n${hint}`,
        });
        return;
      }
    }

    // caller 显式传的 env 优先级高于按 model 解析出的 env(对齐 ClaudeBackend)。
    const spawnEnv: Record<string, string> | undefined =
      resolved.env || opts.env ? { ...resolved.env, ...opts.env } : undefined;

    // codex 无 --system-prompt,把它 inline 到 prompt 前(read-only sandbox 时主要影响风格)。
    // app-server 有原生 baseInstructions 字段但刻意不用 —— 换 transport 只换传输,
    // 不换 prompt 语义(baseInstructions 是整体替换 codex 基础指令,行为差异大)。
    const finalPrompt = opts.systemPrompt ? `${opts.systemPrompt}\n\n---\n\n${prompt}` : prompt;
    const policy: PermissionPolicy = opts.permission ?? (opts.workspace ? "auto-edit" : "readonly");

    // ---- transport 分派:app-server 优先(逐 token 流),preflight 失败回退 exec ----
    // 契约:AppServerPreflight 仅在零事件产出前抛,回退不会让模型跑两遍;
    // turn 已开跑后的错误在 runViaAppServer 内部以 Error 事件产出,不会到这里。
    if (codexTransportPlan(this.options.transport, opts) === "app-server") {
      try {
        yield* runViaAppServer({
          backend: this.name,
          prompt: finalPrompt,
          opts,
          policy,
          model: resolved.model,
          configOverrides: resolved.configOverrides,
          env: spawnEnv,
        });
        return;
      } catch (e) {
        if (!(e instanceof AppServerPreflight)) throw e;
        // 权限确认模式(default + 回调)依赖 app-server 审批协议 —— 回退 exec 会让
        // 该跑审批的命令在沙箱里静默直跑,是安全语义降级,必须 fail loud。
        if (policy === "default" && opts.onCanUseTool) {
          yield ev(this.name, EventType.Error, null, {
            message:
              `codex 权限确认模式需要 app-server 支持,但 preflight 失败:${e.message}。` +
              `请升级 codex CLI(需 ≥0.147 的 v2 协议),或关闭该会话的权限确认。`,
          });
          return;
        }
        // 其余场景:老版本 codex / spawn 失败等 → 静默降级 exec(block 流)。
      }
    }

    // ---- exec 路径(0.5.x 原实现,兼容逃生舱 + 回退目标) ----
    // fork 续会话:headless 模拟 claude --fork-session(rollout copy,见 forkCodexSession)。
    // 失败必须 fail loud,绝不静默线性 resume(那会让树形分支互相污染)。
    let resumeId = opts.resume ?? null;
    if (resumeId && opts.forkSession) {
      try {
        resumeId = forkCodexSession(resumeId);
      } catch (e) {
        yield ev(this.name, EventType.Error, null, {
          message: `codex fork 失败(线程 ${resumeId}):${e instanceof Error ? e.message : String(e)}`,
        });
        return;
      }
    }
    const args = buildCodexArgs({
      policy,
      ephemeral: opts.persistence === false,
      model: resolved.model,
      configOverrides: resolved.configOverrides,
      resume: resumeId,
      additionalWritableDirs: opts.additionalWritableDirs ?? [],
      sandboxNetworkAccess: opts.sandboxNetworkAccess === true,
      imagePaths: (opts.attachments ?? []).map((a) => a.path),
      prompt: finalPrompt,
      additionalDirs: opts.additionalWorkspaces ?? [],
      environmentSkills: opts.environmentSkills,
      environmentSkillNames: opts.environmentSkillNames,
    });

    let sid: string | null = resumeId;
    const finalText: string[] = [];
    // 按 item id 记已转发长度,防 item.updated/completed 对同一条重复 emit。
    const emittedLen = new Map<string, number>();
    // 已发过 ToolCall 的 item id(item.started 先到;某些 build 只发 completed,
    // 届时在 completed 补发 start 再发 done,保证上游永远能按 id 配对)。
    const startedTools = new Set<string>();
    let anonToolSeq = 0;
    // stderr 兜底(对齐 ClaudeBackend):CLI 报错而事件流无信息量时拼 stderr 尾部,
    // 避免只剩 generic "codex error"。
    const stderrSink = { text: "" };

    for await (const raw of streamLines("codex", args, {
      cwd: opts.cwd ?? opts.workspace ?? undefined,
      env: spawnEnv,
      signal: opts.signal,
      stderrSink,
    })) {
      let obj: any;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      const t = obj.type;
      if (t === "thread.started") {
        sid = obj.thread_id ?? sid;
        yield ev(this.name, EventType.SessionStart, sid, {
          tools: null,
          // thread.started 不自报 model;注入端点时后端确知实际命中的 model,
          // 回填之。透传场景仍 null(全局 config.toml 可能改写,不冒充事实)。
          model: resolved.configOverrides ? (resolved.model ?? null) : null,
          note: "capability from static declaration",
        });
      } else if ((t === "item.updated" || t === "item.completed") && obj.item?.type === "agent_message") {
        // codex agent_message 整段(无 per-token);newer build 可能 item.updated 增量,按 id dedup。
        const id = obj.item.id ?? "default";
        const text = obj.item.text ?? "";
        const prev = emittedLen.get(id) ?? 0;
        if (text.length > prev) {
          const delta = text.slice(prev);
          finalText.push(delta);
          yield ev(this.name, EventType.TextChunk, sid, { text: delta });
          emittedLen.set(id, text.length);
        }
      } else if ((t === "item.updated" || t === "item.completed") && obj.item?.type === "reasoning") {
        // reasoning item = codex 的思考摘要。不发的话高 effort 下上游整个思考期
        // 零反馈(与 claude Thinking 同一个失明问题)。按 id 长度 diff 去重。
        const id = obj.item.id ?? "reasoning";
        const text = obj.item.text ?? "";
        const prev = emittedLen.get(id) ?? 0;
        if (text.length > prev) {
          yield ev(this.name, EventType.Thinking, sid, { text: text.slice(prev) });
          emittedLen.set(id, text.length);
        }
      } else if (isToolItem(obj.item?.type) && (t === "item.started" || t === "item.completed")) {
        // 工具生命周期:started 发 ToolCall(带 id 供配对),completed 发 ToolCallDone
        // (带输出/错误)。此前只在 completed 发一条无 id 的 ToolCall——上游按 id
        // 去重会把整轮工具吞到只剩一条,且永远 running。
        const item = obj.item;
        const id: string = item.id ?? `codex-tool-${anonToolSeq++}`;
        const call = toolCallFields(item);
        if (!startedTools.has(id)) {
          startedTools.add(id);
          yield ev(this.name, EventType.ToolCall, sid, { id, ...call, parentToolUseId: null });
        }
        if (t === "item.completed") {
          yield ev(this.name, EventType.ToolCallDone, sid, {
            id,
            output: toolOutput(item),
            stderr: null, // codex aggregated_output 不拆 stdout/stderr
            isError:
              item.status === "failed" ||
              (typeof item.exit_code === "number" && item.exit_code !== 0),
          });
        }
      } else if (t === "item.completed" && obj.item?.type === "file_change") {
        yield ev(this.name, EventType.FileChange, sid, { changes: obj.item.changes });
      } else if (t === "turn.completed") {
        const u = obj.usage ?? {};
        const totalIn = u.input_tokens ?? 0,
          cached = u.cached_input_tokens ?? 0;
        const netIn = Math.max(0, totalIn - cached); // 对齐 Anthropic 语义:input 不含 cache 命中
        const cost: Cost = {
          usd: Number((netIn * CODEX_PRICE.input + (u.output_tokens ?? 0) * CODEX_PRICE.output).toFixed(6)),
          inputTokens: netIn,
          outputTokens: u.output_tokens ?? 0,
          cachedTokens: cached,
          cacheCreation: 0, // codex 不报
          estimated: true,
          // codex 是单轮 block(无 claude 那种跨迭代累计),整轮输入即当前占用。
          contextTokens: totalIn,
        };
        yield ev(this.name, EventType.Result, sid, { text: finalText.join(""), cost });
        return;
      } else if (t === "turn.failed") {
        const stderrTail = stderrSink.text.trim();
        const message =
          obj.error?.message || (stderrTail ? stderrTail.slice(-500) : null) || "codex turn failed";
        yield ev(this.name, EventType.Error, sid, { message });
        return;
      } else if (t === "error") {
        // "Reconnecting..." 是瞬态重连,吞掉(解决 normalizer 噪音);其余才报。
        const msg = (obj.message as string) ?? "";
        if (!msg.toLowerCase().startsWith("reconnecting")) {
          const stderrTail = stderrSink.text.trim();
          yield ev(this.name, EventType.Error, sid, {
            message: msg || (stderrTail ? stderrTail.slice(-500) : "codex error"),
          });
          return;
        }
      }
    }
  }
}

// exec --json 里代表「一次工具调用」的 item 类型(file_change 单独走 FileChange)。
function isToolItem(t: unknown): t is string {
  return t === "command_execution" || t === "mcp_tool_call" || t === "web_search";
}

function toolCallFields(item: any): { name: string; input: unknown } {
  if (item.type === "command_execution") return { name: "shell", input: item.command };
  if (item.type === "mcp_tool_call") return { name: item.tool ?? "mcp", input: item.arguments };
  return { name: "web_search", input: item.query ?? null };
}

function toolOutput(item: any): string | null {
  if (item.type === "command_execution")
    return typeof item.aggregated_output === "string" ? item.aggregated_output : null;
  if (item.type === "mcp_tool_call")
    return item.result !== undefined ? JSON.stringify(item.result) : null;
  return null;
}

export function buildCodexArgs(o: {
  policy: PermissionPolicy;
  ephemeral: boolean;
  model?: string;
  /** resolveCodexModel 产出的 `-c` 端点注入参数;resume parser 同样接受 -c(0.144.2 实测) */
  configOverrides?: string[];
  resume: string | null;
  additionalWritableDirs: string[];
  sandboxNetworkAccess: boolean;
  imagePaths: string[];
  prompt: string;
  additionalDirs?: string[];
  environmentSkills?: boolean;
  environmentSkillNames?: string[];
}): string[] {
  const common = ["--json", "--skip-git-repo-check", ...(o.configOverrides ?? [])];
  if (o.environmentSkills === false) {
    common.push(...codexEnvironmentSkillArgs(o.environmentSkillNames));
  }
  if (o.model) common.push("-m", o.model);
  // `codex exec resume` 当前没有 --add-dir；新会话才显式开放额外 Repository。
  if (!o.resume) {
    for (const directory of o.additionalDirs ?? []) common.push("--add-dir", directory);
  }
  const imageArgs = o.imagePaths.flatMap((p) => ["--image", p]);
  // `--image <FILE>...` 是可变长参数；不显式结束 options，Clap 会把尾部 prompt
  // 一并吃成图片路径，随后 Codex 回退读 stdin 并报 "No prompt provided"。
  // 无图片时也保留分隔符，避免以 `-` 开头的 prompt 被误解析成 flag。
  const positionalPrompt = ["--", o.prompt];
  // default/readonly 都不能仅凭调用方传参扩大额外可写范围；Executor 另有领域闸，这里再做参数层防御。
  const writableDirs =
    o.policy === "auto-edit" || o.policy === "full" ? [...new Set(o.additionalWritableDirs)] : [];
  // 只对 workspace-write 生效。显式写 false，避免 Runtime 默认值或旧 thread
  // 配置漂移；readonly 不通过切换 workspace-write 来换网络，full 已绕过 sandbox。
  const workspaceNetwork =
    o.policy === "auto-edit" || o.policy === "default"
      ? ["-c", `sandbox_workspace_write.network_access=${o.sandboxNetworkAccess ? "true" : "false"}`]
      : [];

  if (o.resume) {
    // codex 0.144.2 实测：resume parser 不接受 --sandbox/--add-dir，但接受 -c。
    // 用等价 config override 保留 readonly/workspace-write 边界，绝不为续会话退化成 full access。
    const sandbox =
      o.policy === "full"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : o.policy === "readonly"
          ? ["-c", 'sandbox_mode="read-only"']
          : [
              "-c",
              'sandbox_mode="workspace-write"',
              ...workspaceNetwork,
              ...(writableDirs.length > 0
                ? ["-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(writableDirs)}`]
                : []),
            ];
    // resume 也吃 --ephemeral(0.142.2 实测在 flag 清单里)——不加会让
    // persistence:false 的承诺在多轮场景被静默违背。
    const ephemeral = o.ephemeral ? ["--ephemeral"] : [];
    return ["exec", "resume", o.resume, ...common, ...ephemeral, ...sandbox, ...imageArgs, ...positionalPrompt];
  }
  const sandbox =
    o.policy === "readonly"
      ? ["--sandbox", "read-only"]
      : o.policy === "full"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : ["--sandbox", "workspace-write"]; // auto-edit(以及兼容 default,codex 无独立 default 档)
  const additionalWritableDirs = writableDirs.flatMap((dir) => ["--add-dir", dir]);
  const ephemeral = o.ephemeral ? ["--ephemeral"] : [];
  return [
    "exec",
    ...common,
    ...ephemeral,
    ...sandbox,
    ...workspaceNetwork,
    ...additionalWritableDirs,
    ...imageArgs,
    ...positionalPrompt,
  ];
}

/**
 * Codex 没有 Claude `--safe-mode` 的单一等价项：
 * - ignore user config/rules，阻止本机配置和 exec policy 进入 Run；
 * - 关闭 plugins，阻止插件携带的 Skills；
 * - 不生成自动 Skills catalog；
 * - 对启动时发现的名字逐一 disabled，阻止用户在 Issue prompt 中用 `$skill` 显式注入。
 *
 * 不使用 `skills.bundled.enabled=false`：Codex 0.144.x 会删除共享
 * `$CODEX_HOME/skills/.system`，会影响 Harbor 之外的并发 Codex 会话。
 */
export function codexEnvironmentSkillArgs(skillNames: string[] = []): string[] {
  const args = [
    "--ignore-user-config",
    "--ignore-rules",
    "--disable",
    "plugins",
    "-c",
    "skills.include_instructions=false",
  ];
  const names = [...new Set(skillNames.map((name) => name.trim()).filter(Boolean))].sort();
  if (names.length > 0) {
    const rules = names
      .map((name) => `{ name = ${JSON.stringify(name)}, enabled = false }`)
      .join(", ");
    args.push("-c", `skills.config=[${rules}]`);
  }
  return args;
}

function ev(
  backend: string,
  type: EventType,
  sessionId: string | null,
  data: Record<string, unknown>,
): AgentEvent {
  return { type, backend, sessionId, data };
}
