/**
 * Chapter 00 tests: LLM boundary conversion (convertToLlm) and EventStream producer-consumer decoupling.
 * The base-layer tests don't depend on the real API (offline); for real-endpoint verification see demo.ts.
 */
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../src/llm.ts";
import { EventStream } from "../src/stream.ts";
import type { AssistantMessage, Message } from "../src/types.ts";

describe("convertToLlm (★ design point 1: the single boundary conversion, agent-loop.ts L295)", () => {
  it("user message → Anthropic MessageParam", () => {
    const messages: Message[] = [{ role: "user", text: "Hello" }];
    const llm = convertToLlm(messages);
    expect(llm).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("assistant message (text + toolCalls) → block array", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      text: "I need to calculate",
      toolCalls: [{ id: "call_1", name: "calculator", arguments: { a: 1, b: 2 } }],
      stopReason: "tool_use",
    };
    const messages: Message[] = [assistant];
    const llm = convertToLlm(messages);
    expect(llm).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "I need to calculate" },
          { type: "tool_use", id: "call_1", name: "calculator", input: { a: 1, b: 2 } },
        ],
      },
    ]);
  });

  it("toolResult messages → consecutive ones merged into one user message (protocol requirement, multiple tool_result blocks)", () => {
    const messages: Message[] = [
      { role: "toolResult", toolCallId: "call_1", toolName: "calculator", text: "3", isError: false },
      { role: "toolResult", toolCallId: "call_2", toolName: "boom", text: "failed", isError: true },
    ];
    const llm = convertToLlm(messages);
    expect(llm).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "3", is_error: false },
          { type: "tool_result", tool_use_id: "call_2", content: "failed", is_error: true },
        ],
      },
    ]);
  });

  it("toolResults separated by other roles form separate groups (only consecutive ones are merged)", () => {
    const messages: Message[] = [
      { role: "user", text: "hi" },
      { role: "toolResult", toolCallId: "call_1", toolName: "calculator", text: "3", isError: false },
      { role: "user", text: "continue" },
      { role: "toolResult", toolCallId: "call_2", toolName: "boom", text: "failed", isError: true },
    ];
    const llm = convertToLlm(messages);
    expect(llm).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "3", is_error: false }] },
      { role: "user", content: "continue" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_2", content: "failed", is_error: true }] },
    ]);
  });
});

describe("EventStream (producer-consumer decoupling, pi-ai event-stream.ts)", () => {
  const endWhen = (e: { type: string; messages?: Message[] }) => e.type === "end";
  const extract = (e: { type: string; messages?: Message[] }) => e.messages ?? [];

  it("produce first, consume later: events are neither dropped nor duplicated", async () => {
    const stream = new EventStream<{ type: string; messages?: Message[] }, Message[]>(endWhen, extract);
    stream.push({ type: "a" });
    stream.push({ type: "b" });
    stream.push({ type: "end", messages: [] });

    const types: string[] = [];
    for await (const event of stream) {
      types.push(event.type);
    }
    expect(types).toEqual(["a", "b", "end"]);
  });

  it("the consumer suspends first and is woken up and handed the event when it arrives", async () => {
    const stream = new EventStream<{ type: string }, Message[]>(endWhen, extract);
    const iterator = stream[Symbol.asyncIterator]();
    const first = iterator.next();
    stream.push({ type: "a" });
    expect((await first).value).toMatchObject({ type: "a" });
    stream.end([]);
    expect((await iterator.next()).done).toBe(true);
  });

  it("the end signal extracts the result automatically; end() ends explicitly", async () => {
    const stream = new EventStream<{ type: string; messages?: Message[] }, Message[]>(endWhen, extract);
    stream.push({ type: "end", messages: [{ role: "user", text: "x" }] });
    expect(await stream.result()).toEqual([{ role: "user", text: "x" }]);
    stream.push({ type: "end", messages: [] }); // push after done has no effect
    const types: string[] = [];
    for await (const event of stream) {
      types.push(event.type);
    }
    expect(types).toEqual(["end"]);
  });
});
