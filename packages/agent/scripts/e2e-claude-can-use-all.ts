import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ClaudeBackend, EventType, type AgentEvent } from "../src/index.js";

const configDir = mkdtempSync(join(tmpdir(), "sm-agent-can-use-all-"));
copyFileSync(join(homedir(), ".claude", ".credentials.json"), join(configDir, ".credentials.json"));

const serverName = "permission_gate_7391";
const allowTool = `mcp__${serverName}__allow_probe`;
const denyTool = `mcp__${serverName}__deny_probe`;
writeFileSync(
  join(configDir, "settings.json"),
  JSON.stringify({ permissions: { allow: [allowTool, denyTool] } }),
);

let allowExecutions = 0;
let denyExecutions = 0;
const mcp = new McpServer({ name: serverName, version: "1.0.0" });
mcp.registerTool("allow_probe", { description: "Return the allow canary" }, async () => {
  allowExecutions++;
  return { content: [{ type: "text", text: "ALLOW_CANARY_7391" }] };
});
mcp.registerTool("deny_probe", { description: "Return a value that must stay unreachable" }, async () => {
  denyExecutions++;
  return { content: [{ type: "text", text: "DENY_HANDLER_RAN_7391" }] };
});

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
transport.onerror = (error) => console.error("MCP transport error", error);
await mcp.connect(transport);
const http = createServer(async (req, res) => {
  if (req.url === "/mcp") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    void transport.handleRequest(req, res, body).catch((error) => {
      console.error("MCP request error", error);
      if (!res.headersSent) res.writeHead(500).end();
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
const address = http.address();
if (!address || typeof address === "string") throw new Error("MCP test server did not bind a TCP port");
const mcpConfig = {
  mcpServers: { [serverName]: { type: "http", url: `http://127.0.0.1:${address.port}/mcp` } },
};

const events: AgentEvent[] = [];
const intercepted: string[] = [];
try {
  const prompt = [
    `Call ${allowTool} exactly once and remember its result.`,
    `Then call ${denyTool} exactly once; if denied, do not retry.`,
    "After both attempts, reply exactly SESSION_CONTINUED_7391.",
  ].join(" ");
  for await (const event of new ClaudeBackend().run(prompt, {
    onCanUseTool: async ({ toolName }) => {
      intercepted.push(toolName);
      return toolName === denyTool
        ? { behavior: "deny" as const, message: "DENIED_BY_HOST_7391" }
        : { behavior: "allow" as const };
    },
    askTools: "all",
    settingSources: ["user"],
    delayFirstMessageMs: 500,
    extraArgs: ["--mcp-config", JSON.stringify(mcpConfig)],
    cwd: configDir,
    persistence: false,
    partialMessages: false,
    env: { CLAUDE_CONFIG_DIR: configDir },
  })) {
    events.push(event);
  }

  const session = events.find((event) => event.type === EventType.SessionStart);
  const result = events.find((event) => event.type === EventType.Result);
  const calls = events.filter((event) => event.type === EventType.ToolCall);
  const allowCall = calls.find((event) => event.data.name === allowTool);
  const denyCall = calls.find((event) => event.data.name === denyTool);
  const done = events.filter((event) => event.type === EventType.ToolCallDone);
  const allowDone = done.find((event) => event.data.id === allowCall?.data.id);
  const denyDone = done.find((event) => event.data.id === denyCall?.data.id);
  const connected = (session?.data.mcpServers as Array<{ name: string; status: string }> | undefined)
    ?.some((server) => server.name === serverName && server.status === "connected");

  if (
    !connected ||
    !intercepted.includes(allowTool) ||
    !intercepted.includes(denyTool) ||
    allowExecutions !== 1 ||
    denyExecutions !== 0 ||
    !allowCall ||
    !denyCall ||
    !allowDone ||
    !denyDone ||
    denyDone.data.isError !== true ||
    !String(denyDone.data.output).includes("DENIED_BY_HOST_7391") ||
    !String(result?.data.text).includes("SESSION_CONTINUED_7391")
  ) {
    console.error(JSON.stringify({ intercepted, allowExecutions, denyExecutions, events }, null, 2));
    throw new Error("onCanUseTool full-interception E2E failed");
  }

  console.log(
    JSON.stringify({
      ok: true,
      intercepted,
      allowExecutions,
      denyExecutions,
      denied: denyDone.data.output,
      result: result?.data.text,
    }),
  );
} finally {
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await mcp.close();
  rmSync(configDir, { recursive: true, force: true });
}
