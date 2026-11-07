/**
 * Chapter 12 product tool: write_file (write a file; Pi blueprint harness/tools/write.ts, 39 lines in full).
 *
 * Mechanisms aligned with Pi:
 * - parameters schema (Pi writeSchema L8-11): path / content
 * - parent directories are created automatically (Pi description text: Automatically creates parent directories; env.writeFile semantics)
 * - the success receipt carries the byte count (Pi L33: Successfully wrote ${content.length} bytes to ${path})
 * - a write failure throws; the Chapter 01 pipeline turns it into an error toolResult
 *
 * Trimmed for teaching:
 * - the concurrent file write queue (Pi withFileMutationQueue, file-mutation-queue.ts, 56 lines in full) is not taught;
 *   the simplified teaching environment avoids concurrent writes to the same path on its own (demo/tests run sequentially)
 * - the env abstraction (Pi ExecutionEnv.writeFile) is simplified to direct fs calls
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool } from "../../../00-minimal-llm-call/src/index.ts";
import { describeError, resolveToolPath } from "./path-utils.ts";

/** Create the write_file tool (Pi createWriteTool, harness/tools/write.ts). */
export function createWriteFileTool(cwd: string): Tool<{ path: string; content: string }> {
  return {
    name: "write_file",
    description: "Write content to a file. Creates the file if it doesn't exist, overwrites it if it does. Automatically creates parent directories.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to write (relative or absolute)" },
        content: { type: "string", description: "Full content to write" },
      },
      required: ["path", "content"],
    },
    async execute(args) {
      const absolutePath = resolveToolPath(cwd, args.path);
      try {
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, args.content, "utf-8");
      } catch (error) {
        throw new Error(`Cannot write file: ${args.path} (${describeError(error)})`);
      }
      return { content: `Successfully wrote ${args.content.length} bytes to ${args.path}` };
    },
  };
}
