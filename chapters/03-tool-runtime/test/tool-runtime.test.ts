/**
 * Chapter 03 tests: Tool Runtime — the pipeline (prepare/validate/execute/normalize),
 * hooks (beforeToolCall/afterToolCall), tool_execution_* events, batch termination semantics.
 * Driven by a streaming mock LLM (offline).
 */
import { describe, expect, it } from "vitest";
import { agentLoop, runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEventSink } from "../src/tool-runtime.ts";
import type { LLMAdapter, LLMRequest } from "../../00-minimal-llm-call/src/index.ts";
import type {
  AgentContext,
  AgentEvent,
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  Tool,
} from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool, createEchoTool } from "../../00-minimal-llm-call/src/index.ts";

/** Streaming mock LLM: returns the event sequence for each turn from scripted steps. */
class ScriptedLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;
  readonly inputs: LLMRequest[] = [];

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(input: LLMRequest): AsyncIterable<AssistantMessageEvent> {
    // Snapshot messages at request time (the loop pushes into the same array reference), used to assert "later LLM requests are not polluted"
    this.inputs.push({ ...input, messages: [...input.messages] });
    const events = this.steps[Math.min(this.next, this.steps.length - 1)];
    this.next++;
    yield* events;
  }

  get callCount(): number {
    return this.next;
  }
}

function textStream(text: string, stopReason: AssistantMessage["stopReason"] = "end_turn"): AssistantMessageEvent[] {
  return [
    { type: "start", partial: { role: "assistant", stopReason } },
    { type: "done", partial: { role: "assistant", stopReason, text: text || undefined } },
  ];
}

/** Tool call stream: supports any number of tool calls (one model reply can carry several toolCalls). */
function toolStream(calls: { id: string; name: string; args: Record<string, unknown> }[]): AssistantMessageEvent[] {
  const partial: AssistantMessage = {
    role: "assistant",
    stopReason: "tool_use",
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args })),
  };
  return [
    { type: "start", partial },
    ...calls.map((c) => ({ type: "toolcall_start" as const, partial })),
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
  get toolEvents(): AgentEvent[] {
    return this.events.filter((e) => e.type.startsWith("tool_execution"));
  }
}

const echo = createEchoTool();
const calculator = createCalculatorTool();

function baseContext(tools: Tool[] = [echo, calculator]): AgentContext {
  return { systemPrompt: "assistant", messages: [], tools };
}

