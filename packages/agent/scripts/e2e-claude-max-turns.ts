import { ClaudeBackend, EventType, type AgentEvent } from "../src/index.js";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const events: AgentEvent[] = [];
const configDir = mkdtempSync(join(tmpdir(), "sm-agent-max-turns-"));
copyFileSync(join(homedir(), ".claude", ".credentials.json"), join(configDir, ".credentials.json"));
const prompt = [
  "Use the Bash tool exactly once to run: printf TURN_CANARY_7391.",
  "Only after reading the tool output, answer with exactly SUMMARY_TURN_CANARY_7391.",
].join(" ");

try {
  for await (const event of new ClaudeBackend().run(prompt, {
    maxTurns: 1,
    tools: ["Bash"],
    workspace: configDir,
    cwd: configDir,
    permission: "full",
    persistence: false,
    partialMessages: false,
    env: { CLAUDE_CONFIG_DIR: configDir },
  })) {
    events.push(event);
  }
} finally {
  rmSync(configDir, { recursive: true, force: true });
}

const toolCall = events.find(
  (event) => event.type === EventType.ToolCall && event.data.name === "Bash",
);
const toolDone = events.find(
  (event) =>
    event.type === EventType.ToolCallDone &&
    event.data.id === toolCall?.data.id &&
    String(event.data.output).includes("TURN_CANARY_7391"),
);
const finalText = events
  .filter((event) => event.type === EventType.TextChunk || event.type === EventType.Result)
  .map((event) => String(event.data.text ?? ""))
  .join("");

if (!toolCall || !toolDone || finalText.includes("SUMMARY_TURN_CANARY_7391")) {
  console.error(JSON.stringify(events, null, 2));
  throw new Error(
    "maxTurns E2E failed: expected one completed Bash turn and no post-tool summary",
  );
}

console.log(
  JSON.stringify({
    ok: true,
    toolCall: toolCall.data.name,
    toolOutput: toolDone.data.output,
    eventTypes: events.map((event) => event.type),
  }),
);
