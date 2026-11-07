/**
 * Chapter 08 core (compaction layer): Session Compaction: cut point, summary and minimal orchestration.
 * Chapter 12 assembly reuse: this file matches its Chapter 08 counterpart (the synced copy of the compaction layer for Product Assembly).
 *
 * Rebuilt mechanisms (all anchored in the coding-agent product stack, not the low-level harness):
 * - `estimateTokens` (compaction.ts L266): token estimate (teaching uses a rough chars / 4; Pi prefers anchoring on usage)
 * - `shouldCompact` (L235): the estimate exceeds a threshold (teaching simplifies the trigger)
 * - `findCutPoint` (L403-461): accumulate tokens from the end to pick a cut point; valid cut point = user/assistant
 *   (the three-role subset of the teaching Message, equivalent to a subset of Pi isCutPointMessage L308-321:
 *   Pi also allows bashExecution/custom/branchSummary/compactionSummary, which teaching does not have),
 *   toolResult is never a cut point. When cutting at assistant(toolCall), the toolResults after it are in the retained tail.
 *   Separate summarization of the turn prefix for a Split Turn (Pi TURN_PREFIX_SUMMARIZATION_PROMPT L835-848) is not rebuilt in teaching.
 * - `summarize`: the LLM generates the summary (fail-safe subset of Pi compact L858-964: error/aborted/stream exception → null)
 * - `compactSession`: minimal orchestration (teaching version of the harness seam of Pi AgentSession.compact, see the function comment)
 *
 * Layers (Chapter 08's core teaching structure, clearly separated from Chapter 06):
 *   Session Tree → buildSessionContext (reconstruction projection) → canonical state.messages
 *   → Chapter 06 transformContext → call-time messages.
 * Compaction does not go through transformContext; transformContext is still the Chapter 06 extension injection seam.
 */
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { Message } from "../../00-minimal-llm-call/src/index.ts";
import { TreeSession, type Entry, sessionEntryToContextMessages } from "./session-tree.ts";

/** System prompt for summary generation (minimal teaching version of Pi SUMMARIZATION_SYSTEM_PROMPT). */
const SUMMARIZATION_SYSTEM_PROMPT =
  "You are a conversation summarization assistant. Read the conversation between the user and the AI assistant and produce a structured summary. " +
  "Keep key facts, file paths, function names, tool call results and error messages. Summarize concisely in English.";

/** Compaction settings (teaching subset of Pi CompactionSettings L126-130; trigger simplified). */
export interface CompactionSettings {
  /** Estimated token threshold that triggers Compaction (teaching mapping of Pi's reserveTokens semantics). */
  limitTokens: number;
  /** Estimated tokens of recent messages kept after Compaction (Pi keepRecentTokens). */
  keepRecentTokens: number;
}

/** Token estimate (chars/4 version of Pi estimateTokens L266; Pi prefers anchoring on usage, teaching has no usage). */
export function estimateTokens(message: Message): number {
  let chars = 0;
  if (message.text) chars += message.text.length;
  if (message.toolCalls) {
    for (const tc of message.toolCalls) {
      chars += tc.name.length + JSON.stringify(tc.arguments).length;
    }
  }
  if (message.errorMessage) chars += message.errorMessage.length;
  return Math.ceil(chars / 4);
}

/** Whether to compact (Pi shouldCompact L235: teaching mapping of contextTokens > contextWindow - reserveTokens). */
export function shouldCompact(messages: Message[], limitTokens: number): boolean {
  const total = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
  return total > limitTokens;
}

/**
 * Find a valid cut point from the end (teaching subset of Pi findCutPoint L403-461):
 * valid cut point = user or assistant (toolResult is excluded from the three teaching roles; Pi's valid set is a superset,
 * but teaching has no bashExecution/custom/summary message roles, so the subset is complete).
 * Once the accumulated total reaches keepRecentTokens, take "the first valid cut point at or after that position".
 * - When cutting at assistant(toolCall), all toolResults after it are in the retained tail (the pairing is not split)
 * - Threshold region is all toolResult (no valid cut point) → return 0, no Compaction (same effect as Pi falling back to startIndex without a valid cut point)
 * Returning 0 also covers the case where "the history itself does not exceed the keep window" (no Compaction needed).
 */
export function findCutPoint(messages: Message[], keepRecentTokens: number): number {
  let accumulated = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateTokens(messages[i]);
    if (accumulated >= keepRecentTokens) {
      // From i onward, find the nearest valid cut point (Pi L393-399: the first cutPoints[c] >= i)
      for (let j = i; j < messages.length; j++) {
        if (messages[j].role !== "toolResult") {
          return j;
        }
      }
      return 0; // threshold region is all toolResult → no Compaction
    }
  }
  return 0;
}

