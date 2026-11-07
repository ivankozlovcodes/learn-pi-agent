/**
 * Chapter 09 tests: the three forms of extension, skill catalog + on-demand reading, uiOnly message filtering, addedToolNames dynamic tools.
 * Driven by a streaming mock LLM (offline).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop } from "../src/agent-loop.ts";
import {
  createToolRegistry,
  formatSkillInvocation,
  formatSkillsForSystemPrompt,
  loadSkillFromFile,
  readSkillContent,
  type Skill,
} from "../src/extensions.ts";
import { convertToLlm } from "../../00-minimal-llm-call/src/index.ts";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AssistantMessageEvent, Message, Tool } from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool, createEchoTool } from "../../00-minimal-llm-call/src/index.ts";

/** Streaming mock LLM: records inputs (including tools). */
class ChatLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;
  readonly seenInputs: { messages: Message[]; tools: unknown[] }[] = [];

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(input: Parameters<LLMAdapter["complete"]>[0]): AsyncIterable<AssistantMessageEvent> {
    this.seenInputs.push({ messages: [...input.messages], tools: [...(input.tools ?? [])] });
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

/** Tool that returns addedToolNames: brings in the "echo" tool. */
function dynamicTool(): Tool {
  return {
    name: "unlock",
    description: "Unlock the echo tool",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: "echo unlocked", addedToolNames: ["echo"] };
    },
  };
}

/** On-demand read tool: read_skill returns the skill file contents (the model calls it with the location). */
function readSkillTool(filePath: string): Tool {
  return {
    name: "read_skill",
    description: "Read a skill file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async execute(args: { path: string }) {
      return { content: readSkillContent(args.path) };
    },
  };
}

/** Temporary skill files (cleaned up together in afterEach). */
let skillCounter = 0;
let tempRoot: string | undefined;
function tempSkillFile(content: string): string {
  tempRoot ??= mkdtempSync(join(tmpdir(), "lpia-09-"));
  const file = join(tempRoot, `skill-${skillCounter++}.md`);
  writeFileSync(file, content, "utf8");
  return file;
}

