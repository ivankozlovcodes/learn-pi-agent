/**
 * Real API demo: Agent wrapper + Entry tree session (Chapter 07 Phase 2).
 * Flow: ask on branch A → resetLeaf (Pi navigateTree semantics for a root user: rewriting the first question = moving the leaf to its parent)
 * → ask on branch B from a brand-new root → structural assertions → restore from file (leaf = branch B) → branch-at back to branch A and continue → print the tree.
 * The choice of primitive is anchored in Pi's product-layer semantics (agent-session.ts L3208-3249):
 * rewriting a user question uses resetLeaf (the root special case); continuing from an existing state such as assistant/toolResult uses branch.
 * Prerequisites: working LLM API credentials; the model is set via the CLAUDE_MODEL environment variable.
 * Run: npm run demo
 */
import { AnthropicLlmAdapter, createCalculatorTool } from "../../00-minimal-llm-call/src/index.ts";
import type { Message } from "../../00-minimal-llm-call/src/index.ts";
import { Agent } from "./agent.ts";
import { clearSession } from "./session.ts";
import { appendEntries, loadTree } from "./jsonl.ts";
import { TreeSession, type Entry, type MessageEntry, type TreeNode } from "./session-tree.ts";

const SESSION_FILE = "/tmp/learn-pi-agent-demo-session-tree.jsonl";
const HEADER = { version: 2 as const, systemPrompt: "You are a calculation assistant. Keep answers concise.", model: "" };

/** One full turn: rebuild the Agent with the current branch path as initialMessages, then write the new messages into the tree and persist them to disk. */
async function runTurn(tree: TreeSession, input: string): Promise<void> {
  const agent = new Agent({
    systemPrompt: HEADER.systemPrompt,
    tools: [createCalculatorTool()],
    llm: new AnthropicLlmAdapter(),
    config: { model: HEADER.model },
    initialMessages: tree.getMessages(),
  });
  agent.subscribe((event) => {
    if (event.type === "turn_start") console.log("-- turn start");
    if (event.type === "tool_execution_end") console.log(`· tool: ${event.toolName} → ${event.result.content}`);
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.text) {
      console.log(`· reply: ${event.message.text}`);
    }
  });
  const before = tree.getMessages().length;
  await agent.prompt(input);
  const entries = agent.state.messages.slice(before).map((m) => tree.appendMessage(m));
  appendEntries(SESSION_FILE, HEADER, entries);
}

/** Text rendering of the tree structure (indentation + leaf marker). */
function renderTree(tree: TreeSession, node: TreeNode, depth: number, out: string[]): void {
  const e = node.entry;
  const label =
    e.type === "message"
      ? `${(e as MessageEntry).message.role}: ${((e as MessageEntry).message.text ?? "(tool call)").slice(0, 30)}`
      : `custom(${(e as Entry & { customType: string }).customType})`;
  const leafMark = e.id === tree.getLeafId() ? " ← leaf" : "";
  out.push("  ".repeat(depth) + `${e.id} [${label}]${leafMark}`);
  for (const child of node.children) {
    renderTree(tree, child, depth + 1, out);
  }
}

/** Programmatic assertions: the demo checks its own structure and throws on failure (independent of the exact model text or a fixed entry count). */
function check(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`Structural assertion failed: ${label}`);
  }
  console.log(`✓ ${label}`);
}

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("Set the CLAUDE_MODEL environment variable to the model to use");
  }
  HEADER.model = model;

  console.log("=== Phase 1 (session.ts, linear) ===");
  console.log("Linear JSONL can only append in order: to go back to message 1 and continue, you must copy the file and truncate it; a branch needs another file.");
  console.log("Upgrade: an Entry{id,parentId} tree (session-tree.ts + jsonl.ts); branching only moves the leaf pointer.\n");

  console.log("=== Session: Entry tree (branch A / brand-new branch B / branch-at continue / restore) ===");
  const tree = new TreeSession();

  // Branch A: ask, and record the root and the latest reply (the latter is a valid branch-at target: a non-user entry)
  console.log("\n[branch A] first question:");
  await runTurn(tree, "What is 12 + 30?");
  const branchARootId = tree.getBranch()[0].id;
  const branchAReplyId = tree.getLeafId()!;
  const branchAPathIds = tree.getBranch().map((e) => e.id);
  const entriesBeforeReset = tree.getEntries().length;

  // Brand-new question: Pi navigateTree on a user target = move the leaf to target.parentId (root user → null), and the text goes into the editor to be rewritten.
  // The teaching version has no editor orchestration, so resetLeaf() expresses the same semantics: branch B doesn't share A's root user.
  console.log("\n[branch B] brand-new question (resetLeaf, doesn't share A's root user):");
  tree.resetLeaf();
  check(tree.getLeafId() === null, "leaf is empty after resetLeaf");
  check(tree.getEntries().length === entriesBeforeReset, "resetLeaf doesn't delete or change any existing entry");

  await runTurn(tree, "What is 100 - 40?");
  const branchBLeafId = tree.getLeafId()!;
  const branchBPathIds = tree.getBranch().map((e) => e.id);

  check(tree.getEntry(branchBPathIds[0])?.parentId === null, "branch B's first entry becomes a new root (parentId === null)");
  check(branchBPathIds[0] !== branchARootId, "branch B root ≠ branch A root");
  check(branchBPathIds.every((id) => !branchAPathIds.includes(id)), "branch B path shares nothing with A (not A's root user nor its reply)");
  check(tree.getBranch(branchAReplyId).map((e) => e.id).join() === branchAPathIds.join(), "branch A's original path can still be fully rebuilt");
  check(tree.getEntries().length === entriesBeforeReset + branchBPathIds.length, "branches A and B live in the same append-only entry set");

  // Persist → restore: leaf = branch B, the last one appended
  const loaded = loadTree(SESSION_FILE);
  if (!loaded) {
    throw new Error("Session restore failed");
  }
  console.log("\n=== Restore from file ===");
  check(loaded.tree.getLeafId() === branchBLeafId, "after restore, active leaf = branch B, the last one appended");
  check(loaded.tree.getBranch().map((e) => e.id).join() === branchBPathIds.join(), "after restore, the rebuild = only the branch B path");
  check(loaded.tree.getBranch(branchAReplyId).map((e) => e.id).join() === branchAPathIds.join(), "old branch A can still be rebuilt from its leaf id");

  // Switch back to branch A and continue: the target is an assistant reply (not a user entry) → branch-at, the target stays on the new path
  console.log("\n[branch A] branch-at continue (target is an assistant reply):");
  tree.branch(branchAReplyId);
  await runTurn(tree, "Good. Now what is 5 * 3?");
  check(tree.getBranch(branchBLeafId).map((e) => e.id).join() === branchBPathIds.join(), "after continuing branch A, the branch B path is untouched");

  // Tree structure and leaf (two roots side by side: branch A root + branch B root)
  const out: string[] = [];
  for (const node of tree.getTree()) {
    renderTree(tree, node, 0, out);
  }
  console.log("\n=== Tree structure (branches A/B side by side, two roots) ===");
  console.log(out.join("\n"));
  console.log(`leaf: ${tree.getLeafId()}`);
}

main()
  .finally(() => {
    clearSession(SESSION_FILE); // finally runs before catch, so the failure path also cleans up the session file
  })
  .catch((error: unknown) => {
    console.error("\nDemo failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
