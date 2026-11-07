/**
 * Chapter 07 tests (Phase 1): Agent wrapper (state machine/prompt/continue/subscribe) and the linear JSONL session scaffold.
 * Tests for the Entry tree session are in session-tree.test.ts (Phase 2).
 * Driven by a streaming mock LLM (offline).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { appendToSession, clearSession, loadSession } from "../src/session.ts";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentEvent, AssistantMessage, AssistantMessageEvent, Message } from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool } from "../../00-minimal-llm-call/src/index.ts";

/** Streaming mock LLM: repeats the last step once the steps run out. */
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

function makeAgent(llm: LLMAdapter, initialMessages?: Message[]): Agent {
  return new Agent({
    systemPrompt: "assistant",
    tools: [createCalculatorTool()],
    llm,
    config: { model: "m" },
    initialMessages,
  });
}

/** Temporary session file. */
function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "lpia-07-")), "session.jsonl");
}

describe("Agent wrapper (Chapter 07)", () => {
  it("state.messages fully accumulates after prompt (event-driven, Pi processEvents)", async () => {
    const agent = makeAgent(new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("3")]));
    await agent.prompt("compute 1+2");

    expect(agent.state.messages.length).toBe(4); // user + assistant(tool_use) + toolResult + assistant
    expect(agent.state.messages[3]).toMatchObject({ role: "assistant", text: "3" });
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.errorMessage).toBeUndefined();
  });

  it("isStreaming lifecycle: true during the run, false after it ends", async () => {
    const agent = makeAgent(new ScriptedLlm([textStream("done")]));
    const streamingStates: boolean[] = [];
    agent.subscribe((event) => {
      if (event.type === "message_start") streamingStates.push(agent.state.isStreaming);
    });
    await agent.prompt("hi");

    expect(streamingStates).toEqual([true, true]); // both the prompt message and the assistant message happen during the run
    expect(agent.state.isStreaming).toBe(false);
  });

  it("streamingMessage lifecycle: set at message_start, cleared at message_end", async () => {
    const agent = makeAgent(new ScriptedLlm([textStream("done")]));
    const seen: (Message | undefined)[] = [];
    agent.subscribe((event) => {
      if (event.type === "message_start" || event.type === "message_end") {
        seen.push(agent.state.streamingMessage);
      }
    });
    await agent.prompt("hi");

    expect(seen[0]).toBeDefined(); // streamingMessage is set at message_start
    expect(seen[1]).toBeUndefined(); // cleared at message_end
  });

  it("pendingToolCalls: tool_execution_start/end maintain the set", async () => {
    const agent = makeAgent(new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("3")]));
    const states: number[] = [];
    agent.subscribe((event) => {
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
        states.push(agent.state.pendingToolCalls.size);
      }
    });
    await agent.prompt("compute");

    expect(states).toEqual([1, 0]); // 1 pending at start, 0 after end
  });

  it("continue: can continue when the last message is user/toolResult; throws when it is assistant (Pi L74-76)", async () => {
    const agent = makeAgent(new ScriptedLlm([textStream("first turn"), textStream("second turn")]));
    await agent.prompt("task");
    // the last message is assistant → continue throws
    await expect(agent.continue()).rejects.toThrow("assistant");
  });

  it("continue semantics: continue from a trailing toolResult (tool retry case)", async () => {
    // Scenario: tool result terminate=true → the loop stops on a trailing toolResult → continue can proceed (Pi L361-410)
    const stopping = {
      ...createCalculatorTool(),
      async execute(args: { a: number; b: number }) {
        return { content: String(args.a + args.b), terminate: true };
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("answer after continue")]);
    const agent = new Agent({
      systemPrompt: "assistant",
      tools: [stopping],
      llm,
      config: { model: "m" },
    });
    await agent.prompt("compute");
    // the last message is toolResult (terminate stopped after the tool result)
    expect(agent.state.messages.at(-1)?.role).toBe("toolResult");
    // continue: ask the model again from the trailing toolResult
    const results = await agent.continue();
    expect(results.at(-1)).toMatchObject({ role: "assistant", text: "answer after continue" });
  });

  it("errors are observable: turn_end errorMessage → state.errorMessage", async () => {
    const errorStep: AssistantMessageEvent[] = [
      { type: "start", partial: { role: "assistant", stopReason: "error", errorMessage: "API failed" } },
      { type: "done", partial: { role: "assistant", stopReason: "error", errorMessage: "API failed" } },
    ];
    const agent = makeAgent(new ScriptedLlm([errorStep]));
    await agent.prompt("hi");

    expect(agent.state.errorMessage).toBe("API failed");
  });

  it("run failure → handleRunFailure: failure message goes into history, errorMessage is set, state is reset (Pi L512-526)", async () => {
    const crashingLlm: LLMAdapter = {
      async *complete(): AsyncIterable<AssistantMessageEvent> {
        throw new Error("LLM network interrupted");
      },
    };
    const agent = makeAgent(crashingLlm);
    const result = await agent.prompt("hi");
    expect(result).toEqual([]);
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
    expect(agent.state.errorMessage).toContain("LLM network interrupted");
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.pendingToolCalls.size).toBe(0);
    // the continue constraint applies: the failed run ends with an assistant message → throws (not silently allowed)
    await expect(agent.continue()).rejects.toThrow("assistant");
  });

  it("concurrency guard: a second prompt while one is running throws (Pi L352-356)", async () => {
    let resolveFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const llm: LLMAdapter = {
      async *complete() {
        await gate; // suspend the first run
        yield { type: "start", partial: { role: "assistant", stopReason: "end_turn" } };
        yield { type: "done", partial: { role: "assistant", stopReason: "end_turn", text: "done" } };
      },
    };
    const agent = makeAgent(llm);
    const first = agent.prompt("task one");
    await expect(agent.prompt("task two")).rejects.toThrow("already processing");
    resolveFirst();
    await first;
  });
});

