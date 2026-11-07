/**
 * Chapter 10 tests: the six Extension Runtime capabilities (Observe / Intercept / Extend / Reconfigure /
 * Inject / Persist) + loader + wrapper linkage + the combined end-to-end chain. Driven by a streaming mock LLM (offline).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionRunner } from "../src/runner.ts";
import { loadExtensionsFromDir } from "../src/loader.ts";
import { createExtensionAwareConfig, forwardAgentEvents } from "../src/index.ts";
import type { ExtensionFactory, ExtensionTool, RuntimeConfig } from "../src/extension-api.ts";
import type { LLMAdapter, Tool } from "../../00-minimal-llm-call/src/index.ts";
import type { AssistantMessage, AssistantMessageEvent, Message } from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool } from "../../00-minimal-llm-call/src/index.ts";
import { Agent } from "../../07-session-tree/src/agent.ts";
import { TreeSession } from "../../07-session-tree/src/session-tree.ts";

/** The Chapter 10 teaching extensions directory (what the loader loads). */
const EXTENSIONS_DIR = fileURLToPath(new URL("../extensions", import.meta.url));

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

/** Records the provider-visible tool names of every complete request (for end-to-end setActiveTools validation). */
class RecordingScriptedLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;
  /** Provider-visible tool names carried by each turn's request. */
  calls: string[][] = [];

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(request: { tools?: Tool[] }): AsyncIterable<AssistantMessageEvent> {
    this.calls.push((request.tools ?? []).map((t) => t.name));
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

function assistantMessage(): AssistantMessage {
  return { role: "assistant", stopReason: "tool_use", toolCalls: [] };
}

/** Build a runner and load factories. */
async function makeRunner(
  factories: ExtensionFactory[],
  config: RuntimeConfig = { model: "m", activeTools: [] },
): Promise<ExtensionRunner> {
  const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
  await runner.load(factories);
  return runner;
}

/** A minimal hello tool factory. */
function helloFactory(): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "hello",
      description: "greet",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async execute(args) {
        return { content: `Hello, ${String(args.name)}!` };
      },
    });
  };
}

/** Temp directories (cleaned up in afterEach). */
let tempRoot: string | undefined;
function tempDir(): string {
  tempRoot ??= mkdtempSync(join(tmpdir(), "lpia-10-"));
  return tempRoot;
}

