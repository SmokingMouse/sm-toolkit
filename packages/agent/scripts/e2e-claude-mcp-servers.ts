import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ClaudeBackend, EventType, type AgentEvent } from "../src/index.js";

const configDir = mkdtempSync(join(tmpdir(), "sm-agent-mcp-servers-"));
copyFileSync(join(homedir(), ".claude", ".credentials.json"), join(configDir, ".credentials.json"));

function resultText(events: AgentEvent[]): string {
  return events
    .filter((event) => event.type === EventType.Result)
    .map((event) => String(event.data.text ?? ""))
    .join("");
}

function toolPair(events: AgentEvent[], name: string): { call?: AgentEvent; done?: AgentEvent } {
  const call = events.find(
    (event) => event.type === EventType.ToolCall && event.data.name === name,
  );
  const done = events.find(
    (event) => event.type === EventType.ToolCallDone && event.data.id === call?.data.id,
  );
  return { call, done };
}

async function runSdkBridge(): Promise<Record<string, unknown>> {
  const serverName = "sdk_bridge_7391";
  const canaryTool = `mcp__${serverName}__get_canary`;
  const throwsTool = `mcp__${serverName}__always_throws`;
  let canaryExecutions = 0;
  let throwExecutions = 0;
  const sdkServer = new McpServer({ name: serverName, version: "1.0.0" });
  sdkServer.registerTool("get_canary", { description: "Return the SDK bridge canary" }, async () => {
    canaryExecutions++;
    return { content: [{ type: "text", text: "CANARY-7391" }] };
  });
  sdkServer.registerTool(
    "always_throws",
    { description: "Always throw so the host can verify session survival" },
    async () => {
      throwExecutions++;
      throw new Error("EXPECTED_THROW_7391");
    },
  );

  const events: AgentEvent[] = [];
  try {
    const prompt = [
      `Call ${canaryTool} exactly once and remember its result.`,
      `Then call ${throwsTool} exactly once; it will fail, so do not retry.`,
      "Continue after the tool error and make the final response include CANARY-7391 and SESSION_ALIVE_7391.",
    ].join(" ");
    for await (const event of new ClaudeBackend().run(prompt, {
      mcpServers: { [serverName]: { type: "sdk", instance: sdkServer } },
      delayFirstMessageMs: 0,
      settingSources: ["user"],
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
    await sdkServer.close();
  }

  const canary = toolPair(events, canaryTool);
  const thrown = toolPair(events, throwsTool);
  const text = resultText(events);
  const session = events.find((event) => event.type === EventType.SessionStart);
  const connected = (session?.data.mcpServers as Array<{ name: string; status: string }> | undefined)
    ?.some((server) => server.name === serverName && server.status === "connected");
  if (
    canaryExecutions !== 1 ||
    throwExecutions !== 1 ||
    !connected ||
    !canary.call ||
    !canary.done ||
    canary.done.data.isError !== false ||
    !thrown.call ||
    !thrown.done ||
    thrown.done.data.isError !== true ||
    !text.includes("CANARY-7391") ||
    !text.includes("SESSION_ALIVE_7391") ||
    events.some((event) => event.type === EventType.Error)
  ) {
    console.error(JSON.stringify({ canaryExecutions, throwExecutions, events }, null, 2));
    throw new Error("SDK MCP bridge E2E failed");
  }
  return {
    canaryExecutions,
    throwExecutions,
    connected,
    toolEvents: events.filter(
      (event) => event.type === EventType.ToolCall || event.type === EventType.ToolCallDone,
    ).length,
    result: text,
  };
}

async function runHttpField(): Promise<Record<string, unknown>> {
  const serverName = "http_field_7391";
  const toolName = `mcp__${serverName}__http_canary`;
  let executions = 0;
  const mcp = new McpServer({ name: serverName, version: "1.0.0" });
  mcp.registerTool("http_canary", { description: "Return the HTTP field canary" }, async () => {
    executions++;
    return { content: [{ type: "text", text: "HTTP_CANARY_7391" }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await mcp.connect(transport);
  const http = createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    void transport.handleRequest(req, res, body).catch((error) => {
      console.error("HTTP MCP request failed", error);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("HTTP MCP server has no TCP port");

  const events: AgentEvent[] = [];
  try {
    const prompt = `Call ${toolName} exactly once, then make the final response include HTTP_CANARY_7391.`;
    for await (const event of new ClaudeBackend().run(prompt, {
      mcpServers: {
        [serverName]: { type: "http", url: `http://127.0.0.1:${address.port}/mcp` },
      },
      delayFirstMessageMs: 500,
      settingSources: ["user"],
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
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await mcp.close();
  }

  const pair = toolPair(events, toolName);
  const text = resultText(events);
  const session = events.find((event) => event.type === EventType.SessionStart);
  const connected = (session?.data.mcpServers as Array<{ name: string; status: string }> | undefined)
    ?.some((server) => server.name === serverName && server.status === "connected");
  if (
    executions !== 1 ||
    !connected ||
    !pair.call ||
    !pair.done ||
    pair.done.data.isError !== false ||
    !text.includes("HTTP_CANARY_7391")
  ) {
    console.error(JSON.stringify({ executions, events }, null, 2));
    throw new Error("HTTP mcpServers field E2E failed");
  }
  return { executions, connected, result: text };
}

try {
  const sdk = await runSdkBridge();
  const http = await runHttpField();
  console.log(JSON.stringify({ ok: true, sdk, http }));
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
