/**
 * Chapter 07 tests (Phase 2): Entry tree session.
 * Covers: leaf moves after append, fork isolates two branches, navigate back, walk toward the root, custom entry,
 * getTree/getChildren, JSONL round-trip and fault tolerance, integration of continuing a conversation after branching,
 * correct leaf after restore, the value of the tree (state derived from the branch path).
 * Driven by a streaming mock LLM (offline).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { appendEntries, loadTree } from "../src/jsonl.ts";
import { TreeSession, type Entry, type MessageEntry } from "../src/session-tree.ts";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AssistantMessageEvent, Message, Tool } from "../../00-minimal-llm-call/src/index.ts";
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

function makeAgent(llm: LLMAdapter, initialMessages?: Message[], tools: Tool[] = [createCalculatorTool()]): Agent {
  return new Agent({
    systemPrompt: "assistant",
    tools,
    llm,
    config: { model: "m" },
    initialMessages,
  });
}

/**
 * Write the Agent's new messages into the tree and persist them to disk (the Pi AgentSession message_end → appendMessage pattern).
 * New messages = the part of agent.state.messages beyond the "current branch message count".
 */
function persist(tree: TreeSession, agent: Agent, file: string): void {
  const before = tree.getMessages().length;
  const entries = agent.state.messages.slice(before).map((m) => tree.appendMessage(m));
  appendEntries(file, { version: 2, systemPrompt: "assistant", model: "m" }, entries);
}

/** Counter tool: state is stored in tool result details, and reconstruct derives it from the branch path (a minimal version of the todo.ts mechanism). */
function createCounterTool(): Tool & { count: number; reconstruct: (entries: Entry[]) => void } {
  const tool = {
    count: 0,
    name: "counter",
    description: "Counter",
    parameters: { type: "object", properties: {} },
    async execute() {
      tool.count += 1;
      return { content: `count=${tool.count}`, details: { count: tool.count } };
    },
    reconstruct(entries: Entry[]) {
      tool.count = 0;
      for (const e of entries) {
        if (e.type !== "message") continue;
        const m = (e as MessageEntry).message;
        if (m.role === "toolResult" && m.toolName === "counter") {
          const details = m.details as { count?: number } | undefined;
          if (typeof details?.count === "number") tool.count = details.count;
        }
      }
    },
  } as Tool & { count: number; reconstruct: (entries: Entry[]) => void };
  return tool;
}

/** Temporary session file (cleaned up in afterEach). */
let tempRoot: string | undefined;
function tempFile(): string {
  tempRoot ??= mkdtempSync(join(tmpdir(), "lpia-07-"));
  return join(tempRoot, "session.jsonl");
}

