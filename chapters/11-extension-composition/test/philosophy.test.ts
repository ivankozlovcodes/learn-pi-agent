/**
 * Chapter 11 tests: pure functions and integration for the three cases (permission-gate / plan-mode / subagent).
 * Core assertion: all three workflows go through the Chapter 10 Extension Runtime, with zero changes to the loop and the Agent;
 * plan-mode's /plan takes effect immediately on the running Agent through the Chapter 10 ctx.setActiveTools action
 * (the tool list visible to the provider changes, without rebuilding the Agent); a subagent child failure goes through isError.
 * Driven by a streaming mock LLM (offline).
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { ExtensionRunner } from "../../10-extension-runtime/src/runner.ts";
import { createExtensionAwareConfig } from "../../10-extension-runtime/src/index.ts";
import type { ExtensionFactory, RuntimeConfig } from "../../10-extension-runtime/src/extension-api.ts";
import type { LLMAdapter, Tool } from "../../00-minimal-llm-call/src/index.ts";
import type { AssistantMessageEvent, Message } from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool } from "../../00-minimal-llm-call/src/index.ts";
import { Agent } from "../../07-session-tree/src/agent.ts";
import { TreeSession } from "../../07-session-tree/src/session-tree.ts";
import permissionGate, { decidePermission, isDangerousCommand } from "../src/permission-gate.ts";
import planMode, { isSafeCommand } from "../src/plan-mode.ts";
import subagent from "../src/subagent.ts";
import { createBashTool } from "../src/bash-tool.ts";

/** Demo tool set (tool names that really exist: built-in bash/calculator + registered subagent). */
const DEMO_ACTIVE_TOOLS = ["bash", "calculator", "subagent"];

/** Streaming mock LLM: repeats the last step once the steps run out; records, per turn, the tool names visible to the provider and the last message text. */
class ScriptedLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;
  /** A snapshot of each turn's complete request (the evidence for validating the full setActiveTools chain and context injection). */
  calls: { tools: string[]; lastMessage?: string }[] = [];

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(request: { tools?: { name: string }[]; messages?: { text?: string }[] }): AsyncIterable<AssistantMessageEvent> {
    this.calls.push({
      tools: (request.tools ?? []).map((t) => t.name),
      lastMessage: request.messages?.at(-1)?.text,
    });
    const events = this.steps[Math.min(this.next, this.steps.length - 1)];
    this.next++;
    yield* events;
  }
}

/** Streaming mock LLM: complete throws directly (for child provider failure). */
class ThrowingLlm implements LLMAdapter {
  async *complete(): AsyncIterable<AssistantMessageEvent> {
    throw new Error("child failed");
  }
}

function textStream(text: string): AssistantMessageEvent[] {
  return [
    { type: "start", partial: { role: "assistant", stopReason: "end_turn" } },
    { type: "done", partial: { role: "assistant", stopReason: "end_turn", text } },
  ];
}

function toolStream(calls: { id: string; name: string; args: Record<string, unknown> }[]): AssistantMessageEvent[] {
  const partial = {
    role: "assistant",
    stopReason: "tool_use",
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args })),
  } as const;
  return [
    { type: "start", partial },
    ...calls.map((c) => ({ type: "toolcall_start" as const, partial })),
    { type: "done", partial },
  ];
}

/** Teaching fixture tool factory: read/write placeholders (only in tests; Chapter 11 builds no real coding tools, Chapter 12 does). */
function fixturesFactory(): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "read_fixture",
      description: "Read-only placeholder",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "r" };
      },
    });
    pi.registerTool({
      name: "write_fixture",
      description: "Write placeholder",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "w" };
      },
    });
  };
}

/** plan-mode test wrapper: disables write_fixture (the fixture-injected form of Pi's hardcoded PLAN_MODE_DISABLED_TOOLS). */
function planModeWithFixtures(): ExtensionFactory {
  return (pi) => planMode(pi, { disabledToolNames: ["write_fixture"] });
}

/** Build a runner and load the factories (activeTools defaults to the demo tool set). */
async function makeRunner(factories: ExtensionFactory[]): Promise<ExtensionRunner> {
  const config: RuntimeConfig = { model: "m", activeTools: [...DEMO_ACTIVE_TOOLS] };
  const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
  await runner.load(factories);
  return runner;
}

