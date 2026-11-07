/**
 * Chapter 07 core (Phase 2): Entry tree session (Reduce it, a minimal rebuild from a close reading of Pi SessionManager / harness/session).
 *
 * Chapter 07 teaches in two phases:
 * - Phase 1 (session.ts, scaffold): linear JSONL session (header + message lines). It exposes the three problems of linear history
 *   (can't restart from a history node, can't keep branches, only a "last" and no "position"), then we upgrade;
 * - Phase 2 (this file + jsonl.ts): Entry tree session, matching Pi's version history
 *   (session-format.md: Version 1 linear → Version 2 tree).
 *
 * Every tree mechanism is anchored in Pi:
 * - Entry{type,id,parentId,timestamp}: EntryBase (harness/session/types.ts L14-20) + the coding-agent v3 format
 *   (docs/session-format.md: id/parentId form a tree, branching in place without a new file)
 * - current leaf: SessionManager.leafId (session-manager.ts L1196); append writes at the leaf and moves it forward (_appendEntry L1045-1050)
 * - branch: only moves the leaf pointer, never changes or deletes an entry (L1361-1366)
 * - getBranch: walks parentId toward the root, then reverses (L1261-1271)
 * - getTree: orphan entries become roots, children sorted by timestamp (L1311-1349)
 * - leaf restore: after loading, leaf = the last entry in the file (_buildIndex L959-978)
 *
 * Trimmed for teaching: the seq field (assigned read-side in the v2 architecture), the full lane/durable operation/crash recovery,
 * the Sqlite backend, and memory.ts/context.ts are not taught; non-message entries such as branch_summary are not covered,
 * and the teaching implementation of the compaction entry is in Chapter 08.
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

/** Entry union: teaching subset (message/custom; model_change/branch_summary etc. are not covered). */
export type Entry = MessageEntry | CustomEntry;

/** Tree node (used by getTree): entry + child nodes. */
export interface TreeNode {
  entry: Entry;
  children: TreeNode[];
}

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

  /** All entries (file order, without the header; Pi getEntries, L1302). */
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

  /** Messages on the branch path (teaching version of buildSessionContext: custom entries produce no messages). */
  getMessages(): Message[] {
    return this.getBranch()
      .filter((e): e is MessageEntry => e.type === "message")
      .map((e) => e.message);
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
