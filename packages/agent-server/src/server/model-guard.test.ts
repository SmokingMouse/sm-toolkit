import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentServer, MockEngine, type ServerOptions } from "../index.js";
import { capture, input, setup } from "../test-helpers.test.js";
import { readConfig } from "../daemon/runtime.js";

const servers: AgentServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });
async function fixture(options: ServerOptions = {}, engineEvents = true) {
  const f = setup(options); servers.push(f.server);
  const c = f.server.connectInProcess();
  await c.request("initialize", { protocolVersion: "as/1", client: { name: "guard", version: "1", kind: "test", label: "guard" }, capabilities: { engineEvents } });
  await c.notifyInitialized();
  return { ...f, c, frames: capture(c) };
}
const audit = (frames: ReturnType<typeof capture>) => frames.filter(f => "method" in f && f.method === "thread/engineEvent" && f.params.subtype === "model_denied");

describe("model guard", () => {
  for (const backend of ["claude", "codex"] as const) {
    test(`${backend}: missing/empty/default model rejects before spawn with actionable data`, async () => {
      const { c, server, engines } = await fixture();
      for (const model of [undefined, "", "  ", "default", "DEFAULT"]) {
        await expect(c.request("thread/start", { backend, model })).rejects.toMatchObject({ code: -32602, data: { reason: "model_required", retryable: false, detail: { hint: expect.stringContaining("explicit") } } });
      }
      expect(engines).toHaveLength(0); expect(server.log.allThreads()).toHaveLength(0);
    });
    test(`${backend}: fable aliases and case variants reject and emit model_denied`, async () => {
      const { c, frames, server, engines } = await fixture();
      for (const model of ["fable", "FABLE", "FaBlE", "fable-5-1", "claude-fable-5-1", "CLAUDE-FABLE-5-1", "  Claude-Fable-5-1  "]) {
        await expect(c.request("thread/start", { backend, model })).rejects.toMatchObject({ code: -32602, data: { reason: "model_denied", detail: { model: model.trim() } } });
      }
      expect(audit(frames)).toHaveLength(7);
      expect(engines).toHaveLength(0); expect(server.log.allThreads()).toHaveLength(0);
      expect(audit(frames)[0]).toMatchObject({ params: { backend, payload: { pattern: "fable" } } });
    });
    test(`${backend}: unknown resume requires model; configured default is persisted and inherited by fork`, async () => {
      const missing = await fixture();
      await expect(missing.c.request("thread/resume", { backend, engineThreadId: "native", cwd: process.cwd() })).rejects.toMatchObject({ code: -32602, data: { reason: "model_required" } });
      await expect(missing.c.request("thread/resume", { backend, engineThreadId: "native", cwd: process.cwd(), model: "FaBlE" })).rejects.toMatchObject({ code: -32602, data: { reason: "model_denied" } });
      expect(missing.engines).toHaveLength(0); expect(audit(missing.frames)).toHaveLength(1);
      const f = await fixture({ defaultModel: "explicit-model" });
      const { thread } = await f.c.request("thread/resume", { backend, engineThreadId: "native", cwd: process.cwd() });
      expect(thread.model).toBe("explicit-model");
      expect(f.server.log.options(thread.id).model).toBe("explicit-model");
      const fork = await f.c.request("thread/fork", { threadId: thread.id });
      expect(fork.thread.model).toBe("explicit-model");
      expect(f.engines[1].options?.model).toBe("explicit-model");
    });
    test(`${backend}: legacy missing or denied saved model cannot resume or fork`, async () => {
      const f = await fixture();
      const { thread } = await f.c.request("thread/start", { backend, model: "sonnet" });
      await f.c.request("thread/close", { threadId: thread.id });
      for (const model of [undefined, "claude-fable-5-1"]) {
        f.server.log.saveOptions(thread.id, { ...f.server.log.options(thread.id), model });
        const reason = model ? "model_denied" : "model_required";
        await expect(f.c.request("thread/resume", { threadId: thread.id })).rejects.toMatchObject({ code: -32602, data: { reason } });
        await expect(f.c.request("thread/fork", { threadId: thread.id })).rejects.toMatchObject({ code: -32602, data: { reason } });
        expect(f.server.threads.get(thread.id).status.type).toBe("closed");
      }
      expect(f.engines).toHaveLength(1); expect(f.server.log.allThreads()).toHaveLength(1);
      expect(audit(f.frames)).toHaveLength(2);
    });
    test(`${backend}: denied turn override cannot enter the queue`, async () => {
      const f = await fixture();
      const { thread } = await f.c.request("thread/start", { backend, model: "sonnet" });
      await expect(f.c.request("turn/start", { threadId: thread.id, input: input("go"), model: "FABLE" })).rejects.toMatchObject({ code: -32602, data: { reason: "model_denied" } });
      expect(f.server.log.turns(thread.id)).toHaveLength(0); expect(f.engines[0].sent).toHaveLength(0);
      expect(audit(f.frames)).toHaveLength(1);
    });
  }

  test("set_model escalation and native default reset never reach engine or mutate saved model", async () => {
    const calls: unknown[] = [];
    class Controlled extends MockEngine {
      async engineControl(subtype: string, params: Record<string, unknown>) { calls.push({ subtype, params }); return { response: { subtype: "success" } }; }
    }
    const f = await fixture({ engineFactory: () => new Controlled() });
    const { thread } = await f.c.request("thread/start", { backend: "claude", model: "sonnet" });
    for (const model of ["fable", "CLAUDE-FABLE-5-1", "FaBlE"]) {
      await expect(f.c.request("thread/engineControl", { threadId: thread.id, subtype: "set_model", params: { model } })).rejects.toMatchObject({ code: -32602, data: { reason: "model_denied" } });
    }
    for (const params of [{}, { model: null }, { model: "default" }, { model: "" }, { model: 42 }]) {
      await expect(f.c.request("thread/engineControl", { threadId: thread.id, subtype: "set_model", params })).rejects.toMatchObject({ code: -32602, data: { reason: "model_required" } });
    }
    await expect(f.c.request("thread/resume", { threadId: thread.id, model: "fable" })).rejects.toMatchObject({ code: -32602 });
    expect(calls).toHaveLength(0); expect(audit(f.frames)).toHaveLength(4);
    expect(f.server.log.options(thread.id).model).toBe("sonnet"); expect(f.server.threads.get(thread.id).model).toBe("sonnet");
    await f.c.request("thread/engineControl", { threadId: thread.id, subtype: "set_model", params: { model: "opus" } });
    expect(calls).toEqual([{ subtype: "set_model", params: { model: "opus" } }]);
  });

  test("denied audit honors engineEvents capability", async () => {
    const f = await fixture({}, false);
    await expect(f.c.request("thread/start", { backend: "claude", model: "fable" })).rejects.toMatchObject({ code: -32602 });
    expect(audit(f.frames)).toHaveLength(0);
  });

  test("config overrides defaults: prefix/glob matching, empty deny list, default_model precedence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "as-model-config-")), path = join(dir, "config.toml");
    try {
      writeFileSync(path, 'denied_models = ["OPUS", "*-private-?", "literal.+*"]\ndefault_model = "sonnet"\n');
      expect(readConfig(path)).toEqual({ deniedModels: ["OPUS", "*-private-?", "literal.+*"], defaultModel: "sonnet" });
      const f = await fixture(readConfig(path));
      for (const model of ["opus-4", "a-private-x", "literal.+abc"]) await expect(f.c.request("thread/start", { backend: "claude", model })).rejects.toMatchObject({ code: -32602, data: { reason: "model_denied" } });
      expect((await f.c.request("thread/start", { backend: "claude" })).thread.model).toBe("sonnet");
      expect((await f.c.request("thread/start", { backend: "claude", model: "haiku" })).thread.model).toBe("haiku");
      expect((await f.c.request("thread/start", { backend: "claude", model: "fable" })).thread.model).toBe("fable");
      writeFileSync(path, 'denied_models = []\ndefault_model = "claude-fable-5-1"\n');
      const empty = await fixture(readConfig(path));
      expect((await empty.c.request("thread/start", { backend: "claude" })).thread.model).toBe("claude-fable-5-1");
      const deniedDefault = await fixture({ defaultModel: "fable" });
      await expect(deniedDefault.c.request("thread/start", { backend: "codex" })).rejects.toMatchObject({ code: -32602, data: { reason: "model_denied" } });
      for (const config of ['default_model = ""', 'default_model = "default"', 'denied_models = "fable"', 'denied_models = [""]']) {
        writeFileSync(path, config); expect(() => readConfig(path)).toThrow();
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("set_model reset uses configured explicit default", async () => {
    const calls: unknown[] = [];
    class Controlled extends MockEngine {
      async engineControl(_subtype: string, params: Record<string, unknown>) { calls.push(params); return { response: { subtype: "success" } }; }
    }
    const f = await fixture({ defaultModel: "haiku", engineFactory: () => new Controlled() });
    const { thread } = await f.c.request("thread/start", { backend: "claude", model: "sonnet" });
    for (const params of [{}, { model: null }, { model: "default" }]) await f.c.request("thread/engineControl", { threadId: thread.id, subtype: "set_model", params });
    expect(calls).toEqual([{ model: "haiku" }, { model: "haiku" }, { model: "haiku" }]);
  });
});
