"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { watchRun, type Run, type RunStreamFrame } from "../lib/api";
import { Markdown } from "./markdown";

/**
 * 订阅一个 run 的 SSE 事件流（回放已有 + 进行中直播）。
 * runId 变更自动重连；卸载 AbortController 收流。
 */
export function useRunFrames(runId: string | null) {
  const [frames, setFrames] = useState<RunStreamFrame[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFrames([]);
    setError(null);
    if (!runId) {
      setStreaming(false);
      return;
    }
    setStreaming(true);
    const ac = new AbortController();
    (async () => {
      let pending: RunStreamFrame[] = [];
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        if (ac.signal.aborted || pending.length === 0) {
          pending = [];
          return;
        }
        const next = pending;
        pending = [];
        setFrames((current) => [...current, ...next]);
      };
      try {
        for await (const f of watchRun(runId, ac.signal)) {
          pending.push(f);
          // 历史 Run 可能有数千帧；按批入 React state，避免逐帧复制数组造成 O(n²) 卡顿。
          if (pending.length >= 50 || f.kind === "done") flush();
          else if (!flushTimer) flushTimer = setTimeout(flush, 80);
        }
      } catch (e) {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        flush();
        if (!ac.signal.aborted) setStreaming(false);
      }
    })();
    return () => ac.abort();
  }, [runId]);

  const doneRun: Run | null = useMemo(() => {
    for (const f of frames) if (f.kind === "done") return f.run;
    return null;
  }, [frames]);

  return { frames, streaming, doneRun, error };
}

// ── 帧折叠：SSE 帧序列 → 渲染块（连续 text/thinking 拼接） ──

/** 工具调用的渲染态：tool_call 落一条，tool_call_done 按 id 回填状态与输出（codex 无 done 事件，id 为 null 直接视为 done） */
export type ToolItem = {
  kind: "tool";
  id: string | null;
  name: string;
  input: unknown;
  /** 一行可读摘要（Read → 文件路径，Bash → description/command…），由 toolSummary 生成 */
  summary: string;
  status: "running" | "done" | "error";
  output: string | null;
  stderr: string | null;
  /** 输出被截断（原文可能数十 KB，全量进 React state 会拖垮回放） */
  outputTruncated: boolean;
};

export type LogItem =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | ToolItem
  | { kind: "error"; text: string }
  | { kind: "session"; text: string }
  | { kind: "approval"; text: string }
  | { kind: "done"; text: string; ok: boolean };

export function foldFrames(frames: RunStreamFrame[]): LogItem[] {
  const items: LogItem[] = [];
  // tool_call.id → 未完结的 ToolItem，供 tool_call_done 回填
  const pendingTools = new Map<string, ToolItem>();
  for (const f of frames) {
    if (f.kind === "approval") {
      items.push({ kind: "approval", text: `⏸ 等待工具授权：${f.approval.toolName}（Approvals 页处理）` });
      continue;
    }
    if (f.kind === "approval_decided") {
      items.push({ kind: "approval", text: `▶ 审批 → ${f.status}${f.decidedBy ? `（by ${f.decidedBy}）` : ""}` });
      continue;
    }
    if (f.kind === "done") {
      const r = f.run;
      const cost = r.cost?.usd != null ? ` · $${r.cost.usd.toFixed(4)}` : "";
      items.push({
        kind: "done",
        text: `── ${r.status}${cost}${r.error ? ` · ${r.error}` : ""}`,
        ok: r.status === "succeeded",
      });
      continue;
    }
    const ev = f.event;
    const d = ev.data as Record<string, unknown>;
    switch (ev.type) {
      case "text_chunk": {
        const last = items[items.length - 1];
        if (last?.kind === "text") last.text += String(d.text ?? "");
        else items.push({ kind: "text", text: String(d.text ?? "") });
        break;
      }
      case "thinking": {
        const last = items[items.length - 1];
        if (last?.kind === "thinking") last.text += String(d.text ?? "");
        else items.push({ kind: "thinking", text: String(d.text ?? "") });
        break;
      }
      case "tool_call": {
        const id = d.id != null ? String(d.id) : null;
        const name = String(d.name ?? "?");
        items.push({
          kind: "tool",
          id,
          name,
          input: d.input ?? null,
          summary: toolSummary(name, d.input),
          status: id ? "running" : "done",
          output: null,
          stderr: null,
          outputTruncated: false,
        });
        if (id) pendingTools.set(id, items[items.length - 1] as ToolItem);
        break;
      }
      case "tool_call_done": {
        const target = d.id != null ? pendingTools.get(String(d.id)) : undefined;
        if (target) {
          const output = typeof d.output === "string" ? d.output : null;
          const stderr = typeof d.stderr === "string" && d.stderr ? d.stderr : null;
          target.status = d.isError ? "error" : "done";
          target.outputTruncated = (output?.length ?? 0) > MAX_TOOL_OUTPUT || (stderr?.length ?? 0) > MAX_TOOL_OUTPUT;
          target.output = output ? output.slice(0, MAX_TOOL_OUTPUT) : null;
          target.stderr = stderr ? stderr.slice(0, MAX_TOOL_OUTPUT) : null;
          pendingTools.delete(String(d.id));
        }
        break;
      }
      case "error":
        items.push({ kind: "error", text: String(d.message ?? "") });
        break;
      case "session_start":
        items.push({
          kind: "session",
          text: `◈ session ${(ev.sessionId ?? "").slice(0, 8)}${d.model ? ` · ${String(d.model)}` : ""}`,
        });
        break;
      // file_change / image_output：看板不展开（与旧版一致）
    }
  }
  return items;
}

