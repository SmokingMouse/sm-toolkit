import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Offline stdio peer. Wire shapes were taken from codex-cli 0.153.4's generated
// schema; this process never imports an SDK, reads credentials, or makes requests.
const scenario = process.env.FAKE_CODEX_SCENARIO ?? "conversation";
const trace = process.env.FAKE_CODEX_TRACE;
const record = (direction: string, frame: unknown) => { if (trace) appendFileSync(trace, JSON.stringify({ direction, frame }) + "\n"); };
const send = (frame: unknown) => { record("out", frame); process.stdout.write(JSON.stringify(frame) + "\n"); };
const notify = (method: string, params: unknown) => send({ method, params });
const reply = (id: string | number, result: unknown) => send({ id, result });
let initialized = false, acknowledged = false, threadId = "native-thread", turnId = "", turns = process.pid * 1000, total = 0;
let cwd = process.cwd();
const pending = new Map<string | number, (frame: any) => void>();
const turn = (status = "inProgress") => ({ id: turnId, items: [], status, error: null });
const base = () => ({ threadId, turnId });
const started = (item: unknown) => notify("item/started", { ...base(), startedAtMs: Date.now(), item });
const completed = (item: unknown) => notify("item/completed", { ...base(), completedAtMs: Date.now(), item });
const request = (id: string | number, method: string, params: unknown, callback: (frame: any) => void) => { pending.set(id, callback); send({ id, method, params }); };
function finish(status = "completed") {
  notify("turn/completed", { threadId, turn: turn(status) });
  notify("thread/status/changed", { threadId, status: { type: "idle" } });
}
function message(text: string) {
  const id = `answer-${turns}`;
  started({ type: "agentMessage", id, text: "", phase: "final_answer" });
  notify("item/agentMessage/delta", { ...base(), itemId: id, delta: text.slice(0, 2) });
  notify("item/agentMessage/delta", { ...base(), itemId: id, delta: text.slice(2) });
  completed({ type: "agentMessage", id, text, phase: "final_answer" });
}
function tokens() {
  total++;
  const breakdown = (n: number) => ({ inputTokens: 10 * n, outputTokens: 3 * n, cachedInputTokens: 4 * n, cacheWriteInputTokens: n, reasoningOutputTokens: n, totalTokens: 13 * n });
  notify("thread/tokenUsage/updated", { ...base(), tokenUsage: { last: breakdown(1), total: breakdown(total), modelContextWindow: 200000 } });
}
function conversation() {
  const thinking = { id: `reasoning-${turns}`, type: "reasoning", summary: [], content: [] };
  started(thinking);
  notify("item/reasoning/summaryPartAdded", { ...base(), itemId: thinking.id, summaryIndex: 0 });
  notify("item/reasoning/summaryTextDelta", { ...base(), itemId: thinking.id, summaryIndex: 0, delta: "Inspect" });
  notify("item/reasoning/summaryTextDelta", { ...base(), itemId: thinking.id, summaryIndex: 1, delta: "Verify" });
  notify("item/reasoning/textDelta", { ...base(), itemId: thinking.id, contentIndex: 0, delta: "Reason" });
  completed({ ...thinking, summary: ["Inspect", "Verify"], content: ["Reason"] });
  const command = { id: `command-${turns}`, type: "commandExecution", command: "pwd", cwd, commandActions: [{ type: "unknown", command: "pwd" }], processId: null, status: "inProgress", aggregatedOutput: null, exitCode: null, durationMs: null };
  started(command);
  request(71, "item/commandExecution/requestApproval", { ...base(), itemId: command.id, startedAtMs: Date.now(), command: null, cwd: null, approvalId: "nested-approval", reason: "Inspect cwd", proposedExecpolicyAmendment: ["pwd"] }, frame => {
    assert.equal(frame.result.decision, "acceptForSession");
    notify("serverRequest/resolved", { threadId, requestId: 71 });
    notify("item/commandExecution/outputDelta", { ...base(), itemId: command.id, delta: cwd + "\n" });
    completed({ ...command, aggregatedOutput: cwd + "\n", exitCode: 0, durationMs: 2, status: "completed" });
    const changes = [{ path: `${cwd}/a.txt`, kind: { type: "update", move_path: null }, diff: "-old\n+new" }];
    const file = { id: `file-${turns}`, type: "fileChange", changes, status: "inProgress" };
    started(file);
    notify("item/fileChange/patchUpdated", { ...base(), itemId: file.id, changes });
    request("72", "item/fileChange/requestApproval", { ...base(), itemId: file.id, startedAtMs: Date.now(), grantRoot: cwd, reason: null }, frame => {
      assert.equal(frame.result.decision, "decline"); completed({ ...file, status: "declined" });
      request(73, "item/permissions/requestApproval", { ...base(), itemId: `permissions-${turns}`, cwd, permissions: { network: { enabled: true } }, reason: null, startedAtMs: Date.now() }, frame => {
        assert.deepEqual(frame.result, { permissions: { network: { enabled: true } }, scope: "session" });
        request("74", "item/tool/requestUserInput", { ...base(), itemId: `question-${turns}`, isBlocking: true, questions: [{ id: "q", header: "Pick", question: "Which?", isOther: true, isSecret: false, options: [{ label: "a", description: "First" }] }] }, frame => {
          assert.deepEqual(frame.result, { answers: { q: { answers: ["a"] } } });
          notify("turn/plan/updated", { ...base(), explanation: "Done", plan: [{ step: "Inspect", status: "completed" }] });
          notify("turn/diff/updated", { ...base(), diff: "-old\n+new" });
          message("你好，完成"); tokens(); finish();
        });
      });
    });
  });
}
function handle(frame: any) {
  record("in", frame);
  if (!frame.method) { const callback = pending.get(frame.id); assert.ok(callback, "unknown reverse response id"); pending.delete(frame.id); callback(frame); return; }
  if (frame.method === "initialize") {
    assert.equal(initialized, false); assert.ok(frame.params.clientInfo.name); assert.equal(frame.params.capabilities.experimentalApi, true);
    initialized = true;
    if (scenario === "no-handshake") return;
    if (scenario === "bad-handshake") { process.stdout.write("invalid json\n"); return; }
    reply(frame.id, { userAgent: scenario === "version-mismatch" ? "codex/99.0.0" : "codex/0.153.4", codexHome: "/tmp/fake-codex", platformFamily: "unix", platformOs: "macos" }); return;
  }
  assert.ok(initialized, "initialize must be first");
  if (frame.method === "initialized") { acknowledged = true; return; }
  assert.ok(acknowledged, "initialized notification must precede methods");
  const p = frame.params;
  if (frame.method === "thread/start" || frame.method === "thread/resume") {
    if (frame.method === "thread/resume") { assert.ok(p.threadId); threadId = p.threadId; }
    assert.equal(p.serviceTier, "default"); assert.equal(p.approvalsReviewer, "user");
    cwd = p.cwd ?? cwd;
    const thread = { id: threadId, sessionId: threadId, cliVersion: "0.153.4", cwd, ephemeral: false, createdAt: 1, updatedAt: 1, modelProvider: "fake", preview: "", projectId: null, source: "appServer", status: { type: "idle" }, turns: [] };
    reply(frame.id, { thread, model: p.model ?? "model-from-config", modelProvider: "fake", cwd, reasoningEffort: p.config?.model_reasoning_effort ?? null, approvalPolicy: p.approvalPolicy ?? "untrusted", approvalsReviewer: "user", sandbox: { type: "workspaceWrite" } });
    notify("thread/started", { thread }); notify("thread/status/changed", { threadId, status: { type: "idle" } }); return;
  }
  assert.equal(p.threadId, threadId, "must use engine thread id");
  if (frame.method === "turn/start") {
    assert.ok(p.input.length); assert.equal(p.serviceTier, "default");
    if (turnId) notify("turn/started", { threadId, turn: turn() }); // stale prior turn
    turnId = `native-turn-${++turns}`;
    // Both item notifications and turn/started can precede the RPC response.
    const user = { id: `user-${turns}`, type: "userMessage", content: p.input, clientId: p.clientUserMessageId ?? null };
    started(user); completed(user);
    notify("turn/started", { threadId, turn: turn() });
    reply(frame.id, { turn: turn() });
    notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
    if (scenario === "crash") {
      started({ type: "agentMessage", id: `partial-${turns}`, text: "" });
      notify("item/agentMessage/delta", { ...base(), itemId: `partial-${turns}`, delta: "partial" });
      request(99, "item/tool/requestUserInput", { ...base(), itemId: "pending-question", isBlocking: true, questions: [{ id: "q", header: "Wait", question: "Wait?", options: null }] }, () => {});
      setTimeout(() => { process.stderr.write("scripted crash\n"); process.exit(23); }, 80); return;
    }
    if (scenario === "system-error") { notify("thread/status/changed", { threadId, status: { type: "systemError" } }); return; }
    if (scenario === "unknown-item") {
      const item = { id: `unknown-${turnId}`, type: "futureItem", status: "futureStatus" };
      started(item); notify("item/commandExecution/outputDelta", { ...base(), itemId: item.id, delta: "unknown output" }); completed(item);
      message("survived unknown item"); finish(); return;
    }
    if (scenario === "unknown-request") {
      request(911, "future/request", base(), frame => { assert.equal(frame.error.code, -32015); message("unsupported request rejected"); finish(); }); return;
    }
    if (scenario === "cancel-request") {
      request(92, "item/tool/requestUserInput", { ...base(), itemId: "cancel-question", isBlocking: true, questions: [{ id: "q", header: "Pick", question: "Pick?", options: null }] }, () => { throw new Error("cancelled request must not receive a decision"); });
      setTimeout(() => { notify("serverRequest/resolved", { threadId, requestId: 92 }); }, 40); return;
    }
    if (scenario === "native-error") { notify("error", { ...base(), error: { message: "temporary provider error", codexErrorInfo: "serverOverloaded" }, willRetry: true }); message("recovered"); finish(); return; }
    if (scenario === "hold" && p.input[0].text !== "complete") return;
    if (scenario === "conversation") { conversation(); return; }
    message("done"); tokens(); finish(); return;
  }
  if (frame.method === "turn/steer") {
    assert.equal(p.expectedTurnId, turnId, "steer requires native turn id");
    const user = { type: "userMessage", id: `steer-${turns}`, content: p.input, clientId: p.clientUserMessageId ?? null };
    started(user); completed(user); reply(frame.id, { turnId }); return;
  }
  if (frame.method === "turn/interrupt") {
    assert.equal(p.turnId, turnId, "interrupt requires native turn id"); reply(frame.id, {});
    setTimeout(() => finish("interrupted"), 40); return;
  }
  throw new Error(`Unexpected client method: ${frame.method}`);
}
createInterface({ input: process.stdin }).on("line", line => {
  try { handle(JSON.parse(line)); }
  catch (error) { process.stderr.write(String(error) + "\n"); process.exit(81); }
});
