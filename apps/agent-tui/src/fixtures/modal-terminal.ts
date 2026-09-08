// PTY fixture: real terminal, input decoder, controller and renderer; only RPCs are fake.
import { renameSync, writeFileSync } from "node:fs";
import type { AgentClient } from "@smokingmouse/agent-server/client";
import type { PendingServerRequest, Thread } from "@smokingmouse/agent-server/protocol";
import { TuiModel } from "../model.js";
import { runTerminal } from "../terminal.js";
import { focusStack } from "../focus.js";

const [mode, output] = process.argv.slice(2);
const model = new TuiModel(), calls: Array<{ method: string; params: any }> = [];
const thread = (id: string): Thread => ({ id, backend: "claude", engineThreadId: null, cwd: process.env.HOME!, createdAtMs: 1, status: { type: id === "closed" ? "closed" : "idle" } });
model.thread = thread("source"); model.connection = "connected"; model.input = "message-draft";
model.launchPermission = "default";
model.tasksVisible = true;
model.logs.push({ time: Date.now(), subtype: "fixture", summary: "log-visible", category: "other", error: false } as any);
model.items.set("item", { id: "item", seq: 1, turnId: "turn", startedAtMs: 1, type: "agentMessage", payload: { text: "timeline" } });
const entries = [{ itemId: "item", seq: 1, type: "agentMessage", summary: "timeline" }];
if (mode === "threads") model.picker = { entries: [{ thread: thread("target"), title: "target", updatedAtMs: 1 }], index: 0 };
if (mode === "fork" || mode.includes("card")) model.forkPicker = { threadId: "source", entries, index: 0 };
if (mode === "permissions") model.permissionPicker = 0;
if (mode === "completion") { model.input = "@"; model.completion = { prefix: "@", start: 0, selected: 0, candidates: [{ name: "file.txt", description: "file" }], draft: "@" }; }
if (mode === "rewind") model.rewindConfirmation = { threadId: "source", request: { command: "/rewind", subtype: "rewind_conversation", params: { target_message_uuid: "native" } } };
if (mode === "resume") model.resumeConfirmation = "closed";
if (mode === "busy") model.sessionOperation = "/new";
const pendingRequests = new Map();
if (mode.includes("card")) {
  const params = { requestId: "card", threadId: "source", turnId: "turn", itemId: "item", startedAtMs: 1 };
  const request: PendingServerRequest = mode.includes("question")
    ? { method: "item/tool/requestUserInput", params: { ...params, isBlocking: true, questions: [{ id: "q", question: "Answer?", options: [{ label: "one" }, { label: "two" }] }] } }
    : { method: "item/commandExecution/requestApproval", params: { ...params, command: "sensitive-command", cwd: process.env.HOME! } };
  model.request(request);
  if (mode.includes("sending")) { model.activeCard!.state = "sending"; model.activeCard!.replying = true; }
  pendingRequests.set("card", { ...request, id: 1, respond(params: any) {
    calls.push({ method: "card/respond", params }); model.activeCard!.state = "resolved"; model.changed();
  } });
}
const client = {
  state: "connected", clientId: "fixture", options: { requestTimeoutMs: 100 }, pendingRequests,
  initializeResult: { capabilities: { midThreadFork: true } },
  onStateChange: () => () => {}, onNotification: () => () => {},
  async request(method: string, params: any) {
    calls.push({ method, params });
    if (method === "thread/lease/acquire") return { lease: { expiresAtMs: Date.now() + 30000 } };
    if (method === "thread/list") return { threads: [thread("target")], nextCursor: null };
    if (method === "thread/items/list") return { items: [], nextCursor: null };
    if (method === "thread/attach") return { thread: { ...thread(params.threadId), status: { type: "idle" } }, items: [], pendingRequests: [], queue: [], nextSeq: 1 };
    if (method === "thread/start" || method === "thread/fork") return { thread: thread("target") };
    if (method === "thread/permission/set") return { thread: { ...model.thread, permission: params.permission } };
    if (method === "thread/engineControl" || method === "thread/effort/set") return { response: { subtype: "success", response: { rewound: true } } };
    if (method === "turn/start") return { turn: { id: "new-turn", status: "running" } };
    return {};
  },
} as unknown as AgentClient;
let revision = 0;
const save = () => {
  writeFileSync(`${output}.tmp`, JSON.stringify({ revision: ++revision, calls, input: model.input, card: model.cards.get("card"), focus: focusStack(model), log: model.logExpanded, reasoning: model.expandedReasoning, plan: model.expandedPlan, panelFocus: model.panelFocus, message: model.message, discardNote: model.discardNote, thread: model.thread?.id, rewind: model.rewindConfirmation, resume: model.resumeConfirmation }));
  renameSync(`${output}.tmp`, output);
};
model.onChange(save); save();
await runTerminal(client, model);
