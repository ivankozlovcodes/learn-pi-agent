/**
 * Chapter 05 abort/error semantics tests: lock in Pi's existing interaction + abort combined behavior (without redesigning cancel semantics).
 * runLoop does not check signal directly (same as Pi L155-275) — cancellation propagates indirectly through the Tool Runtime (tool results land)
 * and the LLM stream (stopReason="aborted").
 * Driven by a streaming mock LLM (offline).
 */
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import { createEchoTool } from "../../00-minimal-llm-call/src/index.ts";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AssistantMessage,
  AssistantMessageEvent,
  LLMAdapter,
  Message,
  Tool,
} from "../../00-minimal-llm-call/src/index.ts";

class ScriptedLlm implements LLMAdapter {
  private next = 0;
  readonly seenHistories: Message[][] = [];
  constructor(private steps: (AssistantMessageEvent[])[]) {}
  async *complete(input: Parameters<LLMAdapter["complete"]>[0]): AsyncIterable<AssistantMessageEvent> {
    this.seenHistories.push([...input.messages]);
    const events = this.steps[Math.min(this.next, this.steps.length - 1)];
    this.next++;
    yield* events;
  }
  get callCount(): number {
    return this.next;
  }
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

/** Final stream with stopReason = aborted / error (adapter contract: failures are encoded in the stream, not thrown). */
function failedStream(stopReason: "aborted" | "error"): AssistantMessageEvent[] {
  return [
    { type: "start", partial: { role: "assistant", stopReason } },
    {
      type: "done",
      partial: {
        role: "assistant",
        stopReason,
        errorMessage: stopReason === "error" ? "Request failed" : "Request aborted",
      },
    },
  ];
}

class EventRecorder {
  readonly events: AgentEvent[] = [];
  readonly sink = (event: AgentEvent): void => {
    this.events.push(event);
  };
  get types(): string[] {
    return this.events.map((e) => e.type);
  }
  indexOf(predicate: (e: AgentEvent) => boolean): number {
    const i = this.events.findIndex(predicate);
    expect(i).toBeGreaterThanOrEqual(0);
    return i;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function baseContext(tools: Tool[]): AgentContext {
  return { systemPrompt: "Assistant", messages: [], tools: [createEchoTool(), ...tools] };
}

function userTextsAt(llm: ScriptedLlm, callIndex: number): string[] {
  return llm.seenHistories[callIndex]?.filter((m) => m.role === "user").map((m) => m.text ?? "") ?? [];
}

describe("error / aborted stopReason early exit (Pi L196-200)", () => {
  it.each([
    { stopReason: "aborted" as const, label: "aborted" },
    { stopReason: "error" as const, label: "error" },
  ])("stopReason=$label: turn_end + agent_end, skipping turn-end steering and follow-up", async ({ stopReason }) => {
    let steeringPolls = 0;
    let followUpPolls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      getSteeringMessages: async () => {
        steeringPolls++;
        return [];
      },
      getFollowUpMessages: async () => {
        followUpPolls++;
        return [{ role: "user", text: "should not be polled" }];
      },
    };
    const llm = new ScriptedLlm([failedStream(stopReason)]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "task" }], baseContext([]), config, llm, recorder.sink);

    // The LLM is called only once; no extra turn
    expect(llm.callCount).toBe(1);
    expect(recorder.types.filter((t) => t === "turn_start")).toHaveLength(1);
    // The initial steering poll is existing behavior (kept); the turn-end poll and follow-up are skipped
    expect(steeringPolls).toBe(1);
    expect(followUpPolls).toBe(0);
    // The current turn wraps up normally: agent_end after turn_end, and agent_end exactly once
    expect(recorder.types).toContain("turn_end");
    expect(recorder.types.filter((t) => t === "agent_end")).toHaveLength(1);
    expect(recorder.types.at(-1)).toBe("agent_end");
  });
});