describe("extensions runtime (Chapter 10)", () => {
  it("Extend: registerTool goes into the registry and can be wrapped into context.tools (Pi registerTool: ToolDefinition type L449, method signature L1286)", async () => {
    const runner = await makeRunner([helloFactory()]);
    expect(runner.getRegisteredTools().map((t) => t.name)).toEqual(["hello"]);
    // After wrapping it has the 00 shared base Tool shape (can go into AgentLoopConfig's context.tools)
    const wrapped: Tool = runner.getRegisteredTools()[0];
    expect(wrapped.name).toBe("hello");
    const result = await wrapped.execute({ name: "Alice" });
    expect(result.content).toBe("Hello, Alice!");
  });

  it("Intercept: on(tool_call) blocks a dangerous tool and sends back block + reason (Pi emitToolCall L932)", async () => {
    const runner = await makeRunner([
      (pi) => {
        pi.on("tool_call", async (event) => {
          if (event.toolCall.name === "delete_file") return { block: true, reason: "deletion not allowed" };
          return undefined;
        });
        pi.registerTool({
          name: "delete_file",
          description: "delete",
          parameters: { type: "object", properties: {} },
          async execute() {
            return { content: "deleted" };
          },
        });
      },
    ]);
    const event = { assistantMessage: assistantMessage(), toolCall: { id: "c1", name: "delete_file", arguments: {} }, args: {} };
    expect(await runner.emitToolCall(event)).toMatchObject({ block: true, reason: "deletion not allowed" });
    // Non-dangerous tools are not blocked
    expect(
      await runner.emitToolCall({ assistantMessage: assistantMessage(), toolCall: { id: "c2", name: "hello", arguments: {} }, args: {} }),
    ).toBeUndefined();
  });

  it("Intercept end to end: a blocked tool becomes an error toolResult and the model sees the block reason", async () => {
    const runner = await makeRunner(
      [
        (pi) => pi.on("tool_call", async (e) => (e.toolCall.name === "delete_file" ? { block: true, reason: "guard: deletion not allowed" } : undefined)),
        (pi) =>
          pi.registerTool({
            name: "delete_file",
            description: "delete",
            parameters: { type: "object", properties: {} },
            async execute() {
              return { content: "deleted" };
            },
          }),
      ],
      { model: "m", activeTools: ["delete_file"] },
    );
    const deleteTool = runner.getRegisteredTools().find((t) => t.name === "delete_file");
    if (!deleteTool) throw new Error("delete_file not registered");
    const agent = new Agent({
      systemPrompt: "assistant",
      tools: [deleteTool],
      llm: new ScriptedLlm([toolStream([{ id: "c1", name: "delete_file", args: { path: "/tmp/x" } }]), textStream("done")]),
      config: { model: "m", ...createExtensionAwareConfig(runner) },
    });
    await agent.prompt("delete");
    const blocked = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "delete_file");
    expect(blocked?.isError).toBe(true);
    expect(blocked?.text).toContain("guard: deletion not allowed");
  });

  it("Extend: registerCommand command table + dispatch (args and ctx injection, Pi registerCommand L1295)", async () => {
    const calls: { args: string; cwd: string }[] = [];
    const runner = await makeRunner([
      (pi) => {
        pi.registerCommand("greet", {
          description: "greet",
          handler: (args, ctx) => {
            calls.push({ args, cwd: ctx.cwd });
          },
        });
      },
    ]);
    expect(runner.getCommands().map((c) => c.name)).toEqual(["greet"]);
    await runner.runCommand("greet Alice");
    expect(calls).toEqual([{ args: "Alice", cwd: tmpdir() }]);
    await expect(runner.runCommand("nope")).rejects.toThrow("not found");
  });

  it("loader: loads all teaching extensions from the directory (default export factory, Pi loadExtensions L648)", async () => {
    const factories = await loadExtensionsFromDir(EXTENSIONS_DIR);
    const runner = await makeRunner(factories);
    const names = runner.getRegisteredTools().map((t) => t.name).sort();
    expect(names).toEqual(["delete_file", "hello", "todo"]);
    expect(runner.getCommands().map((c) => c.name)).toEqual(["todos"]);
    expect(runner.hasHandlers("tool_call")).toBe(true);
  });

  it("Inject: on(context) injects a message → the transformContext output changes (Pi sdk.ts L362-367)", async () => {
    const runner = await makeRunner([
      (pi) => {
        pi.on("context", async ({ messages }) => [
          ...messages,
          { role: "user" as const, text: "Injected: extension context" },
        ]);
      },
    ]);
    const out = await runner.emitContext([{ role: "user", text: "task" }]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ text: "Injected: extension context" });
  });

  it("wrapper addedToolNames linkage: activating a new tool during execute → declared in the result (Pi wrapper.ts L22-35)", async () => {
    const config: RuntimeConfig = { model: "m", activeTools: ["echo"] };
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
    const echo: ExtensionTool = {
      name: "echo",
      description: "echo",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ctx.setActiveTools([...ctx.getActiveTools(), "secret"]); // Unlock a new tool (a runtime version of the Chapter 09 addedToolNames semantics)
        return { content: "hi" };
      },
    };
    const secret: ExtensionTool = {
      name: "secret",
      description: "secret",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "s" };
      },
    };
    await runner.load([(pi) => pi.registerTool(echo), (pi) => pi.registerTool(secret)]);
    // After execute the result carries addedToolNames
    const result = await runner.getRegisteredTools()[0].execute({});
    expect(result.addedToolNames).toContain("secret");
    // loadTools fetches it dynamically from the registry (closing the loop-side dynamic loading)
    const aware = createExtensionAwareConfig(runner);
    expect(aware.loadTools(["secret"]).map((t) => t.name)).toContain("secret");
  });

  it("Reconfigure end to end: ctx.setActiveTools updates the running agent.state.tools right away, visible on the next provider call (Pi setActiveToolsByName L950-972)", async () => {
    const config: RuntimeConfig = { model: "m", activeTools: ["read_fixture", "write_fixture"] };
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
    const readFixture: ExtensionTool = {
      name: "read_fixture",
      description: "read-only placeholder (test fixture, not a real coding tool)",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "r" };
      },
    };
    const writeFixture: ExtensionTool = {
      name: "write_fixture",
      description: "write placeholder (test fixture, not a real coding tool)",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "w" };
      },
    };
    await runner.load([
      (pi) => pi.registerTool(readFixture),
      (pi) => pi.registerTool(writeFixture),
      (pi) =>
        pi.registerCommand("readonly", {
          description: "switch to the read-only tool set",
          handler: async (_args, ctx) => {
            ctx.setActiveTools(["read_fixture"]);
          },
        }),
    ]);

    // Assemble: the Agent is constructed (tool snapshot = the two fixtures) + bind the tool runtime (the assembly layer holds the full universe)
    const allTools = runner.getRegisteredTools();
    const llm = new RecordingScriptedLlm([textStream("initial turn"), textStream("read-only turn"), textStream("restore turn")]);
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

    // Before switching: the provider sees all tools
    await agent.prompt("initial");
    expect(llm.calls[0]).toEqual(["read_fixture", "write_fixture"]);

    // Extension-side action: the command handler calls ctx.setActiveTools (extension → ctx → action → Agent, never holding the Agent)
    await runner.runCommand("readonly");
    expect(agent.state.tools.map((t) => (t as Tool).name)).toEqual(["read_fixture"]);
    expect(config.activeTools).toEqual(["read_fixture"]); // config synced

    // The next provider call sees the new tool set right away
    await agent.prompt("read-only");
    expect(llm.calls[1]).toEqual(["read_fixture"]);

    // Restore: all tools come back on the next provider call
    runner.createContext().setActiveTools(["read_fixture", "write_fixture"]);
    expect(agent.state.tools.map((t) => (t as Tool).name)).toEqual(["read_fixture", "write_fixture"]);
    await agent.prompt("restore");
    expect(llm.calls[2]).toEqual(["read_fixture", "write_fixture"]);
  });

  it("wrapper guard: no addedToolNames when execute adds and removes tools at the same time (Pi wrapper.ts L26)", async () => {
    const config: RuntimeConfig = { model: "m", activeTools: ["echo", "drop"] };
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session: new TreeSession() });
    const echo: ExtensionTool = {
      name: "echo",
      description: "echo",
      parameters: { type: "object", properties: {} },
      async execute(_args, ctx) {
        ctx.setActiveTools(["echo", "secret"]); // add secret and remove drop at the same time
        return { content: "hi" };
      },
    };
    const drop: ExtensionTool = {
      name: "drop",
      description: "placeholder",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "d" };
      },
    };
    await runner.load([(pi) => pi.registerTool(echo), (pi) => pi.registerTool(drop)]);
    const result = await runner.getRegisteredTools()[0].execute({});
    // Pi guard: any tool removed → return the original result as is, no addedToolNames reported
    expect(result.addedToolNames).toBeUndefined();
  });

  it("Observe: on(message_end) receives the event (Pi on() event family)", async () => {
    let seen = 0;
    const runner = await makeRunner([
      (pi) => {
        pi.on("message_end", async () => {
          seen++;
        });
      },
    ]);
    const agent = new Agent({
      systemPrompt: "assistant",
      tools: [],
      llm: new ScriptedLlm([textStream("done")]),
      config: { model: "m" },
    });
    agent.subscribe(forwardAgentEvents(runner));
    await agent.prompt("hi");
    expect(seen).toBeGreaterThanOrEqual(2); // user + assistant
  });

  it("Persist: todo state is stored in the session tree and returns to the historical value after branching back (Pi todo.ts L114-133)", async () => {
    const session = new TreeSession();
    const config: RuntimeConfig = { model: "m", activeTools: ["todo"] };
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session });
    await runner.load(await loadExtensionsFromDir(EXTENSIONS_DIR));
    const todoTool = runner.getRegisteredTools().find((t) => t.name === "todo");
    if (!todoTool) throw new Error("todo not registered");

    // Simulate two turns of tool execution + writing messages to the tree
    const asst1: AssistantMessage = { role: "assistant", stopReason: "tool_use", toolCalls: [{ id: "c1", name: "todo", arguments: { action: "add", text: "task one" } }] };
    const asst2: AssistantMessage = { role: "assistant", stopReason: "tool_use", toolCalls: [{ id: "c2", name: "todo", arguments: { action: "add", text: "task two" } }] };
    const r1 = await todoTool.execute({ action: "add", text: "task one" } as Record<string, unknown>);
    session.appendMessage(asst1);
    session.appendMessage({ role: "toolResult", toolCallId: "c1", toolName: "todo", text: r1.content, details: r1.details });
    const r2 = await todoTool.execute({ action: "add", text: "task two" } as Record<string, unknown>);
    session.appendMessage(asst2);
    session.appendMessage({ role: "toolResult", toolCallId: "c2", toolName: "todo", text: r2.content, details: r2.details });

    const list = await todoTool.execute({ action: "list" } as Record<string, unknown>);
    expect(list.content).toContain("task one");
    expect(list.content).toContain("task two");

    // Branch back to the first toolResult: state automatically returns to the historical value (the tree's second payoff)
    const firstTr = session.getBranch().find((e) => e.type === "message" && (e as { message: Message }).message.role === "toolResult");
    if (!firstTr) throw new Error("toolResult does not exist");
    session.branch(firstTr.id);
    const listAfter = await todoTool.execute({ action: "list" } as Record<string, unknown>);
    expect(listAfter.content).toContain("task one");
    expect(listAfter.content).not.toContain("task two");
  });

  it("Composition: guard + hello + todo end to end (Intercept + Extend + Observe + Persist in one run)", async () => {
    const session = new TreeSession();
    const config: RuntimeConfig = { model: "m", activeTools: ["hello", "todo", "delete_file"] };
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session });
    await runner.load(await loadExtensionsFromDir(EXTENSIONS_DIR));

    const agent = new Agent({
      systemPrompt: "assistant",
      tools: [createCalculatorTool(), ...runner.getVisibleTools()],
      llm: new ScriptedLlm([
        toolStream([{ id: "c1", name: "delete_file", args: { path: "/tmp/x" } }]),
        toolStream([{ id: "c2", name: "todo", args: { action: "add", text: "task" } }]),
        toolStream([{ id: "c3", name: "hello", args: { name: "Alice" } }]),
        textStream("done"),
      ]),
      config: { model: "m", ...createExtensionAwareConfig(runner) },
    });
    agent.subscribe(forwardAgentEvents(runner));
    agent.subscribe((event) => {
      if (event.type === "message_end") session.appendMessage(event.message);
    });
    await agent.prompt("run");

    const msgs = agent.state.messages;
    // Intercept: guard blocks delete_file into an error result
    const blocked = msgs.find((m) => m.role === "toolResult" && m.toolName === "delete_file");
    expect(blocked?.isError).toBe(true);
    expect(blocked?.text).toContain("deleting files is not allowed");
    // Extend: todo / hello execute normally
    expect(msgs.some((m) => m.role === "toolResult" && m.toolName === "todo")).toBe(true);
    expect(msgs.some((m) => m.role === "toolResult" && m.toolName === "hello")).toBe(true);
    // Persist: todo state can be derived from the session tree branch
    const todoTool = runner.getRegisteredTools().find((t) => t.name === "todo");
    if (!todoTool) throw new Error("todo not registered");
    const list = await todoTool.execute({ action: "list" } as Record<string, unknown>);
    expect(list.content).toContain("task");
  });

  it("todo parallel batch: two adds in the same batch don't lose state (module state is the authority + rebuild only on leaf change)", async () => {
    const session = new TreeSession();
    const config: RuntimeConfig = { model: "m", activeTools: ["todo"] };
    const runner = new ExtensionRunner({ cwd: tmpdir(), config, session });
    await runner.load(await loadExtensionsFromDir(EXTENSIONS_DIR));
    const todoTool = runner.getRegisteredTools().find((t) => t.name === "todo");
    if (!todoTool) throw new Error("todo not registered");

    // One assistant message with two todo adds → the Chapter 07 loop executes them in parallel by default (executeToolCallsParallel)
    const agent = new Agent({
      systemPrompt: "assistant",
      tools: runner.getVisibleTools(),
      llm: new ScriptedLlm([
        toolStream([
          { id: "c1", name: "todo", args: { action: "add", text: "A" } },
          { id: "c2", name: "todo", args: { action: "add", text: "B" } },
        ]),
        textStream("done"),
      ]),
      config: { model: "m", ...createExtensionAwareConfig(runner) },
    });
    agent.subscribe(forwardAgentEvents(runner));
    agent.subscribe((event) => {
      if (event.type === "message_end") session.appendMessage(event.message);
    });
    await agent.prompt("add two");

    const list = await todoTool.execute({ action: "list" } as Record<string, unknown>);
    // In a parallel batch both executes increment from in-memory state: no lost state, no duplicate numbers
    expect(list.content).toContain("#1: A");
    expect(list.content).toContain("#2: B");
  });

  it("loader failure isolation: a factory throw doesn't kill sibling extensions and half registrations aren't committed (Pi per-path collection + discard)", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "bad-extension.ts"),
      [
        "export default function (pi) {",
        "  pi.registerTool({ name: \"zombie\", description: \"zombie\", parameters: { type: \"object\", properties: {} },",
        "    async execute() { return { content: \"z\" }; } });",
        '  throw new Error("boom");',
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "good-extension.ts"),
      [
        "export default function (pi) {",
        "  pi.registerTool({ name: \"hello\", description: \"greet\",",
        "    parameters: { type: \"object\", properties: { name: { type: \"string\" } }, required: [\"name\"] },",
        "    async execute(args) { return { content: `Hello, ${String(args.name)}!` }; } });",
        "}",
      ].join("\n"),
    );
    const factories = await loadExtensionsFromDir(dir);
    const runner = await makeRunner(factories);
    // zombie was registered before the throw and must be discarded along with the staging registry
    expect(runner.getRegisteredTools().map((t) => t.name)).toEqual(["hello"]);
  });

  it("Inject chaining: a later context handler sees the previous one's output (Pi emitContext L984 chaining)", async () => {
    const runner = await makeRunner([
      (pi) => pi.on("context", async ({ messages }) => [...messages, { role: "user" as const, text: "A" }]),
      (pi) =>
        pi.on("context", async ({ messages }) => {
          // Chaining semantics: A's injection must already be visible here (load order × registration order)
          expect(messages.some((m) => m.text === "A")).toBe(true);
          return [...messages, { role: "user" as const, text: "B" }];
        }),
    ]);
    const out = await runner.emitContext([{ role: "user", text: "task" }]);
    expect(out.map((m) => m.text)).toEqual(["task", "A", "B"]);
  });

  it("Intercept short-circuit: later handlers don't run after a block (Pi emitToolCall L932 short-circuit)", async () => {
    let sideEffects = 0;
    const runner = await makeRunner([
      (pi) =>
        pi.on("tool_call", async (e) =>
          e.toolCall.name === "delete_file" ? { block: true, reason: "not allowed" } : undefined,
        ),
      (pi) =>
        pi.on("tool_call", async () => {
          sideEffects++;
          return undefined;
        }),
    ]);
    const verdict = await runner.emitToolCall({
      assistantMessage: assistantMessage(),
      toolCall: { id: "c1", name: "delete_file", arguments: {} },
      args: {},
    });
    expect(verdict).toMatchObject({ block: true, reason: "not allowed" });
    expect(sideEffects).toBe(0);
  });

  it("error isolation: a handler that throws doesn't break sibling handlers or the dispatch (Pi per-handler try/catch)", async () => {
    const ran: string[] = [];
    const runner = await makeRunner([
      (pi) =>
        pi.on("message_end", async () => {
          throw new Error("boom");
        }),
      (pi) =>
        pi.on("message_end", async () => {
          ran.push("B");
        }),
    ]);
    // dispatch itself doesn't throw; B runs as usual
    await expect(runner.emit("message_end", { message: { role: "user", text: "hi" } })).resolves.toBeDefined();
    expect(ran).toEqual(["B"]);
  });

  it("async factory: registration after await still takes effect (Pi ExtensionFactory supports Promise<void>)", async () => {
    const runner = await makeRunner([
      async (pi) => {
        await Promise.resolve();
        pi.registerTool({
          name: "hello",
          description: "greet",
          parameters: { type: "object", properties: {} },
          async execute() {
            return { content: "hi" };
          },
        });
      },
    ]);
    expect(runner.getRegisteredTools().map((t) => t.name)).toEqual(["hello"]);
  });

  it("regression: wiring an empty runner doesn't change the Agent baseline (no extensions → hooks pass through)", async () => {
    const runner = await makeRunner([]);
    const aware = createExtensionAwareConfig(runner);
    // transformContext returns its input unchanged
    const msgs: Message[] = [{ role: "user", text: "task" }];
    expect(await aware.transformContext(msgs)).toEqual(msgs);
    // beforeToolCall doesn't block
    const verdict = await aware.beforeToolCall({
      assistantMessage: assistantMessage(),
      toolCall: { id: "c1", name: "hello", arguments: {} },
      args: {},
      context: { systemPrompt: "assistant", messages: msgs },
    });
    expect(verdict).toBeUndefined();
    // loadTools adds nothing
    expect(aware.loadTools(["hello"])).toEqual([]);
  });

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });
});
