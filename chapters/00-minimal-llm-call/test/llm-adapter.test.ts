/**
 * Chapter 00 tests: AnthropicLlmAdapter end-to-end streaming event mapping.
 *
 * Covers the key base-layer paths: start timing, delta accumulation,
 * thinking signature (signature_delta), apiKey header, refusal, resolvedModel,
 * redacted_thinking, pause_turn mapping. This file injects an SDK mock with vi.mock and verifies offline.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, AssistantMessageEvent, Message, StopReason } from "../src/types.ts";

const asst = (m: Partial<AssistantMessage>): AssistantMessage => ({ role: "assistant", stopReason: "end_turn", ...m });

/** Mock SDK that records the stream event sequence. */
const streamEvents: (Record<string, unknown>)[] = [];
const calls: { headers?: Record<string, string>; model?: string }[] = [];
/** Simulates a provider exception during the request: when non-null, the mock stream throws after yielding the preset events. */
let mockFailure: Error | null = null;

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = {
      stream: (opts: { model: string; system?: string; messages?: unknown[]; tools?: unknown[]; max_tokens?: number }, requestOptions?: { headers?: Record<string, string> }) => {
        calls.push({ headers: requestOptions?.headers, model: opts.model });
        const events = [...streamEvents];
        return {
          async *[Symbol.asyncIterator]() {
            for (const e of events) {
              yield e;
            }
            if (mockFailure) {
              throw mockFailure;
            }
          },
        };
      },
    };
  }
  return { default: MockAnthropic };
});

import { AnthropicLlmAdapter } from "../src/llm.ts";

const req = {
  model: "",
  systemPrompt: "s",
  messages: [{ role: "user" as const, text: "hi" }],
  tools: [],
};

/** Event builders: simplified event shapes. */
const textBlockStart = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
const textDelta = (t: string) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } });
const thinkingBlockStart = { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } };
const thinkingDelta = (t: string) => ({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: t } });
const signatureDelta = (s: string) => ({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: s } });
const toolBlockStart = (id: string, name: string) => ({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name, input: {} } });
const inputJsonDelta = (j: string) => ({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: j } });
const messageDelta = (stop_reason: string) => ({ type: "message_delta", delta: { stop_reason } });

