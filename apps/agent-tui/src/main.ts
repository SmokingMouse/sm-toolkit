import { AgentClient } from "@smokingmouse/agent-server/client";
import { help, parseOptions, readToken } from "./options.js";
import { bindClient, TuiModel } from "./model.js";
import { runTerminal } from "./terminal.js";
import { startHerdr } from "./herdr.js";

export async function main(args = process.argv.slice(2)): Promise<number> {
  let client: AgentClient | undefined;
  try {
    const options = parseOptions(args);
    if (options.help) { console.log(help); return 0; }
    client = new AgentClient(options.endpoint, { token: readToken(options.tokenPath), client: { name: "agent-tui", version: "0.1.0", kind: "tui", label: "agent-tui" }, capabilities: { serverRequests: ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput"] } });
    const model = new TuiModel(); bindClient(client, model);
    try { await client.connect(); } catch (error) { throw new Error(`Cannot connect to agent-server (${options.endpoint.transport === "unix" ? options.endpoint.path : options.endpoint.url}). Start it with agent-server start. ${String(error)}`); }
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("agent-tui requires an interactive terminal (TTY)");
    const threadId = options.attach ?? (await client.request("thread/start", { backend: options.backend!, cwd: options.cwd, clientThreadId: crypto.randomUUID() })).thread.id;
    await client.request("thread/attach", { threadId });
    const stopHerdr = startHerdr(model, text => process.stdout.write(text));
    try { await runTerminal(client, model); } finally { await stopHerdr(); }
    return 0;
  } catch (error) { console.error(`agent-tui: ${error instanceof Error ? error.message : String(error)}`); return 1; }
  finally { client?.close(); }
}
