/**
 * Chapter 05 tests: Steering & Follow-up — the two-level loop, injection timing for the two lifecycles,
 * the three steering poll points, the single follow-up poll point, the combined flow, and regressions.
 * Driven by a streaming mock LLM (offline).
 */
import { describe, expect, it } from "vitest";
import { runAgentLoop, type AgentEventSink } from "../src/agent-loop.ts";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AssistantMessage,
  AssistantMessageEvent,
  Message,
} from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool, createEchoTool } from "../../00-minimal-llm-call/src/index.ts";

/** Streaming mock LLM: records the history received on each call (to verify steering/follow-up enter history). */
class ScriptedLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;
  readonly seenHistories: Message[][] = [];

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

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
}

const echo = createEchoTool();
const calculator = createCalculatorTool();

function baseContext(): AgentContext {
  return { systemPrompt: "Assistant", messages: [], tools: [echo, calculator] };
}

/** Records when injected messages enter history (anchored on LLM calls). */
function textsAt(llm: ScriptedLlm, callIndex: number): string[] {
  return llm.seenHistories[callIndex]?.filter((m) => m.role === "user").map((m) => m.text ?? "") ?? [];
}

describe("Steering & Follow-up (Chapter 05)", () => {
  it("steering turn-end poll: enters the next turn after a complete turn, and the model sees it next turn (L259)", async () => {
    let steeringCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      // The initial poll (L167) returns empty; the turn-end poll (L259) returns steering — distinguishes the two poll points (see the next test)
      getSteeringMessages: async () => {
        steeringCalls++;
        return steeringCalls === 2 ? [{ role: "user", text: "mid-run message" }] : [];
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("done")]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop([{ role: "user", text: "calculate" }], baseContext(), config, llm, recorder.sink);

    // The first LLM call (turn 1) does not include steering yet
    expect(textsAt(llm, 0)).toEqual(["calculate"]);
    // By the second LLM call, history already has steering (injected between turns, L182-190)
    expect(textsAt(llm, 1)).toContain("mid-run message");
    // The steering message goes into newMessages
    expect(messages.some((m) => m.text === "mid-run message")).toBe(true);
    // The steering message has message events
    const startEvents = recorder.events.filter((e) => e.type === "message_start");
    expect(startEvents.some((e) => e.type === "message_start" && e.message.text === "mid-run message")).toBe(true);

    // Relative event order (a key fact in the README):
    // toolResult message events → turn_end → next turn_start → steering message events → next assistant message events
    const toolResultMsg = recorder.events.findIndex(
      (e) => e.type === "message_start" && e.message.role === "toolResult",
    );
    const firstTurnEnd = recorder.events.findIndex((e) => e.type === "turn_end");
    const secondTurnStart = recorder.events.findIndex((e, i) => e.type === "turn_start" && i > toolResultMsg);
    const steeringMsg = recorder.events.findIndex(
      (e) => e.type === "message_start" && e.message.text === "mid-run message",
    );
    const assistantStarts = recorder.events
      .map((e, i) => (e.type === "message_start" && e.message.role === "assistant" ? i : -1))
      .filter((i) => i >= 0);
    const secondAssistantMsg = assistantStarts[1];
    expect(toolResultMsg).toBeLessThan(firstTurnEnd);
    expect(firstTurnEnd).toBeLessThan(secondTurnStart);
    expect(secondTurnStart).toBeLessThan(steeringMsg);
    expect(steeringMsg).toBeLessThan(secondAssistantMsg);
    // steering is polled three times: initial (empty) + end of turn 1 (returns a message) + end of turn 2 (empty, inner loop exits)
    expect(steeringCalls).toBe(3);
  });

  it("steering timing: messages returned by the initial poll enter history before the first LLM call (L167)", async () => {
    let steeringCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      // Bounded: returns only once. Contract: must return [] when there are no messages (Pi types.ts L242-243), or the inner loop never stops
      getSteeringMessages: async () => {
        steeringCalls++;
        return steeringCalls === 1 ? [{ role: "user", text: "warm-up message" }] : [];
      },
    };
    const llm = new ScriptedLlm([textStream("done")]);
    await runAgentLoop([{ role: "user", text: "calculate" }], baseContext(), config, llm, () => {});

    // The first LLM call already includes the initial steering
    expect(textsAt(llm, 0)).toEqual(["calculate", "warm-up message"]);
  });

  it("follow-up: injected after the inner loop exits → outer loop continues → new turn (L263-268)", async () => {
    let followUpCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      getFollowUpMessages: async () => {
        followUpCalls++;
        return followUpCalls === 1 ? [{ role: "user", text: "new task after exit" }] : [];
      },
    };
    const llm = new ScriptedLlm([textStream("first turn done"), textStream("second turn done")]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop([{ role: "user", text: "task one" }], baseContext(), config, llm, recorder.sink);

    expect(llm.callCount).toBe(2);
    expect(textsAt(llm, 1)).toContain("new task after exit");
    expect(messages.at(-1)).toMatchObject({ role: "assistant", text: "second turn done" });
    // agent_end only at the very end
    expect(recorder.types.filter((t) => t === "agent_end")).toHaveLength(1);
  });

  it("empty follow-up: the run ends when the inner loop exits (regression, same behavior as Chapter 04)", async () => {
    const llm = new ScriptedLlm([textStream("done")]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "calculate" }], baseContext(), { model: "m" }, llm, recorder.sink);

    expect(llm.callCount).toBe(1);
    expect(recorder.types.at(-1)).toBe("agent_end");
  });

  it("combined flow: steering (between turns) + tool execution + follow-up (after exit), end to end", async () => {
    let steeringCalls = 0;
    let followUpCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      getSteeringMessages: async () => {
        steeringCalls++;
        return steeringCalls === 1 ? [{ role: "user", text: "changed my mind, calculate 10*10" }] : [];
      },
      getFollowUpMessages: async () => {
        followUpCalls++;
        return followUpCalls === 1 ? [{ role: "user", text: "also echo hello" }] : [];
      },
    };
    const llm = new ScriptedLlm([
      toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), // turn 1: original task
      textStream("100"),                                                    // turn 2: after seeing steering
      textStream("echoed hello"),                                           // turn 3: follow-up
    ]);
    const messages = await runAgentLoop([{ role: "user", text: "calculate 1+2" }], baseContext(), config, llm, () => {});

    expect(llm.callCount).toBe(3);
    // History order: original task → tool result → steering → second reply → follow-up → third reply
    const userTexts = messages.filter((m) => m.role === "user").map((m) => m.text);
    expect(userTexts).toEqual(["calculate 1+2", "changed my mind, calculate 10*10", "also echo hello"]);
    // The second LLM call's history includes the tool result and steering (history accumulates correctly)
    const secondHistory = llm.seenHistories[1];
    expect(secondHistory.some((m) => m.role === "toolResult" && m.text === "3")).toBe(true);
    expect(secondHistory.some((m) => m.role === "user" && m.text === "changed my mind, calculate 10*10")).toBe(true);
  });

  it("injection position: steering message events are between turns, follow-up comes before agent_end", async () => {
    let steeringCalls = 0;
    let followUpCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      // steering: poll 1 (initial poll L167) returns empty, poll 2 (turn-end re-poll L259) returns S
      // → S appears after the first turn ends, at the start of the second turn (between turns)
      getSteeringMessages: async () => {
        steeringCalls++;
        return steeringCalls === 2 ? [{ role: "user", text: "S" }] : [];
      },
      getFollowUpMessages: async () => {
        followUpCalls++;
        return followUpCalls === 1 ? [{ role: "user", text: "F" }] : [];
      },
    };
    const llm = new ScriptedLlm([textStream("A"), textStream("B")]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "task" }], baseContext(), config, llm, recorder.sink);

    // Message events for steering S: after the first turn_end (between turns)
    const sIdx = recorder.types.findIndex((t, i) => t === "message_start" && recorder.events[i].type === "message_start" && recorder.events[i].message.text === "S");
    const firstTurnEnd = recorder.types.indexOf("turn_end");
    expect(sIdx).toBeGreaterThan(firstTurnEnd);
    // Message events for follow-up F: after S and before agent_end;
    // it enters at the start of the turn it is injected into (L182-190), not on its own just before agent_end
    const fIdx = recorder.types.findIndex((t, i) => t === "message_start" && recorder.events[i].type === "message_start" && recorder.events[i].message.text === "F");
    const agentEnd = recorder.types.lastIndexOf("agent_end");
    expect(fIdx).toBeGreaterThan(sIdx);
    expect(fIdx).toBeLessThan(agentEnd);
    expect(llm.callCount).toBe(3); // original task → after steering → after follow-up
  });

  it("copy policy: a consumer mutating the steering message_end payload does not pollute the internal history", async () => {
    let steeringCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      getSteeringMessages: async () => {
        steeringCalls++;
        return steeringCalls === 2 ? [{ role: "user", text: "mid-run message" }] : [];
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("done")]);
    let mutated = false;
    // The consumer tampers with the event payload after receiving message_end (the payload is a shallow-copy snapshot)
    const sink: AgentEventSink = (event) => {
      if (event.type === "message_end" && event.message.role === "user" && event.message.text === "mid-run message") {
        event.message.text = "MUTATED";
        mutated = true;
      }
    };
    const messages = await runAgentLoop([{ role: "user", text: "calculate" }], baseContext(), config, llm, sink);

    // The tampering really happened on the event side
    expect(mutated).toBe(true);
    // The internal history (next LLM input) is not polluted
    expect(textsAt(llm, 1)).toContain("mid-run message");
    expect(textsAt(llm, 1)).not.toContain("MUTATED");
    // The returned newMessages is not polluted
    expect(messages.some((m) => m.text === "mid-run message")).toBe(true);
    expect(messages.some((m) => m.text === "MUTATED")).toBe(false);
  });

  it("one poll returning several messages: array order is kept, one set of message events per message (steering + follow-up)", async () => {
    let steeringCalls = 0;
    let followUpCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      getSteeringMessages: async () => {
        steeringCalls++;
        return steeringCalls === 2
          ? [{ role: "user", text: "S1" }, { role: "user", text: "S2" }]
          : [];
      },
      getFollowUpMessages: async () => {
        followUpCalls++;
        return followUpCalls === 1
          ? [{ role: "user", text: "F1" }, { role: "user", text: "F2" }]
          : [];
      },
    };
    const llm = new ScriptedLlm([textStream("A"), textStream("B"), textStream("C")]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop([{ role: "user", text: "task" }], baseContext(), config, llm, recorder.sink);

    // Order within one array is kept: the next LLM input sees them in the same order (S1→S2, F1→F2)
    expect(textsAt(llm, 1)).toEqual(["task", "S1", "S2"]);
    expect(textsAt(llm, 2)).toEqual(["task", "S1", "S2", "F1", "F2"]);
    // Each message produces its own message_start / message_end; they are not merged into one
    const dynTexts = ["S1", "S2", "F1", "F2"];
    const startTexts = recorder.events.flatMap((e) =>
      e.type === "message_start" && e.message.role === "user" && dynTexts.includes(e.message.text ?? "")
        ? [e.message.text]
        : [],
    );
    const endTexts = recorder.events.flatMap((e) =>
      e.type === "message_end" && e.message.role === "user" && dynTexts.includes(e.message.text ?? "")
        ? [e.message.text]
        : [],
    );
    expect(startTexts).toEqual(["S1", "S2", "F1", "F2"]);
    expect(endTexts).toEqual(["S1", "S2", "F1", "F2"]);
    // Final newMessages order: initial → S1 → S2 → F1 → F2
    expect(messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual(["task", "S1", "S2", "F1", "F2"]);
  });
});
