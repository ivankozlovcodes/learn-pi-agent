/**
 * Chapter 08 tests: Session Compaction (Compaction as an Entry).
 *
 * Coverage (layered by mechanism):
 * - token estimate and trigger: estimateTokens / shouldCompact
 * - safe cut point: both user/assistant can be cut points, toolResult never, an all-toolResult threshold region falls back to 0,
 *   when cutting at assistant(toolCall) its toolResult is in the retained tail
 * - structural invariant: appendCompaction is purely additive (N→N+1, all old entries present,
 *   parentId=old leaf, leaf moves forward, later appends hang under the compaction)
 * - reconstruction: without compaction, equivalent to Chapter 07 getMessages (regression); single compaction =
 *   summary + from firstKeptEntryId onward; lenient fallback when firstKeptEntryId is not found; custom is not projected
 * - orchestration: compactSession success / under the limit / three summary failures (zero side effects on the Session);
 *   firstKeptEntryId really is the first retained entry
 * - canonical state refresh: agent.replaceMessages after compact, the next run in the same process uses
 *   summary + retained tail (no reload needed)
 * - branch-local: compacting branch A does not pollute branch B; rebuilding at a pre-compaction position = full old history
 * - multiple compactions: C1/C2 both in the tree, reconstruction uses only the latest, original history all present
 * - JSONL round-trip: append → load → same reconstruction result (compaction persists across runs)
 * Driven by a streaming mock LLM (offline); does not depend on specific summary text.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { appendEntries, loadTree } from "../src/jsonl.ts";
import {
  TreeSession,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  type Entry,
} from "../src/session-tree.ts";
import {
  compactSession,
  estimateTokens,
  findCutPoint,
  shouldCompact,
  type CompactionSettings,
} from "../src/compaction.ts";
import type { AssistantMessage, AssistantMessageEvent, LLMRequest, Message } from "../../00-minimal-llm-call/src/index.ts";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";

/** assistant message builder: the base Message has no stopReason, so it needs the AssistantMessage type. */
function assistantMsg(text: string): AssistantMessage {
  return { role: "assistant", stopReason: "end_turn", text };
}

/** Summary LLM: returns a fixed summary (does not quote the original messages; its text is not part of the structural assertions). */
class SummaryLlm implements LLMAdapter {
  async *complete(): AsyncIterable<AssistantMessageEvent> {
    yield { type: "start", partial: { role: "assistant", stopReason: "end_turn" } };
    yield { type: "done", partial: { role: "assistant", stopReason: "end_turn", text: "[Summary] history was compacted" } };
  }
}

/** Main-conversation LLM that records every LLM input (repeats the last step once the steps run out). */
class RecordingLlm implements LLMAdapter {
  private next = 0;
  readonly seenInputs: Message[][] = [];

  constructor(private steps: AssistantMessageEvent[][]) {}

