import { MockEngine, type MockScript } from "@smokingmouse/agent-server";
import { resolveDaemonPaths, runDaemon } from "@smokingmouse/agent-server/daemon";

const script: MockScript = function* (turnId, input) {
  const text = input.filter(i => i.type === "text").map(i => i.text).join(" ");
  const item = { id: crypto.randomUUID(), type: "agentMessage" as const, payload: { text: `ANSWER<${text}>` } };
  yield { type: "itemStarted", turnId, item };
  yield { type: "itemCompleted", turnId, item };
  yield { type: "turnCompleted", turnId, status: "completed" };
};
const daemon = await runDaemon({ paths: resolveDaemonPaths(), graceMs: 10, logger: () => {}, serverOptions: {
  allowedRoots: [process.env.HOME!], idleTimeoutMs: 0, engineFactory: () => new MockEngine(script),
} });
process.on("SIGTERM", () => { void daemon.shutdown(); });
console.log("READY");
await daemon.closed;