// ── 工具调用可读化 ─────────────────────────────────────

const MAX_TOOL_OUTPUT = 3000;
const SUMMARY_LEN = 110;

function clip(text: string, len: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > len ? `${flat.slice(0, len)}…` : flat;
}

/**
 * 把 tool_call 的 input 压成一行人话摘要。按 Claude Code 常用工具特化，
 * 未知工具（含 MCP）退化为截断的紧凑 JSON。
 */
export function toolSummary(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const str = (...keys: string[]) => {
    for (const k of keys) if (typeof o[k] === "string" && o[k]) return o[k] as string;
    return null;
  };
  switch (name) {
    case "Bash": {
      const command = str("command") ?? "";
      const firstLine = command.split("\n", 1)[0] ?? "";
      return clip(str("description") ?? firstLine, SUMMARY_LEN);
    }
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return clip(str("file_path", "notebook_path") ?? "", SUMMARY_LEN);
    case "Glob":
      return clip(str("pattern") ?? "", SUMMARY_LEN);
    case "Grep": {
      const pattern = str("pattern");
      const path = str("path");
      return clip([pattern ? `/${pattern}/` : null, path].filter(Boolean).join(" "), SUMMARY_LEN);
    }
    case "WebFetch":
      return clip(str("url") ?? "", SUMMARY_LEN);
    case "WebSearch":
      return clip(str("query") ?? "", SUMMARY_LEN);
    case "Task":
    case "Agent":
      return clip(str("description") ?? "", SUMMARY_LEN);
    case "TodoWrite":
      return Array.isArray(o.todos) ? `${o.todos.length} todos` : "";
    default:
      return clip(JSON.stringify(input), SUMMARY_LEN);
  }
}

/** 工具详情里的输入展示：Bash 直接给命令原文（JSON 转义换行没法看），其余 pretty JSON */
function toolInputDisplay(name: string, input: unknown): string {
  if (name === "Bash" && input && typeof input === "object") {
    const command = (input as Record<string, unknown>).command;
    if (typeof command === "string") return command;
  }
  const pretty = JSON.stringify(input, null, 2) ?? "";
  return pretty.length > 1500 ? `${pretty.slice(0, 1500)}\n…（输入过长已截断）` : pretty;
}

function ToolStatus({ status }: { status: ToolItem["status"] }) {
  if (status === "running") return <span className="animate-pulse text-[10px] text-doing">● 运行中</span>;
  if (status === "error") return <span className="text-[10px] font-semibold text-canceled">✗ 失败</span>;
  return <span className="text-[10px] text-done">✓</span>;
}

/** 一次工具调用：一行摘要（可扫读）+ 展开看输入/输出。RunTrace 与 Chats 共用。 */
export function ToolCard({ item }: { item: ToolItem }) {
  const hasDetail = item.input != null || item.output != null || item.stderr != null;
  if (!hasDetail) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-line/75 bg-white/65 px-3 py-2 text-[11px]">
        <span className="text-accent">↳</span>
        <span className="shrink-0 font-semibold text-ink/75">{item.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-dim">{item.summary}</span>
        <ToolStatus status={item.status} />
      </div>
    );
  }
  return (
    <details className="group rounded-lg border border-line/75 bg-white/65 px-3 py-2">
      <summary className="flex cursor-pointer select-none items-center gap-2 text-[11px]">
        <span className="text-accent">↳</span>
        <span className="shrink-0 font-semibold text-ink/75">{item.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-dim">{item.summary}</span>
        <ToolStatus status={item.status} />
      </summary>
      <div className="mt-2 space-y-2 border-t border-line/70 pt-2">
        {item.input != null && (
          <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-md bg-bg/70 p-2 font-mono text-[10px] leading-4 text-ink/70">{toolInputDisplay(item.name, item.input)}</pre>
        )}
        {item.output != null && (
          <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-md bg-bg/70 p-2 font-mono text-[10px] leading-4 text-dim">{item.output}{item.outputTruncated ? "\n…（输出过长已截断）" : ""}</pre>
        )}
        {item.stderr != null && (
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md border border-red-200 bg-red-50 p-2 font-mono text-[10px] leading-4 text-red-700">{item.stderr}</pre>
        )}
      </div>
    </details>
  );
}