/** Assemble: 07 Agent + full tool universe + bindToolRuntime binding + extension hooks (the shared assembly layer for all three cases). */
function makeBoundAgent(runner: ExtensionRunner, builtins: Tool[], llm: LLMAdapter): Agent {
  const allTools = [...builtins, ...runner.getRegisteredTools()];
  const agent = new Agent({
    systemPrompt: "assistant",
    tools: allTools,
    llm,
    config: { model: "m", ...createExtensionAwareConfig(runner) },
  });
  runner.bindToolRuntime({
    resolve: (names) => allTools.filter((t) => names.includes(t.name)),
    apply: (tools) => {
      agent.state.tools = tools;
    },
  });
  return agent;
}

describe("permission-gate (Chapter 11 Case 1, No permission popups → extension)", () => {
  it("pure function: dangerous-pattern matching (the three regexes in Pi permission-gate.ts L11)", () => {
    expect(isDangerousCommand("rm -rf /tmp/x")).toBe(true);
    expect(isDangerousCommand("sudo apt install x")).toBe(true);
    expect(isDangerousCommand("chmod 777 /tmp/x")).toBe(true);
    expect(isDangerousCommand("echo hello")).toBe(false);
    expect(isDangerousCommand("ls -la")).toBe(false);
  });

  it("pure function: decision (deny by default without a UI; allow simulates user confirmation; safe commands pass)", () => {
    expect(decidePermission("rm -rf /tmp/x", false)).toMatchObject({ block: true });
    expect(decidePermission("rm -rf /tmp/x", false).reason).toContain("Dangerous command");
    expect(decidePermission("rm -rf /tmp/x", true)).toEqual({ block: false }); // user allows
    expect(decidePermission("echo hello", false)).toEqual({ block: false }); // safe command
  });

  it("integration: a dangerous bash command is blocked into an error result (full Intercept chain), a safe command really executes", async () => {
    const runner = await makeRunner([permissionGate]);
    const agent = new Agent({
      systemPrompt: "assistant",
      tools: [createBashTool(), ...runner.getVisibleTools()],
      llm: new ScriptedLlm([
        toolStream([{ id: "c1", name: "bash", args: { command: "rm -rf /tmp/lpia-11-nonexistent" } }]),
        toolStream([{ id: "c2", name: "bash", args: { command: "echo hello" } }]),
        textStream("done"),
      ]),
      config: { model: "m", ...createExtensionAwareConfig(runner) },
    });
    await agent.prompt("execute");
    // Proof of blocking = the reason text: if execute had really happened, the result would be rm's stderr, not the block reason
    const rmResult = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "bash" && m.text?.includes("Dangerous command"));
    expect(rmResult?.isError).toBe(true);
    const echoResult = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "bash" && m.text === "hello");
    expect(echoResult?.isError).toBe(false);
  });
});

