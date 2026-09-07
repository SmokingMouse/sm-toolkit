import { expect, test } from "bun:test";
import { NDJSONDecoder, UnixWriter } from "./ndjson.js";

test("NDJSON retains split UTF-8, escaped newlines and multiple frames per chunk", () => {
  const lines: string[] = [];
  const decoder = new NDJSONDecoder(line => lines.push(line));
  const bytes = Buffer.from(JSON.stringify({ text: "中\n文" }) + "\n{}\n");
  for (const byte of bytes.subarray(0, 12)) decoder.push(Buffer.from([byte]));
  decoder.push(bytes.subarray(12));
  expect(lines.map(line => JSON.parse(line))).toEqual([{ text: "中\n文" }, {}]);
});

test("NDJSON bounds an incomplete line and resets its bound for each line", () => {
  const decoder = new NDJSONDecoder(() => {}, 4);
  decoder.push(Buffer.from("{}\n{}\n"));
  decoder.push(Buffer.from("1234"));
  expect(() => decoder.push(Buffer.from("5"))).toThrow("size limit");
});

test("unix partial writes preserve message order through drain and flush before end", () => {
  const sent: Buffer[] = []; let available = 2; let ended = false;
  const writer = new UnixWriter({
    write(data) { const buffer = Buffer.from(data as Uint8Array); const n = Math.min(available, buffer.length); sent.push(buffer.subarray(0, n)); available -= n; return n; },
    end() { ended = true; return 0; },
  });
  writer.send("first"); writer.send("second"); writer.end();
  expect(ended).toBe(false);
  available = 100; writer.drain();
  expect(Buffer.concat(sent).toString()).toBe("first\nsecond\n"); expect(ended).toBe(true);
});
