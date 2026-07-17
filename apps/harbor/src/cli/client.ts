/**
 * REST client + SSE reader（harbor CLI 用）。
 */

import type {
  Approval,
  ApprovalStatus,
  Automation,
  AutomationLogRow,
  Conversation,
  ConversationStatus,
  Device,
  HarborAgent,
  HarborRepository,
  HarborWorkspace,
  RepositoryMount,
  Run,
  RunStreamFrame,
  UsageRow,
} from "../protocol.js";

export class HarborClient {
  constructor(
    private base: string,
    private tok: string,
    private workspace?: string,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.tok}`,
          ...(this.workspace ? { "X-Harbor-Workspace": this.workspace } : {}),
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

  workspaces(): Promise<HarborWorkspace[]> {
    return this.req("GET", "/api/workspaces");
  }

  createWorkspace(body: Record<string, unknown>): Promise<HarborWorkspace> {
    return this.req("POST", "/api/workspaces", body);
  }

  repositories(): Promise<(HarborRepository & { mounts: (RepositoryMount & { deviceName: string })[] })[]> {
    return this.req("GET", "/api/repositories");
  }

  createRepository(body: Record<string, unknown>): Promise<HarborRepository> {
    return this.req("POST", "/api/repositories", body);
  }

  mountRepository(id: string, body: Record<string, unknown>): Promise<HarborRepository> {
    return this.req("POST", `/api/repositories/${encodeURIComponent(id)}/mounts`, body);
  }

  agents(): Promise<HarborAgent[]> {
    return this.req("GET", "/api/agents");
  }

  createAgent(body: Record<string, unknown>): Promise<HarborAgent> {
    return this.req("POST", "/api/agents", body);
  }

  conversations(q: { kind?: string; status?: string }): Promise<(Conversation & { agentName: string | null })[]> {
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

  updateConversation(id: string, body: Record<string, unknown>): Promise<Conversation> {
    return this.req("PATCH", `/api/conversations/${encodeURIComponent(id)}`, body);
  }

  createRun(conversationId: string, prompt: string, options?: { agent?: string; purpose?: string }): Promise<Run> {
    return this.req("POST", `/api/conversations/${encodeURIComponent(conversationId)}/runs`, { prompt, ...options });
  }

  dispatchIssue(id: string, agent?: string, prompt?: string): Promise<Run> {
    return this.req("POST", `/api/conversations/${encodeURIComponent(id)}/dispatch`, { agent, prompt });
  }

  requestChanges(id: string, feedback: string, agent?: string): Promise<Run> {
    return this.req("POST", `/api/conversations/${encodeURIComponent(id)}/request-changes`, { feedback, agent });
  }

  reviewIssue(id: string, agent: string, prompt?: string): Promise<Run> {
    return this.req("POST", `/api/conversations/${encodeURIComponent(id)}/review`, { agent, prompt });
  }

  approveIssue(id: string): Promise<Conversation> {
    return this.req("POST", `/api/conversations/${encodeURIComponent(id)}/approve`);
  }

  cancelIssue(id: string): Promise<Conversation> {
    return this.req("POST", `/api/conversations/${encodeURIComponent(id)}/cancel`);
  }

  getRun(id: string): Promise<Run> {
    return this.req("GET", `/api/runs/${encodeURIComponent(id)}`);
  }

  approvals(status?: ApprovalStatus): Promise<Approval[]> {
    return this.req("GET", `/api/approvals${status ? `?status=${status}` : ""}`);
  }

  decideApproval(id: string, behavior: "allow" | "deny"): Promise<Approval> {
    return this.req("POST", `/api/approvals/${encodeURIComponent(id)}`, { behavior });
  }

  automations(): Promise<(Automation & { agentName: string })[]> {
    return this.req("GET", "/api/automations");
  }

  createAutomation(body: Record<string, unknown>): Promise<Automation> {
    return this.req("POST", "/api/automations", body);
  }

  setAutomationEnabled(id: string, enabled: boolean): Promise<Automation> {
    return this.req("PATCH", `/api/automations/${encodeURIComponent(id)}`, { enabled });
  }

  deleteAutomation(id: string): Promise<{ ok: boolean }> {
    return this.req("DELETE", `/api/automations/${encodeURIComponent(id)}`);
  }

  automationLog(id: string): Promise<AutomationLogRow[]> {
    return this.req("GET", `/api/automations/${encodeURIComponent(id)}/log`);
  }

  usage(days: number): Promise<UsageRow[]> {
    return this.req("GET", `/api/usage?days=${days}`);
  }

  usageRuns(q: { days: number; agent?: string; day?: string }): Promise<Run[]> {
    const params = new URLSearchParams({ days: String(q.days) });
    if (q.agent) params.set("agent", q.agent);
    if (q.day) params.set("day", q.day);
    return this.req("GET", `/api/usage/runs?${params.toString()}`);
  }

  /** SSE：手写解析（data: 行 + \n\n 分帧），done 帧后 server 关流、生成器自然结束 */
  async *watchRun(runId: string): AsyncGenerator<RunStreamFrame> {
    const res = await fetch(`${this.base}/api/runs/${encodeURIComponent(runId)}/events`, {
      headers: {
        Authorization: `Bearer ${this.tok}`,
        ...(this.workspace ? { "X-Harbor-Workspace": this.workspace } : {}),
      },
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
