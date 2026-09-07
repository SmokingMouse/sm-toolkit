import type { Item } from "@smokingmouse/agent-server/protocol";

export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export interface LogEntry { time: number; subtype: string; category: string; error: boolean; summary: string; payload: unknown }
/** Keep unknown payloads intact, including nested fields; display sanitization happens at render time. */
export function classifyEvent(subtype: string, payload: Record<string, unknown>, time = Date.now()): LogEntry {
  const category = /hook/.test(subtype) ? "hook" : subtype === "local_command" ? "command"
    : /api_retry/.test(subtype) ? "retry" : /rate_limit/.test(subtype) ? "rate_limit"
    : /model_refusal_fallback/.test(subtype) ? "fallback" : /memory/.test(subtype) ? "memory"
    : subtype === "away_summary" ? "summary" : "unknown";
  const error = /error|failed|failure|rate_limit|api_retry|refusal/.test(subtype)
    || payload.is_error === true || payload.isError === true || Boolean(payload.error)
    || (typeof payload.exit_code === "number" && payload.exit_code !== 0)
    || (typeof payload.exitCode === "number" && payload.exitCode !== 0)
    || (Array.isArray(payload.hook_errors) && payload.hook_errors.length > 0)
    || /error|failed|failure/.test(String(payload.status ?? payload.outcome ?? ""));
  const detail = ["summary", "output", "stdout", "stderr", "message", "hook_name", "reason"].flatMap(key => typeof payload[key] === "string" ? [payload[key] as string] : []);
  return { time, subtype, category, error, summary: category === "unknown" || !detail.length ? JSON.stringify(payload) : detail.join(" · "), payload: structuredClone(payload) };
}

export interface ObservedTask { id: string; title: string; status: string; inferred?: boolean }
const idOf = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 || typeof value === "number" ? String(value) : undefined;
/** Replay the current item map, so started/completed duplicates and reconnect snapshots are idempotent. */
export function rebuildTasks(items: Iterable<Item>): Map<string, ObservedTask> {
  const tasks = new Map<string, ObservedTask>(); let next = 1;
  for (const item of [...items].sort((a, b) => a.seq - b.seq)) {
    if (item.type !== "toolCall" || item.payload.isError || item.status === "failed" || item.status === "rejected") continue;
    const name = item.payload.name, input = object(item.payload.input), output = object(item.payload.output);
    if (name === "TaskCreate") {
      const explicit = idOf(input.taskId ?? input.id ?? output.taskId ?? output.id ?? object(output.task).id);
      while (tasks.has(String(next))) next++;
      const id = explicit ?? String(next++);
      tasks.set(id, { id, title: String(input.subject ?? input.title ?? "未命名任务"), status: String(input.status ?? "pending"), ...(!explicit ? { inferred: true } : {}) });
    } else if (name === "TaskUpdate") {
      const id = idOf(input.taskId ?? input.id); if (!id) continue;
      if (input.status === "deleted") { tasks.delete(id); continue; }
      const old = tasks.get(id);
      tasks.set(id, { ...old, id, title: String(input.subject ?? input.title ?? old?.title ?? "标题未知"), status: String(input.status ?? old?.status ?? "unknown") });
    } else if (name === "TaskList") {
      const list = input.tasks ?? output.tasks ?? (Array.isArray(item.payload.output) ? item.payload.output : undefined);
      if (!Array.isArray(list)) continue;
      tasks.clear();
      for (const value of list) { const task = object(value), id = idOf(task.id ?? task.taskId); if (id) tasks.set(id, { id, title: String(task.subject ?? task.title ?? "标题未知"), status: String(task.status ?? "unknown") }); }
    }
  }
  return tasks;
}