describe("extensions (Chapter 09)", () => {
  it("formatSkillsForSystemPrompt: the catalog block holds only name/description/location, not content (Pi system-prompt.ts L3-25)", () => {
    const file = tempSkillFile("Compute with the calculator tool");
    const block = formatSkillsForSystemPrompt([
      { name: "calc", description: "Handle calculation tasks", content: "Compute with the calculator tool", filePath: file },
    ]);
    expect(block).toContain("<available_skills>");
    expect(block).toContain(`<skill name="calc" location="${file}">`);
    expect(block).toContain("Handle calculation tasks");
    // content isn't injected into the system prompt: the model reads it on demand via location
    expect(block).not.toContain("Compute with the calculator tool");
    expect(formatSkillsForSystemPrompt([])).toBe("");
  });

  it("readSkillContent / loadSkillFromFile: read the skill file on demand (minimal version of Pi skills.ts L50-76)", () => {
    const file = tempSkillFile("Use the calculator tool to compute results.");
    const skill = loadSkillFromFile(file, "calc", "Handle arithmetic calculations");
    expect(skill).toMatchObject({ name: "calc", description: "Handle arithmetic calculations", filePath: file });
    expect(skill.content).toBe("Use the calculator tool to compute results.");
    expect(readSkillContent(file)).toBe("Use the calculator tool to compute results.");
  });

  it("formatSkillInvocation: full skill block (Pi skills.ts L38-41), can append additional instructions", () => {
    const skill: Skill = { name: "calc", description: "Calculate", content: "Compute with calculator", filePath: "/tmp/calc.md" };
    const block = formatSkillInvocation(skill);
    expect(block).toContain('<skill name="calc" location="/tmp/calc.md">');
    expect(block).toContain("Compute with calculator");
    expect(formatSkillInvocation(skill, "Keep answers concise")).toContain("Keep answers concise");
  });

  it("uiOnly messages are filtered by convertToLlm (Pi comment example: Filter out UI-only messages)", () => {
    const messages: Message[] = [
      { role: "user", text: "Task" },
      { role: "user", text: "UI notice: connecting", uiOnly: true },
      { role: "assistant", text: "Reply" },
    ];
    const llm = convertToLlm(messages);
    expect(llm).toHaveLength(2);
    expect(llm.some((m) => m.role === "user" && (m as { content?: unknown }).content === "UI notice: connecting")).toBe(false);
  });

  it("addedToolNames dynamic tools: a result brings in new tools, visible to the model in later turns (Pi types.ts L368-369)", async () => {
    const registry = createToolRegistry([createCalculatorTool(), createEchoTool()]);
    const chat = new ChatLlm([toolStream([{ id: "c1", name: "unlock", args: {} }]), textStream("Done after unlocking")]);

    await runAgentLoop(
      [{ role: "user", text: "Unlock" }],
      { systemPrompt: "Assistant", messages: [], tools: [createCalculatorTool(), dynamicTool()] },
      {
        model: "m",
        loadTools: (names) => registry.load(names),
      },
      chat,
      () => {},
    );

    // The tool list in the turn 2 LLM input includes the dynamically added echo
    expect(chat.seenInputs.length).toBe(2);
    const secondTools = chat.seenInputs[1].tools.map((t) => (t as { name: string }).name);
    expect(secondTools).toContain("echo");
  });

  it("Across runs: dynamically loaded tools are written back to the caller's context (Pi transcript point onward semantics)", async () => {
    const registry = createToolRegistry([createCalculatorTool(), createEchoTool()]);
    const context: Parameters<typeof runAgentLoop>[1] = {
      systemPrompt: "Assistant",
      messages: [],
      tools: [createCalculatorTool(), dynamicTool()],
    };
    // run 1: unlock echo
    const chat1 = new ChatLlm([toolStream([{ id: "c1", name: "unlock", args: {} }]), textStream("Done after unlocking")]);
    await runAgentLoop(
      [{ role: "user", text: "Unlock" }],
      context,
      { model: "m", loadTools: (names) => registry.load(names) },
      chat1,
      () => {},
    );
    // The caller's context.tools has been written back: echo is available in run 2
    expect(context.tools?.map((t) => (t as { name: string }).name)).toContain("echo");
    // run 2: the model requests echo directly
    const chat2 = new ChatLlm([toolStream([{ id: "c2", name: "echo", args: { text: "hello" } }]), textStream("Done")]);
    const run2 = await runAgentLoop(
      [{ role: "user", text: "Echo" }],
      context,
      { model: "m", loadTools: (names) => registry.load(names) },
      chat2,
      () => {},
    );
    const echoResult = run2.find((m) => m.role === "toolResult" && m.toolName === "echo");
    expect(echoResult).toMatchObject({ isError: false, text: "hello" });
  });

  it("Combined: skill catalog + uiOnly filtering + dynamic tools end to end", async () => {
    const skillFile = tempSkillFile("Compute with the calculator tool");
    const skillsBlock = formatSkillsForSystemPrompt([
      { name: "calc", description: "Calculation tasks", content: "Compute with the calculator tool", filePath: skillFile },
    ]);
    const systemPrompt = `You are an assistant.\n${skillsBlock}`;
    const registry = createToolRegistry([createEchoTool()]);
    const chat = new ChatLlm([toolStream([{ id: "c1", name: "unlock", args: {} }]), textStream("Done")]);

    await runAgentLoop(
      [{ role: "user", text: "Unlock and calculate" }, { role: "user", text: "(connection status)", uiOnly: true }],
      { systemPrompt, messages: [], tools: [createCalculatorTool(), dynamicTool()] },
      {
        model: "m",
        loadTools: (names) => registry.load(names),
      },
      chat,
      () => {},
    );

    // Turn 1 input: the internal history contains the uiOnly message (filtering happens in convertToLlm inside the adapter; verified by a separate case)
    expect(chat.seenInputs[0].messages).toHaveLength(2);
    expect(chat.seenInputs[0].messages[0]).toMatchObject({ role: "user", text: "Unlock and calculate" });
  });

  it("on-demand chain: the model reads the skill file on demand, then follows its instructions (Pi catalog + on-demand reading mechanism)", async () => {
    const skillFile = tempSkillFile("Use the calculator tool to compute results, and keep answers concise.");
    const skill: Skill = { name: "calc", description: "Calculation tasks", content: readSkillContent(skillFile), filePath: skillFile };
    const systemPrompt = "You are a calculation assistant.\n" + formatSkillsForSystemPrompt([skill]);
    const chat = new ChatLlm([
      toolStream([{ id: "c1", name: "read_skill", args: { path: skillFile } }]),
      toolStream([{ id: "c2", name: "calculator", args: { a: 1, b: 2 } }]),
      textStream("Result 3"),
    ]);

    const results = await runAgentLoop(
      [{ role: "user", text: "Calculate 1+2" }],
      { systemPrompt, messages: [], tools: [createCalculatorTool(), readSkillTool(skillFile)] },
      { model: "m" },
      chat,
      () => {},
    );

    // The read_skill result brings the skill content back into history (visible to the model)
    const readResult = results.find((m) => m.role === "toolResult" && m.toolName === "read_skill");
    expect(readResult).toMatchObject({ isError: false });
    expect(readResult?.text).toContain("Use the calculator tool to compute results");
    // Then the model calls calculator per the skill instructions
    expect(results.some((m) => m.role === "toolResult" && m.toolName === "calculator")).toBe(true);
  });

  it("Regression: behavior is unchanged without extensions (no uiOnly, no dynamic tools)", async () => {
    const chat = new ChatLlm([textStream("Done")]);
    await runAgentLoop(
      [{ role: "user", text: "hi" }],
      { systemPrompt: "Assistant", messages: [], tools: [createCalculatorTool()] },
      { model: "m" },
      chat,
      () => {},
    );
    expect(chat.seenInputs[0].messages).toHaveLength(1);
    expect(chat.seenInputs[0].tools.map((t) => (t as { name: string }).name)).toEqual(["calculator"]);
  });
});

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});
