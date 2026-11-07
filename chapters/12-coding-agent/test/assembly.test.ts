/**
 * Chapter 12 tests: assembly integration (continuing the original Chapter 10 Trace it offline validation).
 * All the 00-09 mechanisms working together in one run: Agent wrapper (07) + skills (09) + dynamic tools (09).
 * For wiring 08-layer Session Compaction into the assembly, see the describe later in this file (triggered by saveSession,
 * not through transformContext: Compaction belongs to the Session lifecycle, consistent with Chapter 08 semantics).
 * Driven by a streaming mock LLM (offline). For the product chain added in Chapter 12, see e2e.test.ts.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { appendEntries, loadTree } from "../src/jsonl.ts";
import { TreeSession } from "../src/session-tree.ts";
import { createCodingAgent } from "../src/assembly.ts";
import { createToolRegistry, formatSkillsForSystemPrompt, readSkillContent } from "../src/extensions.ts";
import type { ExtensionFactory } from "../../10-extension-runtime/src/extension-api.ts";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AssistantMessageEvent, Message, Tool } from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool, createEchoTool } from "../../00-minimal-llm-call/src/index.ts";

/** Streaming mock LLM: records inputs (messages after transformContext) and replays steps (repeats the last step once exhausted). */
class ChatLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;
  readonly seenInputs: Message[][] = [];

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(input: Parameters<LLMAdapter["complete"]>[0]): AsyncIterable<AssistantMessageEvent> {
    this.seenInputs.push([...input.messages]);
    const events = this.steps[Math.min(this.next, this.steps.length - 1)];
    this.next++;
    yield* events;
  }
}

/** Mixed mock LLM: summary calls (systemPrompt contains "summarization assistant") return a fixed summary; other calls record their input and return the scripted reply. */
class CompactingLlm implements LLMAdapter {
  readonly seenInputs: Message[][] = [];

  constructor(
    private summaryText: string,
    private chatText = "Reply",
  ) {}

  async *complete(input: Parameters<LLMAdapter["complete"]>[0]): AsyncIterable<AssistantMessageEvent> {
    this.seenInputs.push([...input.messages]);
    const text = input.systemPrompt.includes("summarization assistant") ? this.summaryText : this.chatText;
    yield { type: "start", partial: { role: "assistant", stopReason: "end_turn" } };
    yield { type: "done", partial: { role: "assistant", stopReason: "end_turn", text } };
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

function unlockTool(): Tool {
  return {
    name: "unlock_echo",
    description: "Unlock the echo tool",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: "echo unlocked", addedToolNames: ["echo"] };
    },
  };
}

/** On-demand read tool (Chapter 09 Skill mechanism): reads the skill file by its location. */
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

/** Record the canonical context seen at transformContext and append one injected message (Chapter 10 Inject). */
function markerExtension(seen: Message[][]): ExtensionFactory {
  return (pi) => {
    pi.on("context", async (event) => {
      seen.push([...event.messages]);
      return [...event.messages, { role: "user", text: "[extension injection marker]" }];
    });
  };
}

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "lpia-10-")), "session.jsonl");
}

