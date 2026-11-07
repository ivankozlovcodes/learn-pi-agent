/**
 * Chapter 08 core (session layer): the Chapter 07 Entry tree + CompactionEntry and the reconstruction projection.
 * Chapter 12 assembly reuse: this file matches its Chapter 08 counterpart (the synced copy of the session layer for Product Assembly).
 *
 * Chapter 07 baseline (mechanism unchanged):
 * - Entry{type,id,parentId,timestamp}: a subset of coding-agent v3 SessionEntryBase
 * - append writes at the leaf and moves it forward (Pi _appendEntry session-manager.ts L1045-1050)
 * - branch: only moves the leaf pointer, never changes or deletes an entry (L1361-1366)
 * - getBranch: walks parentId toward the root, then reverses (L1261-1271)
 * - getTree / load: same as Chapter 07
 *
 * New in Chapter 08 (all anchored in the coding-agent product stack's session-manager.ts, not the low-level harness):
 * - CompactionEntry (teaching subset of L69-80: summary/firstKeptEntryId/tokensBefore;
 *   details/usage/fromHook trimmed)
 * - appendCompaction (L1097-1120): exactly the same append mechanism as a regular Entry,
 *   parentId = current leaf, leaf moves forward after append. No deletion, rewriting or side channel.
 * - buildContextEntries (L418-454): active path → latest compaction →
 *   [compaction] + retained entries from firstKeptEntryId + everything after the compaction.
 *   If firstKeptEntryId is not found, it does not throw; it falls back to [compaction] + what follows (same leniency as Pi).
 * - buildSessionContext (L461-470): buildContextEntries → per-entry projection → Message[].
 * - sessionEntryToContextMessages (subset of L383-408): a compaction entry is projected into
 *   a marked summary message (Pi internally uses role=compactionSummary → provider user;
 *   the teaching Message has only three roles and no such role, so it is projected directly as user + prefix/suffix text).
 *
 * Compaction as an Entry: Compaction takes the form of "appending one persisted entry";
 * history is never deleted or changed (the getEntries contract matches Pi L1297-1304); the context gets shorter through the reconstruction projection.
 *
 * Uses the firstKeptEntryId model (product stack), not the low-level harness's retainedTail snapshot model.
 */
import { randomUUID } from "node:crypto";
import type { Message } from "../../00-minimal-llm-call/src/index.ts";

/** Entry base: a teaching subset of Pi EntryBase (harness/session/types.ts L14-20) (no seq; ISO timestamp, as in the v3 format). */
export interface EntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string; // ISO (coding-agent v3 format: new Date().toISOString())
}

/** Message entry: carries a conversation message (Pi MessageEntry). */
export interface MessageEntry extends EntryBase {
  type: "message";
  message: Message;
}

/** Custom entry: persists Extension state, not part of the LLM context (Pi CustomEntry, session-format.md). */
export interface CustomEntry extends EntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

/**
 * Compaction entry (Pi CompactionEntry, teaching subset of session-manager.ts L69-80):
 * - summary: the LLM summary of the compacted prefix (the persisted result of Compaction)
 * - firstKeptEntryId: id of the first entry retained after Compaction (the slicing switch of the reconstruction projection)
 * - tokensBefore: estimated token count of the canonical context before Compaction
 * Trimmed: details/usage/fromHook are not rebuilt (Extension/cost metadata, not covered in teaching).
 */
export interface CompactionEntry extends EntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

/** Entry union: teaching subset (message/custom/compaction; model_change/branch_summary etc. are not covered in teaching). */
export type Entry = MessageEntry | CustomEntry | CompactionEntry;

/** Tree node (used by getTree): entry + child nodes. */
export interface TreeNode {
  entry: Entry;
  children: TreeNode[];
}

/** Summary message markers (Pi coding-agent messages.ts L11-20, verbatim). */
export const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";

