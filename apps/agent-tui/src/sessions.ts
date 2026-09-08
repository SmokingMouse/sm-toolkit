import type { AgentClient } from "@smokingmouse/agent-server/client";
import type { Item, Thread } from "@smokingmouse/agent-server/protocol";
import { canResume, type TuiModel } from "./model.js";
import { forkEntries } from "./fork.js";

export interface ThreadEntry { thread: Thread; title: string; updatedAtMs: number }
export const shortId = (id: string) => id.slice(0, 11);
export function sortThreads(entries: ThreadEntry[]): ThreadEntry[] {
  return entries.toSorted((a, b) => b.updatedAtMs - a.updatedAtMs || a.thread.id.localeCompare(b.thread.id));
}
export class Sessions {
  busy = false;
  get scanning(): boolean { return this.busy && this.model.sessionOperation === "/threads"; }
  rejectInput(): void {
    this.model.discardNote = "操作期间的按键已丢弃，请重新输入";
    this.model.changed();
  }
  constructor(private client: AgentClient, private model: TuiModel) {}
  async run(command: string, argument = "", confirmClosed = false, forkTip = false): Promise<void> {
    if (this.busy) { this.rejectInput(); return; }
    if (this.client.state !== "connected") throw new Error("连接尚未恢复，输入已保留");
    this.busy = true;
    this.model.discardNote = "";
    this.model.message = `正在执行 ${command}…`;
    this.model.sessionOperation = command === "/resume" && !argument ? "/threads" : command;
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
        this.model.forkPicker = undefined;
        this.model.message = `已加载 ${entries.length} 个会话`;
      } else if (command === "/resume") await this.attach(argument, confirmClosed);
      else {
        const current = this.model.thread;
        if (!current) throw new Error("尚未 attach 会话");
        if (current.backend === "external") throw new Error("External thread 为只读");
        if (command === "/fork") {
          const supported = this.client.initializeResult?.capabilities.midThreadFork === true;
          if (!forkTip && (!argument || !supported)) {
            const items: Item[] = [];
            if (supported) {
              let cursor: string | undefined;
              do {
                const page = await this.client.request("thread/items/list", { threadId: current.id, cursor, limit: 1000, direction: "asc" });
                items.push(...page.items); cursor = page.nextCursor ?? undefined;
              } while (cursor);
            }
            const entries = forkEntries(items);
            this.model.picker = undefined;
            this.model.forkPicker = { threadId: current.id, entries: entries.length ? entries : [{ type: "末尾分叉", summary: supported ? "空会话" : "仅支持从末尾分叉" }], index: 0 };
            this.model.message = supported ? "选择分叉边界（包含选中的 item）" : "当前 daemon 不支持从中间分叉";
            return;
          }
        }
        const { thread } = command === "/fork"
          ? await this.client.request("thread/fork", { threadId: current.id, clientThreadId: crypto.randomUUID(), ...(argument && !forkTip ? { fromItemId: argument } : {}) })
          : await this.client.request("thread/start", { backend: current.backend, cwd: current.cwd, model: current.model, clientThreadId: crypto.randomUUID() });
        await this.attach(thread.id);
      }
    } finally {
      this.busy = false; this.model.sessionOperation = undefined;
      this.model.changed();
    }
  }
  private async attach(threadId: string, confirmClosed = false): Promise<void> {
    const previous = this.model.thread?.id;
    let snapshot = await this.client.request("thread/attach", { threadId });
    try {
      if (snapshot.thread.status.type === "closed" && canResume(snapshot.thread) && !confirmClosed) {
        if (previous !== threadId) await this.client.request("thread/detach", { threadId });
        this.model.resumeConfirmation = threadId;
        this.model.message = `会话 ${threadId} 已关闭；恢复会重新启动引擎`;
        return;
      }
      if (canResume(snapshot.thread)) {
        this.model.message = "正在恢复会话引擎…"; this.model.changed();
        await this.client.request("thread/resume", { threadId });
        snapshot = await this.client.request("thread/attach", { threadId });
      }
    } catch (error) {
      // Keep the visible thread subscribed; only roll back the attempted switch.
      if (previous !== threadId) {
        try { await this.client.request("thread/detach", { threadId }); }
        catch (cleanup) { throw new Error(`${String(error)}；清理目标订阅失败：${String(cleanup)}`); }
      }
      throw error;
    }
    this.model.select(snapshot);
    this.model.message = `已切换会话 ${threadId}`;
    if (previous && previous !== threadId) await this.client.request("thread/detach", { threadId: previous });
  }
}
