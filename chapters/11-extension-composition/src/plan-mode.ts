/**
 * Case 2: Plan Mode (the extension version of the official "No plan mode").
 * Pi anchor: examples/extensions/plan-mode/ (index.ts 390 lines + utils.ts 168 lines).
 *
 * The official No list, verbatim (coding-agent README L505):
 * "No plan mode. Write plans to files, or build it with [extensions], or install a package."
 *
 * Pi mechanism:
 * - bash allowlist check (utils.ts isSafeCommand L97-101: the denylist DESTRUCTIVE_PATTERNS L7-41
 *   takes priority, and only the allowlist SAFE_PATTERNS L44-95 lets a command through)
 * - /plan command toggle (index.ts L141-144 registerCommand) + setActiveTools tool switch
 *   (L104-114: save toolsBeforePlanMode on entry; plan mode disables mutation tools and adds read-only tools)
 * - tool_call block (L164-174: bash commands outside the allowlist are blocked)
 * - read-only context injection (teaching uses the context event at call time; Pi uses before_agent_start to inject
 *   a persistent [PLAN MODE ACTIVE] custom message L201-228)
 *
 * Teaching subset: allowlist check + /plan toggle (the Chapter 10 ctx.setActiveTools action, writing the running
 * agent.state.tools) + tool_call block + context injection.
 * Not taught: UI widget/status (L59-84), extractTodoItems/[DONE:n] plan tracking, registerShortcut/Flag,
 * questionnaire, appendEntry state persistence, system prompt rebuild (a side effect of Pi setActiveToolsByName).
 */
import type { ExtensionAPI } from "../../10-extension-runtime/src/extension-api.ts";

/** Destructive patterns (teaching subset of Pi plan-mode/utils.ts L7-41). */
const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bsudo\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bgit\s+(add|commit|push|reset|checkout)/i,
];

/** Read-only safe commands (teaching subset of Pi plan-mode/utils.ts L44-95). */
const SAFE_PATTERNS = [
  /^\s*cat\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*grep\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*find\b/,
];

/** Pure function: whether a command is on the allowlist (Pi utils.ts isSafeCommand L97-101). */
export function isSafeCommand(command: string): boolean {
  return !DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command)) && SAFE_PATTERNS.some((pattern) => pattern.test(command));
}

/** Plan mode tool set (teaching subset of Pi PLAN_MODE_TOOLS L22: the minimal set enough for read-only exploration; delegating research to a subagent is a read-only operation). */
export const PLAN_MODE_TOOLS = ["bash", "calculator", "subagent"];

/** Mutation tools disabled by default (teaching subset of Pi PLAN_MODE_DISABLED_TOOLS L24: the only write tool in this baseline is Chapter 10's delete_file). */
const DEFAULT_DISABLED_TOOL_NAMES = ["delete_file"];

/** Factory options: teaching fixtures can inject extra disabled tool names (tests use write_fixture; in Pi it is a hardcoded constant). */
export interface PlanModeOptions {
  disabledToolNames?: string[];
}

/** Extension factory: /plan toggle + bash allowlist block + read-only context injection. */
export default function (pi: ExtensionAPI, options: PlanModeOptions = {}): void {
  let enabled = false;
  let toolsBeforePlanMode: string[] | undefined;
  const disabledToolNames = new Set([...DEFAULT_DISABLED_TOOL_NAMES, ...(options.disabledToolNames ?? [])]);

  /** Plan mode tool set = current active tools minus disabled tools + added read-only tools (Pi getPlanModeTools L90-95). */
  function computePlanTools(activeToolNames: string[]): string[] {
    return [...new Set([...activeToolNames.filter((name) => !disabledToolNames.has(name)), ...PLAN_MODE_TOOLS])];
  }

  pi.registerCommand("plan", {
    description: "Toggle plan mode (read-only exploration)",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (enabled) {
        // Enter: dynamically save the current tool set and switch to the read-only subset (Pi L104-109: save toolsBeforePlanMode + setActiveTools)
        toolsBeforePlanMode = ctx.getActiveTools();
        ctx.setActiveTools(computePlanTools(toolsBeforePlanMode));
      } else {
        // Exit: restore the tool set from before entry (Pi restoreNormalModeTools L111-114; leave the tool set alone if nothing was saved)
        ctx.setActiveTools(toolsBeforePlanMode ?? ctx.getActiveTools());
        toolsBeforePlanMode = undefined;
      }
      console.log(`[plan] ${enabled ? "Read-only mode on (mutation tools disabled)" : "Read-only mode off"}`);
    },
  });

  pi.on("tool_call", async (event) => {
    if (!enabled || event.toolCall.name !== "bash") return undefined;
    const command = String((event.args as { command?: unknown }).command ?? "");
    if (!isSafeCommand(command)) {
      return { block: true, reason: `Plan mode: command not on the allowlist (${command}). Turn off read-only mode with /plan before executing.` };
    }
    return undefined;
  });

  // Read-only exploration context injection (teaching simplification of Pi's before_agent_start [PLAN MODE ACTIVE] injection: uses the context event, call-time, not persisted)
  pi.on("context", async ({ messages }) => {
    if (!enabled) return undefined;
    return [
      ...messages,
      { role: "user" as const, text: "[PLAN MODE ACTIVE] Read-only exploration mode: you cannot modify files. Research first, then output a numbered Plan: section." },
    ];
  });
}
