/**
 * Chapter 04 tests: Parallel Tool Execution — two-stage parallelism, preserved message order,
 * end events in completion order, dispatch (sequential/executionMode), immediate failures, terminate carrying over.
 * Driven by a streaming mock LLM (offline).
 */
import { describe, expect, it } from "vitest";
import { runAgentLoop, type AgentEventSink } from "../src/agent-loop.ts";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type {
  AgentContext,
  AgentEvent,
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  Tool,
} from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool, createEchoTool } from "../../00-minimal-llm-call/src/index.ts";

/** Streaming mock LLM. */
class ScriptedLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(): AsyncIterable<AssistantMessageEvent> {
    const events = this.steps[Math.min(this.next, this.steps.length - 1)];
    this.next++;
    yield* events;
  }

  get callCount(): number {
    return this.next;
  }
}

function textStream(text: string): AssistantMessageEvent[] {
  return [
    { type: "start", partial: { role: "assistant", stopReason: "end_turn" } },
    { type: "done", partial: { role: "assistant", stopReason: "end_turn", text } },
  ];
}

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
  toolEventsOf(type: string): AgentEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}

const echo = createEchoTool();
const calculator = createCalculatorTool();

/** Delayed tool: finishes after delayMs milliseconds. */
function slowTool(name: string, delayMs: number): Tool {
  return {
    name,
    description: `Finishes after ${delayMs}ms`,
    parameters: { type: "object", properties: {} },
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { content: `${name} done` };
    },
  };
}

function baseContext(tools: Tool[] = [echo, calculator]): AgentContext {
  return { systemPrompt: "assistant", messages: [], tools };
}

