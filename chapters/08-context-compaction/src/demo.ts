/**
 * Real API demo: Session Compaction (Compaction as an Entry).
 *
 * Flow:
 * 1. A scripted long history U1 A1(toolCall) T1 U2(long text) A2 U3 A3 is written into the Entry tree and persisted to disk (no LLM)
 * 2. Build the Agent before Compaction (initialMessages = full path): simulates "an Agent already exists in the process when Compaction happens"
 * 3. compactSession (real LLM summary) → structural assertions: old history not deleted, CompactionEntry appended, context shorter
 * 4. agent.replaceMessages(rebuilt context): the next run in the same process uses summary + retained tail (no reload needed)
 * 5. New turn messages keep being appended + persisted to disk → loadTree → same reconstruction result (compaction persists across runs)
 * 6. A short Branch B: fork from a pre-Compaction node → that path is unaffected by compaction
 *
 * The output has three sections:
 * - Persistent Session: entry count/parent chain (stable mechanism, all asserted programmatically)
 * - Reconstructed Context: composition of the canonical messages (stable mechanism, asserted programmatically)
 * - Model-dependent: the actual summary text and model reply (not asserted, for reference only)
 *
 * Prerequisites: working LLM API credentials; the model is set via the CLAUDE_MODEL environment variable.
 * Run: npm run demo
 */
import { rmSync } from "node:fs";
import { AnthropicLlmAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AssistantMessage, AssistantMessageEvent, LLMRequest, Message } from "../../00-minimal-llm-call/src/index.ts";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import { Agent } from "./agent.ts";
import { appendEntries, loadTree } from "./jsonl.ts";
import { TreeSession } from "./session-tree.ts";
import { compactSession } from "./compaction.ts";

const SESSION_FILE = "/tmp/learn-pi-agent-demo-compaction.jsonl";
const HEADER = { version: 2 as const, systemPrompt: "You are a concise assistant.", model: "" };

/** Records every LLM input and forwards it to the real endpoint (input composition is a structural assertion; reply text is Model-dependent). */
class RecordingAdapter implements LLMAdapter {
  readonly seenInputs: Message[][] = [];

  constructor(private delegate: LLMAdapter) {}

  async *complete(input: LLMRequest, signal?: AbortSignal): AsyncIterable<AssistantMessageEvent> {
    this.seenInputs.push([...input.messages]);
    yield* this.delegate.complete(input, signal);
  }
}

/** Programmatic assertion: the demo carries its own structural self-check and throws on failure (does not depend on specific model text). */
function check(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`Structural assertion failed: ${label}`);
  }
  console.log(`✓ ${label}`);
}