  async *complete(input: LLMRequest): AsyncIterable<AssistantMessageEvent> {
    this.seenInputs.push([...input.messages]);
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

/**
 * Standard long history: U1 A1(toolCall) T1 U2(long text) A2 U3(medium text) A3.
 * Estimated tokens: 1+6+1+34+1+9+1=53 (limitTokens=50 triggers); with keepRecentTokens=10,
 * accumulating from the end reaches the threshold at U3 (9+1≥10) → cut point = U3 → retained tail [U3, A3].
 */
function buildLongHistory(tree: TreeSession) {
  const u1 = tree.appendMessage({ role: "user", text: "Q1" });
  const a1Msg: AssistantMessage = {
    role: "assistant",
    stopReason: "tool_use",
    toolCalls: [{ id: "c1", name: "calculator", arguments: { a: 1, b: 2 } }],
  };
  const a1 = tree.appendMessage(a1Msg);
  const t1 = tree.appendMessage({ role: "toolResult", toolCallId: "c1", toolName: "calculator", text: "3", isError: false });
  const u2 = tree.appendMessage({ role: "user", text: "Q2: " + "x".repeat(132) });
  const a2 = tree.appendMessage(assistantMsg("R2"));
  const u3 = tree.appendMessage({ role: "user", text: "Q3: " + "y".repeat(32) });
  const a3 = tree.appendMessage(assistantMsg("R3"));
  return { u1, a1, t1, u2, a2, u3, a3 };
}

/** Failing summary LLM (by stopReason/exception kind). */
function failingLlm(kind: "error" | "aborted" | "throw"): LLMAdapter {
  return {
    async *complete(): AsyncIterable<AssistantMessageEvent> {
      if (kind === "throw") {
        throw new Error("Network drop: stream reset");
      }
      yield { type: "start", partial: { role: "assistant", stopReason: kind } };
      yield {
        type: "done",
        partial: kind === "error"
          ? { role: "assistant", stopReason: "error", errorMessage: "API failed" }
          : { role: "assistant", stopReason: "aborted", text: "fragment text" },
      };
    },
  };
}

const SETTINGS: CompactionSettings = { limitTokens: 50, keepRecentTokens: 10 };

// ---------------------------------------------------------------------------
// token estimate and trigger
// ---------------------------------------------------------------------------

describe("estimateTokens / shouldCompact", () => {
  it("estimateTokens: chars / 4 estimate", () => {
    expect(estimateTokens({ role: "user", text: "abcd" })).toBe(1);
    expect(estimateTokens({ role: "user", text: "abcdefgh" })).toBe(2);
    expect(estimateTokens({ role: "toolResult", toolCallId: "c", toolName: "t", text: "x".repeat(400), isError: false })).toBe(100);
  });

  it("shouldCompact: triggers when the estimate exceeds the threshold", () => {
    expect(shouldCompact([{ role: "user", text: "hi" }], 10)).toBe(false);
    expect(shouldCompact([{ role: "user", text: "x".repeat(400) }], 10)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findCutPoint: safe cut point
// ---------------------------------------------------------------------------

describe("findCutPoint (safe cut point)", () => {
  it("assistant can be the firstKeptEntry: cut at assistant(toolCall), its toolResult is in the retained tail (the pair is not split)", () => {
    const messages: Message[] = [
      { role: "user", text: "Q1" },
      { role: "assistant", toolCalls: [{ id: "c1", name: "calculator", arguments: { a: 1, b: 2 } }] },
      { role: "toolResult", toolCallId: "c1", toolName: "calculator", text: "3", isError: false },
      { role: "user", text: "Q2" },
      { role: "assistant", text: "R2" },
    ];
    // the accumulated total reaches the threshold at assistant(c1) (6 tokens) → nearest valid cut point = that assistant (index 1)
    const cut = findCutPoint(messages, 5);
    expect(cut).toBe(1);
    const kept = messages.slice(cut);
    expect(kept[0].role).toBe("assistant");
    expect(kept[0].toolCalls?.map((c) => c.id)).toEqual(["c1"]);
    expect(kept[1].role).toBe("toolResult");
    expect(kept[1].toolCallId).toBe("c1");
  });

  it("toolResult is never a cut point: threshold region all toolResult → return 0, no Compaction", () => {
    const messages: Message[] = [
      { role: "user", text: "Q1" },
      { role: "assistant", toolCalls: [{ id: "c1", name: "calculator", arguments: { a: 1, b: 2 } }] },
      { role: "toolResult", toolCallId: "c1", toolName: "calculator", text: "3", isError: false },
      { role: "toolResult", toolCallId: "c2", toolName: "echo", text: "4", isError: false },
    ];
    expect(findCutPoint(messages, 2)).toBe(0);
  });

  it("history itself does not exceed the keep window → return 0 (no Compaction needed)", () => {
    const messages: Message[] = [
      { role: "user", text: "Q1" },
      { role: "assistant", text: "R1" },
    ];
    expect(findCutPoint(messages, 100)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// appendCompaction：structural invariant（additive）
// ---------------------------------------------------------------------------

describe("appendCompaction（additive invariant）", () => {
  it("N before compact → N+1 after; all old entries present; parentId=old leaf; leaf moves forward; later appends hang under the compaction", () => {
    const tree = new TreeSession();
    tree.appendMessage({ role: "user", text: "Q1" });
    tree.appendMessage(assistantMsg("R1"));
    const u2 = tree.appendMessage({ role: "user", text: "Q2" });

    const before = tree.getEntries();
    const oldLeaf = tree.getLeafId();
    const oldIds = before.map((e) => e.id);

    const compaction = tree.appendCompaction("Summary: Q1 done", before[0].id, 42);

    const after = tree.getEntries();
    expect(after.length).toBe(before.length + 1);
    expect(oldIds.every((id) => after.some((e) => e.id === id))).toBe(true); // no old entry missing
    expect(compaction.parentId).toBe(oldLeaf);
    expect(compaction.parentId).toBe(u2.id);
    expect(tree.getLeafId()).toBe(compaction.id); // after append, leaf = CompactionEntry

    const next = tree.appendMessage({ role: "user", text: "Q3" });
    expect(next.parentId).toBe(compaction.id); // later new entries hang under the compaction
  });
});

// ---------------------------------------------------------------------------
// buildContextEntries / buildSessionContext: reconstruction projection
// ---------------------------------------------------------------------------

describe("buildContextEntries / buildSessionContext（reconstruction）", () => {
  it("no compaction: fully equivalent to Chapter 07 getMessages (compatibility regression)", () => {
    const tree = new TreeSession();
    const history = buildLongHistory(tree);
    expect(tree.buildSessionContext()).toEqual(tree.getMessages());
    expect(tree.buildSessionContext().length).toBe(7);
    expect(tree.getMessages()[0]).toMatchObject(history.u1.message);
  });

  it("single compaction: context = summary + from firstKeptEntryId onward; firstKeptEntryId really is the first retained entry", () => {
    const tree = new TreeSession();
    const { u3 } = buildLongHistory(tree);
    const oldLeaf = tree.getLeafId();
    tree.appendCompaction("Summary: Q1 and Q2 done", u3.id, 53);

    const context = tree.buildSessionContext();
    expect(context.length).toBe(3);
    expect(context[0].role).toBe("user");
    expect(context[0].text).toContain(COMPACTION_SUMMARY_PREFIX);
    expect(context[0].text).toContain("Summary: Q1 and Q2 done");
    expect(context[0].text).toContain(COMPACTION_SUMMARY_SUFFIX);
    expect(context[1]).toMatchObject(u3.message); // firstKeptEntryId → the first retained entry
    expect(context[1].role).toBe("user");
    expect(context[2].role).toBe("assistant");

    // tree data unchanged: 7 history entries + 1 compaction
    const entries = tree.getEntries();
    expect(entries.length).toBe(8);
    expect(entries[7].type).toBe("compaction");
    expect(tree.getLeafId()).toBe(entries[7].id);
    expect(oldLeaf).toBe(entries[6].id);
  });

  it("firstKeptEntryId not found: lenient fallback to [compaction] + later entries, no throw", () => {
    const tree = new TreeSession();
    buildLongHistory(tree);
    tree.appendCompaction("Summary", "missing-id", 53);
    tree.appendMessage({ role: "user", text: "Q4" });

    const context = tree.buildSessionContext();
    expect(context.length).toBe(2); // summary + Q4
    expect(context[0].text).toContain("<summary>");
    expect(context[1]).toMatchObject({ role: "user", text: "Q4" });
  });

  it("custom entry produces no context message (Extension state stays out of the LLM context)", () => {
    const tree = new TreeSession();
    tree.appendMessage({ role: "user", text: "Q1" });
    tree.appendMessage(assistantMsg("R1"));
    tree.appendCustomEntry("todo", { items: ["a"] });
    tree.appendMessage({ role: "user", text: "Q2" });
    tree.appendMessage(assistantMsg("R2"));

    expect(tree.buildSessionContext().length).toBe(4);
    expect(tree.buildSessionContext().some((m) => (m as Message).role === "toolResult")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compactSession: orchestration and fail-safety
// ---------------------------------------------------------------------------

describe("compactSession (orchestration)", () => {
  it("success: append CompactionEntry + return the rebuilt context; old history fully kept", async () => {
    const tree = new TreeSession();
    const { u3, a3 } = buildLongHistory(tree);
    const oldLeaf = tree.getLeafId();

    const result = await compactSession(tree, new SummaryLlm(), "m", SETTINGS);

    expect(result).not.toBeNull();
    expect(result!.firstKeptEntryId).toBe(u3.id); // id of the first retained entry
    expect(result!.tokensBefore).toBe(53);
    expect(result!.context).toEqual(tree.buildSessionContext());
    expect(result!.context.length).toBe(3);
    expect(result!.context[0].text).toContain(COMPACTION_SUMMARY_PREFIX);
    expect(result!.context[1]).toMatchObject(u3.message);
    expect(result!.context[2]).toMatchObject(a3.message);

    const entries = tree.getEntries();
    expect(entries.length).toBe(8); // 7 + 1, no deletion
    expect(entries[7].type).toBe("compaction");
    expect(entries[7].parentId).toBe(oldLeaf);
    expect(tree.getLeafId()).toBe(entries[7].id);
  });

  it("under the limit: return null, zero side effects on the Session", async () => {
    const tree = new TreeSession();
    tree.appendMessage({ role: "user", text: "Q1" });
    tree.appendMessage(assistantMsg("R1"));

    const result = await compactSession(tree, new SummaryLlm(), "m", { limitTokens: 1000, keepRecentTokens: 100 });
    expect(result).toBeNull();
    expect(tree.getEntries().some((e) => e.type === "compaction")).toBe(false);
  });

  it.each(["error", "aborted", "throw"] as const)("summary failed (%s): no append, Session and canonical state unchanged", async (kind) => {
    const tree = new TreeSession();
    buildLongHistory(tree);
    const before = tree.getEntries();
    const contextBefore = tree.buildSessionContext();

    const result = await compactSession(tree, failingLlm(kind), "m", SETTINGS);

    expect(result).toBeNull();
    expect(tree.getEntries()).toEqual(before); // no CompactionEntry, no writes at all
    expect(tree.buildSessionContext()).toEqual(contextBefore); // canonical unchanged
  });

  it("after a successful compact the agent state is refreshed on the spot: the next run in the same process uses summary + retained tail (no reload needed)", async () => {
    const tree = new TreeSession();
    buildLongHistory(tree);

    // the Agent exists before Compaction: initialMessages = full path (Chapter 07 getMessages, 7 messages)
    const chat = new RecordingLlm([textStream("Q4 done")]);
    const agent = new Agent({
      systemPrompt: "assistant",
      tools: [],
      llm: chat,
      config: { model: "m" },
      initialMessages: tree.getMessages(),
    });
    expect(agent.state.messages.length).toBe(7);

    const result = await compactSession(tree, new SummaryLlm(), "m", SETTINGS);
    expect(result).not.toBeNull();
    agent.replaceMessages(result!.context); // the seam of Pi agent-session.ts L2004-2007
    expect(agent.state.messages.length).toBe(3);

    await agent.prompt("Q4");

    const firstInput = chat.seenInputs[0];
    expect(firstInput.length).toBe(4); // summary + U3 + A3 + Q4
    expect(firstInput[0].text).toContain("<summary>");
    expect(firstInput.filter((m) => m.text?.includes("<summary>")).length).toBe(1); // exactly one summary
    expect(firstInput.slice(1).some((m) => m.text?.includes("Q1"))).toBe(false); // old prefix content is only in the summary
    expect(firstInput.some((m) => m.toolCalls && m.toolCalls.length > 0)).toBe(false); // A1's toolCall is not in the input
    expect(firstInput.at(-1)).toMatchObject({ role: "user", text: "Q4" });
  });
});

// ---------------------------------------------------------------------------
// branch-local semantics
// ---------------------------------------------------------------------------

describe("branch-local (compaction only affects its descendant path)", () => {
  it("compacting branch A does not pollute branch B; rebuilding at a pre-compaction position = full old history", () => {
    const tree = new TreeSession();
    tree.appendMessage({ role: "user", text: "Q1" });
    const a1 = tree.appendMessage(assistantMsg("R1"));

    // branch A: continue from A1 and compact
    const u2a = tree.appendMessage({ role: "user", text: "QA" });
    const a2a = tree.appendMessage(assistantMsg("RA"));
    tree.appendCompaction("SummaryA", u2a.id, 100);
    const branchALeaf = tree.getLeafId()!;

    // branch B: fork back at A1 (path does not include A's compaction entry)
    tree.branch(a1.id);
    tree.appendMessage({ role: "user", text: "QB" });
    tree.appendMessage(assistantMsg("RB"));

    // B's active path: full original messages, 0 summaries
    const contextB = tree.buildSessionContext();
    expect(contextB.length).toBe(4); // U1 A1 B1 B2
    expect(contextB.some((m) => m.text?.includes("<summary>"))).toBe(false);

    // A's path (rebuilt via its leaf): summary + retained tail
    expect(tree.getBranch(branchALeaf).some((e) => e.type === "compaction")).toBe(true);
    tree.branch(branchALeaf);
    const contextA = tree.buildSessionContext();
    expect(contextA.length).toBe(3); // summary + U2a + A2a
    expect(contextA[0].text).toContain("<summary>");
    expect(contextA[1]).toMatchObject(u2a.message);

    // back to a node before the compaction: full old history, no summary
    tree.branch(a1.id);
    const contextPre = tree.buildSessionContext();
    expect(contextPre.length).toBe(2); // U1 A1 (full history as seen from A1)
    expect(contextPre.some((m) => m.text?.includes("<summary>"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// multiple compactions
// ---------------------------------------------------------------------------

describe("multiple compactions（latest wins）", () => {
  it("C1/C2 both stay in the tree; reconstruction uses only the latest C2; original history all still present", () => {
    const tree = new TreeSession();
    const { u1, a1 } = buildLongHistory(tree);

    const c1 = tree.appendCompaction("Summary1", u1.id, 50);
    const u4 = tree.appendMessage({ role: "user", text: "Q4" });
    tree.appendMessage(assistantMsg("R4"));
    // Pi's prepareCompaction puts the new cut point after C1's retained boundary (boundaryStart = the index of the previous
    // firstKeptEntryId, compaction.ts L771-772); this test follows those semantics and builds it with a scripted
    // summary directly: C2.firstKeptEntryId = Q4 (the first entry after C1).
    const c2 = tree.appendCompaction("Summary2", u4.id, 40);
    tree.appendMessage({ role: "user", text: "Q5" });
    tree.appendMessage(assistantMsg("R5"));

    const entries = tree.getEntries();
    expect(entries.filter((e) => e.type === "compaction").map((e) => e.id)).toEqual([c1.id, c2.id]); // both in the tree
    expect(entries.filter((e) => e.type === "message").length).toBe(11); // U1..A3(7) + Q4/R4 + Q5/R5, all kept

    const context = tree.buildSessionContext();
    expect(context.length).toBe(5); // summary2 + Q4 + R4 + Q5 + R5
    expect(context[0].text).toContain("Summary2");
    expect(context[0].text).not.toContain("Summary1"); // C1 does not appear directly in the current context
    expect(context[1]).toMatchObject({ role: "user", text: "Q4" });
    expect(context[2]).toMatchObject(assistantMsg("R4"));

    // the original history (including entries before C1) is still queryable in entries
    expect(entries.some((e) => e.id === u1.id)).toBe(true);
    expect(entries.some((e) => e.id === a1.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// JSONL round-trip
// ---------------------------------------------------------------------------

describe("JSONL round-trip (compaction persists across runs)", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("append → save → load → same reconstruction result; full entries still queryable", () => {
    const dir = mkdtempSync(join(tmpdir(), "ch08-compaction-"));
    tmpDirs.push(dir);
    const file = join(dir, "session.jsonl");
    const header = { version: 2 as const, systemPrompt: "assistant", model: "m" };

    const tree = new TreeSession();
    const { u3 } = buildLongHistory(tree);
    tree.appendCompaction("Summary", u3.id, 53);
    tree.appendMessage({ role: "user", text: "Q4" });
    tree.appendMessage(assistantMsg("R4"));

    appendEntries(file, header, tree.getEntries());
    const loaded = loadTree(file);
    expect(loaded).not.toBeNull();

    // reconstruction matches the pre-Compaction in-memory state: summary + U3 + A3 + Q4 + R4
    expect(loaded!.tree.buildSessionContext()).toEqual(tree.buildSessionContext());
    expect(loaded!.tree.buildSessionContext().length).toBe(5);
    expect(loaded!.tree.buildSessionContext()[0].text).toContain("<summary>");
    // full entries (including the full history before the compaction) match in count and content
    expect(loaded!.tree.getEntries().length).toBe(10);
    expect(loaded!.tree.getLeafId()).toBe(tree.getLeafId());
  });
});
