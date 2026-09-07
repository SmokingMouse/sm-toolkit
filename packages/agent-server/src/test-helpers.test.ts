import { expect } from "bun:test";
import { AgentServer, MockEngine, type Frame, type InProcessClient, type ServerOptions, type ServerRequestMethod } from "./index.js";

export const capability: ServerRequestMethod = "item/commandExecution/requestApproval";
export async function client(server: AgentServer, name = "test", capabilities: ServerRequestMethod[] = [capability]): Promise<InProcessClient> {
  const c = server.connectInProcess();
  await c.request("initialize", { protocolVersion: "as/1", client: { name, version: "1", kind: "test", label: name }, capabilities: { serverRequests: capabilities } });
  await c.notifyInitialized(); return c;
}
export async function flush(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)); }
export async function until(predicate: () => boolean, description = "condition"): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${description}`); await flush(); }
}
export function capture(c: InProcessClient): Frame[] { const frames: Frame[] = []; c.onFrame(frame => frames.push(frame)); return frames; }
export function setup(options: ServerOptions = {}) {
  const engines: MockEngine[] = [];
  const server = new AgentServer({ databasePath: ":memory:", engineFactory: () => { const engine = new MockEngine(); engines.push(engine); return engine; }, idleTimeoutMs: 0, ...options });
  return { server, engines };
}
export function expectCode(fn: () => unknown, code: number): void { try { fn(); throw new Error("expected failure"); } catch (error) { expect((error as { code: number }).code).toBe(code); } }
export const input = (text: string) => [{ type: "text" as const, text }];
