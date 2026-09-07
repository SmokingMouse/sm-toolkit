import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import * as protocol from "../src/protocol/index.js";

const directory = resolve(import.meta.dir, "../schema");
mkdirSync(directory, { recursive: true });
const schemas: Record<string, z.ZodType> = {};
for (const [name, schema] of Object.entries(protocol)) {
  if (schema instanceof z.ZodType) schemas[name] = schema;
}
for (const [name, schema] of Object.entries(protocol.MethodSchemas)) {
  schemas[`method:${name}:params`] = schema.params;
  schemas[`method:${name}:result`] = schema.result;
}
for (const [name, schema] of Object.entries(protocol.ServerRequestSchemas)) {
  schemas[`serverRequest:${name}:params`] = schema.params;
  schemas[`serverRequest:${name}:result`] = schema.result;
}
for (const [name, schema] of Object.entries(protocol.NotificationSchemas)) schemas[`notification:${name}`] = schema;
const output = {
  $schema: "https://json-schema.org/draft/2020-12/schema", title: "AS Protocol v1", ...z.toJSONSchema(protocol.FrameSchema),
  $defs: Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, z.toJSONSchema(schema)])),
};
writeFileSync(resolve(directory, "as-v1.json"), JSON.stringify(output, null, 2) + "\n");
console.log(`Generated schema/as-v1.json (${Object.keys(schemas).length} definitions)`);