describe("Entry tree (Chapter 07 Phase 2)", () => {
  it("leaf moves after append: the new entry becomes the leaf, with parentId pointing at the current leaf (Pi _appendEntry L1045-1050)", () => {
    const tree = new TreeSession();
    const e1 = tree.appendMessage({ role: "user", text: "hello" });
    expect(tree.getLeafId()).toBe(e1.id);
    expect(e1.parentId).toBeNull(); // the first entry is the root
    const e2 = tree.appendMessage({ role: "assistant", text: "reply" });
    expect(tree.getLeafId()).toBe(e2.id);
    expect(e2.parentId).toBe(e1.id);
  });

  it("fork isolates two branches: branch back to a history point and append a new branch; the branches don't pollute each other (Pi branch L1361-1366)", () => {
    const tree = new TreeSession();
    const u1 = tree.appendMessage({ role: "user", text: "A1" });
    const a1 = tree.appendMessage({ role: "assistant", text: "A reply" });
    tree.branch(u1.id); // fork at the root
    const b1 = tree.appendMessage({ role: "user", text: "B1" });
    const b2 = tree.appendMessage({ role: "assistant", text: "B reply" });
    // leaf is on branch B
    expect(tree.getLeafId()).toBe(b2.id);
    // the two branch paths don't pollute each other
    expect(tree.getBranch(a1.id).map((e) => e.id)).toEqual([u1.id, a1.id]);
    expect(tree.getBranch().map((e) => e.id)).toEqual([u1.id, b1.id, b2.id]);
    // branch A has none of B's entries
    expect(tree.getChildren(u1.id).map((e) => e.id)).toEqual([a1.id, b1.id]);
  });

  it("navigate: leaf is correct after switching to a history entry, and appending from there creates a new child branch", () => {
    const tree = new TreeSession();
    const u1 = tree.appendMessage({ role: "user", text: "Q" });
    const a1 = tree.appendMessage({ role: "assistant", text: "R1" });
    const a2 = tree.appendMessage({ role: "assistant", text: "R2" });
    tree.branch(a1.id); // switch to a history entry
    expect(tree.getLeafId()).toBe(a1.id);
    const a3 = tree.appendMessage({ role: "assistant", text: "R3" });
    expect(a3.parentId).toBe(a1.id);
    expect(tree.getLeafId()).toBe(a3.id);
    expect(tree.getEntry(a2.id)).toBeDefined(); // R2 on the original path is still there (append-only, nothing deleted)
  });

  it("getBranch walks toward the root (root→leaf order); branching to a missing entry throws", () => {
    const tree = new TreeSession();
    const u1 = tree.appendMessage({ role: "user", text: "Q" });
    const a1 = tree.appendMessage({ role: "assistant", text: "R" });
    expect(tree.getBranch().map((e) => e.id)).toEqual([u1.id, a1.id]); // starts from the leaf by default
    expect(tree.getBranch(u1.id).map((e) => e.id)).toEqual([u1.id]);
    expect(() => tree.branch("nope")).toThrow("not found"); // Pi L1361-1366 validation
  });

  it("custom entry: joins the tree, advances the leaf, stays out of the message path (Pi CustomEntry, not in the LLM context)", () => {
    const tree = new TreeSession();
    const u1 = tree.appendMessage({ role: "user", text: "Q" });
    const c1 = tree.appendCustomEntry("todo", { count: 1 });
    expect(tree.getEntry(c1.id)).toBeDefined();
    expect(c1.parentId).toBe(u1.id);
    expect(tree.getLeafId()).toBe(c1.id);
    expect(tree.getMessages()).toHaveLength(1); // custom produces no messages
    expect(tree.getMessages()[0]).toMatchObject({ role: "user", text: "Q" });
  });

  it("getTree: correct multi-branch structure, orphan entries become roots, children sorted by timestamp (Pi L1311-1349)", () => {
    const tree = new TreeSession();
    const u1 = tree.appendMessage({ role: "user", text: "Q" });
    tree.appendMessage({ role: "assistant", text: "R1" });
    tree.branch(u1.id);
    const b1 = tree.appendMessage({ role: "assistant", text: "R2" });
    const roots = tree.getTree();
    expect(roots).toHaveLength(1);
    expect(roots[0].children.map((c) => c.entry.id)).toEqual([tree.getChildren(u1.id)[0].id, b1.id]); // by timestamp
    // orphans become roots: an entry with a missing parent becomes its own root (Pi L1332-1335)
    const orphan: Entry = {
      type: "message",
      id: "o1",
      parentId: "ghost",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", text: "orphan" },
    };
    tree.load([...tree.getEntries(), orphan]);
    expect(tree.getTree()).toHaveLength(2);
  });
});

describe("JSONL persistence (Chapter 07 Phase 2)", () => {
  it("round-trip: save → load keeps the structure and the correct leaf (branched state)", () => {
    const file = tempFile();
    const tree = new TreeSession();
    const u1 = tree.appendMessage({ role: "user", text: "A1" });
    const a1 = tree.appendMessage({ role: "assistant", text: "A reply" });
    tree.branch(u1.id);
    const b1 = tree.appendMessage({ role: "user", text: "B1" });
    appendEntries(file, { version: 2, systemPrompt: "assistant", model: "m" }, tree.getEntries());

    const loaded = loadTree(file);
    expect(loaded).not.toBeNull();
    expect(loaded?.header).toMatchObject({ systemPrompt: "assistant", model: "m" });
    expect(loaded?.tree.getEntries()).toHaveLength(3);
    expect(loaded?.tree.getLeafId()).toBe(b1.id); // after restore, leaf = the last entry (Pi _buildIndex L959)
    expect(loaded?.tree.getBranch(a1.id).map((e) => e.id)).toEqual([u1.id, a1.id]); // branch A is intact
  });

  it("JSONL fault tolerance: skip corrupted lines; add a missing trailing newline before append", () => {
    const file = tempFile();
    const tree = new TreeSession();
    tree.appendMessage({ role: "user", text: "first" });
    const a1 = tree.appendMessage({ role: "assistant", text: "second" });
    appendEntries(file, { version: 2, systemPrompt: "assistant", model: "m" }, tree.getEntries());
    // corrupt a middle line: one corrupted line doesn't kill the whole session
    const raw = readFileSync(file, "utf8");
    const lines = raw.split("\n").filter((l) => l);
    writeFileSync(file, [lines[0], "{{{broken", ...lines.slice(1)].join("\n") + "\n", "utf8");
    const loaded = loadTree(file);
    expect(loaded?.tree.getMessages().map((m) => m.text)).toEqual(["first", "second"]);
    expect(loaded?.tree.getLeafId()).toBe(a1.id);
    // missing trailing newline: no newline after an external write → append adds one first, so lines don't merge into corruption
    writeFileSync(file, raw.trimEnd(), "utf8");
    const tree2 = new TreeSession();
    tree2.load(tree.getEntries()); // reuse the existing entries; leaf lands on the last one (correct append position)
    const u2 = tree2.appendMessage({ role: "user", text: "third" });
    appendEntries(file, { version: 2, systemPrompt: "assistant", model: "m" }, [u2]);
    const loaded2 = loadTree(file);
    expect(loaded2?.tree.getMessages().map((m) => m.text)).toEqual(["first", "second", "third"]);
  });

  it("returns null when the file doesn't exist; returns null on a corrupted header (can't-restore semantics)", () => {
    const file = tempFile();
    expect(loadTree(file)).toBeNull();
    writeFileSync(file, '{"version": 1, "systemPrompt": "x", "model": "m"}\n', "utf8"); // a v1 linear header doesn't match v2
    expect(loadTree(file)).toBeNull();
    writeFileSync(file, "not json\n", "utf8");
    expect(loadTree(file)).toBeNull();
  });
});

