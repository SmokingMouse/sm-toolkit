/**
 * codex app-server 审批回调 + multi-agent Task 映射真机 e2e(走 CodexBackend 本体)。
 *   bun packages/agent/scripts/e2e-codex-approvals.ts
 * 断言:
 *   1 approve-allow  permission default + onCanUseTool,python3 命令触发回调
 *                    (toolName=Bash, input.command 为裸命令),allow → 命令执行成功
 *   2 approve-deny   deny → item declined,命令未执行(模型答 SKIPPED),run 正常收尾
 *   3 multi-agent    子线不污染主输出:Result 只在主 turn 完成后出现、主文本含乘积、
 *                    spawn_agent 工具卡 + Task started/completed + 子线挂 parentToolUseId
 */
import * as os from "node:os";
import { CodexBackend } from "../src/backends/codex.js";
import { EventType, type AgentEvent } from "../src/events.js";

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  if (!ok) failures++;
}

const be = new CodexBackend();

async function run(
  prompt: string,
  opts: Record<string, unknown>,
): Promise<{ events: AgentEvent[]; text: string; approvals: { toolName: string; input: unknown }[] }> {
  const events: AgentEvent[] = [];
  const approvals: { toolName: string; input: unknown }[] = [];
  let text = "";
  for await (const e of be.run(prompt, opts as never)) {
    events.push(e);
    if (e.type === EventType.TextChunk) text += String(e.data.text ?? "");
  }
  return { events, text, approvals };
}

// 1+2) 审批双路
{
  const seen: { toolName: string; input: Record<string, unknown> }[] = [];
  const allow = await run("Run this exact shell command: python3 -c 'print(6*7)'\nThen reply DONE.", {
    cwd: os.tmpdir(),
    permission: "default",
    persistence: false,
    onCanUseTool: async (req: { toolName: string; input: Record<string, unknown> }) => {
      seen.push({ toolName: req.toolName, input: req.input });
      return { behavior: "allow", updatedInput: req.input };
    },
  });
  const toolDone = allow.events.filter((e) => e.type === EventType.ToolCallDone);
  check(
    "1 approve-allow",
    seen.length >= 1 &&
      seen[0].toolName === "Bash" &&
      String(seen[0].input.command).includes("python3") &&
      !String(seen[0].input.command).includes("zsh") &&
      toolDone.some((e) => String(e.data.output ?? "").includes("42")) &&
      allow.events.some((e) => e.type === EventType.Result),
    `callbacks=${JSON.stringify(seen)} outputs=${toolDone.map((e) => JSON.stringify(e.data.output)).join(",")}`,
  );

  const denies: string[] = [];
  const deny = await run(
    "Run this exact shell command: python3 -c 'print(999)'\nIf the command is declined/not approved, reply exactly SKIPPED without retrying.",
    {
      cwd: os.tmpdir(),
      permission: "default",
      persistence: false,
      onCanUseTool: async (req: { toolName: string }) => {
        denies.push(req.toolName);
        return { behavior: "deny", message: "not allowed" };
      },
    },
  );
  const deniedTool = deny.events.find(
    (e) => e.type === EventType.ToolCallDone && e.data.isError === true,
  );
  check(
    "2 approve-deny",
    denies.length >= 1 &&
      !!deniedTool &&
      !deny.text.includes("999\n") &&
      deny.text.includes("SKIPPED") &&
      deny.events.some((e) => e.type === EventType.Result),
    `denies=${denies.length} declinedTool=${!!deniedTool} answer=${JSON.stringify(deny.text.trim().slice(0, 60))}`,
  );
}

// 3) multi-agent:子线隔离 + Task 树
{
  const r = await run(
    "Spawn one subagent to compute 17*23, wait for it, then report the product. Use your multi-agent collab tools.",
    { cwd: os.tmpdir(), permission: "full", workspace: os.tmpdir(), persistence: false },
  );
  const resultIdx = r.events.findIndex((e) => e.type === EventType.Result);
  const spawnCalls = r.events.filter(
    (e) => e.type === EventType.ToolCall && e.data.name === "spawn_agent",
  );
  const tasks = r.events.filter((e) => e.type === EventType.Task);
  const started = tasks.filter((e) => e.data.phase === "started");
  const completed = tasks.filter((e) => e.data.phase === "completed");
  const childTools = r.events.filter(
    (e) => e.type === EventType.ToolCall && e.data.parentToolUseId != null,
  );
  const lastEventIsResultish = resultIdx === r.events.length - 1; // Result 必须收尾,子线不得再触发提前 Result
  check(
    "3 multi-agent",
    resultIdx > 0 &&
      lastEventIsResultish &&
      r.text.includes("391") &&
      spawnCalls.length >= 1 &&
      started.length >= 1 &&
      completed.length >= 1 &&
      String(completed[0].data.summary ?? "").includes("391"),
    `result@${resultIdx}/${r.events.length - 1} text391=${r.text.includes("391")} spawn=${spawnCalls.length} ` +
      `taskStarted=${started.length} taskCompleted=${completed.length} childTools=${childTools.length} ` +
      `summary=${JSON.stringify(String(completed[0]?.data.summary ?? "").slice(0, 50))}`,
  );
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