describe("plan-mode (Chapter 11 Case 2, No plan mode → extension)", () => {
  it("pure function: bash allowlist check (Pi plan-mode/utils.ts isSafeCommand L97-101)", () => {
    expect(isSafeCommand("cat file.txt")).toBe(true);
    expect(isSafeCommand("ls -la")).toBe(true);
    expect(isSafeCommand("echo hello")).toBe(true);
    expect(isSafeCommand("rm file.txt")).toBe(false);
    expect(isSafeCommand("mv a b")).toBe(false);
    expect(isSafeCommand("ls > out.txt")).toBe(false); // redirection
    expect(isSafeCommand("git add .")).toBe(false);
  });

  it("integration: /plan takes effect immediately on the running Agent: provider-visible tools change, context is injected, exit restores (validates the Chapter 10 Reconfigure seam)", async () => {
    const config: RuntimeConfig = { model: "m", activeTools: [...DEMO_ACTIVE_TOOLS, "read_fixture", "write_fixture"] };
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
    await runner.load([subagent, fixturesFactory(), planModeWithFixtures()]);

    // 1-2. Build the running Agent (tool snapshot = all 5); initially the provider sees read + write
    const llm = new ScriptedLlm([textStream("initial turn"), textStream("read-only turn"), textStream("restored turn")]);
    const agent = makeBoundAgent(runner, [createBashTool(), createCalculatorTool()], llm);
    await agent.prompt("initial");
    expect(llm.calls[0].tools).toEqual(["bash", "calculator", "subagent", "read_fixture", "write_fixture"]);

    // 3-4. /plan: the Agent is not rebuilt; the action writes the running agent.state.tools through ctx.setActiveTools
    await runner.runCommand("plan");
    expect(agent.state.tools.map((t) => (t as Tool).name)).toEqual(["bash", "calculator", "subagent", "read_fixture"]);
    expect(config.activeTools).toEqual(["bash", "calculator", "subagent", "read_fixture"]); // config in sync

    // 5-7. Next provider call: write_fixture is gone and the PLAN MODE context injection is present
    await agent.prompt("read-only exploration");
    expect(llm.calls[1].tools).toEqual(["bash", "calculator", "subagent", "read_fixture"]);
    expect(llm.calls[1].lastMessage).toContain("[PLAN MODE ACTIVE]");

    // 8-10. /plan exit: the tool set from before entry is fully restored; the next provider call sees write_fixture come back
    await runner.runCommand("plan");
    expect(agent.state.tools.map((t) => (t as Tool).name)).toEqual(["bash", "calculator", "subagent", "read_fixture", "write_fixture"]);
    await agent.prompt("restore");
    expect(llm.calls[2].tools).toEqual(["bash", "calculator", "subagent", "read_fixture", "write_fixture"]);
  });

  it("integration: plan mode bash allowlist block (non-allowlisted blocked, allowlisted passes), the same Agent with zero rebuilds throughout", async () => {
    const runner = await makeRunner([planMode, subagent]);
    const agent = makeBoundAgent(
      runner,
      [createBashTool(), createCalculatorTool()],
      new ScriptedLlm([
        toolStream([{ id: "c1", name: "bash", args: { command: "rm file.txt" } }]), // not on allowlist → blocked
        toolStream([{ id: "c2", name: "bash", args: { command: "echo ok" } }]), // on allowlist → passes
        textStream("done"),
      ]),
    );
    await runner.runCommand("plan"); // build the Agent first, then /plan (same order as the demo)
    await agent.prompt("explore");
    const blocked = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "bash" && m.text?.includes("allowlist"));
    expect(blocked?.isError).toBe(true);
    expect(agent.state.messages.some((m) => m.role === "toolResult" && m.toolName === "bash" && m.text === "ok")).toBe(true);

    // /plan off: the same Agent's tool set is restored (no rebuild)
    await runner.runCommand("plan");
    expect(agent.state.tools.map((t) => (t as Tool).name)).toEqual(DEMO_ACTIVE_TOOLS);
  });

  it("Inject: after /plan is on, context injects the read-only notice ([PLAN MODE ACTIVE])", async () => {
    const runner = await makeRunner([planMode]);
    const ctx = runner.createContext();
    expect(await runner.emitContext([{ role: "user", text: "task" }])).toHaveLength(1); // not on, so no injection
    await runner.runCommand("plan", ctx);
    const out = await runner.emitContext([{ role: "user", text: "task" }]);
    expect(out.at(-1)?.text).toContain("[PLAN MODE ACTIVE]");
  });
});

