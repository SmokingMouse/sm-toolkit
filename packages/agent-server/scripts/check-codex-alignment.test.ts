import { expect, test } from "bun:test";
import { checkAlignment, checkVersion } from "./check-codex-alignment.js";

const doc = `### 10.1
\`turn/start\`
### 10.2
<!-- codex-required-differences -->
<!-- /codex-required-differences -->`;
const fixture = (name = "turn/start", required = ["threadId", "input"]) => ({ ClientRequest: { oneOf: [{ properties: { method: { enum: [name] }, params: { $ref: "#/definitions/Params" } } }], definitions: { Params: { required } } } });
test("alignment catches removed methods, changed required fields and stale exceptions", () => {
  expect(checkAlignment(doc, fixture())).toBe(1);
  expect(() => checkAlignment(doc, fixture("turn/replaced"))).toThrow("missing turn/start");
  expect(() => checkAlignment(doc, fixture("turn/start", ["threadId", "input", "newField"]))).toThrow("required fields drifted");
  expect(() => checkAlignment(doc, fixture("turn/start", ["threadId"]))).toThrow("required fields drifted");
  expect(() => checkAlignment(doc.replace("<!-- /codex", "| `thread/removed` | x | — |\n<!-- /codex"), fixture())).toThrow("Stale");
});
test("alignment accepts only explicitly documented required-field differences", () => {
  const exception = doc.replace("<!-- /codex", "| `turn/start` | — | newField |\n<!-- /codex");
  expect(checkAlignment(exception, fixture("turn/start", ["threadId", "input", "newField"]))).toBe(1);
  expect(() => checkAlignment(exception, fixture())).toThrow("drifted");
});
test("schema version drift fails rather than silently accepting the installed CLI", () => {
  expect(() => checkVersion("0.153.4", "0.153.4")).not.toThrow();
  expect(() => checkVersion("0.154.0", "0.153.4")).toThrow("does not match");
});
