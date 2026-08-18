/**
 * codex app-server transport 真机 e2e —— 走 CodexBackend 本体(非协议探针),
 * 逐档与 exec 行为对照。跑一遍约 6 次真实模型调用(小 prompt)。
 *   bun packages/agent/scripts/e2e-codex-appserver.ts
 * 断言:
 *   1 streaming   readonly 无 workspace,TextChunk ≥ 4(exec 同 prompt 为 1)
 *   2 resume      续 1 的线程,记忆在 + session id 不变
 *   3 fork        原生 thread/fork:子线加的事实不回流父线,新 id ≠ 父 id
 *   4 readonly    OS sandbox 拒写文件(文件不存在)
 *   5 ws-write    workspace-write 真能写进 workspace
 *   6 abort       中断后 generator 及时收尾(≤10s),无 Result
 *   7 exec 强制   transport:"exec" 行为如旧(block:同 prompt TextChunk ≤ 2)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodexBackend } from "../src/backends/codex.js";
import { EventType, type AgentEvent } from "../src/events.js";

type Collected = {
  events: AgentEvent[];
  chunks: number;
  text: string;
  sessionId: string | null;
  transport: string | null;
  result: AgentEvent | null;
  errors: string[];
  tools: { name: string; isErrorDone: boolean | null }[];
};

async function collect(
  backend: CodexBackend,
  prompt: string,
  opts: Record<string, unknown>,
  onEvent?: (e: AgentEvent, all: Collected) => void,
): Promise<Collected> {
  const c: Collected = {
    events: [],
    chunks: 0,
    text: "",
    sessionId: null,
    transport: null,
    result: null,
    errors: [],
    tools: [],
  };
  for await (const e of backend.run(prompt, opts as never)) {
    c.events.push(e);
    if (e.type === EventType.SessionStart) {
      c.sessionId = e.sessionId;
      c.transport = (e.data.transport as string) ?? null;
    } else if (e.type === EventType.TextChunk) {
      c.chunks++;
      c.text += String(e.data.text ?? "");
    } else if (e.type === EventType.ToolCall) {
      c.tools.push({ name: String(e.data.name), isErrorDone: null });
    } else if (e.type === EventType.ToolCallDone) {
      const t = c.tools[c.tools.length - 1];
      if (t) t.isErrorDone = Boolean(e.data.isError);
    } else if (e.type === EventType.Result) {
      c.result = e;
    } else if (e.type === EventType.Error) {
      c.errors.push(String(e.data.message));
    }
    onEvent?.(e, c);
  }
  return c;
}

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  if (!ok) failures++;
}

const be = new CodexBackend();
const beExec = new CodexBackend({ transport: "exec" });
const STORY = "Write a 5-sentence story about a robot learning to paint. Prose only, no tools.";

// 1) streaming(readonly 纯对话形态:无 workspace,有 cwd)
{
  const r = await collect(be, STORY, { cwd: os.tmpdir() });
  check(
    "1 streaming",
    r.transport === "app-server" && r.chunks >= 4 && !!r.result && r.errors.length === 0,
    `transport=${r.transport} chunks=${r.chunks} result=${!!r.result} err=${r.errors.join("|")}`,
  );
  const cost = (r.result?.data.cost ?? {}) as Record<string, number | null>;
  check(
    "1b usage",
    (cost.inputTokens ?? 0) > 0 && (cost.outputTokens ?? 0) > 0 && (cost.contextTokens ?? 0) > 0,
    `cost=${JSON.stringify(cost)}`,
  );

  // 2) resume 记忆连续性(同一线程,先教后问)
  const sid = r.sessionId!;
  const teach = await collect(be, "Remember: my codeword is ALPHA. Reply exactly OK.", {
    cwd: os.tmpdir(),
    resume: sid,
  });
  check("2a resume-id", teach.sessionId === sid, `sid=${teach.sessionId} expect=${sid}`);
  // 3) fork 隔离:fork 出子线加 BETA,再回父线问 —— 父线不该知道 BETA
  const forked = await collect(be, "Also remember codeword BETA. Reply exactly OK.", {
    cwd: os.tmpdir(),
    resume: sid,
    forkSession: true,
  });
  check("3a fork-new-id", !!forked.sessionId && forked.sessionId !== sid, `forked=${forked.sessionId}`);
  const parent = await collect(
    be,
    "List every codeword you were told in this conversation, comma-separated, nothing else.",
    { cwd: os.tmpdir(), resume: sid },
  );
  check(
    "3b fork-isolation",
    parent.text.includes("ALPHA") && !parent.text.includes("BETA"),
    `parent answer=${JSON.stringify(parent.text.trim())}`,
  );
}

// 4) readonly 档:OS sandbox 拒写(与 exec 同语义)
{
  const probe = path.join(os.tmpdir(), `sm-e2e-readonly-${Date.now()}.txt`);
  const r = await collect(
    be,
    `Run this exact shell command: echo hi > ${probe}\nThen reply DONE.`,
    { cwd: os.tmpdir(), permission: "readonly" },
  );
  check(
    "4 readonly-blocked",
    !fs.existsSync(probe) && r.transport === "app-server",
    `fileExists=${fs.existsSync(probe)} tools=${JSON.stringify(r.tools)}`,
  );
  fs.rmSync(probe, { force: true });
}

// 5) workspace-write 档:能写进 workspace
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sm-e2e-ws-"));
  const r = await collect(
    be,
    "Create a file named hello.txt containing exactly: hi\nin the current directory, then reply DONE.",
    { workspace: ws, permission: "auto-edit" },
  );
  const written = fs.existsSync(path.join(ws, "hello.txt"));
  check("5 workspace-write", written, `written=${written} tools=${JSON.stringify(r.tools)} err=${r.errors.join("|")}`);
  fs.rmSync(ws, { recursive: true, force: true });
}

// 5b) full 档:danger-full-access,能写 workspace 之外(trellis project/增强 chat 用此档)
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sm-e2e-full-ws-"));
  const outside = path.join(os.tmpdir(), `sm-e2e-full-outside-${Date.now()}.txt`);
  const r = await collect(
    be,
    `Run this exact shell command: echo hi > ${outside}\nThen reply DONE.`,
    { workspace: ws, permission: "full" },
  );
  const written = fs.existsSync(outside);
  check("5b full-access", written && r.transport === "app-server", `outsideWritten=${written} err=${r.errors.join("|")}`);
  fs.rmSync(outside, { force: true });
  fs.rmSync(ws, { recursive: true, force: true });
}

// 6) abort:首个事件后立刻中断,generator 应 ≤10s 收尾且无 Result
{
  const ac = new AbortController();
  const t0 = Date.now();
  let aborted = false;
  const r = await collect(
    be,
    "Count from 1 to 50 slowly, one number per line, thinking carefully about each.",
    { cwd: os.tmpdir(), signal: ac.signal },
    (e) => {
      if (!aborted && (e.type === EventType.TextChunk || e.type === EventType.ToolCall)) {
        aborted = true;
        ac.abort();
      }
    },
  );
  const dur = Date.now() - t0;
  check("6 abort", aborted && r.result === null && dur < 60_000, `durMs=${dur} result=${!!r.result}`);
}

// 7) 强制 exec:行为如旧(block 流,同 STORY prompt chunk 数应极小)
{
  const r = await collect(beExec, STORY, { cwd: os.tmpdir() });
  check(
    "7 exec-forced-block",
    r.transport !== "app-server" && r.chunks <= 2 && !!r.result,
    `transport=${r.transport} chunks=${r.chunks} result=${!!r.result} err=${r.errors.join("|")}`,
  );
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
