/**
 * 通用 Mock 后端 —— 返回注入的文本(分块流),不调真实 CLI。
 * 用于测试 / 离线开发。业务 canned 内容(如 trellis 的 mock-responses)由上游构造时注入。
 * 移植自 agent-gateway src/mock.ts,原样搬入。
 */

import { EventType, type AgentEvent } from "../events.js";
import type { Backend, RunOptions } from "../backend.js";

export class MockBackend implements Backend {
  readonly name: string;
  #response: string;
  #chunkSize: number;

  constructor(opts: { name?: string; response?: string; chunkSize?: number } = {}) {
    this.name = opts.name ?? "mock";
    this.#response = opts.response ?? "This is a mock response.";
    this.#chunkSize = opts.chunkSize ?? 8;
  }

  capabilities(): Record<string, unknown> {
    return {
      workspace: false,
      tools: false,
      vision: false,
      streaming: "token",
      costInStream: false,
      resume: false,
    };
  }

  async *run(_prompt: string, opts: RunOptions): AsyncGenerator<AgentEvent> {
    const sid = opts.resume ?? "mock-session";
    yield ev(this.name, EventType.SessionStart, sid, { tools: [], model: "mock" });
    // 分块吐文本,模拟逐 token 流
    const chunks = this.#response.match(new RegExp(`[\\s\\S]{1,${this.#chunkSize}}`, "g")) ?? [];
    for (const c of chunks) {
      yield ev(this.name, EventType.TextChunk, sid, { text: c });
    }
    yield ev(this.name, EventType.Result, sid, {
      text: this.#response,
      cost: {
        usd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheCreation: 0,
        estimated: false,
        contextTokens: null,
      },
    });
  }
}

function ev(
  backend: string,
  type: EventType,
  sessionId: string | null,
  data: Record<string, unknown>,
): AgentEvent {
  return { type, backend, sessionId, data };
}
