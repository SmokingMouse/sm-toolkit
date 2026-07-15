/**
 * REST client + SSE reader（harbor CLI 用）。
 */

import type {
  Conversation,
  ConversationStatus,
  Device,
  HarborAgent,
  Run,
  RunStreamFrame,
} from "../protocol.js";

export class HarborClient {
  constructor(
    private base: string,
    private tok: string,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.tok}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error(`无法连接 harbor-server（${this.base}）：${e instanceof Error ? e.message : e}`);
    }
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg;
      } catch {}
      throw new Error(msg);
    }
    return res.json() as Promise<T>;
  }

  devices(): Promise<Device[]> {
    return this.req("GET", "/api/devices");
  }

  agents(): Promise<HarborAgent[]> {
    return this.req("GET", "/api/agents");
  }

  createAgent(body: Record<string, unknown>): Promise<HarborAgent> {
    return this.req("POST", "/api/agents", body);
  }

  conversations(q: { kind?: string; status?: string }): Promise<(Conversation & { agentName: string })[]> {
    const params = new URLSearchParams();
    if (q.kind) params.set("kind", q.kind);
    if (q.status) params.set("status", q.status);
    const qs = params.toString();
    return this.req("GET", `/api/conversations${qs ? `?${qs}` : ""}`);
  }

  createConversation(body: Record<string, unknown>): Promise<Conversation> {
    return this.req("POST", "/api/conversations", body);
  }

  getConversation(id: string): Promise<{ conversation: Conversation; agent: HarborAgent | null; runs: Run[] }> {
    return this.req("GET", `/api/conversations/${encodeURIComponent(id)}`);
  }

  setConversationStatus(id: string, status: ConversationStatus): Promise<Conversation> {
    return this.req("PATCH", `/api/conversations/${encodeURIComponent(id)}`, { status });
  }

  createRun(conversationId: string, prompt: string): Promise<Run> {
    return this.req("POST", `/api/conversations/${encodeURIComponent(conversationId)}/runs`, { prompt });
  }

  getRun(id: string): Promise<Run> {
    return this.req("GET", `/api/runs/${encodeURIComponent(id)}`);
  }

  /** SSE：手写解析（data: 行 + \n\n 分帧），done 帧后 server 关流、生成器自然结束 */
  async *watchRun(runId: string): AsyncGenerator<RunStreamFrame> {
    const res = await fetch(`${this.base}/api/runs/${encodeURIComponent(runId)}/events`, {
      headers: { Authorization: `Bearer ${this.tok}` },
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg;
      } catch {}
      throw new Error(msg);
    }
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data: ")) {
            yield JSON.parse(line.slice(6)) as RunStreamFrame;
          }
          // ": ping" 保活注释帧直接忽略
        }
      }
    }
  }
}