describe("steering semantics after abort during tool execution", () => {
  it("steering does not interrupt the current tool; the turn-end poll still happens; the next LLM call ends as aborted; follow-up is not polled", async () => {
    const controller = new AbortController();
    const abortingTool: Tool = {
      name: "slow-abort",
      description: "Slow tool",
      parameters: { type: "object", properties: {} },
      execute: async (_args, _onUpdate, signal) => {
        // Simulate an external abort arriving during tool execution (deterministic: the tool observes signal itself)
        controller.abort();
        await sleep(10);
        if (signal?.aborted) throw new Error("Operation aborted");
        return { content: "done" };
      },
    };
    let steeringPolls = 0;
    let followUpPolls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      getSteeringMessages: async () => {
        steeringPolls++;
        return steeringPolls === 2 ? [{ role: "user", text: "check D instead" }] : [];
      },
      getFollowUpMessages: async () => {
        followUpPolls++;
        return [{ role: "user", text: "should not be polled" }];
      },
    };
    const llm = new ScriptedLlm([
      toolStream([{ id: "c1", name: "slow-abort", args: {} }]),
      failedStream("aborted"), // signal is already aborted; adapter contract → stopReason="aborted"
    ]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop(
      [{ role: "user", text: "check A" }],
      baseContext([abortingTool]),
      config,
      llm,
      recorder.sink,
      controller.signal,
    );

    // 1. Tool execution is not interrupted: the error toolResult lands (end + message events both come before the steering message events)
    const toolEnd = recorder.indexOf((e) => e.type === "tool_execution_end");
    const toolResultMsg = recorder.indexOf((e) => e.type === "message_start" && e.message.role === "toolResult");
    // 2. turn_end comes before the steering message events
    const firstTurnEnd = recorder.indexOf((e) => e.type === "turn_end");
    const steeringMsg = recorder.indexOf((e) => e.type === "message_start" && e.message.text === "check D instead");
    expect(toolEnd).toBeLessThan(steeringMsg);
    expect(toolResultMsg).toBeLessThan(firstTurnEnd);
    expect(firstTurnEnd).toBeLessThan(steeringMsg);
    // 3. steering goes into the next LLM input
    expect(userTextsAt(llm, 1)).toContain("check D instead");
    // 4. The turn-end steering poll still happens (initial + end of turn 1); follow-up is not polled
    expect(steeringPolls).toBe(2);
    expect(followUpPolls).toBe(0);
    // 5. The next LLM call ends as aborted: two calls, two turns, agent_end exactly once
    expect(llm.callCount).toBe(2);
    expect(recorder.types.filter((t) => t === "turn_start")).toHaveLength(2);
    expect(recorder.types.filter((t) => t === "agent_end")).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
  });
});

describe("follow-up after abort + normal inner exit", () => {
  it("follow-up is polled and injected into a new turn, but an aborted run cannot be revived", async () => {
    const controller = new AbortController();
    const terminateTool: Tool = {
      name: "term-on-abort",
      description: "Tool",
      parameters: { type: "object", properties: {} },
      execute: async (_args, _onUpdate, signal) => {
        controller.abort();
        await sleep(10);
        // Return normally after abort and terminate the batch → the inner loop exits normally with "no more tools" and reaches the follow-up checkpoint
        if (signal?.aborted) return { content: "aborted-but-complete", terminate: true };
        return { content: "done", terminate: true };
      },
    };
    let steeringPolls = 0;
    let followUpPolls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      getSteeringMessages: async () => {
        steeringPolls++;
        return [];
      },
      getFollowUpMessages: async () => {
        followUpPolls++;
        return followUpPolls === 1 ? [{ role: "user", text: "summarize again" }] : [];
      },
    };
    const llm = new ScriptedLlm([
      toolStream([{ id: "c1", name: "term-on-abort", args: {} }]),
      failedStream("aborted"),
    ]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop(
      [{ role: "user", text: "run" }],
      baseContext([terminateTool]),
      config,
      llm,
      recorder.sink,
      controller.signal,
    );

    // 1. follow-up is actually polled (exactly once)
    expect(followUpPolls).toBe(1);
    // 2. agent_end has not been emitted yet: the follow-up message events come before agent_end
    const followUpMsg = recorder.indexOf((e) => e.type === "message_start" && e.message.text === "summarize again");
    const agentEnd = recorder.indexOf((e) => e.type === "agent_end");
    expect(followUpMsg).toBeLessThan(agentEnd);
    // 3+4. follow-up is injected into a new turn, and the next LLM input sees it
    expect(recorder.types.filter((t) => t === "turn_start")).toHaveLength(2);
    expect(userTextsAt(llm, 1)).toContain("summarize again");
    // 5. signal is already aborted → the next LLM call ends as aborted
    expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
    // 6. agent_end exactly once
    expect(recorder.types.filter((t) => t === "agent_end")).toHaveLength(1);
    // 7. Two LLM calls; the turn-end steering poll (returns empty) also still happens
    expect(llm.callCount).toBe(2);
    expect(steeringPolls).toBe(2);
  });
});
