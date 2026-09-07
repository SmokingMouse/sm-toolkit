import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MethodSchemas, NotificationSchemas, ServerRequestSchemas } from "../src/protocol/index.js";
import { CODEX_SCHEMA_VERSION } from "../src/engines/codex-version.js";

type Schema = { $ref?: string; required?: string[]; properties?: Record<string, Schema>; enum?: string[]; definitions?: Record<string, Schema>; oneOf?: Schema[]; anyOf?: Schema[] };
export const groups = {
  ClientRequest: Object.fromEntries(Object.entries(MethodSchemas).map(([name, value]) => [name, value.params])),
  ClientNotification: { initialized: z.object({}) },
  ServerNotification: NotificationSchemas,
  ServerRequest: Object.fromEntries(Object.entries(ServerRequestSchemas).map(([name, value]) => [name, value.params])),
};
function required(schema: Schema | undefined, root: Schema): string[] {
  if (!schema) return [];
  if (schema.$ref) {
    const target = root.definitions?.[schema.$ref.split("/").at(-1)!];
    if (!target) throw new Error(`Unresolved schema reference: ${schema.$ref}`);
    return required(target, root);
  }
  const branches = schema.oneOf ?? schema.anyOf;
  const intersection = branches?.map(s => required(s, root)).reduce((a, b) => a.filter(k => b.includes(k)));
  return [...new Set([...(schema.required ?? []), ...(intersection ?? [])])].sort();
}
export function checkAlignment(doc: string, schemas: Record<string, Schema>): number {
  const section = doc.split("### 10.1")[1]?.split("### 10.2")[0];
  if (!section) throw new Error("Missing protocol §10.1");
  const names = [...new Set([...section.matchAll(/`([^`]+)`/g)].map(m => m[1]).filter(n => n.includes("/") || ["initialize", "initialized", "error"].includes(n)))];
  if (!names.length) throw new Error("Empty alignment contract");
  const differences = new Map<string, [string[], string[]]>();
  const table = doc.split("<!-- codex-required-differences -->")[1]?.split("<!-- /codex-required-differences -->")[0] ?? "";
  const fields = (s: string) => s.trim() === "—" ? [] : s.split(",").map(k => k.trim()).sort();
  for (const row of table.matchAll(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \|$/gm)) differences.set(row[1], [fields(row[2]), fields(row[3])]);
  for (const name of names) {
    const entry = Object.entries(groups).find(([, registry]) => name in registry);
    if (!entry) throw new Error(`§10.1 name missing from AS: ${name}`);
    const [group, registry] = entry;
    const root = schemas[group];
    const native = root?.oneOf?.find(v => v.properties?.method?.enum?.includes(name));
    if (!native) throw new Error(`Codex ${group} missing ${name}`);
    const nativeRequired = required(native.properties?.params, root);
    const asSchema = z.toJSONSchema((registry as Record<string, z.ZodType>)[name], { io: "input" }) as Schema;
    const asRequired = required(asSchema, asSchema);
    const actual = [asRequired.filter(k => !nativeRequired.includes(k)), nativeRequired.filter(k => !asRequired.includes(k))];
    const expected = differences.get(name) ?? [[], []];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${name}: required fields drifted; actual AS-only/Codex-only ${JSON.stringify(actual)}, documented ${JSON.stringify(expected)}`);
    differences.delete(name);
  }
  if (differences.size) throw new Error(`Stale §10.2 exceptions: ${[...differences.keys()]}`);
  return names.length;
}
export function checkVersion(version: string, pinned: string): void {
  if (version !== pinned) throw new Error(`Codex version ${version} does not match pinned schema ${pinned}`);
}
if (import.meta.main) {
  let temporary: string | undefined;
  try {
    const pinned = readFileSync(new URL("../../../docs/agent-server/codex-schema-version.txt", import.meta.url), "utf8").trim();
    checkVersion(CODEX_SCHEMA_VERSION, pinned);
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== "--schema-dir")) throw new Error("Usage: check-codex-alignment.ts [--schema-dir <dir>]");
    let directory = args[1];
    if (!directory) {
      const version = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim().replace(/^codex-cli\s+/, "");
      checkVersion(version, pinned);
      const cached = "/tmp/codex-app-server-schema";
      const marker = join(cached, "codex-schema-version.txt");
      if (existsSync(marker) && readFileSync(marker, "utf8").trim() === pinned) directory = cached;
      else {
        directory = temporary = mkdtempSync(join(tmpdir(), "as-codex-schema-"));
        execFileSync("codex", ["app-server", "generate-json-schema", "--out", directory], { stdio: "pipe" });
      }
    } else checkVersion(readFileSync(join(directory, "codex-schema-version.txt"), "utf8").trim(), pinned);
    const schemas = Object.fromEntries(Object.keys(groups).map(group => [group, JSON.parse(readFileSync(join(directory!, `${group}.json`), "utf8"))]));
    const count = checkAlignment(readFileSync(new URL("../../../docs/agent-server/protocol.md", import.meta.url), "utf8"), schemas);
    console.log(`Codex ${pinned}: ${count} protocol names and required-field contracts aligned`);
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
  finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
}
