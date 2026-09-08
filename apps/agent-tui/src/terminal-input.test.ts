import { expect, test } from "bun:test";
import { TerminalInput } from "./terminal-input.js";
import type { Key } from "./controller.js";

test("bracketed paste preserves split UTF8/multiline content without synthesizing send keys", () => {
  const keys: Array<{ text: string | undefined; key: Key }> = [];
  const parser = new TerminalInput((text, key) => keys.push({ text, key }));
  const text = "  中文🙂\r\tsecond\r\nthird\nlast\r";
  try {
    for (const byte of Buffer.from(`\x1b[200~${text}\x1b[201~`)) parser.write(Buffer.from([byte]));
    expect(keys).toEqual([{ text: "  中文🙂\n\tsecond\nthird\nlast\n", key: { paste: true } }]);
    parser.write(Buffer.from("🙂\n\x1b[13;2u\x1b[27;2;13~\r"));
    expect(keys[1].text).toBe("🙂");
    expect(keys.slice(2, 5).map(k => k.key)).toEqual([{ name: "j", ctrl: true }, { name: "return", shift: true }, { name: "return", shift: true }]);
    expect(keys.at(-1)?.key.name).toBe("return");
  } finally { parser.close(); }
});
