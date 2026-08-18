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
 * approvalPolicy 默认 "never"(非交互 parity,exec 从不弹审批);唯一例外:
 * `approvals`(= policy "default" + onCanUseTool 在场,即上游权限确认模式)
 * → "untrusted",不可信命令/patch 逐个发 requestApproval 由回调裁决——
 * 可信白名单命令(ls/cat/echo…)codex 自动放行,2026-08-18 实测。
 */
export function appServerThreadOptions(o: {
  policy: PermissionPolicy;
  additionalWritableDirs: string[];
  sandboxNetworkAccess: boolean;
  approvals?: boolean;
}): {
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "never" | "untrusted";
  config?: Record<string, unknown>;
} {
  if (o.policy === "readonly") return { sandbox: "read-only", approvalPolicy: "never" };
  if (o.policy === "full") return { sandbox: "danger-full-access", approvalPolicy: "never" };
  // auto-edit / default(codex 无独立 default 档,同 exec 归到 workspace-write)
  const writable = [...new Set(o.additionalWritableDirs)];
  return {
    sandbox: "workspace-write",
    approvalPolicy: o.policy === "default" && o.approvals ? "untrusted" : "never",
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
  if (item.type === "collabAgentToolCall") {
    // agentsStates = 目标子线的最后已知状态(spawn/wait 的可观测结果)。
    const states = item.agentsStates;
    const hasStates = states && typeof states === "object" && Object.keys(states).length > 0;
    return { output: hasStates ? JSON.stringify(states) : null, isError: failed };
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

/** 送进主循环的两类消息:通知,以及需要回调裁决的审批请求(带响应 id)。 */
type Incoming =
  | { kind: "notif"; method: string; params: Json }
  | { kind: "approval"; rpcId: unknown; method: string; params: Json };

// 走 onCanUseTool 裁决的 server→client 请求;其余(permissions/requestUserInput/
// elicitation…)仍在 startRpc 内联自动应答。
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

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
  /** 审批请求的应答通道(主循环拿到用户决策后回写)。 */
  respond: (rpcId: unknown, result: Json) => void;
  incoming: AsyncQueue<Incoming>;
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
  const incoming = new AsyncQueue<Incoming>();

  const write = (obj: Json) => {
    if (child.stdin?.writable) child.stdin.write(JSON.stringify(obj) + "\n");
  };

  // 非审批类 server→client 请求内联自动应答;真审批(APPROVAL_METHODS)进队列由
  // 主循环裁决(有回调走回调,没有则 decline)。未知请求拒掉比挂死等待强。
  const respondToServerRequest = (id: unknown, method: string, params: Json) => {
    const reply = (result: Json) => write({ jsonrpc: "2.0", id: id as number, result });
    if (APPROVAL_METHODS.has(method)) {
      incoming.push({ kind: "approval", rpcId: id, method, params });
      return;
    }
    switch (method) {
      case "execCommandApproval": // v1 遗留双胞胎,shape 不同,v2 turn 不应出现
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
      respondToServerRequest(msg.id, msg.method, (msg.params ?? {}) as Json);
      return;
    }
    if (typeof msg.method === "string") {
      incoming.push({ kind: "notif", method: msg.method, params: (msg.params ?? {}) as Json });
    }
  });

  child.on("close", () => {
    incoming.close();
    const err = new Error("codex app-server exited");
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });
  child.on("error", (e) => {
    // spawn 失败(codex 不在 PATH 等):close 可能不来,主动收尾。
    incoming.close();
    for (const [, p] of pending) p.reject(e);
    pending.clear();
  });

  return {
    child,
    incoming,
    stderrTail: () => stderr.trim(),
    respond: (rpcId, result) => write({ jsonrpc: "2.0", id: rpcId as number, result }),
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
      // 权限确认模式:上游要求逐项审批且给了裁决回调 → untrusted。
      approvals: !!opts.onCanUseTool,
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
  // 权限确认(与 threadOpts 的 untrusted 条件同源):回调在场且档位为 default。
  const approvalsActive = ctx.policy === "default" && !!opts.onCanUseTool;
  // fileChange 审批请求只带 itemId,diff 在先行的 item/started 里 —— 缓存备查。
  const fileChanges = new Map<string, Json>();
  // multi-agent(2026-08-18 实测):子 agent 的事件走同一连接、带子 threadId。
  // spawnByThread: 子 threadId → 派生它的 subAgentActivity call id(Task 挂载点);
  // childText: 子线最后一条 agentMessage 全文(Task summary + spawn 调用的输出)。
  const spawnByThread = new Map<string, string>();
  const childText = new Map<string, string>();
  const seenActivity = new Set<string>(); // subAgentActivity started/completed 双发去重
  const ABORTED = Symbol("aborted");
  const abortPromise: Promise<typeof ABORTED> | null = opts.signal
    ? new Promise((resolve) => {
        if (opts.signal!.aborted) return resolve(ABORTED);
        opts.signal!.addEventListener("abort", () => resolve(ABORTED), { once: true });
      })
    : null;

  try {
    yield ev(EventType.SessionStart, threadId, {
      tools: null,
      model: ctx.model ?? null,
      note: "transport=app-server",
      transport: "app-server",
    });

    for (;;) {
      const n = await rpc.incoming.next();
      if (n === null) {
        // 进程退出而 turn 未收尾 —— 报最后已知错误/stderr,绝不静默。
        const tail = rpc.stderrTail();
        yield ev(EventType.Error, threadId, {
          message: lastError ?? (tail ? tail.slice(-500) : "codex app-server exited unexpectedly"),
        });
        return;
      }
      // ---- 审批请求:映射成 claude 形状的 can_use_tool,拿决策回写 ----
      if (n.kind === "approval") {
        const itemId = String(n.params.itemId ?? "");
        if (!approvalsActive || !opts.onCanUseTool) {
          // 非权限确认模式不该出现(approvalPolicy=never);真出现拒掉防挂死。
          rpc.respond(n.rpcId, { decision: "decline" });
          continue;
        }
        let toolName: string;
        let input: Json;
        if (n.method === "item/commandExecution/requestApproval") {
          // commandActions[0].command 是裸命令(不带 /bin/zsh -lc 包装),对齐
          // claude Bash 卡片的 input.command 语义;渲染层能直接出等宽命令块。
          const actions = n.params.commandActions as Array<{ command?: string }> | undefined;
          toolName = "Bash";
          input = {
            command: actions?.[0]?.command ?? String(n.params.command ?? ""),
            ...(n.params.cwd ? { cwd: n.params.cwd } : {}),
            ...(n.params.reason ? { reason: n.params.reason } : {}),
          };
        } else {
          toolName = "Edit";
          const fc = fileChanges.get(itemId);
          input = {
            changes: (fc?.changes as unknown) ?? [],
            ...(n.params.reason ? { reason: n.params.reason } : {}),
            ...(n.params.grantRoot ? { grantRoot: n.params.grantRoot } : {}),
          };
        }
        const callbackP = opts.onCanUseTool({
          toolName,
          toolUseId: itemId,
          requestId: String(n.rpcId),
          input,
        });
        // 回调可能等很久(等用户);abort 时回 cancel(codex 语义:取消并中断 turn),
        // 外层 onAbort 的 interrupt + 延时 kill 继续兜底,循环等正常收尾事件。
        const r = abortPromise ? await Promise.race([callbackP, abortPromise]) : await callbackP;
        if (r === ABORTED) {
          rpc.respond(n.rpcId, { decision: "cancel" });
          continue;
        }
        // codex 审批不支持改写入参(仅 execpolicy amendment),updatedInput 忽略。
        rpc.respond(n.rpcId, { decision: r.behavior === "allow" ? "accept" : "decline" });
        continue;
      }
      const { method, params } = n;
      // ---- 子线程路由:threadId 非主线的一律不进主输出 ----
      // 不过滤的话子 agent 的 turn/completed 会提前终结整个 run、子线文本混进主
      // 回答(0.6.0 的潜伏 bug,multi-agent 实测暴露)。子线事件降维成 Task 进度
      // + 挂在 spawn 调用下的子工具调用,对齐 claude 子 agent 的 parentToolUseId 树。
      const evThread = typeof params.threadId === "string" ? params.threadId : threadId;
      if (evThread !== threadId) {
        const spawnId = spawnByThread.get(evThread);
        if (!spawnId) continue; // 未经 subAgentActivity 宣告的线程,不认
        if (method === "item/started" || method === "item/completed") {
          const item = (params.item ?? {}) as Json;
          if (item.type === "agentMessage") {
            if (method === "item/completed") childText.set(evThread, String(item.text ?? ""));
          } else {
            const call = appServerToolCall(item);
            if (call) {
              const childItemId = String(item.id ?? "");
              if (!startedTools.has(childItemId)) {
                startedTools.add(childItemId);
                yield ev(EventType.ToolCall, threadId, {
                  id: childItemId,
                  ...call,
                  parentToolUseId: spawnId,
                });
              }
              if (method === "item/completed") {
                const r = appServerToolResult(item);
                yield ev(EventType.ToolCallDone, threadId, {
                  id: childItemId,
                  output: r.output,
                  stderr: null,
                  isError: r.isError,
                });
              }
            }
          }
        } else if (method === "turn/completed") {
          const turn = (params.turn ?? {}) as Json;
          const status = String(turn.status ?? "completed");
          const summary = childText.get(evThread);
          yield ev(EventType.Task, threadId, {
            toolUseId: spawnId,
            taskId: evThread,
            phase: "completed",
            status,
            ...(summary ? { summary } : {}),
          });
          // spawn 调用的输出 = 子线最终回答(对齐 claude Task 工具的报告回传)。
          yield ev(EventType.ToolCallDone, threadId, {
            id: spawnId,
            output: summary ?? null,
            stderr: null,
            isError: status === "failed",
          });
        } else if (method === "thread/tokenUsage/updated") {
          const tu = (params.tokenUsage as { total?: TokenBreakdown } | null)?.total;
          if (tu?.totalTokens !== undefined) {
            yield ev(EventType.Task, threadId, {
              toolUseId: spawnId,
              taskId: evThread,
              phase: "progress",
              totalTokens: tu.totalTokens,
            });
          }
        }
        continue; // 子线 delta/reasoning 等其余通知不进主输出
      }
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
          // started 先缓存:审批请求(item/fileChange/requestApproval)只带 itemId,
          // diff 内容在这条 item 里 —— 权限卡要展示改了什么全靠它。
          if (method === "item/started") fileChanges.set(itemId, item);
          if (method === "item/completed") {
            fileChanges.delete(itemId);
            yield ev(EventType.FileChange, threadId, { changes: item.changes });
          }
        } else if (item.type === "subAgentActivity") {
          // multi-agent 生命周期标记:id 就是 spawn 调用的 call id(实测),
          // agentThreadId 是子线。据此①合成 spawn 工具卡(trellis 的
          // tool_call_update 只认已存在的调用)②发 Task started 挂上去
          // ③登记路由表,后续子线事件降维挂载。started/completed 双发,按
          // itemId+kind 去重。
          const kind = String(item.kind ?? "");
          const agentThreadId = String(item.agentThreadId ?? "");
          const dedupeKey = `${itemId}:${kind}`;
          if (agentThreadId && !seenActivity.has(dedupeKey)) {
            seenActivity.add(dedupeKey);
            const agentPath = typeof item.agentPath === "string" ? item.agentPath : undefined;
            if (kind === "started") {
              spawnByThread.set(agentThreadId, itemId);
              if (!startedTools.has(itemId)) {
                startedTools.add(itemId);
                yield ev(EventType.ToolCall, threadId, {
                  id: itemId,
                  name: "spawn_agent",
                  input: { ...(agentPath ? { agentPath } : {}), agentThreadId },
                  parentToolUseId: null,
                });
              }
              yield ev(EventType.Task, threadId, {
                toolUseId: itemId,
                taskId: agentThreadId,
                taskType: "local_agent",
                phase: "started",
                ...(agentPath ? { description: agentPath } : {}),
              });
            } else if (kind === "interrupted") {
              const spawnId = spawnByThread.get(agentThreadId) ?? itemId;
              yield ev(EventType.Task, threadId, {
                toolUseId: spawnId,
                taskId: agentThreadId,
                phase: "completed",
                status: "interrupted",
              });
            }
            // kind "interacted":子线间消息传递,暂无对应 AgentEvent
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
