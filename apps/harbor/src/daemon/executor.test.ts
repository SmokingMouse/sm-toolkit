import { expect, test } from "bun:test";
import { EventType, type AgentEvent } from "@sm/agent";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coalesceStreamingEvent, materializeRunAttachments, runAgentSetup } from "./executor.js";

function event(type: AgentEvent["type"], text: string, sessionId = "session_1"): AgentEvent {
  return { type, backend: "claude", sessionId, data: { text } };
}

test("coalesces only adjacent text/thinking chunks from the same stream", () => {
  expect(coalesceStreamingEvent(event(EventType.Thinking, "think "), event(EventType.Thinking, "more"))).toEqual(
    event(EventType.Thinking, "think more"),
  );
  expect(coalesceStreamingEvent(event(EventType.TextChunk, "hello "), event(EventType.TextChunk, "world"))).toEqual(
    event(EventType.TextChunk, "hello world"),
  );
  expect(coalesceStreamingEvent(event(EventType.Thinking, "a"), event(EventType.TextChunk, "b"))).toBeNull();
  expect(coalesceStreamingEvent(event(EventType.Thinking, "a"), event(EventType.Thinking, "b", "session_2"))).toBeNull();
  expect(
    coalesceStreamingEvent(event(EventType.Thinking, "a"), {
      type: EventType.ToolCall,
      backend: "claude",
      sessionId: "session_1",
      data: { name: "Read" },
    }),
  ).toBeNull();
});

test("Agent setup runs in the repository with configured env and fails loudly", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harbor-setup-"));
  try {
    await runAgentSetup(
      directory,
      'printf "%s" "$HARBOR_TEST_VALUE" > setup.out',
      null,
      { HARBOR_TEST_VALUE: "ready" },
      new AbortController().signal,
    );
    expect(readFileSync(join(directory, "setup.out"), "utf8")).toBe("ready");
    await expect(runAgentSetup(
      directory,
      "echo broken >&2; exit 7",
      null,
      {},
      new AbortController().signal,
    )).rejects.toThrow("broken");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Run attachments are materialized with safe unique names", () => {
  const result = materializeRunAttachments("r_test", [
    { name: "../screen.png", mime: "image/png", dataBase64: Buffer.from("one").toString("base64") },
    { name: "screen.png", mime: "image/png", dataBase64: Buffer.from("two").toString("base64") },
  ]);
  try {
    expect(result.directory).not.toBeNull();
    expect(result.paths).toHaveLength(2);
    expect(result.paths[0]!.path.startsWith(result.directory!)).toBe(true);
    expect(result.paths[1]!.path).not.toBe(result.paths[0]!.path);
    expect(readFileSync(result.paths[0]!.path, "utf8")).toBe("one");
    expect(readFileSync(result.paths[1]!.path, "utf8")).toBe("two");
  } finally {
    if (result.directory) rmSync(result.directory, { recursive: true, force: true });
  }
});