describe("assembly integration (Chapter 10, Trace it offline validation)", () => {
  it("00-09 together: Skill catalog + on-demand reading + dynamic tools + Agent state", async () => {
    const skillFile = join(mkdtempSync(join(tmpdir(), "lpia-10-")), "calc.md");
    writeFileSync(skillFile, "Calculate with calculator", "utf8");
    const chat = new ChatLlm([
      toolStream([{ id: "c1", name: "read_skill", args: { path: skillFile } }]),
      toolStream([{ id: "c2", name: "unlock_echo", args: {} }]),
      toolStream([{ id: "c3", name: "echo", args: { text: "hello" } }]),
      textStream("all done"),
    ]);
    const registry = createToolRegistry([createEchoTool()]);
    const skillsBlock = formatSkillsForSystemPrompt([
      { name: "calc", description: "Calculate", content: readSkillContent(skillFile), filePath: skillFile },
    ]);
    const systemPrompt = "You are a calculation assistant.\n" + skillsBlock;

    const agent = new Agent({
      systemPrompt,
      tools: [createCalculatorTool(), unlockTool(), readSkillTool(skillFile)],
      llm: chat,
      config: {
        model: "m",
        // Dynamic tools (09)
        loadTools: (names) => registry.load(names),
      },
    });
    const toolEvents: string[] = [];
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end") toolEvents.push(event.toolName);
    });

    await agent.prompt("Unlock and echo");

    // 1. The Skill catalog is in systemPrompt: it has location, but not content (layer 2/09)
    expect(agent.state.systemPrompt).toContain("<available_skills>");
    expect(agent.state.systemPrompt).toContain(skillFile);
    expect(agent.state.systemPrompt).not.toContain("Calculate with calculator");
    // 1.5 On-demand reading: read_skill brings the skill content back into history (layer 2/09)
    const readResult = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "read_skill");
    expect(readResult?.text).toContain("Calculate with calculator");
    // 2. Dynamic tools: after unlock, echo is available in later turns (layer 8/09)
    expect(
      chat.seenInputs.slice(1).some((msgs) => msgs.some((m) => m.role === "assistant" && m.toolCalls?.some((t) => t.name === "echo"))),
    ).toBe(true);
    // 3. Tool events are complete (layer 6/02)
    expect(toolEvents).toContain("read_skill");
    expect(toolEvents).toContain("unlock_echo");
    expect(toolEvents).toContain("echo");
    // 4. Agent state accumulates (layer 5/07)
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", text: "all done" });
    expect(agent.state.isStreaming).toBe(false);
  });

  it("session persistence: save after a run → restore and continue (layer 7/08, memory across runs)", async () => {
    const file = tempFile();
    const chat1 = new ChatLlm([textStream("First turn reply")]);
    const agent1 = new Agent({
      systemPrompt: "Assistant",
      tools: [createCalculatorTool()],
      llm: chat1,
      config: { model: "m" },
    });
    await agent1.prompt("Compute 1+2");
    // Messages are written into the Entry tree (append-only), and entry lines are persisted to disk (v2 format)
    const tree = new TreeSession();
    const entries = agent1.state.messages.map((m) => tree.appendMessage(m));
    appendEntries(file, { version: 2, systemPrompt: "assistant", model: "m" }, entries);

    // Restore → continue (leaf = the last entry, Pi _buildIndex)
    const loaded = loadTree(file);
    expect(loaded?.tree.getMessages()).toHaveLength(2);
    expect(loaded?.tree.getLeafId()).toBe(entries[entries.length - 1].id);
    const chat2 = new ChatLlm([textStream("Second turn reply")]);
    const agent2 = new Agent({
      systemPrompt: "Assistant",
      tools: [createCalculatorTool()],
      llm: chat2,
      config: { model: "m" },
      initialMessages: loaded?.tree.getMessages(),
    });
    await agent2.prompt("Continue");
    expect(agent2.state.messages).toHaveLength(4); // 2 restored + new prompt + reply
    expect(agent2.state.messages[0]).toMatchObject({ role: "user", text: "Compute 1+2" });

    rmSync(join(tmpdir(), "lpia-10-"), { recursive: true, force: true });
  });
});

/** 08-layer Compaction history (estimated tokens ≈ 10+6+1+44+2+16+2 = 81 > limitTokens=50; keepRecentTokens=10 → the cut point lands on U3). */
const compactionHistory: Message[] = [
  { role: "user", text: "Task 1: please implement a calculator." },
  {
    role: "assistant",
    stopReason: "tool_use",
    toolCalls: [{ id: "c1", name: "calculator", arguments: { a: 1, b: 2 } }],
  } as Message,
  { role: "toolResult", toolCallId: "c1", toolName: "calculator", text: "3", isError: false },
  { role: "user", text: "Task 2: here is a long reference document..." + "x".repeat(132) },
  { role: "assistant", stopReason: "end_turn", text: "Reply 2" } as Message,
  { role: "user", text: "Task 3: add a multiply function." + "y".repeat(32) },
  { role: "assistant", stopReason: "end_turn", text: "Reply 3" } as Message,
];

const COMPACT_SETTINGS = { limitTokens: 50, keepRecentTokens: 10 };