/** Role summary: an assistant with toolCalls is shown as assistant(toolCall). */
function roleOf(m: Message): string {
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return "assistant(toolCall)";
  }
  return m.role;
}

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("Set the CLAUDE_MODEL environment variable to the model to use");
  }
  HEADER.model = model;

  // ---------------------------------------------------------------------------
  // 1. Scripted long history (no LLM; estimated tokens 1+6+1+34+1+9+1=53 > limitTokens=50,
  //    keepRecentTokens=10 → the cut point lands on U3, retained tail [U3, A3])
  // ---------------------------------------------------------------------------
  console.log("=== Persistent Session: scripted long history (before Compaction) ===");
  const tree = new TreeSession();
  const u1 = tree.appendMessage({ role: "user", text: "Task 1: please implement a calculator." });
  const a1 = tree.appendMessage({
    role: "assistant",
    stopReason: "tool_use",
    toolCalls: [{ id: "c1", name: "calculator", arguments: { a: 1, b: 2 } }],
  } as AssistantMessage);
  const t1 = tree.appendMessage({ role: "toolResult", toolCallId: "c1", toolName: "calculator", text: "3", isError: false });
  const u2 = tree.appendMessage({ role: "user", text: "Task 2: here is a very long reference document..." + "x".repeat(132) });
  const a2 = tree.appendMessage({ role: "assistant", stopReason: "end_turn", text: "Reply 2" } as AssistantMessage);
  const u3 = tree.appendMessage({ role: "user", text: "Task 3: add a multiplication function too." + "y".repeat(32) });
  const a3 = tree.appendMessage({ role: "assistant", stopReason: "end_turn", text: "Reply 3" } as AssistantMessage);

  const oldLeaf = tree.getLeafId();
  const oldIds = tree.getEntries().map((e) => e.id);
  appendEntries(SESSION_FILE, HEADER, tree.getEntries());

  console.log(`entries: ${tree.getEntries().length}`);
  console.log(`canonical messages (${tree.buildSessionContext().length}): ${tree.buildSessionContext().map(roleOf).join(", ")}`);

  // ---------------------------------------------------------------------------
  // 2. An Agent already exists in the process before Compaction (initialMessages = full path, 7 messages)
  // ---------------------------------------------------------------------------
  const recording = new RecordingAdapter(new AnthropicLlmAdapter());
  const agent = new Agent({
    systemPrompt: HEADER.systemPrompt,
    tools: [],
    llm: recording,
    config: { model },
    initialMessages: tree.getMessages(),
  });
  check(agent.state.messages.length === 7, "Before Compaction the Agent holds the full path of 7 messages");

  // ---------------------------------------------------------------------------
  // 3. compactSession (real LLM summary)
  // ---------------------------------------------------------------------------
  console.log("\n=== Persistent Session: compaction (append CompactionEntry) ===");
  const result = await compactSession(tree, new AnthropicLlmAdapter(), model, { limitTokens: 50, keepRecentTokens: 10 });
  if (!result) {
    throw new Error("compactSession returned null (history under the limit or summary failed)");
  }

  console.log("\n=== Model-dependent: summary text ===");
  console.log(result.summary);

  console.log("\n=== Persistent Session: structural assertions ===");
  const entriesAfter = tree.getEntries();
  check(entriesAfter.length === oldIds.length + 1, `entries ${oldIds.length} → ${entriesAfter.length} (+1, append-only)`);
  check(oldIds.every((id) => entriesAfter.some((e) => e.id === id)), "No old history entry missing (old entries removed: 0)");
  const compactionEntry = entriesAfter.find((e) => e.type === "compaction");
  check(compactionEntry !== undefined && compactionEntry.parentId === oldLeaf, "CompactionEntry.parentId = old leaf (A3)");
  check(tree.getLeafId() === compactionEntry?.id, "after append, leaf = CompactionEntry");
  check(result.firstKeptEntryId === u3.id, "firstKeptEntryId = first retained entry (U3)");
  check(compactionEntry !== undefined && compactionEntry.parentId === a3.id, "compaction parent is specifically A3");
  if (!compactionEntry) {
    throw new Error("CompactionEntry missing");
  }
  // Persist to disk: the CompactionEntry is appended to the session file like any other entry (Pi AgentSession persists automatically; in teaching the demo calls it explicitly)
  appendEntries(SESSION_FILE, HEADER, [compactionEntry]);

  console.log("\n=== Reconstructed Context：buildSessionContext ===");
  const context = result.context;
  console.log(`before: 7 messages`);
  console.log(`after:  ${context.length} messages`);
  console.log(`roles:  ${context.map(roleOf).join(", ")}`);
  check(context.length === 3, "context = summary + U3 + A3 (3 messages)");
  check(context[0].role === "user" && context[0].text?.includes("<summary>") === true, "summary is projected as a user message with the <summary> marker");
  check(context[1].role === "user" && context[2].role === "assistant", "retained tail [U3, A3] verbatim");

  // ---------------------------------------------------------------------------
  // 4. canonical state refresh (no reload needed): the next run in the same process uses summary + retained tail
  // ---------------------------------------------------------------------------
  console.log("\n=== canonical state refresh (agent.replaceMessages, no reload needed) ===");
  agent.replaceMessages(result.context); // the seam of Pi agent-session.ts L2004-2007
  check(agent.state.messages.length === 3, "after replacement, Agent state = rebuilt context (3 messages)");

  await agent.prompt("Task 4: summarize the work we have done so far.");
  const firstInput = recording.seenInputs[0];
  console.log(`LLM input this time (${firstInput.length}): ${firstInput.map(roleOf).join(", ")}`);
  check(firstInput.length === 4, "input = summary + U3 + A3 + new prompt (4 messages)");
  check(firstInput[0].text?.includes("<summary>") === true, "input starts with the summary message");
  check(firstInput.filter((m) => m.text?.includes("<summary>")).length === 1, "exactly one summary message");
  check(firstInput.slice(1).some((m) => m.text?.includes("Task 1")) === false, "old prefix content exists only in the summary and is not repeated in the input");
  check(firstInput.some((m) => m.toolCalls && m.toolCalls.length > 0) === false, "old toolCall (A1) is not in this input");

  console.log("\n=== Model-dependent: model reply based on \"summary + retained tail\" ===");
  const reply = agent.state.messages.at(-1);
  console.log(reply?.text ?? "(none)");

  // New turn messages keep being appended (the first one hangs under the CompactionEntry) and persisted to disk
  const newEntries = agent.state.messages.slice(3).map((m) => tree.appendMessage(m));
  check(newEntries.length === 2 && newEntries[0].parentId === compactionEntry?.id, "the first entry of the new turn hangs under the CompactionEntry");
  appendEntries(SESSION_FILE, HEADER, newEntries);

  // ---------------------------------------------------------------------------
  // 5. Persist to disk → restore: same reconstruction (compaction persists across runs)
  // ---------------------------------------------------------------------------
  console.log("\n=== Restore from file (save/load idempotent) ===");
  const loaded = loadTree(SESSION_FILE);
  if (!loaded) {
    throw new Error("Session restore failed");
  }
  const reloadedContext = loaded.tree.buildSessionContext();
  console.log(`reloaded canonical messages (${reloadedContext.length}): ${reloadedContext.map(roleOf).join(", ")}`);
  check(reloadedContext.length === 5, "after restore = summary + U3 + A3 + Task 4 + reply (5 messages)");
  check(reloadedContext[0].text?.includes("<summary>") === true, "after restore, the summary message is still first");
  check(loaded.tree.getEntries().length === tree.getEntries().length, "after restore, full entry count matches (history still queryable)");

  // ---------------------------------------------------------------------------
  // 6. Branch B: fork from a pre-Compaction node (not passing through the CompactionEntry)
  // ---------------------------------------------------------------------------
  console.log("\n=== Branch B: fork from the pre-Compaction U2 ===");
  tree.branch(u2.id);
  tree.appendMessage({ role: "user", text: "Branch B: rewrite it a different way." });
  const branchBContext = tree.buildSessionContext();
  console.log(`branch B canonical messages (${branchBContext.length}): ${branchBContext.map(roleOf).join(", ")}`);
  check(branchBContext.some((m) => m.text?.includes("<summary>")) === false, "branch B path has no compaction → full original history, 0 summaries");
}

main()
  .finally(() => {
    rmSync(SESSION_FILE, { force: true }); // clean up the session file on the failure path too
  })
  .catch((error: unknown) => {
    console.error("\nDemo failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
