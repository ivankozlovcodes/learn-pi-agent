/**
 * Minimal teaching bash tool (the target that Chapter 11's cases block; the full product tool set is in Chapter 12).
 *
 * Design point: the bash tool itself is **unguarded** (it executes any command). That is exactly the teaching point:
 * permission policy lives not in the tool but in extensions (permission-gate / plan-mode block before execute).
 * Dangerous commands (rm -rf etc.) never really execute in teaching: the demo/tests only send safe commands, and dangerous commands are always blocked.
 */
import { execFileSync } from "node:child_process";
import type { Tool } from "../../00-minimal-llm-call/src/index.ts";

/** Create the bash tool (a minimal teaching version of Pi harness/tools/bash.ts; Chapter 12 builds the full version). */
export function createBashTool(): Tool<{ command: string }> {
  return {
    name: "bash",
    description: "Execute a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The command to execute" } },
      required: ["command"],
    },
    async execute(args) {
      const stdout = execFileSync("/bin/sh", ["-c", args.command], { encoding: "utf-8", timeout: 5000 });
      return { content: stdout.trim() || "(no output)" };
    },
  };
}
