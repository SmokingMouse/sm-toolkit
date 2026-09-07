import type { AgentClient } from "@smokingmouse/agent-server/client";
import type { Thread } from "@smokingmouse/agent-server/protocol";
import { canResume, type TuiModel } from "./model.js";

export interface ThreadEntry { thread: Thread; title: string; updatedAtMs: number }
export const shortId = (id: string) => id.slice(0, 11);
export function sortThreads(entries: ThreadEntry[]): ThreadEntry[] {
  return entries.toSorted((a, b) => b.updatedAtMs - a.updatedAtMs || a.thread.id.localeCompare(b.thread.id));
}
export class Sessions {
  busy = false;
  private discarded = false;
  rejectInput(): void {
    this.discarded = true;
    this.model.message = "会话操作进行中，本次按键已丢弃（Esc 也不取消在途操作）；完成后请重试";
    this.model.changed();
  }
  constructor(private client: AgentClient, private model: TuiModel) {}
  async run(command: string, argument = ""): Promise<void> {
    if (this.busy) { this.rejectInput(); return; }
    if (this.client.state !== "connected") throw new Error("连接尚未恢复，输入已保留");
    this.busy = true;
    this.discarded = false;
    this.model.sessionOperation = command;
    this.model.changed();
    try {
      if (command === "/threads" || (command === "/resume" && !argument)) {
        const entries: ThreadEntry[] = [];
        let cursor: string | undefined;
        do {
          const page = await this.client.request("thread/list", { cursor, limit: 100 });
          for (const thread of page.threads) {
            let itemCursor: string | undefined, title = thread.title, updatedAtMs = Math.max(thread.createdAtMs, thread.closedAtMs ?? 0);
            do {
              const page = await this.client.request("thread/items/list", { threadId: thread.id, cursor: itemCursor, limit: 1000, direction: "asc" });
              for (const item of page.items) {
                updatedAtMs = Math.max(updatedAtMs, item.startedAtMs, item.completedAtMs ?? 0);
                if (!title && item.type === "userMessage") title = item.payload.content.filter(c => c.type === "text").map(c => c.text).join(" ");
              }
              itemCursor = page.nextCursor ?? undefined;
            } while (itemCursor);
            entries.push({ thread, title: title || "（空会话）", updatedAtMs });
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        this.model.picker = { entries: sortThreads(entries), index: 0 };
        this.model.message = `已加载 ${entries.length} 个会话`;
      } else if (command === "/resume") await this.attach(argument);
      else {
        const current = this.model.thread;
        if (!current) throw new Error("尚未 attach 会话");
        if (current.backend === "external") throw new Error("External thread 为只读");
        const { thread } = command === "/fork"
          ? await this.client.request("thread/fork", { threadId: current.id, clientThreadId: crypto.randomUUID() })
          : await this.client.request("thread/start", { backend: current.backend, cwd: current.cwd, model: current.model, clientThreadId: crypto.randomUUID() });
        await this.attach(thread.id);
      }
    } finally {
      this.busy = false; this.model.sessionOperation = undefined;
      if (this.discarded) this.model.message += " · 操作期间的按键已丢弃，请重新输入";
      this.model.changed();
    }
  }
  private async attach(threadId: string): Promise<void> {
    const previous = this.model.thread?.id;
    let snapshot = await this.client.request("thread/attach", { threadId });
    if (canResume(snapshot.thread)) {
      this.model.message = "正在恢复会话引擎…"; this.model.changed();
      await this.client.request("thread/resume", { threadId });
      snapshot = await this.client.request("thread/attach", { threadId });
    }
    this.model.select(snapshot);
    this.model.message = `已切换会话 ${threadId}`;
    if (previous && previous !== threadId) await this.client.request("thread/detach", { threadId: previous });
  }
}
