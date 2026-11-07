/**
 * Chapter 07 Phase 1: linear JSONL session (teaching scaffold).
 *
 * Chapter 07 teaches in two phases: first the most natural linear approach (this file) exposes the problems, then we upgrade to the Phase 2 Entry tree
 * (session-tree.ts + jsonl.ts). This file stays as a scaffold and for comparison; the final mechanism does not reuse it.
 *
 * - One JSON line per message (append to add, parse line by line to restore)
 * - Plus a session header (the first line records systemPrompt/model, so the full context can be restored)
 *
 * Three problems with the linear approach (README §2):
 * 1. You can't restart from a history node (going back to message N and continuing means copying the file and truncating it);
 * 2. You can't keep branches (another path needs another file, and the two files have no relation);
 * 3. The session has only a "last", not a "position" (it can't express "where we are now").
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Message } from "../../00-minimal-llm-call/src/index.ts";

/** Session file header: the first JSON line (system prompt and model, used to rebuild the context on restore). */
export interface SessionHeader {
  version: 1;
  systemPrompt: string;
  model: string;
}

/** Session file: header + message lines. */
export interface LoadedSession {
  header: SessionHeader;
  messages: Message[];
}

/** Append messages to the session file (a minimal version of Pi JsonlSessionRepo's append semantics). */
export function appendToSession(file: string, header: SessionHeader, messages: Message[]): void {
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
  for (const message of messages) {
    lines.push(JSON.stringify(message));
  }
  writeFileSync(file, lines.join("\n") + "\n", { flag: "a" });
}

/** Restore from the session file (header + messages; returns null if the file doesn't exist). */
export function loadSession(file: string): LoadedSession | null {
  if (!existsSync(file)) {
    return null;
  }
  const lines = readFileSync(file, "utf-8").split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    return null;
  }
  let header: SessionHeader;
  try {
    header = JSON.parse(lines[0]) as SessionHeader;
    if (typeof header?.systemPrompt !== "string" || header?.version !== 1) {
      return null;  // corrupted header (not a session file, or half-written) → can't restore
    }
  } catch {
    return null;
  }
  // Per-line fault tolerance: skip corrupted lines, so one bad line doesn't kill the whole session
  const messages: Message[] = [];
  for (const line of lines.slice(1)) {
    try {
      messages.push(JSON.parse(line) as Message);
    } catch {
      console.warn("Session file has a corrupted line, skipped:", line.slice(0, 60));
    }
  }
  return { header, messages };
}

/** Clear the session file (start a new session). */
export function clearSession(file: string): void {
  writeFileSync(file, "");
}