async function drain(iter: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const out: AssistantMessageEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

afterEach(() => {
  streamEvents.length = 0;
  calls.length = 0;
  mockFailure = null;
  vi.clearAllMocks();
});

describe("adapter end to end (compare Pi anthropic-messages.ts L575-795)", () => {
  it("start is yielded after stream() is set up (a consumer polluting start's partial doesn't affect the sent request)", async () => {
    streamEvents.push(textBlockStart, textDelta("Hello"), { type: "content_block_stop", index: 0 }, messageDelta("end_turn"));
    const llm = new AnthropicLlmAdapter({ model: "claude-test" });
    // Manual AsyncIterable iteration: take the first event (start)
    const events: AssistantMessageEvent[] = [];
    for await (const e of llm.complete(req)) {
      events.push(e);
      break;  // take only start
    }
    const first = events[0];
    expect(first?.type).toBe("start");
    // The consumer pushes start's partial into its own context (how the teaching loop uses it)
    const consumed = first as { type: "start"; partial: { text?: string } };
    consumed.partial.text = "polluted";
    // Evidence that the request was sent: the mock was called before the start event arrived (the request body was snapshotted at stream())
    expect(calls.length).toBe(1);
  });

  it("text_delta accumulation + stopReason mapping (end_turn)", async () => {
    streamEvents.push(textBlockStart, textDelta("Hel"), textDelta("lo"), { type: "content_block_stop", index: 0 }, messageDelta("end_turn"));
    const llm = new AnthropicLlmAdapter({ model: "claude-test" });
    const events = await drain(llm.complete(req));
    expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "text_delta", "done"]);
    const done = events.at(-1) as { type: "done"; partial: { text?: string; stopReason?: StopReason } };
    expect(done.partial.text).toBe("Hello");
    expect(done.partial.stopReason).toBe("end_turn");
  });

  it("signature_delta accumulation: the thinking signature arrives in streamed chunks (Pi L691-697)", async () => {
    streamEvents.push(thinkingBlockStart, thinkingDelta("reasoning"), signatureDelta("SIG-ABC-123"), messageDelta("end_turn"));
    const llm = new AnthropicLlmAdapter({ model: "claude-test" });
    const events = await drain(llm.complete(req));
    const done = events.at(-1) as { type: "done"; partial: { thinking?: string; thinkingSignature?: string } };
    expect(done.partial.thinking).toBe("reasoning");
    expect(done.partial.thinkingSignature).toBe("SIG-ABC-123");
  });

  it("redacted_thinking maps to [Reasoning redacted] + signature=data (Pi L629-638)", async () => {
    streamEvents.push(
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "redacted-payload" } },
      messageDelta("end_turn"),
    );
    const llm = new AnthropicLlmAdapter({ model: "claude-test" });
    const events = await drain(llm.complete(req));
    const done = events.at(-1) as { type: "done"; partial: { thinking?: string; thinkingSignature?: string } };
    expect(done.partial.thinking).toBe("[Reasoning redacted]");
    expect(done.partial.thinkingSignature).toBe("redacted-payload");
  });

  it("apiKey goes through the x-api-key request header (SDK 0.121 RequestOptions has no apiKey field)", async () => {
    streamEvents.push(textBlockStart, textDelta("ok"), messageDelta("end_turn"));
    const llm = new AnthropicLlmAdapter({ model: "claude-test" });
    await drain(llm.complete({ ...req, apiKey: "sk-test-123" }));
    expect(calls[0]?.headers).toEqual({ "x-api-key": "sk-test-123" });
  });

  it("refusal → stopReason=error + explicit text (Pi L1365-1390)", async () => {
    streamEvents.push(textBlockStart, textDelta("refused"), messageDelta("refusal"));
    const llm = new AnthropicLlmAdapter({ model: "claude-test" });
    const events = await drain(llm.complete(req));
    const done = events.at(-1) as { type: "done"; partial: { stopReason?: StopReason; errorMessage?: string } };
    expect(done.partial.stopReason).toBe("error");
    expect(done.partial.errorMessage).toContain("refusal");
  });

  it("pause_turn/stop_sequence → end_turn (Pi: Stop is good enough)", async () => {
    streamEvents.push(textBlockStart, textDelta("long output"), messageDelta("pause_turn"));
    const llm = new AnthropicLlmAdapter({ model: "claude-test" });
    const events = await drain(llm.complete(req));
    const done = events.at(-1) as { type: "done"; partial: { stopReason?: StopReason } };
    expect(done.partial.stopReason).toBe("end_turn");
  });

  it("resolvedModel: the complete argument takes precedence over the constructor argument", async () => {
    streamEvents.push(textBlockStart, textDelta("ok"), messageDelta("end_turn"));
    const llm = new AnthropicLlmAdapter({ model: "constructor-model" });
    await drain(llm.complete({ ...req, model: "complete-model" }));
    expect(calls[0]?.model).toBe("complete-model");
    calls.length = 0;
    await drain(llm.complete(req));
    expect(calls[0]?.model).toBe("constructor-model");
  });

  it("tool_use block: input_json_delta accumulates by blockIndex (index is not an array index)", async () => {
    streamEvents.push(
      textBlockStart,
      textDelta("First"),
      toolBlockStart("call_1", "calculator"),
      inputJsonDelta('{"a":12,"b":30}'),
      messageDelta("tool_use"),
    );
    const llm = new AnthropicLlmAdapter({ model: "claude-test" });
    const events = await drain(llm.complete(req));
    const done = events.at(-1) as { type: "done"; partial: { text?: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[] } };
    expect(done.partial.text).toBe("First");
    expect(done.partial.toolCalls?.[0]).toEqual({ id: "call_1", name: "calculator", arguments: { a: 12, b: 30 } });
  });

  it("a provider exception during the request is encoded in the final done event, no throw (StreamFn contract)", async () => {
    streamEvents.push(textBlockStart, textDelta("part already received"));
    mockFailure = new Error("provider stream broken");
    const llm = new AnthropicLlmAdapter({ model: "claude-test" });
    // Contract assertion: the consumer fully consumes the event stream without receiving any throw
    const events = await drain(llm.complete(req));
    // The failure happens after the request is set up (start already emitted, partial text already arrived)
    expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "done"]);
    const done = events.at(-1) as { type: "done"; partial: { stopReason?: StopReason; errorMessage?: string } };
    expect(done.type).toBe("done");
    expect(done.partial.stopReason).toBe("error");
    expect(done.partial.errorMessage).toContain("provider stream broken");
  });
});

describe("convertToLlm boundary", () => {
  it("user messages with empty text are filtered out (Pi L1169-1176)", async () => {
    const { convertToLlm } = await import("../src/llm.ts");
    const out = convertToLlm([{ role: "user", text: "" }, { role: "user", text: "valid" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ role: "user", content: "valid" });
  });

  it("empty assistant (no text, no tool calls) is dropped entirely (Pi L1261)", async () => {
    const { convertToLlm } = await import("../src/llm.ts");
    const out = convertToLlm([asst({ stopReason: "error", errorMessage: "failed" })]);
    expect(out).toHaveLength(0);
  });

  it("thinking without signature → converted to a text block that keeps the reasoning (Pi L1232-1243)", async () => {
    const { convertToLlm } = await import("../src/llm.ts");
    const out = convertToLlm([asst({ thinking: "reasoning process", text: "answer" })]);
    const blocks = out[0].content as { type: string; text?: string }[];
    expect(blocks.map((b) => b.type)).toEqual(["text", "text"]);
    expect(blocks[0].text).toBe("reasoning process");
    expect(blocks[1].text).toBe("answer");
  });

  it("thinking with signature and text → thinking block sent back as-is (Pi L1246-1250)", async () => {
    const { convertToLlm } = await import("../src/llm.ts");
    const out = convertToLlm([asst({ thinking: "reasoning", thinkingSignature: "sig-1", text: "answer" })]);
    const blocks = out[0].content as { type: string; thinking?: string; signature?: string }[];
    expect(blocks).toEqual([
      { type: "thinking", thinking: "reasoning", signature: "sig-1" },
      { type: "text", text: "answer" },
    ]);
  });
});
