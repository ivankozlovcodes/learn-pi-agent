/**
 * Chapter 01 tests: the Tool Calling loop (driven by a streaming mock, offline).
 * The mock event sequences follow the Chapter 00 shared base AssistantMessageEvent (start + done, optionally with deltas).
 */
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { LLMAdapter, LLMRequest } from "../../00-minimal-llm-call/src/index.ts";
import type { AssistantMessage, AssistantMessageEvent, Message, Tool } from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool, createEchoTool } from "../../00-minimal-llm-call/src/index.ts";

/** Streaming mock LLM: returns one scripted event sequence per turn and records every input. */
class ScriptedLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;
  readonly inputs: LLMRequest[] = [];

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(input: LLMRequest): AsyncIterable<AssistantMessageEvent> {
    this.inputs.push(input);
    const events = this.steps[Math.min(this.next, this.steps.length - 1)];
    this.next++;
    yield* events;
  }

  get callCount(): number {
    return this.next;
  }
}

/** Build the event sequence for a text reply. */
function textStream(text: string, stopReason: AssistantMessage["stopReason"] = "end_turn"): AssistantMessageEvent[] {
  return [
    { type: "start", partial: { role: "assistant", stopReason } },
    { type: "done", partial: { role: "assistant", stopReason, text: text || undefined } },
  ];
}

/** Build the event sequence for a tool call. */
function toolStream(id: string, name: string, args: Record<string, unknown>): AssistantMessageEvent[] {
  const partial: AssistantMessage = {
    role: "assistant",
    stopReason: "tool_use",
    toolCalls: [{ id, name, arguments: args }],
  };
  return [
    { type: "start", partial },
    { type: "toolcall_start", partial },
    { type: "done", partial },
  ];
}

const echo = createEchoTool();
const calculator = createCalculatorTool();

function lastMessage(messages: Message[]): Message {
  return messages[messages.length - 1];
}

describe("agentLoop (01: Tool Calling, streaming interface)", () => {
  it("termination: no tool call ends the loop (one LLM call returns the final text)", async () => {
    const llm = new ScriptedLlm([textStream("Hello!")]);
    const messages = await agentLoop({
      model: "m",
      systemPrompt: "You are an assistant",
      messages: [{ role: "user", text: "Say hello" }],
      tools: [echo, calculator],
      llm,
    });

    expect(llm.callCount).toBe(1);
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].text).toBe("Hello!");
  });

  it("tool loop: tool_call → toolResult → LLM called again → final text", async () => {
    const llm = new ScriptedLlm([toolStream("call_1", "echo", { text: "hi" }), textStream("Echoed")]);
    const messages = await agentLoop({
      model: "m",
      systemPrompt: "You are an assistant",
      messages: [{ role: "user", text: "Echo hi" }],
      tools: [echo, calculator],
      llm,
    });

    expect(llm.callCount).toBe(2);
    expect(messages).toHaveLength(4);
    expect(messages[2]).toMatchObject({ role: "toolResult", toolCallId: "call_1", text: "hi", isError: false });
    expect(lastMessage(messages).text).toBe("Echoed");
  });

  it("key loop: the history received by the second LLM call must include the toolResult (result sent back)", async () => {
    const llm = new ScriptedLlm([toolStream("call_1", "calculator", { a: 12, b: 30 }), textStream("42")]);
    await agentLoop({
      model: "m",
      systemPrompt: "Calculation assistant",
      messages: [{ role: "user", text: "12+30=?" }],
      tools: [echo, calculator],
      llm,
    });

    // Internal message model: toolResult keeps its own role (the convertToLlm merge happens inside the adapter, on the provider side)
    const secondInput = llm.inputs[1].messages;
    expect(secondInput[1]).toMatchObject({ role: "assistant", toolCalls: [{ name: "calculator" }] });
    expect(secondInput[2]).toMatchObject({ role: "toolResult", toolCallId: "call_1", text: "42", isError: false });
  });

  it("multi-turn tool calls (echo → calculator → text)", async () => {
    const llm = new ScriptedLlm([
      toolStream("call_1", "echo", { text: "Start" }),
      toolStream("call_2", "calculator", { a: 1, b: 2 }),
      textStream("Done"),
    ]);
    const messages = await agentLoop({
      model: "m",
      systemPrompt: "Assistant",
      messages: [{ role: "user", text: "Run them in order" }],
      tools: [echo, calculator],
      llm,
    });

    expect(llm.callCount).toBe(3);
    expect(messages[4].text).toBe("3");
    expect(lastMessage(messages).text).toBe("Done");
  });

  it("tool not found → error toolResult (Pi prepareToolCall L608-614), the loop keeps going", async () => {
    const llm = new ScriptedLlm([toolStream("call_1", "unknown_tool", {}), textStream("There is no such tool")]);
    const messages = await agentLoop({
      model: "m",
      systemPrompt: "Assistant",
      messages: [{ role: "user", text: "Call unknown_tool" }],
      tools: [echo, calculator],
      llm,
    });

    expect(messages[2]).toMatchObject({ role: "toolResult", toolName: "unknown_tool", isError: true });
    expect(messages[2].text).toContain("not found");
    expect(lastMessage(messages).role).toBe("assistant");
  });

  it("tool execution throws → error toolResult (Pi executePreparedToolCall L701-707)", async () => {
    const broken: Tool = {
      name: "boom",
      description: "Always fails",
      parameters: { type: "object", properties: {} },
      async execute() {
        throw new Error("boom tool execution failed");
      },
    };
    const llm = new ScriptedLlm([toolStream("call_1", "boom", {}), textStream("Got the error")]);
    const messages = await agentLoop({
      model: "m",
      systemPrompt: "Assistant",
      messages: [{ role: "user", text: "Call boom" }],
      tools: [echo, calculator, broken],
      llm,
    });

    expect(messages[2]).toMatchObject({ role: "toolResult", toolName: "boom", isError: true });
    expect(messages[2].text).toBe("boom tool execution failed");
  });
});
