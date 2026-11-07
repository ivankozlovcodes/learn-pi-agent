/**
 * Chapter 07 Phase 2: Entry tree JSONL persistence (maps to the coding-agent v3 file format, docs/session-format.md).
 * Chapter 10 assembly reuse: this file is kept in sync with Chapter 07's jsonl.ts.
 *
 * Format evolution from Phase 1 (session.ts):
 * - v1 (Phase 1 scaffold): header line + message lines, linear;
 * - v2 (this file): header line + entry lines, id/parentId form a tree, branching in place without a new file.
 * Pi's version history is the same (session-format.md: Version 1 linear → Version 2 tree).
 *
 * Fault tolerance carries over from Phase 1: skip corrupted lines and continue; add the missing trailing newline before append;
 * Pi's atomic repair (harness/session/jsonl/storage.ts L86-106 torn tail rewrite) is not covered here.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { TreeSession, type Entry } from "./session-tree.ts";

/** Session header (v2 = Entry tree format). */
export interface TreeSessionHeader {
  version: 2;
  systemPrompt: string;
  model: string;
}

/** Append entry lines to the session file (Pi JsonlSessionRepo append semantics + Phase 1 fault tolerance). */
export function appendEntries(file: string, header: TreeSessionHeader, entries: Entry[]): void {
  const lines: string[] = [];
  // Only an existing, non-empty file counts as an "existing session"; an empty file (e.g. after clearSession) needs the header written again
  const hasContent = existsSync(file) && readFileSync(file, "utf-8").trim() !== "";
  if (!hasContent) {
    lines.push(JSON.stringify(header));
  } else {
    // If the file exists but lacks a trailing newline (crash truncation etc.), add one first so it doesn't merge with the next line into corrupted JSON
    const existing = readFileSync(file, "utf-8");
    if (!existing.endsWith("\n")) {
      writeFileSync(file, "\n", { flag: "a" });
    }
  }
  for (const entry of entries) {
    lines.push(JSON.stringify(entry));
  }
  writeFileSync(file, lines.join("\n") + "\n", { flag: "a" });
}

/** Restore the tree from the session file (header + entry lines; returns null if the file is missing or the header is corrupted). leaf = the last entry (Pi _buildIndex L959). */
export function loadTree(file: string): { header: TreeSessionHeader; tree: TreeSession } | null {
  if (!existsSync(file)) {
    return null;
  }
  const lines = readFileSync(file, "utf-8").split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    return null;
  }
  let header: TreeSessionHeader;
  try {
    header = JSON.parse(lines[0]) as TreeSessionHeader;
    if (typeof header?.systemPrompt !== "string" || header?.version !== 2) {
      return null; // corrupted header (not a v2 session file, or half-written) → can't restore
    }
  } catch {
    return null;
  }
  // Per-line fault tolerance: skip corrupted lines, so one bad line doesn't kill the whole session
  const entries: Entry[] = [];
  for (const line of lines.slice(1)) {
    try {
      entries.push(JSON.parse(line) as Entry);
    } catch {
      console.warn("Session file has a corrupted line, skipped:", line.slice(0, 60));
    }
  }
  const tree = new TreeSession();
  tree.load(entries);
  return { header, tree };
}