describe("08 layer: Session Compaction wiring (triggered by saveSession, not through transformContext)", () => {
  it("saveSession Compaction: old entries kept, CompactionEntry appended, agent state = rebuilt context", async () => {
    const llm = new CompactingLlm("[Summary] The first five turns implemented and discussed a calculator");
    const assembly = await createCodingAgent({
      cwd: tmpdir(),
      model: "m",
      llm,
      skills: [],
      compact: COMPACT_SETTINGS,
    });
    assembly.agent.state.messages.push(...compactionHistory);
    await assembly.saveSession();

    // 1. Session source of truth: all 7 message entries are still there, CompactionEntry is append-only
    const entries = assembly.session.getEntries();
    expect(entries.filter((e) => e.type === "message")).toHaveLength(7);
    const compaction = entries.find((e) => e.type === "compaction");
    expect(compaction).toBeDefined();
    expect(compaction?.parentId).toBe(entries[6].id); // old leaf = A3's entry
    expect(assembly.session.getLeafId()).toBe(compaction?.id);
    // 2. The reconstruction projection is shorter: summary + U3 + A3 (3 messages, not the full 7)
    const context = assembly.session.buildSessionContext();
    expect(context).toHaveLength(3);
    expect(context[0].text).toContain("<summary>");
    expect(context[1].text).toContain("Task 3");
    // 3. canonical state is refreshed in sync (replaceMessages seam, Pi agent-session.ts L2004-2007)
    expect(assembly.agent.state.messages).toHaveLength(3);
    expect(assembly.agent.state.messages[0].text).toContain("<summary>");
    // 4. The summary LLM receives the compacted prefix (5 messages), not the full history
    expect(llm.seenInputs[0]).toHaveLength(5);
  });

  it("after Compaction the next run uses the rebuilt context (provider input = summary + retained tail + new prompt)", async () => {
    const llm = new CompactingLlm("[Summary] Early tasks");
    const assembly = await createCodingAgent({
      cwd: tmpdir(),
      model: "m",
      llm,
      skills: [],
      compact: COMPACT_SETTINGS,
    });
    assembly.agent.state.messages.push(...compactionHistory);
    await assembly.saveSession();

    await assembly.agent.prompt("Task 4: continue");

    const chatInput = llm.seenInputs.at(-1)!;
    expect(chatInput).toHaveLength(4); // summary + U3 + A3 + new prompt
    expect(chatInput[0].text).toContain("<summary>");
    expect(chatInput.some((m) => m.text?.includes("Task 1"))).toBe(false);
    expect(chatInput.at(-1)?.text).toBe("Task 4: continue");
  });

  it("Compaction persists across runs: restore goes through buildSessionContext (summary + retained tail, not the full history)", async () => {
    const file = tempFile();
    const a1 = await createCodingAgent({
      cwd: tmpdir(),
      model: "m",
      llm: new CompactingLlm("[Summary] Early tasks"),
      skills: [],
      sessionFile: file,
      compact: COMPACT_SETTINGS,
    });
    a1.agent.state.messages.push(...compactionHistory);
    await a1.saveSession();

    // CompactionEntry is persisted to disk like messages (persistent across runs)
    const loaded = loadTree(file);
    expect(loaded!.tree.getEntries().some((e) => e.type === "compaction")).toBe(true);

    // Restore: canonical initial messages = rebuilt context (3 messages), not the full history (7 messages)
    const a2 = await createCodingAgent({
      cwd: tmpdir(),
      model: "m",
      llm: new CompactingLlm("[Summary] Early tasks"),
      skills: [],
      sessionFile: file,
      compact: COMPACT_SETTINGS,
    });
    expect(a2.agent.state.messages).toHaveLength(3);
    expect(a2.agent.state.messages[0].text).toContain("<summary>");
    expect(a2.agent.state.messages.some((m) => m.text?.includes("Task 1"))).toBe(false);
  });

  it("transformContext still only does extension injection: Compaction first, Extension second", async () => {
    const extensionSeen: Message[][] = [];
    const llm = new CompactingLlm("[Summary] Early tasks");
    const assembly = await createCodingAgent({
      cwd: tmpdir(),
      model: "m",
      llm,
      skills: [],
      extensions: [markerExtension(extensionSeen)],
      compact: COMPACT_SETTINGS,
    });
    assembly.agent.state.messages.push(...compactionHistory);
    await assembly.saveSession(); // Compaction: canonical = summary + U3 + A3

    await assembly.agent.prompt("Continue");

    // Extension injection happens after Compaction: the canonical context the extension sees is the rebuilt 4 messages, not the full history
    const seenByExtension = extensionSeen.at(-1)!;
    expect(seenByExtension).toHaveLength(4);
    expect(seenByExtension[0].text).toContain("<summary>");
    // provider input = rebuilt context + extension injected message (5 messages)
    const providerInput = llm.seenInputs.at(-1)!;
    expect(providerInput).toHaveLength(5);
    expect(providerInput.at(-1)?.text).toBe("[extension injection marker]");
  });
});
