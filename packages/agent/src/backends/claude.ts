/**
 * Claude Code CLI 后端 —— spawn `claude` + 把 stream-json 归一成统一 Event。
 * 事件映射基于 agent-gateway 的实测(claude 2.1.167)原样移植,新增能力:模型解析
 * 原生接入 endpoints.yaml(@sm/llm),让 `--model` 可以是第三方 Anthropic 兼容端点
 * 的模型名 —— 这是本包吸收 agent-gateway 之外新增的唯一能力,其余 spawn/解析逻辑
 * 保持原样,不顺手"优化",降低移植过程中引入行为漂移的风险。
 */

import * as fs from "node:fs";
import { EventType, type AgentEvent, type Cost } from "../events.js";
import type { Backend, RunOptions, PermissionPolicy } from "../backend.js";
import { streamLines, type StdinChannel } from "./stream-lines.js";
import { loadEndpoints, resolveEndpoint, getApiKey } from "@sm/llm";

// claude CLI 自己认识的裸 tier 别名 —— 这些不查 endpoints.yaml,直通给 CLI 自己
// 的别名表解析(它们不在 endpoints.yaml 的 model 列表里,查了也找不到)。
const NATIVE_TIER_ALIASES = new Set(["opus", "sonnet", "haiku"]);

/**
 * 把 RunOptions.model 解析成 { model, env? }。三种结果:
 *   ① 裸 tier 别名(去掉可能的 "claude-" 前缀后命中)→ 原样传给 --model,无 env。
 *   ② endpoints.yaml 能解析出的名字/限定 id → 返回真实 model 名 + (若非原生
 *      claude 端点)ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY。
 *   ③ 解析失败(如已废弃的 legacy id、CLI 新别名还没进 YAML)→ 原样透传给
 *      --model,让 claude CLI 自己校验 —— 不在这一层生降级用户的请求。
 */
function resolveClaudeModel(model: string | undefined): {
  model: string | undefined;
  env?: Record<string, string>;
} {
  if (!model) return { model: undefined };
  const bare = model.startsWith("claude-") ? model.slice("claude-".length) : model;
  if (NATIVE_TIER_ALIASES.has(bare)) return { model: bare };
  try {
    const { endpoint } = resolveEndpoint(loadEndpoints(), model, "anthropic");
    if (!endpoint.base_url) return { model: endpoint.model };
    const key = getApiKey(endpoint);
    // 代理（super-relay 等）通过 ANTHROPIC_AUTH_TOKEN 认证，同时也设
    // ANTHROPIC_API_KEY 以兼容不同版本的 claude CLI
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: endpoint.base_url,
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_API_KEY: key,
    };
    // provider 级 claude.env 是端点正确性配置（tier 映射/上下文窗口/认证头
    // 差异），跟 endpoint 走，headless 同样生效。endpoints.yaml 顶层全局
    // claude: 块与 args 不进这里——那是交互 launch 偏好（EFFORT_LEVEL、
    // --dangerously-skip-permissions 等），后者会绕过审批链路。
    for (const [k, v] of Object.entries(endpoint.claude?.env ?? {})) {
      env[k] = String(v);
    }
    return { model: endpoint.model, env };
  } catch {
    return { model };
  }
}

export class ClaudeBackend implements Backend {
  readonly name = "claude";

  capabilities(): Record<string, unknown> {
    return {
      workspace: true,
      tools: true,
      mcp: true,
      permissionModes: ["default", "acceptEdits", "bypassPermissions"],
      permissionPolicies: ["readonly", "auto-edit", "full", "default"],
      readonlyEnforcement: "tool-level", // 禁 Write/Edit 工具,但 Bash 仍可能绕过(非 OS sandbox)
      dynamicPermissionCallback: true, // stream-json control protocol (--permission-prompt-tool stdio)
      vision: true,
      toolAllowlist: true,
      streaming: "token", // 真流式逐 token delta
      costInStream: true, // result 直报 total_cost_usd
      structuredOutput: true, // --json-schema
      reportsCapabilityAtRuntime: true, // init 自报 tools/model/permissionMode
      resume: true,
      configDrivenModelSwitch: true, // model 可解析 endpoints.yaml,切第三方 Anthropic 兼容端点
    };
  }

