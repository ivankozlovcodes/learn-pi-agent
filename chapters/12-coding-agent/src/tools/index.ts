/**
 * Chapter 12 product toolset registration (the assembly view of Pi blueprint coding-agent/src/core/tools/index.ts createAllToolDefinitions).
 *
 * Five real tools:
 * - read_file (Pi harness/tools/read.ts): read a file
 * - write_file (Pi harness/tools/write.ts): write a file
 * - edit (Pi harness/tools/edit.ts): targeted string replacement
 * - grep (Pi coding-agent/src/core/tools/grep.ts): search file contents, product layer only
 * - bash (Pi harness/tools/bash.ts + coding-agent core/tools/bash.ts): execute commands
 *
 * Tool layering teaching point: read/write/edit/bash live in the harness layer of the agent package (with an env abstraction, swappable backend);
 * grep lives only in the coding-agent product layer (a product tool that depends on ripgrep). The teaching versions of all five go straight to fs and
 * child_process; README §4 explains the layering difference.
 */
import type { Tool } from "../../../00-minimal-llm-call/src/index.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createGrepTool } from "./grep.ts";
import { createReadFileTool } from "./read.ts";
import { createWriteFileTool } from "./write.ts";

/** Names of the five product tools (registered into RuntimeConfig.activeTools at assembly time). */
export const PRODUCT_TOOL_NAMES = ["read_file", "write_file", "edit", "grep", "bash"] as const;

/** Create all product tools (teaching version of Pi createAllToolDefinitions; cwd is the project root). */
export function createProductTools(cwd: string): Tool[] {
  return [
    createReadFileTool(cwd),
    createWriteFileTool(cwd),
    createEditTool(cwd),
    createGrepTool(cwd),
    createBashTool(cwd),
  ];
}