/** Issues 抽屉的类终端回放面板（自动滚底） */
export function EventLog({ runId }: { runId: string | null }) {
  const { frames, streaming, error } = useRunFrames(runId);
  const items = useMemo(() => foldFrames(frames), [frames]);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [items, streaming]);

  if (!runId) return null;
  return (
    <div
      ref={boxRef}
      className="max-h-[46vh] overflow-y-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-200"
    >
      {items.length === 0 && !error && (
        <span className="text-zinc-500">{streaming ? "等待事件…" : "（无事件——记录可能已过期，7 天 prune）"}</span>
      )}
      {items.map((it, i) => {
        switch (it.kind) {
          case "text":
            return <span key={i}>{it.text}</span>;
          case "thinking":
            return (
              <details key={i} className="my-1 rounded border border-zinc-800 bg-zinc-900/65 px-2 py-1 text-zinc-500">
                <summary className="cursor-pointer select-none text-[10px] font-semibold uppercase tracking-[0.1em] hover:text-zinc-300">
                  Thinking · {it.text.length.toLocaleString()} chars
                </summary>
                <div className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-all border-t border-zinc-800 pt-2 italic">
                  {it.text}
                </div>
              </details>
            );
          case "tool":
            return (
              <div key={i} className="text-zinc-400">
                ⚙ {it.name} <span className="text-zinc-500">{it.summary}</span>
              </div>
            );
          case "error":
            return (
              <div key={i} className="text-red-400">
                ✗ {it.text}
              </div>
            );
          case "session":
            return (
              <div key={i} className="text-zinc-500">
                {it.text}
              </div>
            );
          case "approval":
            return (
              <div key={i} className="text-amber-400">
                {it.text}
              </div>
            );
          case "done":
            return (
              <div key={i} className={it.ok ? "text-green-400" : "text-amber-400"}>
                {it.text}
              </div>
            );
        }
      })}
      {streaming && <span className="animate-pulse text-zinc-500">▍</span>}
      {error && <div className="text-red-400">✗ {error}</div>}
    </div>
  );
}

/** Mew 式执行过程：正文流而非黑色终端；thinking / tool 默认保持轻量、可扫读。 */
export function RunTrace({ runId, className = "" }: { runId: string | null; className?: string }) {
  const { frames, streaming, error } = useRunFrames(runId);
  const items = useMemo(() => foldFrames(frames), [frames]);

  if (!runId) return null;
  return (
    <div className={`space-y-2 text-[12px] leading-5 text-ink/72 ${className}`}>
      {items.length === 0 && !error && (
        <div className="flex items-center gap-2 py-1 text-dim">
          <span className={`h-1.5 w-1.5 rounded-full ${streaming ? "animate-pulse bg-doing" : "bg-backlog"}`} />
          {streaming ? "Agent 正在准备…" : "执行记录已过期或没有事件"}
        </div>
      )}
      {items.map((item, index) => {
        if (item.kind === "text") return <Markdown key={index} text={item.text} className="text-[13px] leading-6 text-ink/85" />;
        if (item.kind === "thinking") {
          return (
            <details key={index} className="group rounded-lg border border-line/80 bg-bg/55 px-3 py-2">
              <summary className="cursor-pointer select-none text-[11px] font-medium text-dim group-open:text-ink/70">
                Think <span className="ml-1 font-mono text-[9px] text-dim/70">{item.text.length.toLocaleString()} chars</span>
              </summary>
              <div className="mt-2 max-h-52 overflow-y-auto whitespace-pre-wrap border-t border-line/70 pt-2 text-[11px] italic text-dim">{item.text}</div>
            </details>
          );
        }
        if (item.kind === "tool") return <ToolCard key={index} item={item} />;
        if (item.kind === "session") return <div key={index} className="font-mono text-[10px] text-dim/70">{item.text}</div>;
        if (item.kind === "approval") return <div key={index} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">{item.text}</div>;
        if (item.kind === "error") return <div key={index} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700">{item.text}</div>;
        return <div key={index} className={`border-t border-line/70 pt-2 text-[11px] font-medium ${item.ok ? "text-done" : "text-review"}`}>{item.text}</div>;
      })}
      {streaming && <span className="inline-block animate-pulse text-accent">●</span>}
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700">{error}</div>}
    </div>
  );
}