describe("Integration (Chapter 07 Phase 2, scripted LLM)", () => {
  it("continue a conversation after branching: switch to a history entry and rebuild the Agent; the new and old branches have correct message sequences", async () => {
    const file = tempFile();
    const tree = new TreeSession();
    // branch A: compute 1+2
    const agentA = makeAgent(
      new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("3")]),
    );
    await agentA.prompt("compute 1+2");
    persist(tree, agentA, file);
    const a1Reply = tree.getLeafId()!;
    const branchPoint = tree.getBranch()[0].id;
    // branch B: fork at the root, compute 3+4
    tree.branch(branchPoint);
    const agentB = makeAgent(
      new ScriptedLlm([toolStream([{ id: "c2", name: "calculator", args: { a: 3, b: 4 } }]), textStream("7")]),
      tree.getMessages(),
    );
    await agentB.prompt("compute 3+4");
    persist(tree, agentB, file);
    // the two branches are isolated: same root, they fork at the second level, and the messages don't pollute each other
    // branch B path = u1 + userB + b1(tool) + trB + b1text (5 entries); branch A path = u1 + a1(tool) + tr1 + a1text (4 entries)
    expect(tree.getBranch()[0].id).toBe(branchPoint);
    expect(tree.getBranch()).toHaveLength(5);
    expect(tree.getBranch(a1Reply)).toHaveLength(4);
    expect(tree.getBranch()[1].id).not.toBe(tree.getBranch(a1Reply)[1].id);
    expect(tree.getMessages().at(-1)).toMatchObject({ role: "assistant", text: "7" });
  });

  it("leaf is correct after save and restore, and the continued conversation lands on the original branch", async () => {
    const file = tempFile();
    const tree = new TreeSession();
    // branch A
    const agentA = makeAgent(
      new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("3")]),
    );
    await agentA.prompt("compute 1+2");
    persist(tree, agentA, file);
    const branchPoint = tree.getBranch()[0].id;
    // branch B
    tree.branch(branchPoint);
    const agentB = makeAgent(
      new ScriptedLlm([toolStream([{ id: "c2", name: "calculator", args: { a: 3, b: 4 } }]), textStream("7")]),
      tree.getMessages(),
    );
    await agentB.prompt("compute 3+4");
    persist(tree, agentB, file);
    const bLeaf = tree.getLeafId()!;
    // restore: leaf correctly lands on branch B
    const loaded = loadTree(file);
    expect(loaded).not.toBeNull();
    expect(loaded?.tree.getLeafId()).toBe(bLeaf);
    // the continued conversation lands on the original branch (history restored from the branch B path)
    const agentC = makeAgent(new ScriptedLlm([textStream("second turn")]), loaded!.tree.getMessages());
    await agentC.prompt("one more turn");
    expect(agentC.state.messages).toHaveLength(loaded!.tree.getMessages().length + 2);
    expect(agentC.state.messages[0]).toMatchObject({ text: "compute 1+2" });
  });

  it("value of the tree: state lives in tool results, and after branching back the path-derived state returns to its historical value (todo.ts mechanism)", async () => {
    const counter = createCounterTool();
    const file = tempFile();
    const tree = new TreeSession();
    const agent = makeAgent(
      new ScriptedLlm([
        toolStream([{ id: "c1", name: "counter", args: {} }]),
        textStream("1"),
        toolStream([{ id: "c2", name: "counter", args: {} }]),
        textStream("2"),
      ]),
      undefined,
      [counter],
    );
    await agent.prompt("count");
    persist(tree, agent, file);
    await agent.prompt("count again");
    persist(tree, agent, file);
    expect(counter.count).toBe(2);
    // branch back: return to the first counter tool result entry; the derived state goes back to count=1
    const toolResults = tree
      .getEntries()
      .filter((e) => e.type === "message" && (e as MessageEntry).message.role === "toolResult" && (e as MessageEntry).message.toolName === "counter");
    expect(toolResults).toHaveLength(2);
    tree.branch(toolResults[0].id);
    counter.reconstruct(tree.getBranch());
    expect(counter.count).toBe(1);
    // back to the root: state resets to zero
    tree.branch(tree.getBranch()[0].id);
    counter.reconstruct(tree.getBranch());
    expect(counter.count).toBe(0);
  });
});

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});
