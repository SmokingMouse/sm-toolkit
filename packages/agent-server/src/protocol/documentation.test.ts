import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ErrorCode, MethodSchemas, NotificationSchemas, ServerRequestSchemas } from "./index.js";

test("P2-2: foundation RPCs, notifications, capabilities and input variants appear in normative tables", () => {
  const doc = readFileSync(new URL("../../../../docs/agent-server/protocol.md", import.meta.url), "utf8");
  const methods = doc.split("\n## 3.")[1].split("\n## 4.")[0];
  const notices = doc.split("### 4.1")[1].split("### 4.2")[0];
  for (const name of ["thread/engineControl", "thread/permission/set", "thread/effort/set", "thread/compact"]) expect(methods).toContain(`| \`${name}\` |`);
  for (const name of ["thread/engineEvent", "thread/permission/changed"]) expect(notices).toContain(`| \`${name}\` |`);
  for (const name of ["engineEvents", "engineControl", "permissionSet", "effortSet", "subAgentText", "bashInput", "compact"]) expect(doc).toContain(`| \`capabilities.engine.${name}\` |`);
  expect(doc).toContain('{ type: "bash"; command: string }');
  const subAgent = doc.split("\n").find(line => line.startsWith("| `subAgent`"))!;
  expect(subAgent).toContain("text?: string"); expect(subAgent).toContain("thinking?: string");
});

test("asrev-doccheck: protocol names and business error codes match registries in both directions", () => {
  const doc = readFileSync(new URL("../../../../docs/agent-server/protocol.md", import.meta.url), "utf8").replace(/```[\s\S]*?```/g, "");
  const quoted = new Set([...doc.matchAll(/`([^`]+)`/g)].map(m => m[1]));
  const names = new Set([...Object.keys(MethodSchemas), ...Object.keys(NotificationSchemas), ...Object.keys(ServerRequestSchemas), "initialized"]);
  for (const name of names) expect([...quoted].some(q => q === name || q.split(" ")[0] === name)).toBe(true);
  // AS method/notification tables precede the native comparison section.
  for (const row of doc.split("## 10.")[0].matchAll(/^\|\s*`([a-zA-Z][\w/]*)`/gm)) if (row[1].includes("/")) expect(names.has(row[1])).toBe(true);
  const codes = new Map([...doc.matchAll(/\|\s*`(-320\d\d)`\s*\|\s*`(\w+)`/g)].map(m => [m[2], Number(m[1])]));
  for (const [name, code] of Object.entries(ErrorCode)) if (code >= -32099 && code <= -32000) expect(codes.get(name)).toBe(code);
  for (const [name, code] of codes) expect(ErrorCode[name as keyof typeof ErrorCode]).toBe(code);
});
