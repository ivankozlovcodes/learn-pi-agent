/**
 * Chapter 12 product tool: read_file (read a file; Pi blueprint harness/tools/read.ts, 144 lines in full).
 *
 * Mechanisms aligned with Pi:
 * - parameters schema (Pi readSchema L16-20): path / offset (1-based) / limit
 * - text read + line slicing (Pi L98-114); an out-of-range offset throws (Pi L102-104)
 * - output truncation and a continue hint (Pi truncateHead L116-131: [Showing lines X-Y of N. Use offset=Z to continue.])
 * - a read failure throws (Pi L55 getOrThrow); the Chapter 01 pipeline turns it into an error toolResult
 *
 * Trimmed for teaching:
 * - image reading (Pi L56-95: mime detection + base64 attachment) is not taught; text-only tool
 * - the env abstraction (Pi ExecutionEnv.readBinaryFile, swappable for a remote backend) is simplified to direct fs calls
 * - truncation limits are the teaching choice of 500 lines / 64KB (Pi actually uses DEFAULT_MAX_LINES=2000, DEFAULT_MAX_BYTES=50KB,
 *   harness/utils/truncate.ts L11-12; values chosen for teaching, not Pi's halved)
 */
import { readFile } from "node:fs/promises";
import type { Tool } from "../../../00-minimal-llm-call/src/index.ts";
import { describeError, resolveToolPath } from "./path-utils.ts";

/** Default truncation limits: truncate when either the line count or the byte count is exceeded (teaching subset of Pi DEFAULT_MAX_LINES / DEFAULT_MAX_BYTES). */
export const READ_MAX_LINES = 500;
export const READ_MAX_BYTES = 64 * 1024;

/** Create the read_file tool (Pi createReadTool, harness/tools/read.ts). */
export function createReadFileTool(cwd: string): Tool<{ path: string; offset?: number; limit?: number }> {
  return {
    name: "read_file",
    description:
      "Read the contents of a (text) file. Use offset/limit to slice by line; overly long output is truncated with a hint for the offset to continue from. A read failure returns an error result.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to read (relative or absolute)" },
        offset: { type: "number", description: "Line number to start from (1-based, defaults to line 1)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
    async execute(args) {
      const absolutePath = resolveToolPath(cwd, args.path);
      let content: string;
      try {
        content = await readFile(absolutePath, "utf-8");
      } catch (error) {
        throw new Error(`Cannot read file: ${args.path} (${describeError(error)})`);
      }
      const allLines = content.split("\n");
      const startLine = args.offset ? Math.max(0, args.offset - 1) : 0;
      const startLineDisplay = startLine + 1;
      if (startLine >= allLines.length) {
        throw new Error(`Offset ${args.offset} is beyond end of file (${allLines.length} lines total)`);
      }
      const endLine = args.limit !== undefined ? Math.min(startLine + args.limit, allLines.length) : allLines.length;
      const selected = allLines.slice(startLine, endLine);
      const { text, truncated, keptLines } = truncateHead(selected);

      let output = text;
      if (truncated) {
        const shownEnd = startLineDisplay + keptLines - 1;
        output += `\n\n[Showing lines ${startLineDisplay}-${shownEnd} of ${allLines.length} (limit ${READ_MAX_LINES} lines / ${READ_MAX_BYTES / 1024}KB). Use offset=${shownEnd + 1} to continue.]`;
      } else if (args.limit !== undefined && endLine < allLines.length) {
        output += `\n\n[${allLines.length - endLine} more lines in file. Use offset=${endLine + 1} to continue.]`;
      }
      return {
        content: output,
        details: truncated
          ? { truncation: { truncated: true, outputLines: keptLines, totalLines: allLines.length } }
          : undefined,
      };
    },
  };
}

/** Head truncation: keep the head when either the line count or the byte count is exceeded (teaching subset of Pi utils/truncate.ts truncateHead). */
function truncateHead(lines: string[]): { text: string; truncated: boolean; keptLines: number } {
  let bytes = 0;
  let kept = 0;
  for (const line of lines) {
    const lineBytes = new TextEncoder().encode(line).length + 1; // +1 for the newline
    if (kept >= READ_MAX_LINES || bytes + lineBytes > READ_MAX_BYTES) break;
    bytes += lineBytes;
    kept++;
  }
  const truncated = kept < lines.length;
  return { text: lines.slice(0, kept).join("\n"), truncated, keptLines: kept };
}
