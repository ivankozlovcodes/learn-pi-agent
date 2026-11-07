/**
 * Case 1: Permission Gate (the extension version of the official "No permission popups").
 * Pi anchor: examples/extensions/permission-gate.ts (34 lines in full).
 *
 * The official No list, verbatim (coding-agent README L503):
 * "No permission popups. Run in a container, or build your own confirmation flow with extensions."
 *
 * Pi mechanism (permission-gate.ts): dangerous-pattern matching (three regexes at L11) → on("tool_call") blocks bash
 * (L13-33) → block by default without a UI (L20-23), user choice with a UI (L25-29).
 * Teaching version: hasUI=false (TUI is outside the allowlist), the decision is abstracted into a pure function decidePermission (testable),
 * and the allow path is covered by the allow parameter (simulating user confirmation).
 */
import type { ExtensionAPI } from "../../10-extension-runtime/src/extension-api.ts";

/** Dangerous command patterns (Pi permission-gate.ts L11). */
export const DANGEROUS_PATTERNS = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];

/** Pure function: whether a command matches a dangerous pattern. */
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

/** Pure function: allow/block decision (Pi L19-30 semantics: deny by default without a UI; allow simulates user confirmation). */
export function decidePermission(command: string, allow: boolean): { block: boolean; reason?: string } {
  if (!isDangerousCommand(command)) return { block: false };
  if (allow) return { block: false };
  return { block: true, reason: "Dangerous command blocked (permission-gate: no UI confirmation, denied by default)" };
}

/** Extension factory: block dangerous bash commands (teaching hasUI=false, dangerous means blocked). */
export default function (pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    if (event.toolCall.name !== "bash") return undefined;
    const command = String((event.args as { command?: unknown }).command ?? "");
    const verdict = decidePermission(command, false);
    return verdict.block ? { block: true, reason: verdict.reason } : undefined;
  });
}