describe("subagent (Chapter 11 Case 3, No sub-agents → extension)", () => {
  it("delegate: the subagent runs independently (independent context), the result is sent back to the main history; the child's internal messages stay out of the parent history", async () => {
    const config = { model: "m", activeTools: ["subagent", "calculator"], llm: new ScriptedLlm([textStream("subtask done")]) } as RuntimeConfig;
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
    await runner.load([subagent]);

    const agent = new Agent({
      systemPrompt: "assistant",
      tools: [createCalculatorTool(), ...runner.getVisibleTools()],
      llm: new ScriptedLlm([
        toolStream([{ id: "c1", name: "subagent", args: { task: "research the project structure" } }]),
        textStream("main done"),
      ]),
      config: { model: "m" },
    });
    await agent.prompt("delegate");

    // Parent history = user → assistant(tool call) → toolResult → assistant (not a single child internal message enters the parent history)
    expect(agent.state.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    const result = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "subagent");
    expect(result?.isError).toBe(false);
    expect(result?.text).toContain("Subagent reply: subtask done");
    // Isolation evidence: the parent sees the subagent's final answer only through the ToolResult; the child history shows up only as a count
    expect(agent.state.messages.filter((m) => m.text?.includes("subtask done"))).toHaveLength(1);
    expect(result?.details).toMatchObject({ subMessages: 2 }); // child side: task + assistant reply
  });

  it("child failure: the child LLM throws → the parent receives an isError ToolResult (Pi exitCode/stopReason → isError; teaching via 07 errorMessage + throw), the parent continues", async () => {
    const config = { model: "m", activeTools: ["subagent"], llm: new ThrowingLlm() } as RuntimeConfig;
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
    await runner.load([subagent]);

    const agent = new Agent({
      systemPrompt: "assistant",
      tools: [...runner.getVisibleTools()],
      llm: new ScriptedLlm([
        toolStream([{ id: "c1", name: "subagent", args: { task: "task" } }]),
        textStream("main continues"),
      ]),
      config: { model: "m", ...createExtensionAwareConfig(runner) },
    });
    await agent.prompt("delegate");
    const result = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "subagent");
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("Subagent execution failed");
    expect(result?.text).toContain("child failed");
    // The parent loop still continues to the next turn after receiving the error result
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", text: "main continues" });
  });

  it("abort boundary: parent signal aborted → the check after child execution throws (07 Agent has no public abort seam; Pi uses child-process SIGTERM/SIGKILL)", async () => {
    const config = { model: "m", activeTools: ["subagent"], llm: new ScriptedLlm([textStream("child done")]) } as RuntimeConfig;
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
    await runner.load([subagent]);
    const tool = runner.getRegisteredTools().find((t) => t.name === "subagent");
    if (!tool) throw new Error("subagent not registered");
    const aborted = new AbortController();
    aborted.abort();
    await expect(tool.execute({ task: "task" }, undefined, aborted.signal)).rejects.toThrow("aborted");
  });

  it("parallel: two subagent calls in the same batch each build an independent child Agent, results do not contaminate each other (teaching equivalent of Pi parallel mode: per-execute isolation)", async () => {
    const config = {
      model: "m",
      activeTools: ["subagent"],
      llm: new ScriptedLlm([textStream("A result"), textStream("B result")]),
    } as RuntimeConfig;
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
    await runner.load([subagent]);

    const agent = new Agent({
      systemPrompt: "assistant",
      tools: [...runner.getVisibleTools()],
      llm: new ScriptedLlm([
        toolStream([
          { id: "c1", name: "subagent", args: { task: "task A" } },
          { id: "c2", name: "subagent", args: { task: "task B" } },
        ]),
        textStream("all done"),
      ]),
      config: { model: "m", ...createExtensionAwareConfig(runner) },
    });
    await agent.prompt("parallel delegate");
    const results = agent.state.messages.filter((m) => m.role === "toolResult" && m.toolName === "subagent");
    expect(results).toHaveLength(2);
    const texts = results.map((r) => r.text);
    expect(texts.some((t) => t?.includes("A result"))).toBe(true);
    expect(texts.some((t) => t?.includes("B result"))).toBe(true);
    // No contamination: each result contains only its own subagent's reply
    expect(texts.filter((t) => t?.includes("A result"))[0]).not.toContain("B result");
    expect(texts.filter((t) => t?.includes("B result"))[0]).not.toContain("A result");
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", text: "all done" });
  });
});

describe("extension composition (validating the three cases together)", () => {
  it("three workflows coexist in one run: permission-gate blocks rm + plan-mode blocks + subagent delegates, zero loop changes", async () => {
    const config = {
      model: "m",
      activeTools: [...DEMO_ACTIVE_TOOLS],
      llm: new ScriptedLlm([textStream("child done")]),
    } as RuntimeConfig;
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
    await runner.load([permissionGate, planMode, subagent]);
    // Build + bind first, then /plan: same order as the demo, locking in the "switch while running" semantics
    const agent = makeBoundAgent(
      runner,
      [createBashTool(), createCalculatorTool()],
      new ScriptedLlm([
        toolStream([{ id: "c1", name: "bash", args: { command: "rm -rf /tmp/lpia-11-x" } }]), // permission-gate blocks (plan would block too; first one wins)
        toolStream([{ id: "c2", name: "bash", args: { command: "echo safe" } }]), // plan allowlist passes
        toolStream([{ id: "c3", name: "subagent", args: { task: "subtask" } }]), // subagent delegates
        textStream("all done"),
      ]),
    );
    await runner.runCommand("plan");
    await agent.prompt("execute");
    const msgs = agent.state.messages;
    // The permission-gate block hits first (first-block short-circuit)
    expect(msgs.some((m) => m.role === "toolResult" && m.toolName === "bash" && m.isError && m.text?.includes("Dangerous command"))).toBe(true);
    // plan allowlist passes
    expect(msgs.some((m) => m.role === "toolResult" && m.toolName === "bash" && m.text === "safe")).toBe(true);
    // subagent delegation succeeds
    expect(msgs.some((m) => m.role === "toolResult" && m.toolName === "subagent" && m.text?.includes("child done"))).toBe(true);
    // Final assertion: the last assistant message is normal (no extension broke the loop)
    expect(msgs.at(-1)).toMatchObject({ role: "assistant", text: "all done" });
  });
});
