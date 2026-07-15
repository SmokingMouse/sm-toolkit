"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { watchRun, type Run, type RunStreamFrame } from "../lib/api";

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
      try {
        for await (const f of watchRun(runId, ac.signal)) {
          setFrames((xs) => [...xs, f]);
        }
      } catch (e) {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
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

export type LogItem =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "error"; text: string }
  | { kind: "session"; text: string }
  | { kind: "approval"; text: string }
  | { kind: "done"; text: string; ok: boolean };

export function foldFrames(frames: RunStreamFrame[]): LogItem[] {
  const items: LogItem[] = [];
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
      case "tool_call":
        items.push({
          kind: "tool",
          name: String(d.name ?? "?"),
          summary: JSON.stringify(d.input ?? {}).slice(0, 140),
        });
        break;
      case "error":
        items.push({ kind: "error", text: String(d.message ?? "") });
        break;
      case "session_start":
        items.push({
          kind: "session",
          text: `◈ session ${(ev.sessionId ?? "").slice(0, 8)}${d.model ? ` · ${String(d.model)}` : ""}`,
        });
        break;
      // tool_call_done / file_change / image_output：看板不展开（与旧版一致）
    }
  }
  return items;
}

/** Issues 抽屉的类终端回放面板（自动滚底） */
export function EventLog({ runId }: { runId: string | null }) {
  const { frames, streaming, error } = useRunFrames(runId);
  const items = useMemo(() => foldFrames(frames), [frames]);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [items.length, streaming]);

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
              <span key={i} className="italic text-zinc-500">
                {it.text}
              </span>
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