describe("Tool Runtime (Chapter 03)", () => {
  it("validation blocks: wrong argument type → error result, tool never executed", async () => {
    let executed = 0;
    const guarded: Tool<{ a: number; b: number }> = {
      ...calculator,
      async execute(args: { a: number; b: number }) {
        executed++;
        return calculator.execute(args);
      },
    };
    const llm = new ScriptedLlm([
      toolStream([{ id: "c1", name: "calculator", args: { a: "not a number", b: 2 } }]),
      textStream("bad arguments"),
    ]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop([{ role: "user", text: "calculate" }], baseContext([guarded]), { model: "m" }, llm, recorder.sink);

    expect(executed).toBe(0);
    const result = messages.find((m) => m.role === "toolResult");
    expect(result).toMatchObject({ isError: true, toolName: "calculator" });
    expect(result?.text).toContain("Argument validation failed");
    expect(llm.callCount).toBe(2); // the model continues after the error result is sent back
  });

  it("validation blocks: missing required argument → error result", async () => {
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "echo", args: {} }]), textStream("missing argument")]);
    const messages = await runAgentLoop([{ role: "user", text: "hi" }], baseContext(), { model: "m" }, llm, () => {});

    expect(messages.find((m) => m.role === "toolResult")?.text).toContain("Missing required argument");
  });

  it("beforeToolCall hook: block → error result, tool not executed", async () => {
    let executed = 0;
    const guarded: Tool<{ text: string }> = {
      ...echo,
      async execute(args: { text: string }) {
        executed++;
        return echo.execute(args);
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "echo", args: { text: "hi" } }]), textStream("blocked")]);
    const messages = await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([guarded]),
      {
        model: "m",
        beforeToolCall: async () => ({ block: true, reason: "test block" }),
      },
      llm,
      () => {},
    );

    expect(executed).toBe(0);
    expect(messages.find((m) => m.role === "toolResult")).toMatchObject({ isError: true, text: "test block" });
  });

  it("afterToolCall hook: field-level override of content and terminate", async () => {
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "echo", args: { text: "hi" } }]), textStream("after override")]);
    const messages = await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext(),
      {
        model: "m",
        afterToolCall: async ({ result }) => ({ content: `overridden: ${result.content}`, terminate: true }),
      },
      llm,
      () => {},
    );

    const result = messages.find((m) => m.role === "toolResult");
    expect(result?.text).toBe("overridden: hi");
    expect(result?.terminate).toBe(true);
  });

  it("tool_execution_* events: start/end always emitted, update emitted on onUpdate", async () => {
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "echo", args: { text: "hi" } }]), textStream("done")]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "hi" }], baseContext(), { model: "m" }, llm, recorder.sink);

    const types = recorder.toolEvents.map((e) => e.type);
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("tool_execution_end");
    expect(types).not.toContain("tool_execution_update"); // echo does not call onUpdate
  });

  it("onUpdate: partial updates during tool execution → tool_execution_update events", async () => {
    const streaming: Tool = {
      name: "slow",
      description: "runs in steps",
      parameters: { type: "object", properties: {} },
      async execute(_args, onUpdate) {
        onUpdate?.({ content: "step 1 done" });
        onUpdate?.({ content: "step 2 done" });
        return { content: "all done" };
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "slow", args: {} }]), textStream("done")]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "hi" }], baseContext([streaming]), { model: "m" }, llm, recorder.sink);

    const updates = recorder.toolEvents.filter((e) => e.type === "tool_execution_update");
    expect(updates).toHaveLength(2);
    if (updates[0]?.type === "tool_execution_update") {
      expect(updates[0].partialResult).toMatchObject({ content: "step 1 done" });
    }
  });

  it("normalize: details/usage/terminate/addedToolNames go into the tool result message", async () => {
    const rich: Tool = {
      name: "rich",
      description: "returns a structured result",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          content: "processing done",
          details: { rows: 42 },
          usage: { inputTokens: 10, outputTokens: 5 },
          terminate: true,
          addedToolNames: ["echo"],
        };
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "rich", args: {} }]), textStream("done")]);
    const messages = await runAgentLoop([{ role: "user", text: "hi" }], baseContext([rich]), { model: "m" }, llm, () => {});

    const result = messages.find((m) => m.role === "toolResult");
    expect(result).toMatchObject({
      text: "processing done",
      details: { rows: 42 },
      usage: { inputTokens: 10, outputTokens: 5 },
      terminate: true,
      addedToolNames: ["echo"],
      isError: false,
    });
  });

  it("prepareArguments: the compatibility layer converts the model's raw arguments into the format the tool expects", async () => {
    const lenient: Tool<{ text: string }> = {
      name: "echo2",
      description: "accepts { input } or { text }",
      // parameters describe the converted shape: validation happens after prepare (Pi L617-618)
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      prepareArguments: (args) => {
        const record = args as Record<string, unknown>;
        return { text: typeof record.text === "string" ? record.text : String(record.input ?? "") };
      },
      async execute({ text }) {
        return { content: `echo2: ${text}` };
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "echo2", args: { input: "compat" } }]), textStream("done")]);
    const messages = await runAgentLoop([{ role: "user", text: "hi" }], baseContext([lenient]), { model: "m" }, llm, () => {});

    expect(messages.find((m) => m.role === "toolResult")?.text).toBe("echo2: compat");
  });

  it("batch termination: stop only if the whole batch terminates; continue if only some terminate", async () => {
    const stopping: Tool = {
      name: "stop",
      description: "suggests stopping",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "suggest stop", terminate: true };
      },
    };

    // Scenario A: both tools terminate → the loop stops (no more LLM calls)
    const allStop = new ScriptedLlm([toolStream([{ id: "c1", name: "stop", args: {} }, { id: "c2", name: "stop", args: {} }])]);
    const recorderA = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "hi" }], baseContext([stopping]), { model: "m" }, allStop, recorderA.sink);
    expect(allStop.callCount).toBe(1);
    expect(recorderA.types.at(-1)).toBe("agent_end");

    // Scenario B: one terminates, one doesn't → the loop continues
    const partialStop = new ScriptedLlm([
      toolStream([{ id: "c1", name: "stop", args: {} }, { id: "c2", name: "echo", args: { text: "hi" } }]),
      textStream("done after continuing"),
    ]);
    const messages = await runAgentLoop([{ role: "user", text: "hi" }], baseContext([stopping, echo]), { model: "m" }, partialStop, () => {});
    expect(partialStop.callCount).toBe(2);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", text: "done after continuing" });
  });

  it("the normal loop still works: echo → calculator → final text (regression)", async () => {
    const llm = new ScriptedLlm([
      toolStream([{ id: "c1", name: "echo", args: { text: "start" } }]),
      toolStream([{ id: "c2", name: "calculator", args: { a: 1, b: 2 } }]),
      textStream("3"),
    ]);
    const messages = await agentLoop([{ role: "user", text: "run in order" }], baseContext(), { model: "m" }, llm);
    const result = await messages.result();

    expect(result.at(-1)).toMatchObject({ role: "assistant", text: "3" });
    expect(result.filter((m) => m.role === "toolResult").length).toBe(2);
  });

  it("beforeToolCall throws: error result, tool not executed, start/end paired, loop not broken (Pi L616-667)", async () => {
    let executed = 0;
    const guarded: Tool = {
      ...echo,
      async execute(args: never) {
        executed++;
        return echo.execute(args);
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "echo", args: { text: "hi" } }]), textStream("continue")]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([guarded]),
      {
        model: "m",
        beforeToolCall: async () => {
          throw new Error("hook blew up");
        },
      },
      llm,
      recorder.sink,
    );

    expect(executed).toBe(0); // the hook throws before execute
    expect(messages.find((m) => m.role === "toolResult")).toMatchObject({
      isError: true,
      text: "beforeToolCall hook threw: hook blew up",
    });
    const starts = recorder.toolEvents.filter((e) => e.type === "tool_execution_start");
    const ends = recorder.toolEvents.filter((e) => e.type === "tool_execution_end");
    expect(starts).toHaveLength(1); // start/end pairing is not affected by the hook error
    expect(ends).toHaveLength(1);
    expect(llm.callCount).toBe(2); // the error doesn't break the loop; the next turn continues
    expect(recorder.types.at(-1)).toBe("agent_end");
  });

  it("afterToolCall throws: execution already done, result becomes an error, end matches toolResult, batch not broken (Pi L747-750)", async () => {
    let executed = 0;
    const guarded: Tool = {
      ...echo,
      async execute(args: never) {
        executed++;
        return echo.execute(args);
      },
    };
    const llm = new ScriptedLlm([
      toolStream([
        { id: "c1", name: "echo", args: { text: "hi" } },
        { id: "c2", name: "echo", args: { text: "b" } },
      ]),
      textStream("continue"),
    ]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([guarded]),
      {
        model: "m",
        afterToolCall: async () => {
          throw new Error("override blew up");
        },
      },
      llm,
      recorder.sink,
    );

    expect(executed).toBe(2); // both tools actually executed
    const results = messages.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r).toMatchObject({ isError: true, text: "override blew up" }); // the original success result must not enter history
    }
    const ends = recorder.toolEvents.filter((e) => e.type === "tool_execution_end");
    expect(ends).toHaveLength(2);
    if (ends[0]?.type === "tool_execution_end") {
      expect(ends[0]).toMatchObject({ isError: true, result: { content: "override blew up" } }); // end matches the final toolResult
    }
    expect(llm.callCount).toBe(2); // batch/loop not broken
  });

  it("not-found: tool_execution_start happens before lookup, one start and one end, tool not executed (Pi L445-450 + L608-614)", async () => {
    let executed = 0;
    const guarded: Tool = {
      ...echo,
      async execute(args: never) {
        executed++;
        return echo.execute(args);
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "ghost", args: {} }]), textStream("continue")]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop([{ role: "user", text: "hi" }], baseContext([guarded]), { model: "m" }, llm, recorder.sink);

    // Event order: tool_execution_start → tool_execution_end → message_start(toolResult) → message_end(toolResult)
    const indexOf = (type: string): number => recorder.events.findIndex((e) => e.type === type);
    expect(indexOf("tool_execution_start")).toBeGreaterThanOrEqual(0);
    expect(indexOf("tool_execution_end")).toBeGreaterThan(indexOf("tool_execution_start"));
    const resultStart = recorder.events.findIndex((e) => e.type === "message_start" && e.message.role === "toolResult");
    const resultEnd = recorder.events.findIndex((e) => e.type === "message_end" && e.message.role === "toolResult");
    expect(resultStart).toBeGreaterThan(indexOf("tool_execution_end"));
    expect(resultEnd).toBeGreaterThan(resultStart);

    // One start and one end: if someone later moves start after a successful lookup, the not-found path will have no start
    expect(recorder.toolEvents.filter((e) => e.type === "tool_execution_start")).toHaveLength(1);
    expect(recorder.toolEvents.filter((e) => e.type === "tool_execution_end")).toHaveLength(1);
    expect(messages.find((m) => m.role === "toolResult")).toMatchObject({ isError: true, text: "Tool ghost not found" });
    expect(executed).toBe(0);
  });

  it("signal aborts midway: break after the first tool, second not executed, result enters history and the run closes out (Pi L478-480)", async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const first: Tool = {
      ...echo,
      name: "echo_first",
      async execute(args: never) {
        executed.push("first");
        controller.abort(); // trigger abort during execution: the loop breaks after the first tool returns
        return echo.execute(args);
      },
    };
    const second: Tool = {
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
    // Second turn: after abort the loop still enters the next turn (hasMoreToolCalls=true); a real adapter would return aborted because of the signal → termination ①
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
      [{ role: "user", text: "two tools" }],
      baseContext([first, second]),
      { model: "m" },
      llm,
      recorder.sink,
      controller.signal,
    );

    expect(executed).toEqual(["first"]); // the second tool never executed
    const toolResults = messages.filter((m) => m.role === "toolResult");
    expect(toolResults).toHaveLength(1); // the completed first toolResult enters history normally
    expect(toolResults[0]).toMatchObject({ toolCallId: "c1", toolName: "echo_first" });
    const turnEnds = recorder.events.filter((e) => e.type === "turn_end");
    expect(turnEnds).toHaveLength(2); // both the tool turn and the aborted turn close out correctly
    if (turnEnds[0]?.type === "turn_end") {
      expect(turnEnds[0].toolResults).toHaveLength(1);
    }
    expect(llm.callCount).toBe(2);
    expect(recorder.types.at(-1)).toBe("agent_end"); // the lifecycle closes out correctly
    expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
  });

  it("message event snapshot isolation: consumer changes to event.message don't pollute history or later LLM requests", async () => {
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "echo", args: { text: "hi" } }]), textStream("done")]);
    const mutatingSink: AgentEventSink = (event) => {
      // A consumer maliciously mutates the event payload: before snapshot isolation, raw-reference sites would pollute the internal history directly
      if (event.type === "message_end") {
        event.message.text = "polluted";
        event.message.isError = true;
      }
    };
    const messages = await runAgentLoop([{ role: "user", text: "echo" }], baseContext(), { model: "m" }, llm, mutatingSink);

    expect(messages.find((m) => m.role === "toolResult")).toMatchObject({ text: "hi", isError: false });
    expect(messages.at(-1)?.text).toBe("done"); // the final assistant message is not polluted either
    const secondRequest = llm.inputs[1]; // the second-turn LLM request (snapshot at request time)
    expect(secondRequest.messages.find((m) => m.role === "toolResult")).toMatchObject({ text: "hi", isError: false });
  });
});