/**
 * Generate a unique short ID (8 hex chars, collision-checked): Pi generateId (session-manager.ts L221, randomUUID().slice(0,8)).
 */
export function generateId(existing: ReadonlySet<string>): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!existing.has(id)) return id;
  }
  return randomUUID();
}

/**
 * A single entry → LLM context messages (teaching subset of Pi sessionEntryToContextMessages L383-408).
 * - message → the original message
 * - compaction → a marked user summary message (teaching projection, see the divergence note in the file header)
 * - custom → no message (Extension state stays out of the LLM context)
 */
export function sessionEntryToContextMessages(entry: Entry): Message[] {
  if (entry.type === "message") {
    return [entry.message];
  }
  if (entry.type === "compaction") {
    return [{ role: "user", text: COMPACTION_SUMMARY_PREFIX + entry.summary + COMPACTION_SUMMARY_SUFFIX }];
  }
  return [];
}

/**
 * Session tree: append-only entry tree + current leaf pointer (a teaching subset of Pi SessionManager).
 * Every write is an append (entries are never modified or deleted); branching only moves the leaf pointer.
 */
export class TreeSession {
  private entries: Entry[] = [];
  private byId = new Map<string, Entry>();
  private _leafId: string | null = null;

  /** Current leaf (Pi getLeafId, L1196). */
  getLeafId(): string | null {
    return this._leafId;
  }

  /** Look up an entry by id (Pi getEntry, L1204). */
  getEntry(id: string): Entry | undefined {
    return this.byId.get(id);
  }

  /** All entries (file order, without the header; Pi getEntries, L1302: append-only, returns a shallow copy). */
  getEntries(): Entry[] {
    return [...this.entries];
  }

  /** Direct children of an entry (Pi getChildren, L1211). */
  getChildren(parentId: string): Entry[] {
    return this.entries.filter((e) => e.parentId === parentId);
  }

  /** Append a message as a child of the current leaf, then move the leaf forward; returns the full entry (Pi appendMessage L1058 + _appendEntry L1045). */
  appendMessage(message: Message): MessageEntry {
    return this.append({ type: "message", message } as MessageEntry);
  }

  /** Append a custom entry (Extension state, kept out of the LLM context; Pi appendCustomEntry L1123). */
  appendCustomEntry(customType: string, data?: unknown): CustomEntry {
    return this.append({ type: "custom", customType, data } as CustomEntry);
  }

