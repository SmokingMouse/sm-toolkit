import { expect, test } from "bun:test";
import { EventType, type AgentEvent } from "@sm/agent";
import { coalesceStreamingEvent } from "./executor.js";

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
