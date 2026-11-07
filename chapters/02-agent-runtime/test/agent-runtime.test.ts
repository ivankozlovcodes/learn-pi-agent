/**
 * Chapter 02 tests: the full Agent Runtime. Event sequence, streaming deltas (message_update/partial snapshot),
 * termination semantics (error/aborted/length), newMessages, context snapshot isolation, EventStream entry.
 * Driven by a streaming mock LLM (offline).
 */
import { describe, expect, it, vi } from "vitest";
import { agentLoop, runAgentLoop, type AgentEventSink } from "../src/agent-loop.ts";
import type { LLMAdapter, LLMRequest } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentContext, AgentEvent, AssistantMessage, AssistantMessageEvent, Message, Tool } from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool, createEchoTool } from "../../00-minimal-llm-call/src/index.ts";

/** Streaming mock LLM: returns an event sequence per turn, following the script steps. */
class ScriptedLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;
  readonly inputs: LLMRequest[] = [];

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(input: LLMRequest): AsyncIterable<AssistantMessageEvent> {
    // Snapshot the messages at request time: the loop pushes new messages into the same array reference,
    // so "the next LLM request carries the updated history" must be asserted as of request time
    this.inputs.push({ ...input, messages: [...input.messages] });
    const events = this.steps[Math.min(this.next, this.steps.length - 1)];
    this.next++;
    yield* events;
  }

  get callCount(): number {
    return this.next;
  }
}

/** Chunked text stream: the text arrives step by step in chunks. */
function textStream(chunks: string[], stopReason: AssistantMessage["stopReason"] = "end_turn"): AssistantMessageEvent[] {
  const events: AssistantMessageEvent[] = [];
  let acc = "";
  events.push({ type: "start", partial: { role: "assistant", stopReason } });
  for (const chunk of chunks) {
    acc += chunk;
    events.push({ type: "text_delta", partial: { role: "assistant", stopReason, text: acc } });
  }
  events.push({ type: "done", partial: { role: "assistant", stopReason, text: acc || undefined } });
  return events;
}

/** Tool call stream: toolcall_start (complete arguments) → done. */
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

class EventRecorder {
  readonly events: AgentEvent[] = [];
  readonly sink: AgentEventSink = (event) => {
    this.events.push(event);
  };
  get types(): string[] {
    return this.events.map((e) => e.type);
  }
}

const echo = createEchoTool();
const calculator = createCalculatorTool();

function baseContext(extra?: Partial<AgentContext>): AgentContext {
  return { systemPrompt: "Assistant", messages: [{ role: "user", text: "hello" }], tools: [echo, calculator], ...extra };
}

