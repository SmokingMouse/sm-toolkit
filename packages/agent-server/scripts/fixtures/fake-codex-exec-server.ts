import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Offline stdio peer that reproduces codex 0.153.4's exec lifetime instead of its full
// conversation: a command runs in a shell, and turn/interrupt signals only that shell.
// Whatever the shell started is reparented to init and keeps running — the leak this
// fixture exists to prove. Wire shapes come from the pinned generated schema; this
// process never imports an SDK, reads credentials, or makes network requests.
const command = process.env.FAKE_EXEC_COMMAND ?? "sleep 600";
let initialized = false, acknowledged = false, turnId = "", turns = 0;
let shell: ReturnType<typeof spawn> | undefined;
let cwd = process.cwd();
const threadId = "native-exec-thread";
const send = (frame: unknown) => { process.stdout.write(JSON.stringify(frame) + "\n"); };
const notify = (method: string, params: unknown) => send({ method, params });
const turn = (status = "inProgress") => ({ id: turnId, items: [], status, error: null });
const base = () => ({ threadId, turnId });
const commandItem = (status: string) => ({ id: `command-${turns}`, type: "commandExecution", command, cwd, commandActions: [], processId: shell?.pid ?? null, status, aggregatedOutput: null, exitCode: null, durationMs: null });

function handle(frame: any): void {
  if (!frame.method) return; // this peer issues no reverse requests
  if (frame.method === "initialize") {
    assert.equal(initialized, false); initialized = true;
    send({ id: frame.id, result: { userAgent: "codex/0.153.4", codexHome: "/tmp/fake-codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  assert.ok(initialized, "initialize must be first");
  if (frame.method === "initialized") { acknowledged = true; return; }
  assert.ok(acknowledged, "initialized notification must precede methods");
  const p = frame.params;
  if (frame.method === "thread/start") {
    cwd = p.cwd ?? cwd;
    const thread = { id: threadId, sessionId: threadId, cliVersion: "0.153.4", cwd, ephemeral: false, createdAt: 1, updatedAt: 1, modelProvider: "fake", preview: "", projectId: null, source: "vscode", status: { type: "idle" }, turns: [] };
    send({ id: frame.id, result: { thread, model: p.model ?? "model-from-config", modelProvider: "fake", cwd, reasoningEffort: null, approvalPolicy: p.approvalPolicy ?? "never", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" } } });
    notify("thread/started", { thread }); notify("thread/status/changed", { threadId, status: { type: "idle" } });
    return;
  }
  assert.equal(p.threadId, threadId, "must use engine thread id");
  if (frame.method === "turn/start") {
    turnId = `native-turn-${++turns}`;
    const user = { id: `user-${turns}`, type: "userMessage", content: p.input, clientId: null };
    notify("item/started", { ...base(), startedAtMs: Date.now(), item: user });
    notify("item/completed", { ...base(), completedAtMs: Date.now(), item: user });
    notify("turn/started", { threadId, turn: turn() });
    send({ id: frame.id, result: { turn: turn() } });
    notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
    // The app-server runs `/bin/zsh -lc '<cmd>'`; `; :` keeps the shell from
    // exec-replacing itself, so the command becomes a grandchild exactly as it does
    // in production. No detach: the tree inherits the app-server's process group.
    shell = spawn("/bin/sh", ["-c", `${command}; :`], { cwd, stdio: "ignore" });
    notify("item/started", { ...base(), startedAtMs: Date.now(), item: commandItem("inProgress") });
    return;
  }
  if (frame.method === "turn/interrupt") {
    assert.equal(p.turnId, turnId, "interrupt requires native turn id");
    // Exactly what codex does: signal the shell it spawned, never walk its subtree.
    if (shell?.pid) try { process.kill(shell.pid, "SIGKILL"); } catch {}
    send({ id: frame.id, result: {} });
    // The command item is left inProgress, as codex leaves it; AS closes it itself.
    setTimeout(() => {
      notify("turn/completed", { threadId, turn: turn("interrupted") });
      notify("thread/status/changed", { threadId, status: { type: "idle" } });
    }, 60);
    return;
  }
  throw new Error(`Unexpected client method: ${frame.method}`);
}
createInterface({ input: process.stdin }).on("line", line => {
  try { handle(JSON.parse(line)); }
  catch (error) { process.stderr.write(String(error) + "\n"); process.exit(81); }
});