describe("Parallel Tool Execution (Chapter 04)", () => {
  it("parallel by default: all tool_execution_start events come first, and only then the first end (two-stage structure)", async () => {
    const llm = new ScriptedLlm([
      toolStream([
        { id: "c1", name: "fast1", args: {} },
        { id: "c2", name: "slow200", args: {} },
        { id: "c3", name: "fast2", args: {} },
      ]),
      textStream("done"),
    ]);
    const recorder = new EventRecorder();
    await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([slowTool("fast1", 10), slowTool("slow200", 200), slowTool("fast2", 10)]),
      { model: "m" },
      llm,
      recorder.sink,
    );

    const starts = recorder.toolEventsOf("tool_execution_start");
    const ends = recorder.toolEventsOf("tool_execution_end");
    expect(starts).toHaveLength(3);
    expect(ends).toHaveLength(3);
    // Two stages: all starts precede the first end
    const startIdx = recorder.events.findIndex((e) => e.type === "tool_execution_start");
    const firstEndIdx = recorder.events.findIndex((e) => e.type === "tool_execution_end");
    const lastStartIdx = recorder.events.map((e) => e.type).lastIndexOf("tool_execution_start");
    expect(startIdx).toBeLessThan(firstEndIdx);
    expect(lastStartIdx).toBeLessThan(firstEndIdx);
  });

  it("end events follow completion order, toolResult messages follow assistant source order", async () => {
    // Source order: fast1(10ms) → slow200(200ms) → fast2(10ms)
    const llm = new ScriptedLlm([
      toolStream([
        { id: "c1", name: "fast1", args: {} },
        { id: "c2", name: "slow200", args: {} },
        { id: "c3", name: "fast2", args: {} },
      ]),
      textStream("done"),
    ]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([slowTool("fast1", 10), slowTool("slow200", 200), slowTool("fast2", 10)]),
      { model: "m" },
      llm,
      recorder.sink,
    );

    // end completion order: fast1, fast2 (finish in parallel), slow200 last
    const endOrder = recorder.toolEventsOf("tool_execution_end").map((e) => (e.type === "tool_execution_end" ? e.toolName : ""));
    expect(endOrder[0]).toBe("fast1");
    expect(endOrder[1]).toBe("fast2");
    expect(endOrder[2]).toBe("slow200");

    // Message source order: fast1 → slow200 → fast2 (matches the assistant's request order)
    const resultNames = messages.filter((m) => m.role === "toolResult").map((m) => m.toolName);
    expect(resultNames).toEqual(["fast1", "slow200", "fast2"]);
  });

  it("dispatch: config.toolExecution = sequential → sequential (end order = source order)", async () => {
    const llm = new ScriptedLlm([
      toolStream([
        { id: "c1", name: "fast1", args: {} },
        { id: "c2", name: "slow200", args: {} },
      ]),
      textStream("done"),
    ]);
    const recorder = new EventRecorder();
    await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([slowTool("fast1", 10), slowTool("slow200", 200)]),
      { model: "m", toolExecution: "sequential" },
      llm,
      recorder.sink,
    );

    const endOrder = recorder.toolEventsOf("tool_execution_end").map((e) => (e.type === "tool_execution_end" ? e.toolName : ""));
    expect(endOrder).toEqual(["fast1", "slow200"]);
  });

  it("tool-level executionMode: one sequential tool → the whole batch is sequential (Pi L419-421)", async () => {
    const sequentialTool: Tool = { ...echo, executionMode: "sequential" };
    const llm = new ScriptedLlm([
      toolStream([
        { id: "c1", name: "echo", args: { text: "a" } },
        { id: "c2", name: "calculator", args: { a: 1, b: 2 } },
      ]),
      textStream("done"),
    ]);
    const recorder = new EventRecorder();
    await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([sequentialTool, calculator]),
      { model: "m" },
      llm,
      recorder.sink,
    );

    const endOrder = recorder.toolEventsOf("tool_execution_end").map((e) => (e.type === "tool_execution_end" ? e.toolName : ""));
    expect(endOrder).toEqual(["echo", "calculator"]);
  });

  it("immediate failure: one call in the batch not found → wraps up in place, the rest execute concurrently", async () => {
    const llm = new ScriptedLlm([
      toolStream([
        { id: "c1", name: "unknown", args: {} },
        { id: "c2", name: "calculator", args: { a: 1, b: 2 } },
      ]),
      textStream("continue"),
    ]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([echo, calculator]),
      { model: "m" },
      llm,
      recorder.sink,
    );

    const unknown = messages.find((m) => m.toolName === "unknown");
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown?.text).toContain("not found");
    const calc = messages.find((m) => m.toolName === "calculator");
    expect(calc).toMatchObject({ isError: false, text: "3" });
    expect(llm.callCount).toBe(2);
  });

  it("immediate message events follow source order: with unknown in second place, its message events come after calculator (Pi L543-548)", async () => {
    const llm = new ScriptedLlm([
      toolStream([
        { id: "c1", name: "calculator", args: { a: 1, b: 2 } },
        { id: "c2", name: "unknown", args: {} },
      ]),
      textStream("continue"),
    ]);
    const recorder = new EventRecorder();
    await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([echo, calculator]),
      { model: "m" },
      llm,
      recorder.sink,
    );

    const msgStarts = recorder.events.filter(
      (e): e is Extract<AgentEvent, { type: "message_start" }> => e.type === "message_start" && e.message.role === "toolResult",
    );
    expect(msgStarts.map((e) => e.message.toolName)).toEqual(["calculator", "unknown"]);
  });

  it("AbortSignal: an already aborted signal → the remaining tools are not prepared/executed (Pi L516-518/L629-654)", async () => {
    const executed: string[] = [];
    const guardTool: Tool = {
      name: "guard",
      description: "Records execution",
      parameters: { type: "object", properties: {} },
      async execute(args: never, _onUpdate?: (p: { content: string }) => void, signal?: AbortSignal) {
        if (signal?.aborted) {
          throw new Error("Operation aborted");
        }
        executed.push("guard");
        return { content: "ok" };
      },
    };
    const llm = new ScriptedLlm([
      toolStream([
        { id: "c1", name: "echo", args: { text: "x" } },
        { id: "c2", name: "guard", args: {} },
      ]),
      textStream("continue"),
    ]);
    const aborted = new AbortController();
    aborted.abort();
    await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([echo, guardTool]),
      { model: "m" },
      llm,
      () => {},
      aborted.signal,
    );
    // Stage 1 abort check before prepare: echo is intercepted with Operation aborted, guard is not prepared
    expect(executed).toEqual([]);
    expect(llm.callCount).toBe(2);  // the loop continues after the error results are sent back
  });

  it("carries over: under parallel execution, stop only if the whole batch terminates", async () => {
    const stopping: Tool = {
      name: "stop",
      description: "suggests stopping",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "stop", terminate: true };
      },
    };
    const llm = new ScriptedLlm([
      toolStream([
        { id: "c1", name: "stop", args: {} },
        { id: "c2", name: "stop", args: {} },
      ]),
    ]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "hi" }], baseContext([stopping]), { model: "m" }, llm, recorder.sink);

    expect(llm.callCount).toBe(1);
    expect(recorder.types.at(-1)).toBe("agent_end");
  });

  it("regression: normal closed loop echo → calculator → text (parallel by default)", async () => {
    const llm = new ScriptedLlm([
      toolStream([{ id: "c1", name: "echo", args: { text: "start" } }]),
      toolStream([{ id: "c2", name: "calculator", args: { a: 1, b: 2 } }]),
      textStream("3"),
    ]);
    const messages = await runAgentLoop([{ role: "user", text: "run them in turn" }], baseContext(), { model: "m" }, llm, () => {});

    expect(messages.at(-1)).toMatchObject({ role: "assistant", text: "3" });
    expect(messages.filter((m) => m.role === "toolResult").length).toBe(2);
  });

  it("the prepare stage is strictly sequential: hooks finish one by one in source order without overlapping, and execute starts only after all of them (two-stage structure)", async () => {
    const timeline: string[] = [];
    let hookDepth = 0;
    let hookOverlap = false;
    let execDepth = 0;
    let execOverlap = false;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const mkTool = (name: string): Tool => ({
      name,
      description: "Records execution",
      parameters: { type: "object", properties: {} },
      async execute() {
        timeline.push(`${name}-exec-start`);
        execDepth++;
        if (execDepth > 1) execOverlap = true;
        await sleep(30);
        execDepth--;
        timeline.push(`${name}-exec-end`);
        return { content: `${name} done` };
      },
    });

    const llm = new ScriptedLlm([
      toolStream([
        { id: "A", name: "tA", args: {} },
        { id: "B", name: "tB", args: {} },
        { id: "C", name: "tC", args: {} },
      ]),
      textStream("done"),
    ]);
    await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([mkTool("tA"), mkTool("tB"), mkTool("tC")]),
      {
        model: "m",
        beforeToolCall: async ({ toolCall }) => {
          timeline.push(`${toolCall.name}-hook-start`);
          hookDepth++;
          if (hookDepth > 1) hookOverlap = true;
          await sleep(20); // stretch the hook to create a detectable overlap window
          hookDepth--;
          timeline.push(`${toolCall.name}-hook-end`);
        },
      },
      llm,
      () => {},
    );

    // 1. hook call order strictly equals the assistant source order, with no overlap
    expect(timeline.slice(0, 6)).toEqual([
      "tA-hook-start", "tA-hook-end",
      "tB-hook-start", "tB-hook-end",
      "tC-hook-start", "tC-hook-end",
    ]);
    expect(hookOverlap).toBe(false);
    // 2. no execute starts until the prepare stage has fully finished (after all hook-ends)
    const execEvents = timeline.slice(6);
    expect(execEvents).toHaveLength(6); // 3 exec-starts + 3 exec-ends
    expect(execEvents.filter((e) => e.endsWith("-exec-start"))).toHaveLength(3);
    // 3. the execute stage may overlap (evidence of concurrency)
    expect(execOverlap).toBe(true);
  });

  it("parallel batch global order: the immediate end is in the prepare stage, the other ends follow completion order, all ends precede all messages, messages follow source order (Pi L532 + L543-548)", async () => {
    const timeline: string[] = [];
    const sink: AgentEventSink = (event) => {
      switch (event.type) {
        case "tool_execution_start":
          timeline.push(`start:${event.toolName}`);
          break;
        case "tool_execution_end":
          timeline.push(`end:${event.toolName}`);
          break;
        case "message_start":
          if (event.message.role === "toolResult") timeline.push(`msg:${event.message.toolName}`);
          break;
        default:
          break;
      }
    };
    // Source order: A=slowA(150ms) → B=ghost(immediate not found) → C=fastC(20ms)
    const llm = new ScriptedLlm([
      toolStream([
        { id: "A", name: "slowA", args: {} },
        { id: "B", name: "ghost", args: {} },
        { id: "C", name: "fastC", args: {} },
      ]),
      textStream("continue"),
    ]);
    await runAgentLoop(
      [{ role: "user", text: "hi" }],
      baseContext([slowTool("slowA", 150), slowTool("fastC", 20)]),
      { model: "m" },
      llm,
      sink,
    );

    const idxOf = (label: string): number => timeline.indexOf(label);
    // 1. starts are emitted in source order (one by one in the prepare stage)
    expect(timeline.filter((e) => e.startsWith("start:"))).toEqual(["start:slowA", "start:ghost", "start:fastC"]);
    // 2. B's immediate end is in the prepare stage (before fastC's start, i.e. before the execute stage)
    expect(idxOf("end:ghost")).toBeLessThan(idxOf("start:fastC"));
    expect(idxOf("end:ghost")).toBeLessThan(idxOf("end:fastC"));
    expect(idxOf("end:ghost")).toBeLessThan(idxOf("end:slowA"));
    // 3. Completion order: C before A (completion order ≠ source order)
    expect(idxOf("end:fastC")).toBeLessThan(idxOf("end:slowA"));
    // 4. all tool_execution_end events precede all toolResult message events
    const endIdx = [idxOf("end:ghost"), idxOf("end:fastC"), idxOf("end:slowA")];
    const msgIdx = [idxOf("msg:slowA"), idxOf("msg:ghost"), idxOf("msg:fastC")];
    for (const m of msgIdx) {
      for (const e of endIdx) {
        expect(m).toBeGreaterThan(e);
      }
    }
    // 5. messages follow assistant source order A → B → C (message commit order ≠ completion order)
    expect(timeline.filter((e) => e.startsWith("msg:"))).toEqual(["msg:slowA", "msg:ghost", "msg:fastC"]);
  });
});
