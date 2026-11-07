/**
 * Chapter 06 tests: Context Transformation (transformContext/getApiKey/prepareNextTurn/shouldStopAfterTurn).
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

/** Streaming mock LLM: records the input of every call (messages, apiKey, model, systemPrompt). */
class ScriptedLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;
  readonly seenInputs: { messages: Message[]; apiKey?: string; model: string; systemPrompt: string }[] = [];

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(input: Parameters<LLMAdapter["complete"]>[0]): AsyncIterable<AssistantMessageEvent> {
    this.seenInputs.push({ messages: [...input.messages], apiKey: input.apiKey, model: input.model, systemPrompt: input.systemPrompt });
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

/** Final stream with stopReason = error / aborted (adapter contract: failures are encoded in the stream, not thrown). */
function failStream(stopReason: "error" | "aborted"): AssistantMessageEvent[] {
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

/** Message label: used to assert on the LLM/transform input sequence. */
function labelOf(m: Message): string {
  if (m.role === "user") return `U:${m.text}`;
  if (m.role === "toolResult") return `T:${m.toolName}`;
  return "A";
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

describe("Context Transformation (Chapter 06)", () => {
  it("transformContext: messages are transformed before the LLM call (trim/inject, Pi L289-292)", async () => {
    const config: AgentLoopConfig = {
      model: "m",
      transformContext: async (messages) => [
        ...messages,
        { role: "user", text: "[System background] Current time 12:00" },
      ],
    };
    const llm = new ScriptedLlm([textStream("Done")]);
    await runAgentLoop([{ role: "user", text: "What time is it" }], baseContext(), config, llm, () => {});

    // The messages the model receives include the injected background (but the context itself is not modified)
    const seen = llm.seenInputs[0].messages;
    expect(seen.some((m) => m.text === "[System background] Current time 12:00")).toBe(true);
  });

  it("transformContext timing: runs before every LLM call (including the next turn after a tool)", async () => {
    let transformCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      transformContext: async (messages) => {
        transformCalls++;
        return messages;
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("3")]);
    await runAgentLoop([{ role: "user", text: "Calculate" }], baseContext(), config, llm, () => {});

    expect(transformCalls).toBe(2); // Once for each of the two LLM calls
  });

  it("transformContext only affects the messages sent to the LLM, not the context history", async () => {
    const config: AgentLoopConfig = {
      model: "m",
      transformContext: async (messages) => messages.slice(0, 1), // keep only the first message
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("3")]);
    await runAgentLoop([{ role: "user", text: "Calculate" }], baseContext(), config, llm, () => {});

    // The messages sent to the LLM in the second turn are trimmed (only the first one)
    expect(llm.seenInputs[1].messages).toHaveLength(1);
  });

  it("getApiKey: resolved before every LLM call and passed to complete (Pi L304-306)", async () => {
    let apiKeyCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      getApiKey: () => {
        apiKeyCalls++;
        return "sk-dynamic-key";
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("3")]);
    await runAgentLoop([{ role: "user", text: "Calculate" }], baseContext(), config, llm, () => {});

    expect(apiKeyCalls).toBe(2);
    expect(llm.seenInputs[0].apiKey).toBe("sk-dynamic-key");
    expect(llm.seenInputs[1].apiKey).toBe("sk-dynamic-key");
  });

  it("prepareNextTurn: replaces context and model, effective from the next turn (Pi L232-245)", async () => {
    let nextTurnCalls = 0;
    const config: AgentLoopConfig = {
      model: "model-a",
      prepareNextTurn: async ({ context }) => {
        nextTurnCalls++;
        if (nextTurnCalls === 1) {
          return {
            model: "model-b",
            context: { ...context, systemPrompt: "Replaced system prompt" },
          };
        }
        return undefined;
      },
    };
    // Turn 1 has a tool → hasMoreToolCalls=true → turn 2 (model-b takes effect)
    const llm = new ScriptedLlm([
      toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]),
      textStream("Second turn"),
    ]);
    await runAgentLoop([{ role: "user", text: "Task" }], baseContext(), config, llm, () => {});

    expect(llm.callCount).toBe(2);
    expect(llm.seenInputs[1]).toMatchObject({ model: "model-b" });
    // context replacement really takes effect: the next LLM request sees the replaced systemPrompt (not just the model switch)
    expect(llm.seenInputs[1].systemPrompt).toBe("Replaced system prompt");
    // Turn 2 input history: prompt + assistant(tool_use) + toolResult
    expect(llm.seenInputs[1].messages).toHaveLength(3);
  });

  it("shouldStopAfterTurn: true → graceful stop (the current turn ends normally, tool results are persisted)", async () => {
    const config: AgentLoopConfig = {
      model: "m",
      shouldStopAfterTurn: async ({ toolResults }) => toolResults.length > 0, // stop once there are tool results
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }])]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop([{ role: "user", text: "Calculate" }], baseContext(), config, llm, recorder.sink);

    expect(llm.callCount).toBe(1); // stop right after the tool turn, no more LLM calls
    expect(recorder.types.at(-1)).toBe("agent_end");
    // Tool results are persisted (the graceful-stop guarantee)
    expect(messages.some((m) => m.role === "toolResult" && m.text === "3")).toBe(true);
  });

  it("combined: transformContext + prepareNextTurn + shouldStopAfterTurn end to end + regression", async () => {
    const config: AgentLoopConfig = {
      model: "m",
      transformContext: async (messages) => messages,
      getApiKey: () => "key",
      shouldStopAfterTurn: async ({ message }) => message.text === "Done",
    };
    const llm = new ScriptedLlm([textStream("Done")]);
    const messages = await runAgentLoop([{ role: "user", text: "Task" }], baseContext(), config, llm, () => {});

    expect(messages.at(-1)).toMatchObject({ role: "assistant", text: "Done" });
  });

  it("canonical vs LLM view: the transform input is the full canonical context, the return value only goes into this LLM request (not written back automatically)", async () => {
    // canonical preset history: U1 / A1 / U2 (unrelated to this task)
    const oldReply: AssistantMessage = { role: "assistant", text: "A1", stopReason: "end_turn" };
    const history: Message[] = [
      { role: "user", text: "U1" },
      oldReply,
      { role: "user", text: "U2" },
    ];
    const transformInputs: Message[][] = [];
    const config: AgentLoopConfig = {
      model: "m",
      transformContext: async (messages) => {
        transformInputs.push([...messages]); // record an input snapshot (the input is the original canonical reference)
        return messages.slice(-1);           // project only the last message to the LLM
      },
    };
    // Two LLM calls: tool turn + final reply, to check that the second-turn transform still starts from the full canonical context
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("3")]);
    const messages = await runAgentLoop(
      [{ role: "user", text: "U3" }],
      { systemPrompt: "SYS", messages: history, tools: [echo, calculator] },
      config,
      llm,
      () => {},
    );

    // 1. transform input = full canonical context (old history + this turn's prompt)
    expect(transformInputs[0].map(labelOf)).toEqual(["U:U1", "A", "U:U2", "U:U3"]);
    // 2. The first LLM request sees only the projection (the last message)
    expect(llm.seenInputs[0].messages.map(labelOf)).toEqual(["U:U3"]);
    // 3. The turn-2 transform input still comes from the full canonical context (6 messages: history + this turn's prompt + assistant + toolResult),
    //    not what was left by the first slice(-1): the transform return value is not written back to canonical automatically
    expect(transformInputs[1]).toHaveLength(6);
    expect(transformInputs[1].at(-1)).toMatchObject({ role: "toolResult" });
    // 4. The second LLM request likewise sees only that turn's projection (the last toolResult)
    expect(llm.seenInputs[1].messages.map(labelOf)).toEqual(["T:calculator"]);
    // 5. newMessages holds only the messages added in this run (U3/A/T/A), not the preset history U1/A1/U2
    expect(messages.map(labelOf)).toEqual(["U:U3", "A", "T:calculator", "A"]);
  });

  it("copy policy + dynamic message visibility: mutating the steering message_end payload does not pollute canonical/transform/LLM; visible to the follow-up turn transform", async () => {
    let steeringCalls = 0;
    let followUpCalls = 0;
    const transformInputs: Message[][] = [];
    const config: AgentLoopConfig = {
      model: "m",
      transformContext: async (messages) => {
        transformInputs.push([...messages]);
        return messages;
      },
      getSteeringMessages: async () => {
        steeringCalls++;
        return steeringCalls === 2 ? [{ role: "user", text: "S-between-turns" }] : [];
      },
      getFollowUpMessages: async () => {
        followUpCalls++;
        return followUpCalls === 1 ? [{ role: "user", text: "F-after-stop" }] : [];
      },
    };
    const llm = new ScriptedLlm([textStream("A"), textStream("B"), textStream("C")]);
    let mutated = false;
    const sink: AgentEventSink = (event) => {
      // The consumer mutates the event payload after receiving the steering message_end (the payload is a shallow-copy snapshot)
      if (event.type === "message_end" && event.message.role === "user" && event.message.text === "S-between-turns") {
        event.message.text = "MUTATED";
        mutated = true;
      }
    };
    const messages = await runAgentLoop([{ role: "user", text: "Task" }], baseContext(), config, llm, sink);

    // The mutation really happened on the event side
    expect(mutated).toBe(true);
    // The steering turn's transform input (original canonical reference contents) and LLM input are not polluted
    expect(transformInputs[1].some((m) => m.text === "S-between-turns")).toBe(true);
    expect(transformInputs[1].some((m) => m.text === "MUTATED")).toBe(false);
    expect(llm.seenInputs[1].messages.some((m) => m.text === "S-between-turns")).toBe(true);
    expect(llm.seenInputs[1].messages.some((m) => m.text === "MUTATED")).toBe(false);
    // newMessages is not polluted
    expect(messages.some((m) => m.text === "S-between-turns")).toBe(true);
    expect(messages.some((m) => m.text === "MUTATED")).toBe(false);
    // The follow-up turn's transform input contains both steering and follow-up (transform always happens after injection)
    const thirdUsers = transformInputs[2].filter((m) => m.role === "user").map((m) => m.text);
    expect(thirdUsers).toEqual(["Task", "S-between-turns", "F-after-stop"]);
  });

  it("turn boundary order: turn_end → prepareNextTurn → shouldStopAfterTurn → steeringPoll (with replacement semantics)", async () => {
    const order: string[] = [];
    let shouldStopContextSystemPrompt = "";
    const config: AgentLoopConfig = {
      model: "m",
      prepareNextTurn: async ({ context }) => {
        order.push("prepareNextTurn");
        return { context: { ...context, systemPrompt: "v2" } };
      },
      shouldStopAfterTurn: async ({ context }) => {
        order.push("shouldStopAfterTurn");
        shouldStopContextSystemPrompt = context.systemPrompt;
        return false;
      },
      getSteeringMessages: async () => {
        order.push("steeringPoll");
        return [];
      },
      getFollowUpMessages: async () => {
        order.push("followUpPoll");
        return [];
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("3")]);
    const sink: AgentEventSink = (event) => {
      if (event.type === "turn_start" || event.type === "turn_end") order.push(event.type);
    };
    await runAgentLoop([{ role: "user", text: "Calculate" }], baseContext(), config, llm, sink);

    // After every normal turn the order is strictly: turn_end → prepareNextTurn → shouldStopAfterTurn → steeringPoll;
    // the initial steeringPoll (existing Chapter 05 mechanism) comes after the first turn_start and before the first LLM call
    expect(order).toEqual([
      "turn_start",
      "steeringPoll",
      "turn_end",
      "prepareNextTurn",
      "shouldStopAfterTurn",
      "steeringPoll",
      "turn_start",
      "turn_end",
      "prepareNextTurn",
      "shouldStopAfterTurn",
      "steeringPoll",
      "followUpPoll",
    ]);
    // shouldStopAfterTurn receives the context after prepareNextTurn replaced it
    expect(shouldStopContextSystemPrompt).toBe("v2");
    // The next LLM request sees the replaced canonical systemPrompt
    expect(llm.seenInputs[1].systemPrompt).toBe("v2");
  });

  it("shouldStopAfterTurn=true: skips the turn-end steering poll and follow-up (agent_end is emitted directly)", async () => {
    let steeringPolls = 0;
    let followUpPolls = 0;
    let prepareCalls = 0;
    let shouldStopCalls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      prepareNextTurn: async () => {
        prepareCalls++;
        return undefined;
      },
      shouldStopAfterTurn: async () => {
        shouldStopCalls++;
        return true;
      },
      getSteeringMessages: async () => {
        steeringPolls++;
        return [{ role: "user", text: "should not enter" }];
      },
      getFollowUpMessages: async () => {
        followUpPolls++;
        return [{ role: "user", text: "should not enter" }];
      },
    };
    const llm = new ScriptedLlm([textStream("Done")]);
    const recorder = new EventRecorder();
    const messages = await runAgentLoop([{ role: "user", text: "Task" }], baseContext(), config, llm, recorder.sink);

    // The current turn is persisted normally: turn_end is emitted, the result goes into newMessages
    expect(recorder.types).toContain("turn_end");
    expect(messages.at(-1)).toMatchObject({ role: "assistant", text: "Done" });
    // Both prepareNextTurn and shouldStopAfterTurn are called
    expect(prepareCalls).toBe(1);
    expect(shouldStopCalls).toBe(1);
    // total steering polls = only the initial one (turn-end poll skipped); follow-up 0; no new turn
    expect(steeringPolls).toBe(1);
    expect(followUpPolls).toBe(0);
    expect(recorder.types.filter((t) => t === "turn_start")).toHaveLength(1);
    // agent_end closes out the run
    expect(recorder.types.at(-1)).toBe("agent_end");
  });

  it.each([
    { stopReason: "aborted" as const, label: "aborted" },
    { stopReason: "error" as const, label: "error" },
  ])("stopReason=$label: early exit skips prepareNextTurn/shouldStopAfterTurn/turn-end steering/follow-up", async ({ stopReason }) => {
    let transformCalls = 0;
    let apiKeyCalls = 0;
    let prepareCalls = 0;
    let shouldStopCalls = 0;
    let steeringPolls = 0;
    let followUpPolls = 0;
    const config: AgentLoopConfig = {
      model: "m",
      transformContext: async (messages) => {
        transformCalls++;
        return messages;
      },
      getApiKey: () => {
        apiKeyCalls++;
        return "k";
      },
      prepareNextTurn: async () => {
        prepareCalls++;
        return undefined;
      },
      shouldStopAfterTurn: async () => {
        shouldStopCalls++;
        return false;
      },
      getSteeringMessages: async () => {
        steeringPolls++;
        return [];
      },
      getFollowUpMessages: async () => {
        followUpPolls++;
        return [];
      },
    };
    const llm = new ScriptedLlm([failStream(stopReason)]);
    const recorder = new EventRecorder();
    await runAgentLoop([{ role: "user", text: "Task" }], baseContext(), config, llm, recorder.sink);

    // The pre-call hooks ran (the LLM request really was sent)
    expect(transformCalls).toBe(1);
    expect(apiKeyCalls).toBe(1);
    // Early-exit boundary: all after-turn hooks are skipped (Pi L196-200 returns before L226/L247/L259/L263)
    expect(prepareCalls).toBe(0);
    expect(shouldStopCalls).toBe(0);
    expect(steeringPolls).toBe(1); // only the initial poll
    expect(followUpPolls).toBe(0);
    // Events close out with: turn_end → agent_end
    expect(recorder.types).toContain("turn_end");
    expect(recorder.types.at(-1)).toBe("agent_end");
  });

  it("transformContext throws: not caught by runLoop, the LLM is not called (top-level fallback)", async () => {
    const config: AgentLoopConfig = {
      model: "m",
      transformContext: async () => {
        throw new Error("transform exploded");
      },
    };
    const llm = new ScriptedLlm([textStream("should not be reached")]);
    await expect(
      runAgentLoop([{ role: "user", text: "Task" }], baseContext(), config, llm, () => {}),
    ).rejects.toThrow("transform exploded");
    expect(llm.callCount).toBe(0);
  });
});
