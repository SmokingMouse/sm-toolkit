import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { homedir } from "node:os";
const args = process.argv.slice(2), dry = args.includes("--dry-run");
const release = args.find(a => !a.startsWith("--"));
if (!release || !isAbsolute(release)) throw new Error("Usage: bun install.ts /absolute/stable/release [--dry-run]");
const bun = process.execPath, userHome = homedir();
if (!existsSync(join(release, "packages/agent-server/dist/daemon/cli.js"))) throw new Error("Build the complete release first: bun run typecheck");
const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const values: Record<string, string> = { BUN: bun, RELEASE: resolve(release), HOME: userHome, PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" };
const template = readFileSync(new URL("./com.smokingmouse.agent-server.plist", import.meta.url), "utf8").replace(/@(BUN|RELEASE|HOME|PATH)@/g, (_, k) => escape(values[k]!));
if (dry) { process.stdout.write(template); process.exit(0); }
const file = join(userHome, "Library/LaunchAgents/com.smokingmouse.agent-server.plist");
mkdirSync(join(userHome, "Library/LaunchAgents"), { recursive: true }); mkdirSync(join(userHome, "Library/Logs"), { recursive: true });
writeFileSync(file, template, { mode: 0o600, flag: "wx" });
const p = Bun.spawnSync(["launchctl", "bootstrap", `gui/${process.getuid!()}`, file], { stdout: "inherit", stderr: "inherit" });
if (p.exitCode) throw new Error(`bootstrap failed (${p.exitCode}); inspect ${file}`);
