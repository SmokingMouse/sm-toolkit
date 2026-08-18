/**
 * codex app-server transport —— per-run spawn `codex app-server`(stdio JSON-RPC v2),
 * 换取 exec --json 拿不到的三样东西:逐 token 流(item/agentMessage/delta)、原生
 * thread/fork(替代 rollout copy)、turn/interrupt(正经中断语义)。
 *
 * 背景(2026-08-18 调研,详见 progress/decisions.md 当日条目):
 *   - exec --json 的输出层**有意丢弃** delta(event_processor_with_jsonl_output.rs
 *     把所有 delta 通知落进 `_ => Running` 兜底),没有任何 flag 能打开;
 *   - 0.147 起 TUI/exec 自己也是 app-server 客户端,v1 协议(newConversation 族)
 *     已整体移除,v2 是唯一表面;官方 Python SDK 即 app-server stdio 客户端;
 *   - 本机实测:app-server thread/resume 可直接续 exec 录的 rollout(同一存储),
 *     两种 transport 的会话 id 完全互通,切换不孤儿化存量会话。
 *
 * 契约:preflight(spawn → initialize → thread/* → turn/start 响应)失败抛
 * AppServerPreflight 且保证**零事件已产出**,由 CodexBackend 静默回退 exec 路径;
 * turn/start 响应之后模型已开跑,一切错误以 Error 事件产出,绝不回退(否则同一
 * prompt 会被跑两遍)。
 *
 * 协议形状全部依据 `codex app-server generate-json-schema` 导出的 v2 schema
 * (2026-08-18, codex 0.147.0)逐字段核对;v2 的 item type/status 是 camelCase
 * (commandExecution/inProgress),与 exec --json 的 snake_case 不同,不能复用
 * exec 的判别函数。
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { EventType, type AgentEvent, type Cost } from "../events.js";
import type { RunOptions, PermissionPolicy } from "../backend.js";

// 与 exec 路径同一份示意单价(codex 不直报 $,按 token 估)。
const PRICE = { input: 1.25 / 1_000_000, output: 10.0 / 1_000_000 };

/** preflight 阶段(未产出任何事件)失败 —— caller 可安全回退 exec。 */
export class AppServerPreflight extends Error {
  constructor(stage: string, cause: unknown) {
    super(`codex app-server preflight failed at ${stage}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "AppServerPreflight";
  }
}

/**
 * transport 决策(纯函数,单测覆盖)。返回 "exec" 的都是 app-server 路径 v1
 * 尚不支持/未验证的选项组合 —— 宁可整跑降级 block 流,不做行为漂移:
 *   - environmentSkills=false:--ignore-user-config/--ignore-rules 是否作用于
 *     app-server 子命令未验证(harbor 依赖该语义,不能赌);
 *   - extraArgs:语义上是 exec CLI 的逃生舱(--output-schema 等),对 app-server
 *     spawn 无意义甚至有害;
 *   - persistence=false + resume:`codex exec resume --ephemeral` 有对应物,
 *     thread/resume 无 ephemeral 参数。
 */
export function codexTransportPlan(
  transport: "app-server" | "exec" | undefined,
  opts: Pick<RunOptions, "environmentSkills" | "extraArgs" | "persistence" | "resume">,
): "app-server" | "exec" {
  if (transport === "exec") return "exec";
  if (opts.environmentSkills === false) return "exec";
  if (opts.extraArgs?.length) return "exec";
  if (opts.persistence === false && opts.resume) return "exec";
  return "app-server";
}

/**
 * PermissionPolicy → thread/start 的 sandbox/approvalPolicy/config。
 * 与 buildCodexArgs 的 flag 映射逐档对齐(这是 2026-08-04 决策点名的安全红线,
 * 单测 + e2e 双向对照):
 *   readonly  → sandbox "read-only"
 *   auto-edit/default → "workspace-write" + config.sandbox_workspace_write
 *     (network_access 显式写、writable_roots 仅此两档生效 —— 同 exec)
 *   full      → "danger-full-access"(exec 的 --dangerously-bypass 等价物)
 * approvalPolicy 恒为 "never":非交互 parity —— exec 从不弹审批,v1 的
 * app-server 路径也不弹(动态审批回调是后续独立 phase,需上游 dispatcher 配合)。
 */
export function appServerThreadOptions(o: {
  policy: PermissionPolicy;
  additionalWritableDirs: string[];
  sandboxNetworkAccess: boolean;
}): {
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "never";
  config?: Record<string, unknown>;
} {
  if (o.policy === "readonly") return { sandbox: "read-only", approvalPolicy: "never" };
  if (o.policy === "full") return { sandbox: "danger-full-access", approvalPolicy: "never" };
  // auto-edit / default(codex 无独立 default 档,同 exec 归到 workspace-write)
  const writable = [...new Set(o.additionalWritableDirs)];
  return {
    sandbox: "workspace-write",
    approvalPolicy: "never",
    config: {
      sandbox_workspace_write: {
        network_access: o.sandboxNetworkAccess === true,
        ...(writable.length > 0 ? { writable_roots: writable } : {}),
      },
    },
  };
}

/** v2 ThreadItem → ToolCall 的 {name, input};非工具 item 返回 null。
 * 命名与 exec 路径对齐(shell/mcp 工具名/web_search),collab 多 agent 与
 * dynamicToolCall 是 app-server 才可见的新品类,原样透传工具名。 */
export function appServerToolCall(item: Record<string, unknown>): { name: string; input: unknown } | null {
  switch (item.type) {
    case "commandExecution":
      return { name: "shell", input: item.command };
    case "mcpToolCall":
      return { name: String(item.tool ?? "mcp"), input: item.arguments };
    case "webSearch":
      return { name: "web_search", input: item.query ?? null };
    case "collabAgentToolCall":
      // codex multi_agent(0.147 stable):spawn/wait/send 等协作工具。
      return {
        name: String(item.tool ?? "collab"),
        input: {
          prompt: item.prompt ?? null,
          receiverThreadIds: item.receiverThreadIds ?? [],
          model: item.model ?? null,
        },
      };
    case "dynamicToolCall":
      return { name: String(item.tool ?? "tool"), input: item.arguments };
    case "imageGeneration":
      return { name: "image_generation", input: item.revisedPrompt ?? null };
    default:
      return null; // agentMessage/reasoning/plan/fileChange/subAgentActivity 等各有去处
  }
}

/** v2 ThreadItem(completed)→ ToolCallDone 的 {output, isError}。 */
export function appServerToolResult(item: Record<string, unknown>): {
  output: string | null;
  isError: boolean;
} {
  const status = String(item.status ?? "");
  const failed = status === "failed" || status === "declined";
  if (item.type === "commandExecution") {
    return {
      output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : null,
      isError: failed || (typeof item.exitCode === "number" && item.exitCode !== 0),
    };
  }
  if (item.type === "mcpToolCall") {
    return {
      output: item.result !== undefined && item.result !== null ? JSON.stringify(item.result) : null,
      isError: failed || item.error != null,
    };
  }
  if (item.type === "imageGeneration") {
    return { output: typeof item.savedPath === "string" ? item.savedPath : null, isError: failed };
  }
  return { output: null, isError: failed };
}

interface TokenBreakdown {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

/**
 * thread/tokenUsage/updated → Cost。语义对齐 exec 路径:inputTokens 含 cache 命中
 * (e2e 实测核对),净 input = input - cached;contextTokens 用 last(最后一次模型
 * 请求)的 gross input —— 比 exec 只有 turn 总量时的近似更准。
 */
export function appServerCost(u: { total?: TokenBreakdown; last?: TokenBreakdown } | null): Cost {
  const total = u?.total ?? {};
  const totalIn = total.inputTokens ?? 0;
  const cached = total.cachedInputTokens ?? 0;
  const netIn = Math.max(0, totalIn - cached);
  const out = total.outputTokens ?? 0;
  return {
    usd: Number((netIn * PRICE.input + out * PRICE.output).toFixed(6)),
    inputTokens: netIn,
    outputTokens: out,
    cachedTokens: cached,
    cacheCreation: total.cacheWriteInputTokens ?? 0,
    estimated: true,
    contextTokens: u?.last?.inputTokens ?? (totalIn || null),
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio 底盘
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** 无界 push→pull 队列:JSON-RPC 回调世界 → async generator 世界的桥。 */
class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((v: T | null) => void)[] = [];
  private closed = false;
  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w(item);
    else this.items.push(item);
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w(null);
  }
  /** null = 队列已关(进程退出)。 */
  next(): Promise<T | null> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.closed) return Promise.resolve(null);
    return new Promise((res) => this.waiters.push(res));
  }
}

interface Rpc {
  child: ChildProcess;
  request: (method: string, params: Json, timeoutMs?: number) => Promise<Json>;
  notify: (method: string, params?: Json) => void;
  notifications: AsyncQueue<{ method: string; params: Json }>;
  stderrTail: () => string;
  kill: () => void;
}

const PREFLIGHT_TIMEOUT_MS = 30_000; // thread/start 含 MCP 启动,本机实测 ~1.6s,给足余量

function startRpc(o: { args: string[]; cwd?: string; env?: Record<string, string> }): Rpc {
  const child = spawn("codex", o.args, {
    cwd: o.cwd,
    env: o.env ? { ...process.env, ...o.env } : undefined,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => {
    stderr = (stderr + c.toString()).slice(-4096);
  });

  let seq = 0;
  const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  const notifications = new AsyncQueue<{ method: string; params: Json }>();

  const write = (obj: Json) => {
    if (child.stdin?.writable) child.stdin.write(JSON.stringify(obj) + "\n");
  };

  // 审批类 server→client 请求自动拒答:approvalPolicy=never 下不应出现,真出现
  // (granular 语义漂移/未来新增)时拒掉比挂死等待强 —— 挂死是最坏结局。
  const respondToServerRequest = (id: unknown, method: string) => {
    const reply = (result: Json) => write({ jsonrpc: "2.0", id: id as number, result });
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return reply({ decision: "decline" });
      case "execCommandApproval": // v1 遗留双胞胎,shape 不同
      case "applyPatchApproval":
        return reply({ decision: "denied" });
      case "item/permissions/requestApproval":
        return reply({ permissions: {} });
      case "item/tool/requestUserInput":
        return reply({ answers: {} });
      default:
        return write({
          jsonrpc: "2.0",
          id: id as number,
          error: { code: -32601, message: `client does not support ${method}` },
        });
    }
  };

  const rl = readline.createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const s = line.trim();
    if (!s) return;
    let msg: Json;
    try {
      msg = JSON.parse(s) as Json;
    } catch {
      return; // 非 JSON 噪音
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id as number);
      if (!p) return;
      pending.delete(msg.id as number);
      if (msg.error !== undefined) {
        const e = msg.error as { code?: number; message?: string };
        p.reject(new Error(`${e.message ?? "rpc error"} (code ${e.code ?? "?"})`));
      } else {
        p.resolve(msg.result as Json);
      }
      return;
    }
    if (msg.id !== undefined && typeof msg.method === "string") {
      respondToServerRequest(msg.id, msg.method);
      return;
    }
    if (typeof msg.method === "string") {
      notifications.push({ method: msg.method, params: (msg.params ?? {}) as Json });
    }
  });

  child.on("close", () => {
    notifications.close();
    const err = new Error("codex app-server exited");
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });
  child.on("error", (e) => {
    // spawn 失败(codex 不在 PATH 等):close 可能不来,主动收尾。
    notifications.close();
    for (const [, p] of pending) p.reject(e);
    pending.clear();
  });

  return {
    child,
    notifications,
    stderrTail: () => stderr.trim(),
    notify: (method, params) => write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
    request: (method, params, timeoutMs = PREFLIGHT_TIMEOUT_MS) =>
      new Promise<Json>((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        write({ jsonrpc: "2.0", id, method, params });
      }),
    kill: () => {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export interface AppServerRunContext {
  backend: string;
  /** systemPrompt 已 inline 的最终 prompt(与 exec 路径同一份构造)。 */
  prompt: string;
  opts: RunOptions;
  policy: PermissionPolicy;
  /** resolveCodexModel 的产物:model 原样给 thread 参数,-c 注入参数给 spawn argv。 */
  model?: string;
  configOverrides?: string[];
  env?: Record<string, string>;
}

export async function* runViaAppServer(ctx: AppServerRunContext): AsyncGenerator<AgentEvent> {
  const { opts, backend } = ctx;
  const ev = (type: EventType, sessionId: string | null, data: Json): AgentEvent => ({
    type,
    backend,
    sessionId,
    data,
  });

  // ---- preflight(可安全回退区,契约:此块内绝不 yield) ----
  let rpc: Rpc;
  let threadId: string;
  let turnId: string;
  try {
    rpc = startRpc({
      args: ["app-server", ...(ctx.configOverrides ?? [])],
      cwd: opts.cwd ?? opts.workspace ?? undefined,
      env: ctx.env,
    });
  } catch (e) {
    throw new AppServerPreflight("spawn", e);
  }
  try {
    if (opts.signal?.aborted) throw new Error("aborted before start");
    await rpc.request("initialize", {
      clientInfo: { name: "sm-agent", title: "@smokingmouse/agent", version: "0" },
      // 只用 stable 表面(thread/turn/delta 均 stable)。partialMessages=false 时
      // 精确退订正文 delta,靠 item/completed 的余量补发退回 block 行为 —— 与
      // claude 的 --include-partial-messages 开关同语义。
      capabilities: {
        experimentalApi: false,
        ...(opts.partialMessages === false
          ? { optOutNotificationMethods: ["item/agentMessage/delta"] }
          : {}),
      },
    });
    rpc.notify("initialized");

    const threadOpts = appServerThreadOptions({
      policy: ctx.policy,
      additionalWritableDirs: opts.additionalWritableDirs ?? [],
      sandboxNetworkAccess: opts.sandboxNetworkAccess === true,
    });
    const cwd = opts.cwd ?? opts.workspace ?? undefined;
    const common: Json = {
      ...(ctx.model ? { model: ctx.model } : {}),
      ...(cwd ? { cwd } : {}),
      sandbox: threadOpts.sandbox,
      approvalPolicy: threadOpts.approvalPolicy,
      ...(threadOpts.config ? { config: threadOpts.config } : {}),
    };

    let resp: Json;
    if (opts.resume && opts.forkSession) {
      // 原生 fork:等价于 exec 路径的 forkCodexSession rollout copy,但由 codex
      // 自己保证一致性。失败走 preflight 回退,exec 路径的 copy fork 仍能兜住。
      resp = await rpc.request("thread/fork", { threadId: opts.resume, ...common });
    } else if (opts.resume) {
      resp = await rpc.request("thread/resume", { threadId: opts.resume, ...common });
    } else {
      resp = await rpc.request("thread/start", {
        ...common,
        ...(opts.persistence === false ? { ephemeral: true } : {}),
      });
    }
    const thread = (resp.thread ?? {}) as Json;
    threadId = String(thread.id ?? "");
    if (!threadId) throw new Error("thread/* response missing thread.id");

    const input: Json[] = [
      { type: "text", text: ctx.prompt },
      ...(opts.attachments ?? []).map((a) => ({ type: "localImage", path: a.path })),
    ];
    const turnResp = await rpc.request("turn/start", { threadId, input });
    turnId = String(((turnResp.turn ?? {}) as Json).id ?? "");
  } catch (e) {
    rpc.kill();
    throw new AppServerPreflight("handshake", e);
  }

  // ---- 模型已开跑:从这里起只 yield,不再抛(不可回退) ----
  let interruptTimer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => {
    // 先礼后兵:turn/interrupt 让 codex 持久化半程状态,2s 不收尾再 SIGTERM。
    rpc.request("turn/interrupt", { threadId, turnId }, 2_000).catch(() => {});
    interruptTimer = setTimeout(() => rpc.kill(), 2_000);
  };
  opts.signal?.addEventListener("abort", onAbort);

  const finalText: string[] = [];
  // agentMessage 逐 item 记已发长度:delta 与 completed 全文之间做余量补发,
  // 退订 delta(partialMessages=false)时这条路径就是全部输出。
  const emittedLen = new Map<string, number>();
  const startedTools = new Set<string>();
  let usage: { total?: TokenBreakdown; last?: TokenBreakdown } | null = null;
  let lastError: string | null = null;

  try {
    yield ev(EventType.SessionStart, threadId, {
      tools: null,
      model: ctx.model ?? null,
      note: "transport=app-server",
      transport: "app-server",
    });

    for (;;) {
      const n = await rpc.notifications.next();
      if (n === null) {
        // 进程退出而 turn 未收尾 —— 报最后已知错误/stderr,绝不静默。
        const tail = rpc.stderrTail();
        yield ev(EventType.Error, threadId, {
          message: lastError ?? (tail ? tail.slice(-500) : "codex app-server exited unexpectedly"),
        });
        return;
      }
      const { method, params } = n;
      if (method === "item/agentMessage/delta") {
        const delta = String(params.delta ?? "");
        const itemId = String(params.itemId ?? "default");
        if (delta) {
          emittedLen.set(itemId, (emittedLen.get(itemId) ?? 0) + delta.length);
          finalText.push(delta);
          yield ev(EventType.TextChunk, threadId, { text: delta });
        }
      } else if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
        const delta = String(params.delta ?? "");
        if (delta) yield ev(EventType.Thinking, threadId, { text: delta });
      } else if (method === "item/reasoning/summaryPartAdded") {
        yield ev(EventType.Thinking, threadId, { text: "\n\n" }); // 摘要分节边界
      } else if (method === "item/started" || method === "item/completed") {
        const item = (params.item ?? {}) as Json;
        const itemId = String(item.id ?? "");
        if (item.type === "agentMessage") {
          if (method === "item/completed") {
            // delta 已流过的部分不重发;退订/漏发时这里补齐余量。
            const text = String(item.text ?? "");
            const prev = emittedLen.get(itemId) ?? 0;
            if (text.length > prev) {
              const rest = text.slice(prev);
              finalText.push(rest);
              yield ev(EventType.TextChunk, threadId, { text: rest });
              emittedLen.set(itemId, text.length);
            }
          }
        } else if (item.type === "fileChange") {
          if (method === "item/completed") {
            yield ev(EventType.FileChange, threadId, { changes: item.changes });
          }
        } else {
          const call = appServerToolCall(item);
          if (call) {
            if (!startedTools.has(itemId)) {
              startedTools.add(itemId);
              yield ev(EventType.ToolCall, threadId, {
                id: itemId,
                ...call,
                parentToolUseId: null,
              });
            }
            if (method === "item/completed") {
              const r = appServerToolResult(item);
              yield ev(EventType.ToolCallDone, threadId, {
                id: itemId,
                output: r.output,
                stderr: null, // aggregatedOutput 不拆 stdout/stderr,同 exec
                isError: r.isError,
              });
              if (item.type === "imageGeneration" && typeof item.savedPath === "string") {
                yield ev(EventType.ImageOutput, threadId, { paths: [item.savedPath] });
              }
            }
          }
        }
      } else if (method === "thread/tokenUsage/updated") {
        usage = (params.tokenUsage ?? null) as typeof usage;
      } else if (method === "error") {
        // willRetry=true 是瞬态(对齐 exec 吞 "Reconnecting");false 记下留作
        // turn/completed(failed) 或进程猝死时的报错素材。
        if (params.willRetry !== true) {
          lastError = String(((params.error ?? {}) as Json).message ?? "codex error");
        }
      } else if (method === "turn/completed") {
        const turn = (params.turn ?? {}) as Json;
        const status = String(turn.status ?? "completed");
        if (status === "completed") {
          yield ev(EventType.Result, threadId, {
            text: finalText.join(""),
            cost: appServerCost(usage),
          });
        } else if (status === "interrupted") {
          // 主动 abort:安静收尾(exec 路径 SIGTERM 也无终事件)。外因中断则报错。
          if (!opts.signal?.aborted) {
            yield ev(EventType.Error, threadId, { message: "codex turn interrupted" });
          }
        } else {
          const msg = ((turn.error ?? {}) as Json).message;
          yield ev(EventType.Error, threadId, {
            message: String(msg ?? lastError ?? "codex turn failed"),
          });
        }
        return;
      }
      // thread/started, mcpServer/*, hook/*, warning, turn/started, plan 等:
      // 暂无对应 AgentEvent,静默略过(与 exec 路径 default: continue 同位)。
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    if (interruptTimer) clearTimeout(interruptTimer);
    rpc.kill();
  }
}