describe("runAgentLoop (02: Agent Runtime)", () => {
  it("event sequence: agent → turn → message → turn_end → agent_end (one text turn)", async () => {
    const llm = new ScriptedLlm([textStream(["Hello!"])]);
    const recorder = new EventRecorder();
    const newMessages = await runAgentLoop([{ role: "user", text: "Say hello" }], baseContext(), { model: "m" }, llm, recorder.sink);

    expect(recorder.types).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_update", // streaming delta: once for a single text chunk (Chapter 02 consumes deltas)
      "message_end",
      "turn_end",
      "agent_end",
    ]);
    expect(newMessages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const agentEnd = recorder.events.at(-1);
    expect(agentEnd?.type).toBe("agent_end");
    if (agentEnd?.type === "agent_end") {
      expect(agentEnd.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    }
  });

  it("tool turn: events include toolResult message events, turn_end.toolResults is non-empty, multiple turns", async () => {
    const llm = new ScriptedLlm([toolStream("call_1", "echo", { text: "hi" }), textStream(["Echoed"])]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "Echo hi" }], baseContext(), { model: "m" }, llm, recorder.sink);

    expect(recorder.types).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_update", // toolcall_start delta
      "message_end",
      "message_start", // toolResult
      "message_end",
      "turn_end",
      "turn_start",
      "message_start",
      "message_update", // text_delta delta
      "message_end",
      "turn_end",
      "agent_end",
    ]);
    const toolTurnEnd = recorder.events.find((e) => e.type === "turn_end" && e.toolResults.length > 0);
    expect(toolTurnEnd).toBeDefined();
    if (toolTurnEnd?.type === "turn_end") {
      expect(toolTurnEnd.toolResults[0]).toMatchObject({ role: "toolResult", toolName: "echo", text: "hi" });
    }
  });

  it("streaming deltas: message_start once, message_update once per chunk, message_end once, text grows chunk by chunk", async () => {
    const llm = new ScriptedLlm([textStream(["Hel", "lo, ", "world"])]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "hi" }], baseContext(), { model: "m" }, llm, recorder.sink);

    const updates = recorder.events.filter((e) => e.type === "message_update");
    expect(updates).toHaveLength(3);
    const texts = updates.map((e) => (e.type === "message_update" ? e.message.text : ""));
    expect(texts).toEqual(["Hel", "Hello, ", "Hello, world"]);
    expect(recorder.types.filter((t) => t === "message_start")).toHaveLength(2);
    expect(recorder.types.filter((t) => t === "message_end")).toHaveLength(2);
  });

  it("partial snapshot mechanism: message_update carries a complete snapshot (not a delta), text accumulates monotonically (Pi L335-343)", async () => {
    const llm = new ScriptedLlm([textStream(["A", "B"])]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "hi" }], baseContext(), { model: "m" }, llm, recorder.sink);

    const updates = recorder.events.filter((e) => e.type === "message_update");
    // If the payload were a delta, "AB" would be "B"; the second update already holds all the text = evidence of a complete snapshot
    expect(updates[1]).toMatchObject({ message: { text: "AB" } });
    if (updates[1]?.type === "message_update") {
      expect(updates[1].assistantMessageEvent.type).toBe("text_delta");
    }
    // Note: the observable assertion that "the snapshot replacement was written into history" is in the next test (history chain); this test only locks the payload shape
  });

  it("history chain: partial replacement + done settles + toolResult goes into history → the next LLM request carries the updated history", async () => {
    // First turn: a text delta and a tool call arrive one after another (partial replaces the last context entry step by step)
    const startPartial: AssistantMessage = { role: "assistant", stopReason: "tool_use" };
    const withText: AssistantMessage = { role: "assistant", stopReason: "tool_use", text: "Let me check" };
    const withCall: AssistantMessage = {
      role: "assistant",
      stopReason: "tool_use",
      text: "Let me check",
      toolCalls: [{ id: "call_1", name: "calculator", arguments: { a: 12, b: 30 } }],
    };
    const llm = new ScriptedLlm([
      [
        { type: "start", partial: startPartial },
        { type: "text_delta", partial: withText },
        { type: "toolcall_start", partial: withCall },
        { type: "done", partial: withCall },
      ],
      textStream(["42"]),
    ]);
    await runAgentLoop([{ role: "user", text: "Calculate this" }], baseContext(), { model: "m" }, llm, () => {});

    // The second LLM request (snapshot at request time) must see the final assistant of the first turn + the matching toolResult
    const secondRequest = llm.inputs[1];
    // baseContext brings 1 history user message: request = [history user, this run's user, first-turn assistant, toolResult]
    expect(secondRequest.messages.map((m) => m.role)).toEqual(["user", "user", "assistant", "toolResult"]);
    expect(secondRequest.messages.at(-2)).toMatchObject({
      role: "assistant",
      text: "Let me check", // the final text settled by done, not some intermediate delta
      toolCalls: [{ id: "call_1", name: "calculator", arguments: { a: 12, b: 30 } }],
    });
    expect(secondRequest.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "calculator",
      text: "42",
      isError: false,
    });
  });

  it("tool stream: partial already holds the tool call at toolcall_start, and enters the execution cycle after done", async () => {
    const llm = new ScriptedLlm([toolStream("call_1", "calculator", { a: 12, b: 30 }), textStream(["42"])]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop([{ role: "user", text: "12+30?" }], baseContext(), { model: "m" }, llm, recorder.sink);

    expect(recorder.types).toContain("message_update");
    const toolStart = recorder.events.find((e) => e.type === "message_update" && e.assistantMessageEvent.type === "toolcall_start");
    expect(toolStart).toBeDefined();
    expect(messages.find((m) => m.role === "toolResult")).toMatchObject({ text: "42", isError: false });
    expect(llm.callCount).toBe(2);
  });

  it("termination ① error: agent_end immediately, no further LLM calls; errorMessage is observable", async () => {
    const llm = new ScriptedLlm([
      [
        { type: "start", partial: { role: "assistant", stopReason: "error", errorMessage: "API call failed" } },
        { type: "done", partial: { role: "assistant", stopReason: "error", errorMessage: "API call failed" } },
      ],
    ]);
    const recorder = new EventRecorder();
    const newMessages = await runAgentLoop([{ role: "user", text: "hi" }], baseContext(), { model: "m" }, llm, recorder.sink);

    expect(llm.callCount).toBe(1);
    expect(recorder.types.at(-1)).toBe("agent_end");
    expect(newMessages[1]).toMatchObject({ stopReason: "error", errorMessage: "API call failed" });
  });

  it("termination ① aborted: stopReason=aborted → agent_end immediately, tools are not executed (Pi L196)", async () => {
    const aborted = (): AssistantMessageEvent[] => {
      const partial: AssistantMessage = {
        role: "assistant",
        stopReason: "aborted",
        errorMessage: "Operation aborted",
        toolCalls: [{ id: "c1", name: "calculator", arguments: { a: 1, b: 2 } }],
      };
      return [
        { type: "start", partial },
        { type: "done", partial },
      ];
    };
    const llm = new ScriptedLlm([aborted()]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop([{ role: "user", text: "hi" }], baseContext(), { model: "m" }, llm, recorder.sink);

    expect(recorder.types.at(-1)).toBe("agent_end");
    expect(messages.some((m) => m.role === "toolResult")).toBe(false);
  });

  it("truncation guard: stopReason=length with toolCalls → all marked as errors, tools are not executed", async () => {
    let calls = 0;
    let executed = 0;
    const countingLlm: LLMAdapter = {
      async *complete() {
        calls++;
        if (calls === 1) {
          const partial: AssistantMessage = {
            role: "assistant",
            stopReason: "length",
            toolCalls: [{ id: "call_1", name: "echo", arguments: { text: "x" } }],
          };
          yield { type: "start", partial };
          yield { type: "done", partial };
        } else {
          yield { type: "start", partial: { role: "assistant", stopReason: "end_turn" } };
          yield { type: "done", partial: { role: "assistant", stopReason: "end_turn", text: "Done after retry" } };
        }
      },
    };
    const guardedEcho: Tool = {
      ...echo,
      async execute(args: never) {
        executed++;
        return echo.execute(args);
      },
    };

    const events: AgentEvent[] = [];
    const messages = await runAgentLoop(
      [{ role: "user", text: "hi" }],
      { systemPrompt: "Assistant", messages: [], tools: [guardedEcho] },
      { model: "m" },
      countingLlm,
      (e) => {
        events.push(e);
      },
    );

    expect(executed).toBe(0);
    const truncated = messages.find((m) => m.role === "toolResult");
    expect(truncated).toMatchObject({ isError: true, toolName: "echo" });
    expect(truncated?.text).toContain("token limit");
    // Pi L216: truncated batch terminate=false → keep looping; the model re-issues complete arguments based on the error results (second turn)
    expect(calls).toBe(2);
    expect(messages.at(-1)?.text).toBe("Done after retry");
    // Pi L386-403: the truncated-result events are complete (tool_execution_start/end + message events)
    const truncToolEvents = events.filter(
      (e) => (e.type === "tool_execution_start" || e.type === "tool_execution_end") && e.toolCallId === "call_1",
    );
    expect(truncToolEvents).toHaveLength(2);
    const truncMsgEvents = events.filter((e) => e.type === "message_start" && e.message.role === "toolResult");
    expect(truncMsgEvents).toHaveLength(1);
  });

  it("signal aborts midway: break after the first tool finishes, the second tool is not executed, results go into history normally and the run wraps up (Pi L478-480)", async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const abortingEcho: Tool = {
      ...echo,
      name: "echo_first",
      async execute(args: never) {
        executed.push("first");
        controller.abort(); // abort fires during tool execution: the loop breaks after the first tool returns (teaching L134-137)
        return echo.execute(args);
      },
    };
    const countingEcho: Tool = {
      ...echo,
      name: "echo_second",
      async execute(args: never) {
        executed.push("second");
        return echo.execute(args);
      },
    };
    const twoCalls: AssistantMessage = {
      role: "assistant",
      stopReason: "tool_use",
      toolCalls: [
        { id: "c1", name: "echo_first", arguments: { text: "a" } },
        { id: "c2", name: "echo_second", arguments: { text: "b" } },
      ],
    };
    // Second turn: after abort the loop still enters the next turn (hasMoreToolCalls=true); a real adapter would return aborted here because of the signal → termination ①
    const aborted: AssistantMessage = { role: "assistant", stopReason: "aborted", errorMessage: "Operation aborted" };
    const llm = new ScriptedLlm([
      [
        { type: "start", partial: twoCalls },
        { type: "toolcall_start", partial: twoCalls },
        { type: "done", partial: twoCalls },
      ],
      [
        { type: "start", partial: aborted },
        { type: "done", partial: aborted },
      ],
    ]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop(
      [{ role: "user", text: "Two tools" }],
      { systemPrompt: "Assistant", messages: [], tools: [abortingEcho, countingEcho] },
      { model: "m" },
      llm,
      recorder.sink,
      controller.signal,
    );

    expect(executed).toEqual(["first"]); // the second tool never executes (Pi L478-480 break)
    const toolResults = messages.filter((m) => m.role === "toolResult");
    expect(toolResults).toHaveLength(1); // the completed first toolResult goes into history normally
    expect(toolResults[0]).toMatchObject({ toolCallId: "c1", toolName: "echo_first" });
    const turnEnds = recorder.events.filter((e) => e.type === "turn_end");
    expect(turnEnds).toHaveLength(2); // both the tool turn and the aborted turn wrap up correctly
    if (turnEnds[0]?.type === "turn_end") {
      expect(turnEnds[0].toolResults).toHaveLength(1);
    }
    expect(llm.callCount).toBe(2); // after abort the loop still enters the next turn; the second turn terminates with aborted
    expect(recorder.events.at(-1)?.type).toBe("agent_end"); // the lifecycle wraps up correctly
    expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
  });

  it("newMessages semantics: holds only what this run adds, not the caller's history", async () => {
    const llm = new ScriptedLlm([textStream(["Done"])]);
    const context = baseContext({ messages: [{ role: "user", text: "Old message" }] });
    const newMessages = await runAgentLoop([{ role: "user", text: "New message" }], context, { model: "m" }, llm, () => {});

    expect(newMessages.map((m) => m.text)).toEqual(["New message", "Done"]);
    expect(newMessages.some((m) => m.text === "Old message")).toBe(false);
  });

  it("context snapshot isolation: the caller's context is not modified by the loop", async () => {
    const llm = new ScriptedLlm([toolStream("call_1", "calculator", { a: 1, b: 2 }), textStream(["3"])]);
    const context = baseContext();
    const originalLength = context.messages.length;
    await runAgentLoop([{ role: "user", text: "Calculate" }], context, { model: "m" }, llm, () => {});

    expect(context.messages).toHaveLength(originalLength);
  });

  it("agentLoop entry: for await receives all events, result() returns newMessages, agent_end appears only once", async () => {
    const llm = new ScriptedLlm([textStream(["Done"])]);
    const stream = agentLoop([{ role: "user", text: "hi" }], baseContext(), { model: "m" }, llm);

    const types: string[] = [];
    for await (const event of stream) {
      types.push(event.type);
    }
    const result = await stream.result();

    expect(types.at(-1)).toBe("agent_end");
    expect(types.filter((t) => t === "agent_end")).toHaveLength(1);
    expect(result.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("agentLoop exception fallback: when the background runner throws, the stream still ends and result() is [] (teaching addition)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Contract-violation scenario: an adapter failure should be encoded into the stopReason of done; here we simulate a runner-level exception (a real hang risk)
      const throwingLlm: LLMAdapter = {
        async *complete() {
          throw new Error("LLM blew up");
        },
      };
      const stream = agentLoop([{ role: "user", text: "hi" }], baseContext(), { model: "m" }, throwingLlm);

      const types: string[] = [];
      for await (const event of stream) {
        types.push(event.type);
      }
      const result = await stream.result();

      // Events emitted before the failure can still be consumed, then the stream terminates normally: consumers do not hang forever
      expect(types).toEqual(["agent_start", "turn_start", "message_start", "message_end"]);
      expect(result).toEqual([]); // current convention: runner exception → empty result (Pi has no catch; on reject the stream hangs)
      expect(consoleSpy).toHaveBeenCalled(); // the exception leaves a trace
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("empty prompts guard: runAgentLoop throws directly and does not call the LLM (teaching addition; Pi has no such guard)", async () => {
    const llm = new ScriptedLlm([textStream(["x"])]);
    await expect(runAgentLoop([], baseContext(), { model: "m" }, llm, () => {})).rejects.toThrow("prompts must not be empty");
    expect(llm.callCount).toBe(0);
  });
});