describe("JSONL session persistence (Chapter 07)", () => {
  it("load after append restores everything (including tool results and assistant replies)", async () => {
    const file = tempFile();
    appendToSession(file, { version: 1, systemPrompt: "assistant", model: "m" }, [
      { role: "user", text: "compute 1+2" },
      { role: "assistant", text: "3" },
    ]);

    const loaded = loadSession(file);
    expect(loaded?.header).toMatchObject({ systemPrompt: "assistant", model: "m" });
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.messages[1]).toMatchObject({ role: "assistant", text: "3" });
  });

  it("append semantics: repeated appends don't overwrite existing content", async () => {
    const file = tempFile();
    appendToSession(file, { version: 1, systemPrompt: "assistant", model: "m" }, [{ role: "user", text: "first turn" }]);
    appendToSession(file, { version: 1, systemPrompt: "assistant", model: "m" }, [{ role: "assistant", text: "reply" }]);

    const loaded = loadSession(file);
    expect(loaded?.messages.map((m) => m.text)).toEqual(["first turn", "reply"]);
  });

  it("continue the conversation after restore: load → Agent(initialMessages) → prompt over several turns", async () => {
    const file = tempFile();
    appendToSession(file, { version: 1, systemPrompt: "assistant", model: "m" }, [
      { role: "user", text: "compute 1+2" },
      { role: "assistant", text: "3" },
    ]);

    const loaded = loadSession(file);
    expect(loaded).not.toBeNull();
    const agent = makeAgent(new ScriptedLlm([textStream("history seen")]), loaded?.messages);
    await agent.prompt("one more turn");
    expect(agent.state.messages.length).toBe(4); // 2 restored + new prompt + new reply
    expect(agent.state.messages[0]).toMatchObject({ text: "compute 1+2" });
  });

  it("JSONL fault tolerance: skip a corrupted middle line; add a missing trailing newline before append", async () => {
    const file = tempFile();
    appendToSession(file, { version: 1, systemPrompt: "assistant", model: "m" }, [
      { role: "user", text: "first" },
      { role: "assistant", text: "second" },
    ]);
    const raw = readFileSync(file, "utf8");
    // corrupt a middle line: one corrupted line doesn't kill the whole session
    const lines = raw.split("\n").filter((l) => l);
    writeFileSync(file, [lines[0], "{{{broken json", ...lines.slice(1)].join("\n") + "\n", "utf8");
    const loaded = loadSession(file);
    expect(loaded?.messages.map((m) => m.text)).toEqual(["first", "second"]);  // the corrupted line is skipped, the rest is fully restored
    // missing trailing newline: no newline after an external write → append adds one first, so lines don't merge into corruption
    writeFileSync(file, raw.trimEnd(), "utf8");
    appendToSession(file, { version: 1, systemPrompt: "assistant", model: "m" }, [{ role: "user", text: "third" }]);
    const loaded2 = loadSession(file);
    expect(loaded2?.messages.map((m) => m.text)).toEqual(["first", "second", "third"]);
  });

  it("loadSession returns null when the file doesn't exist; clearSession clears it", async () => {
    const file = tempFile();
    expect(loadSession(file)).toBeNull();
    appendToSession(file, { version: 1, systemPrompt: "assistant", model: "m" }, [{ role: "user", text: "x" }]);
    clearSession(file);
    expect(loadSession(file)).toBeNull();
  });

  afterEach(() => {
    // clean up the temp directory
    rmSync(join(tmpdir(), "lpia-07-"), { recursive: true, force: true });
  });
});
