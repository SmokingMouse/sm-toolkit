/**
 * Codex CLI 后端 —— spawn `codex` + 把 jsonl 事件归一成统一 Event。
 * 移植自 agent-gateway src/backends.ts,原样搬入(codex 的模型切换不在本次范围内,
 * 这个后端本身也没有 endpoints.yaml 接入 —— 见 ClaudeBackend 的对比)。
 */

import { spawnSync } from "node:child_process";
import { EventType, type AgentEvent, type Cost } from "../events.js";
import type { Backend, RunOptions, PermissionPolicy } from "../backend.js";
import { streamLines } from "./stream-lines.js";

// 示意单价(USD / token),真实值由上游配置注入。
const CODEX_PRICE = { input: 1.25 / 1_000_000, output: 10.0 / 1_000_000 };

export class CodexBackend implements Backend {
  readonly name = "codex";

  capabilities(): Record<string, unknown> {
    return {
      workspace: true,
      tools: true,
      mcp: true,
      sandboxModes: ["read-only", "workspace-write", "full-access"],
      permissionPolicies: ["readonly", "auto-edit", "full"],
      readonlyEnforcement: "os-sandbox", // OS 级只读,Bash 也无法绕过
      dynamicPermissionCallback: false, // Phase 2:需 app-server JSON-RPC
      vision: true, // --image FILE
      toolAllowlist: false, // codex 无工具白名单(sandbox 决定可达)
      streaming: "block", // codex --json 不发 per-token,agent_message 整段出
      costInStream: false, // 只给 token,$ 需上游按单价估
      structuredOutput: true, // --output-schema
      reportsCapabilityAtRuntime: false, // thread.started 不含 tools/model
      resume: true,
    };
  }

  async *run(prompt: string, opts: RunOptions): AsyncGenerator<AgentEvent> {
    // 登录检查(便宜 ~50ms):给清晰可操作错误,避免浪费一次必 401 的往返。
    const login = spawnSync("codex", ["login", "status"], { encoding: "utf8", timeout: 5000 });
    if (login.status !== 0) {
      yield ev(this.name, EventType.Error, null, {
        message: "codex 未登录。请先在终端运行 `codex login` 后重试。",
      });
      return;
    }

    // codex 无 --system-prompt,把它 inline 到 prompt 前(read-only sandbox 时主要影响风格)。
    const finalPrompt = opts.systemPrompt ? `${opts.systemPrompt}\n\n---\n\n${prompt}` : prompt;
    const policy: PermissionPolicy = opts.permission ?? (opts.workspace ? "auto-edit" : "readonly");
    const args = buildCodexArgs({
      policy,
      ephemeral: opts.persistence === false,
      model: opts.model,
      resume: opts.resume ?? null,
      additionalWritableDirs: opts.additionalWritableDirs ?? [],
      sandboxNetworkAccess: opts.sandboxNetworkAccess === true,
      imagePaths: (opts.attachments ?? []).map((a) => a.path),
      prompt: finalPrompt,
      additionalDirs: opts.additionalWorkspaces ?? [],
      environmentSkills: opts.environmentSkills,
      environmentSkillNames: opts.environmentSkillNames,
    });

    let sid: string | null = opts.resume ?? null;
    const finalText: string[] = [];
    // 按 item id 记已转发长度,防 item.updated/completed 对同一条重复 emit。
    const emittedLen = new Map<string, number>();

    for await (const raw of streamLines("codex", args, {
      cwd: opts.cwd ?? opts.workspace ?? undefined,
      env: opts.env,
      signal: opts.signal,
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
          model: null,
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
      } else if (t === "item.completed" && obj.item?.type === "command_execution") {
        yield ev(this.name, EventType.ToolCall, sid, { name: "shell", input: obj.item.command });
      } else if (t === "item.completed" && obj.item?.type === "file_change") {
        yield ev(this.name, EventType.FileChange, sid, { changes: obj.item.changes });
      } else if (t === "item.completed" && obj.item?.type === "mcp_tool_call") {
        yield ev(this.name, EventType.ToolCall, sid, { name: obj.item.tool, input: obj.item.arguments });
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
        yield ev(this.name, EventType.Error, sid, { message: obj.error?.message ?? "codex turn failed" });
        return;
      } else if (t === "error") {
        // "Reconnecting..." 是瞬态重连,吞掉(解决 normalizer 噪音);其余才报。
        const msg = (obj.message as string) ?? "";
        if (!msg.toLowerCase().startsWith("reconnecting")) {
          yield ev(this.name, EventType.Error, sid, { message: msg || "codex error" });
          return;
        }
      }
    }
  }
}

export function buildCodexArgs(o: {
  policy: PermissionPolicy;
  ephemeral: boolean;
  model?: string;
  resume: string | null;
  additionalWritableDirs: string[];
  sandboxNetworkAccess: boolean;
  imagePaths: string[];
  prompt: string;
  additionalDirs?: string[];
  environmentSkills?: boolean;
  environmentSkillNames?: string[];
}): string[] {
  const common = ["--json", "--skip-git-repo-check"];
  if (o.environmentSkills === false) {
    common.push(...codexEnvironmentSkillArgs(o.environmentSkillNames));
  }
  if (o.model) common.push("-m", o.model);
  // `codex exec resume` 当前没有 --add-dir；新会话才显式开放额外 Repository。
  if (!o.resume) {
    for (const directory of o.additionalDirs ?? []) common.push("--add-dir", directory);
  }
  const imageArgs = o.imagePaths.flatMap((p) => ["--image", p]);
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
    return ["exec", "resume", o.resume, ...common, ...sandbox, ...imageArgs, o.prompt];
  }
  const sandbox =
    o.policy === "readonly"
      ? ["--sandbox", "read-only"]
      : o.policy === "full"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : ["--sandbox", "workspace-write"]; // auto-edit(以及兼容 default,codex 无独立 default 档)
  const additionalWritableDirs = writableDirs.flatMap((dir) => ["--add-dir", dir]);
  const ephemeral = o.ephemeral ? ["--ephemeral"] : [];
  return ["exec", ...common, ...ephemeral, ...sandbox, ...workspaceNetwork, ...additionalWritableDirs, ...imageArgs, o.prompt];
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