/**
 * Generate the summary with the LLM (fail-safe subset of Pi compact, no retries).
 * Failure (stopReason=error/aborted or a stream exception) → return null (the caller does not write a CompactionEntry).
 * Extra teaching guard: an empty-text summary counts as a failure (Pi allows an empty summary under a normal stopReason).
 */
export async function summarize(messages: Message[], llm: LLMAdapter, model: string): Promise<string | null> {
  let summary = "";
  let failed = false;
  try {
    for await (const event of llm.complete({
      model,
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      messages,
      tools: [],
    })) {
      if (event.type === "done") {
        // Pi getSummarizationFailure L545-553: both error and aborted count as failure (fragment text from aborted must not become a summary)
        if (event.partial.stopReason === "error" || event.partial.stopReason === "aborted") {
          failed = true;
        }
        summary = event.partial.text ?? "";
      }
    }
  } catch {
    // Stream exception (network drop, etc.) → fail-safe: don't break through the Compaction flow
    failed = true;
  }
  if (failed || summary.trim() === "") {
    return null;
  }
  return summary;
}

/** Result of a successful compact (teaching subset of Pi CompactionResult L88-97). */
export interface CompactionResult {
  /** Summary of the compacted prefix (persisted into CompactionEntry.summary). */
  summary: string;
  /** id of the first entry retained after Compaction (persisted into CompactionEntry.firstKeptEntryId). */
  firstKeptEntryId: string;
  /** Estimated token count of the canonical context before Compaction (persisted into CompactionEntry.tokensBefore). */
  tokensBefore: number;
  /** Canonical context rebuilt after a successful compact (for the caller to refresh agent state). */
  context: Message[];
}

/**
 * Minimal Session Compaction orchestration (teaching version of the harness seam of Pi AgentSession.compact):
 * 1. Take the canonical messages of the active path (buildSessionContext)
 * 2. shouldCompact: under the limit → null (do nothing)
 * 3. findCutPoint: cut point 0 (no safe cut point) → null
 * 4. summarize the old prefix; failure → null (Session and agent state unchanged)
 * 5. cutIndex → firstKeptEntryId (a Session position persisted across runs; cutIndex is only a temporary position for this run)
 * 6. appendCompaction: parentId = the old leaf, leaf moves forward; not a single old entry is touched
 * 7. The rebuilt canonical context is returned with the result, and the caller refreshes agent state
 *    (Pi agent-session.ts L2004-2007/L2329-2332: agent.state.messages = buildSessionContext().messages)
 *
 * The three null-returning cases have zero side effects on the Session.
 * Teaching scope: only handles the first Compaction, when the active path has no compaction entry yet;
 * Pi's repeated Compaction (prepareCompaction boundaryStart + UPDATE prompt summary chain) is not rebuilt.
 */
export async function compactSession(
  session: TreeSession,
  llm: LLMAdapter,
  model: string,
  settings: CompactionSettings,
): Promise<CompactionResult | null> {
  const path = session.getBranch();
  if (path.some((entry) => entry.type === "compaction")) {
    return null; // teaching scope: repeated Compaction when the active path already has a compaction entry is not rebuilt
  }

  const messages = session.buildSessionContext();
  if (!shouldCompact(messages, settings.limitTokens)) {
    return null;
  }

  const cutIndex = findCutPoint(messages, settings.keepRecentTokens);
  if (cutIndex === 0) {
    return null; // no safe cut point / no Compaction needed
  }

  const oldPart = messages.slice(0, cutIndex);

  const summary = await summarize(oldPart, llm, model);
  if (summary === null) {
    return null; // summary failed → no append; Session and canonical state unchanged
  }

  // cutIndex is a temporary position in message space; mapping it back to an entry gives the Session position persisted across runs
  // (with no compaction entry on the path, message/custom entries map to messages 1:0|1, so the mapping is unique)
  let messageOffset = 0;
  let firstKeptEntry: Entry | undefined;
  for (const entry of path) {
    const projected = sessionEntryToContextMessages(entry);
    if (messageOffset <= cutIndex && cutIndex < messageOffset + projected.length) {
      firstKeptEntry = entry;
      break;
    }
    messageOffset += projected.length;
  }
  if (!firstKeptEntry) {
    return null; // unreachable in theory (cutIndex < messages.length); kept as a defense
  }
  const firstKeptEntryId = firstKeptEntry.id;

  const tokensBefore = messages.reduce((sum, m) => sum + estimateTokens(m), 0);

  session.appendCompaction(summary, firstKeptEntryId, tokensBefore);
  const context = session.buildSessionContext();

  return { summary, firstKeptEntryId, tokensBefore, context };
}