  async *run(prompt: string, opts: RunOptions): AsyncGenerator<AgentEvent> {
    const hasImages = (opts.attachments?.length ?? 0) > 0;
    const interactive = !!opts.onCanUseTool; // 双向交互模式(can_use_tool control protocol)
    const partial = opts.partialMessages !== false; // 默认开逐 token 流

    const resolved = resolveClaudeModel(opts.model);
    // caller 显式传的 env 优先级高于按 model 解析出的 env。
    const spawnEnv: Record<string, string> | undefined =
      resolved.env || opts.env ? { ...resolved.env, ...opts.env } : undefined;

    const args: string[] = [];
    // 交互或有图都走 stdin stream-json;交互模式 prompt 走 stdin user 消息且 stdin 常开。
    // 否则纯文本走 -p。
    if (hasImages || interactive) args.push("-p", "--input-format", "stream-json");
    else args.push("-p", prompt);
    args.push("--output-format", "stream-json", "--verbose");
    if (interactive) args.push("--permission-prompt-tool", "stdio");
    if (opts.askTools && opts.askTools.length > 0) {
      // ask 规则 > 用户 settings 的 allow 规则(实测):强制这些工具走审批,
      // 不然全局 allowlist(裸 "Bash" 等)会静默放行。--settings 是增量 merge,
      // CLAUDE.md/skills 不受影响。
      args.push("--settings", JSON.stringify({ permissions: { ask: opts.askTools } }));
    }
    if (partial) args.push("--include-partial-messages");
    if (resolved.model) args.push("--model", resolved.model);
    if (opts.resume) args.push("--resume", opts.resume);
    if (opts.resume && opts.forkSession) args.push("--fork-session");
    if (opts.persistence === false) args.push("--no-session-persistence");
    if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
    if (opts.settingSources === false) {
      // 砍全局 CLAUDE.md + 默认 MCP 省 context。实测一句 OK $0.28→$0.0015(↓184x)。
      // 等号形式而非 ("--setting-sources", ""):独立的空字符串 argv 在部分 runtime
      // (工作机 bun 实测)会被丢弃,导致后面的 --strict-mcp-config 被当成值吞掉、
      // CLI 报错 0 输出;等号把空值焊死在同一个 argv 里,两种写法 CLI 均实测接受。
      args.push("--setting-sources=", "--strict-mcp-config");
    }
    if (opts.tools && opts.tools !== "all") {
      args.push("--tools", opts.tools.join(",")); // [] → "" 即无工具
    }
    if (opts.workspace) {
      args.push("--add-dir", opts.workspace);
      args.push(...claudePermissionArgs(opts.permission ?? "auto-edit")); // variadic 放末尾
    }

    // vision:把图片 + 文本拼成一条 stream-json user message 从 stdin 喂入
    // 交互模式:prompt 走 stdin user 消息(纯文本),stdin 常开等 control_response。
    let stdinData: string | undefined;
    if (hasImages) {
      const content = [
        ...opts.attachments!.map((a) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: a.mime,
            data: fs.readFileSync(a.path).toString("base64"),
          },
        })),
        { type: "text", text: prompt },
      ];
      stdinData = JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
    } else if (interactive) {
      // 交互模式:先发 initialize 握手,再送 prompt(user 消息),stdin 常开。
      // claude 2.1.207 实测(2026-07-15):不发 initialize 则 --permission-prompt-tool stdio
      // 被静默忽略,headless 对需授权工具直接 auto-deny,can_use_tool 永远不会下发;
      // 握手后 claude 回 control_response(success) 并开始把权限请求路由到 stdio。
      const initHandshake = {
        request_id: "sm_agent_init_1",
        type: "control_request",
        request: { subtype: "initialize", hooks: {} },
      };
      const interactivePrompt = {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: prompt }] },
      };
      stdinData = JSON.stringify(initHandshake) + "\n" + JSON.stringify(interactivePrompt) + "\n";
    }

    let sid: string | null = opts.resume ?? null;
    const stderrSink = { text: "" };
    // 「当前上下文窗口占用」追踪:每条 assistant message 的 input+cache 覆盖更新,
    // 最后一条的值 = 主 agent 本轮结束时的真实 context 占用。result.usage 是
    // 跨迭代累计和(且含同模型 subagent),不能拿来算占用%。
    let lastAssistantContext: number | null = null;
    // 交互通道:streamLines 会把 write/end 通道挂到 .channel 上(交互模式)。
    const interactiveSlot: { channel?: StdinChannel } = {};
    for await (const raw of streamLines("claude", args, {
      cwd: opts.cwd ?? opts.workspace ?? undefined,
      env: spawnEnv,
      stdinData,
      signal: opts.signal,
      stderrSink,
      interactive: interactive ? interactiveSlot : undefined,
    })) {
      let obj: any;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      const t = obj.type;
      // 交互:can_use_tool control_request → 调 onCanUseTool 拿决策 → 回 control_response。
      // claude 在此 block 等响应,期间不发新 stdout 行,故 await 阻塞循环是安全的。
      if (interactive && t === "control_request" && obj.request?.subtype === "can_use_tool") {
        // 回调可能等很久(等用户)。期间若 abort:streamLines 的 onAbort 已 kill 进程,
        // 但 await 还卡在回调里 —— race 一个 abort promise,让循环能及时跳出收尾。
        const callbackP = opts.onCanUseTool!({
          toolName: obj.request.tool_name,
          toolUseId: obj.request.tool_use_id,
          requestId: obj.request_id,
          input: obj.request.input,
        });
        const ABORTED = Symbol("aborted");
        const r = opts.signal
          ? await Promise.race([
              callbackP,
              new Promise<typeof ABORTED>((resolve) => {
                if (opts.signal!.aborted) return resolve(ABORTED);
                opts.signal!.addEventListener("abort", () => resolve(ABORTED), { once: true });
              }),
            ])
          : await callbackP;
        if (r === ABORTED) {
          interactiveSlot.channel?.end();
          return; // 进程已被 onAbort kill,直接收尾退出
        }
        interactiveSlot.channel?.write({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: obj.request_id,
            response: {
              behavior: r.behavior,
              ...(r.updatedInput !== undefined ? { updatedInput: r.updatedInput } : {}),
              ...(r.message ? { message: r.message } : {}),
            },
          },
        });
        continue;
      }
      if (t === "system" && obj.subtype === "init") {
        sid = obj.session_id ?? sid;
        yield ev(this.name, EventType.SessionStart, sid, {
          tools: obj.tools,
          model: obj.model,
          permissionMode: obj.permissionMode,
        });
      } else if (
        t === "stream_event" &&
        obj.event?.type === "content_block_delta" &&
        obj.event?.delta?.type === "text_delta"
      ) {
        const d = obj.event.delta.text; // 真流式逐 token
        if (typeof d === "string" && d.length > 0) {
          yield ev(this.name, EventType.TextChunk, sid, { text: d });
        }
      } else if (
        t === "stream_event" &&
        obj.event?.type === "content_block_delta" &&
        obj.event?.delta?.type === "thinking_delta"
      ) {
        // extended thinking 逐 token(delta.thinking 携文本)。正文前必有 thinking
        // 块(claude 2.x 默认),不发事件上游会把思考期当"卡死"。
        const d = obj.event.delta.thinking;
        if (typeof d === "string" && d.length > 0) {
          yield ev(this.name, EventType.Thinking, sid, { text: d });
        }
      } else if (t === "assistant") {
        // 覆盖式记录本条 assistant 的 context 占用(input+cache_read+cache_creation);
        // 末条即主 agent 当前窗口实际占用,供 result 直报给上游算占用%。
        const au = obj.message?.usage;
        if (au) {
          lastAssistantContext =
            (au.input_tokens ?? 0) +
            (au.cache_read_input_tokens ?? 0) +
            (au.cache_creation_input_tokens ?? 0);
        }
        // text 已走 delta;这里取 tool_use 开始(带 id 供与 done 配对)
        for (const b of obj.message?.content ?? []) {
          if (b.type === "tool_use") {
            yield ev(this.name, EventType.ToolCall, sid, { id: b.id, name: b.name, input: b.input });
          }
        }
      } else if (t === "user") {
        // tool_result:工具执行完。Bash 的 stdout/stderr 在顶层 tool_use_result 隔离,优先用 stdout。
        const tur = obj.tool_use_result;
        for (const b of obj.message?.content ?? []) {
          if (b.type === "tool_result") {
            const stdout = typeof tur?.stdout === "string" ? tur.stdout : null;
            const stderr = typeof tur?.stderr === "string" && tur.stderr ? tur.stderr : null;
            const output = stdout ?? (typeof b.content === "string" ? b.content : null);
            yield ev(this.name, EventType.ToolCallDone, sid, {
              id: b.tool_use_id,
              output,
              stderr,
              isError: !!b.is_error,
            });
          }
        }
      } else if (t === "result") {
        // 交互模式:本轮结束 → 关 stdin 让进程收尾退出。
        if (interactive) interactiveSlot.channel?.end();
        if (obj.is_error) {
          // result 常为空(如 --resume 命中不存在的 session → "No conversation
          // found"),空时退而取 subtype,再退而取缓冲的 stderr,避免吞成无信息量
          // 的 "claude CLI error"。
          const stderrTail = stderrSink.text.trim();
          const message =
            obj.result ||
            obj.subtype ||
            (stderrTail ? stderrTail.slice(-500) : null) ||
            "claude CLI error";
          yield ev(this.name, EventType.Error, sid, { message });
          return;
        }
        const u = obj.usage ?? {};
        const cost: Cost = {
          usd: obj.total_cost_usd ?? null,
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cachedTokens: u.cache_read_input_tokens ?? 0,
          cacheCreation: u.cache_creation_input_tokens ?? 0,
          estimated: false,
          // 末条 assistant 的占用;若整轮没 assistant usage(异常),退回 result 累计
          // 的 input+cache(仍比纯 inputTokens 接近,且不会比真值更离谱)。
          contextTokens:
            lastAssistantContext ??
            ((u.input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0)),
        };
        yield ev(this.name, EventType.Result, sid, { text: obj.result, cost });
      } else if (t === "error") {
        const msg =
          typeof obj.message === "string"
            ? obj.message
            : typeof obj.error === "string"
              ? obj.error
              : "claude error";
        yield ev(this.name, EventType.Error, sid, { message: msg });
      }
    }
  }
}

function claudePermissionArgs(p: PermissionPolicy): string[] {
  switch (p) {
    case "readonly":
      // 工具级:禁文件编辑工具(注:Bash 未禁,理论可绕 —— 见 capability readonlyEnforcement)
      return ["--permission-mode", "default", "--disallowedTools", "Write", "Edit", "MultiEdit", "NotebookEdit"];
    case "auto-edit":
      return ["--permission-mode", "acceptEdits"];
    case "full":
      return ["--dangerously-skip-permissions"];
    case "default":
      // 纯 claude 自己的默认交互式审批,不额外禁工具 —— 保留给 CLIRunner 的历史
      // 兼容路径(self-agent 生产 harness 用的正是这档),与 readonly 语义不同。
      return ["--permission-mode", "default"];
  }
}

function ev(
  backend: string,
  type: EventType,
  sessionId: string | null,
  data: Record<string, unknown>,
): AgentEvent {
  return { type, backend, sessionId, data };
}
