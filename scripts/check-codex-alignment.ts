import { fileURLToPath } from "node:url";

// Keep the package checker authoritative while supporting the repository-root command.
const result = Bun.spawnSync([process.execPath, fileURLToPath(new URL("../packages/agent-server/scripts/check-codex-alignment.ts", import.meta.url)), ...process.argv.slice(2)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exitCode = result.exitCode;