  /**
   * Append a compaction entry as a child of the current leaf, then move the leaf forward (Pi appendCompaction L1097-1120).
   * Locked semantics: parentId = the old leaf; after append, leaf = CompactionEntry.id.
   * Shares the same mechanism as a regular append: no old entry is deleted or modified, and no old MessageEntry is written back.
   */
  appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number): CompactionEntry {
    return this.append({ type: "compaction", summary, firstKeptEntryId, tokensBefore } as CompactionEntry);
  }

  /** Branch: move the leaf to a history entry. Only moves the pointer, never changes or deletes an entry (Pi branch L1361-1366). */
  branch(entryId: string): void {
    if (!this.byId.has(entryId)) {
      throw new Error(`Entry ${entryId} not found`);
    }
    this._leafId = entryId;
  }

  /** Reset the leaf to null (the next append creates a new root; Pi resetLeaf L1373). */
  resetLeaf(): void {
    this._leafId = null;
  }

  /** Walk toward the root: from fromId (default: leaf) follow parentId to the root, returned in root→leaf order (Pi getBranch L1261-1271). */
  getBranch(fromId?: string): Entry[] {
    const path: Entry[] = [];
    const startId = fromId ?? this._leafId;
    let current = startId ? this.byId.get(startId) : undefined;
    while (current) {
      path.push(current);
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }
    path.reverse();
    return path;
  }

  /**
   * Old Chapter 07 interface: projects the message entries on the branch path directly (not compaction-aware).
   * Chapter 08's canonical reconstruction is buildSessionContext();
   * this interface is kept for comparison with Chapter 07 semantics (the two are equivalent without compaction, locked by tests).
   */
  getMessages(): Message[] {
    return this.getBranch()
      .filter((e): e is MessageEntry => e.type === "message")
      .map((e) => e.message);
  }

  /**
   * Reconstruction projection, layer 1 (teaching subset of Pi buildContextEntries L418-454):
   * take the [last-positioned] compaction entry on the active path (if there are several, only the latest counts);
   * result = [compaction] + the path entries from firstKeptEntryId + all entries after the compaction.
   * firstKeptEntryId not found: does not throw; falls back to [compaction] + what follows (same leniency as Pi).
   * No compaction: returns the full path (equivalent to Chapter 07 behavior).
   */
  buildContextEntries(): Entry[] {
    const path = this.getBranch();

    let compaction: CompactionEntry | null = null;
    for (const entry of path) {
      if (entry.type === "compaction") {
        compaction = entry; // overwriting assignment → the last compaction on the path wins
      }
    }
    if (!compaction) {
      return path;
    }

    const compactionIndex = path.findIndex((entry) => entry.id === compaction.id);
    if (compactionIndex < 0) {
      return path;
    }

    const result: Entry[] = [compaction];
    let foundFirstKept = false;
    for (let i = 0; i < compactionIndex; i++) {
      const entry = path[i];
      if (entry.id === compaction.firstKeptEntryId) {
        foundFirstKept = true;
      }
      if (foundFirstKept) {
        result.push(entry);
      }
    }
    result.push(...path.slice(compactionIndex + 1));
    return result;
  }

  /**
   * Reconstruction projection, layer 2 (teaching subset of Pi buildSessionContext L461-470):
   * buildContextEntries → per-entry projection → canonical Message[].
   * This is the single slicing point of Chapter 08's "active path → canonical messages":
   * Compaction only changes the result here, never any data in the tree.
   */
  buildSessionContext(): Message[] {
    return this.buildContextEntries().flatMap(sessionEntryToContextMessages);
  }

  /** Tree structure: orphans (missing parent) become roots, children sorted by timestamp (Pi getTree L1311-1349). */
  getTree(): TreeNode[] {
    const nodeMap = new Map<string, TreeNode>();
    const roots: TreeNode[] = [];
    for (const entry of this.entries) {
      nodeMap.set(entry.id, { entry, children: [] });
    }
    for (const entry of this.entries) {
      const node = nodeMap.get(entry.id)!;
      if (entry.parentId === null || entry.parentId === entry.id) {
        roots.push(node);
      } else {
        const parent = nodeMap.get(entry.parentId);
        if (parent) {
          parent.children.push(node);
        } else {
          roots.push(node); // orphan becomes a root (Pi L1332-1335)
        }
      }
    }
    const stack: TreeNode[] = [...roots];
    while (stack.length > 0) {
      const node = stack.pop()!;
      node.children.sort((a, b) => a.entry.timestamp.localeCompare(b.entry.timestamp));
      stack.push(...node.children);
    }
    return roots;
  }

  /** Rebuild from a parsed entry list (used on load): leaf = the last entry (Pi _buildIndex L959-978). */
  load(entries: Entry[]): void {
    this.entries = [...entries];
    this.byId.clear();
    this._leafId = null;
    for (const entry of this.entries) {
      this.byId.set(entry.id, entry);
      this._leafId = entry.id;
    }
  }

  /** Internal write: assign id/parentId/timestamp, append, and move the leaf forward (Pi _appendEntry L1045-1050). */
  private append<T extends Entry>(entry: T): T {
    const full: Entry = {
      ...entry,
      id: generateId(new Set(this.byId.keys())),
      parentId: this._leafId,
      timestamp: new Date().toISOString(),
    };
    this.entries.push(full);
    this.byId.set(full.id, full);
    this._leafId = full.id;
    return full as T;
  }
}
