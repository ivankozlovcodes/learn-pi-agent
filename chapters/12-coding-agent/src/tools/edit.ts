/**
 * Chapter 12 product tool: edit (targeted string replacement; Pi blueprint harness/tools/edit.ts, 140 lines in full).
 *
 * Mechanisms aligned with Pi:
 * - parameters schema（Pi editSchema L28-37）：path + edits[]（oldText/newText）
 * - compatibility layer prepareArguments (Pi L55-77): edits given as a JSON string or a single edit object are normalized to an array
 * - semantics (Pi description text): each oldText must match uniquely in the original file, with no overlaps;
 *   all edits are matched against the original file (not incrementally); overlapping/nested edits must be merged
 * - no match / not unique / overlap all throw (Pi L79-84 validate + applyEditsToNormalizedContent) and become an error toolResult
 * - success receipt and details (Pi L130-136: Successfully replaced N block(s) + diff/patch/firstChangedLine)
 *
 * Trimmed for teaching:
 * - the diff pipeline is trimmed entirely: no fuzzy matching (normalizeForFuzzyMatch), unified patch generation,
 *   or BOM/line-ending detection and restore (all of edit-diff.ts); details give only a line-level diff and the first changed line
 * - the concurrent file write queue (Pi withFileMutationQueue) is not taught, same as write_file
 * - the env abstraction (Pi ExecutionEnv.fileInfo/readTextFile) is simplified to direct fs calls
 */
import { readFile, writeFile } from "node:fs/promises";
import type { Tool, ToolParameters } from "../../../00-minimal-llm-call/src/index.ts";
import { describeError, resolveToolPath } from "./path-utils.ts";

/** A single replacement (Pi replaceEditSchema L17-26). */
export interface EditItem {
  oldText: string;
  newText: string;
}

/** edit tool arguments (Pi EditToolInput; a type alias to get an implicit index signature, satisfying the generic constraint of the 00 shared base Tool). */
export type EditInput = {
  path: string;
  edits: EditItem[];
};

/** Match result: one match in the original file. */
interface Match extends EditItem {
  start: number;
}

/** Create the edit tool (Pi createEditTool, harness/tools/edit.ts). */
export function createEditTool(cwd: string): Tool<EditInput> {
  return {
    name: "edit",
    description:
      "Make targeted string replacements in a single file: each edits[].oldText must match uniquely in the original file, with no overlaps; merge two adjacent changes into one edit.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to edit (relative or absolute)" },
        // The 00 shared base ToolParameters is a minimal schema (type/description); array element details are kept via a type assertion
        edits: { type: "array", description: "One or more targeted replacements, each with oldText and newText" },
      },
      required: ["path", "edits"],
    } as ToolParameters,
    prepareArguments(args) {
      return prepareEditArguments(args);
    },
    async execute(args) {
      const { path, edits } = validateEditInput(args);
      const absolutePath = resolveToolPath(cwd, path);
      let content: string;
      try {
        content = await readFile(absolutePath, "utf-8");
      } catch (error) {
        throw new Error(`Cannot edit file: ${path} (${describeError(error)})`);
      }

      // All matched against the original file (Pi: Each edit is matched against the original file, not incrementally)
      const matches = edits.map((edit) => findUniqueMatch(content, edit));
      matches.sort((a, b) => a.start - b.start);
      assertNoOverlap(matches);

      const newContent = applyMatches(content, matches);
      await writeFile(absolutePath, newContent, "utf-8");

      const details = buildDetails(content, matches);
      return {
        content: `Successfully replaced ${matches.length} block(s) in ${path}`,
        details,
      };
    },
  };
}

/** Compatibility layer: normalize edits to an array when given as a JSON string, a single edit object, or top-level oldText/newText (Pi prepareEditArguments L55-77). */
export function prepareEditArguments(input: unknown): EditInput {
  if (!input || typeof input !== "object") {
    return input as EditInput;
  }
  const args = input as Record<string, unknown>;
  let edits: unknown = args.edits;
  if (typeof edits === "string") {
    try {
      const parsed: unknown = JSON.parse(edits);
      if (Array.isArray(parsed) || isSingleEdit(parsed)) edits = parsed;
    } catch {
      // On parse failure keep the original value; validation reports the error
    }
  }
  if (isSingleEdit(edits)) {
    edits = [edits];
  }
  // Legacy top-level arguments (Pi L71-76: legacy.oldText/newText are appended to edits)
  const { oldText, newText, ...rest } = args;
  if (typeof oldText === "string" && typeof newText === "string") {
    const base = Array.isArray(edits) ? [...edits] : [];
    return { ...rest, edits: [...base, { oldText, newText }] } as EditInput;
  }
  return { ...rest, edits } as EditInput;
}

/** A single edit object (legacy arguments without an edits array). */
function isSingleEdit(value: unknown): value is EditItem {
  if (!value || typeof value !== "object") return false;
  const edit = value as Record<string, unknown>;
  return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

/** Validation: path and edits must be valid (Pi validateEditInput L79-84). */
function validateEditInput(input: EditInput): EditInput {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("Invalid edit tool arguments: edits must contain at least one replacement.");
  }
  return input;
}

/** Find a unique match in the original file (Pi: must be unique in the original file). */
function findUniqueMatch(content: string, edit: EditItem): Match {
  if (edit.oldText === "") {
    throw new Error("oldText must not be an empty string");
  }
  const positions: number[] = [];
  let index = content.indexOf(edit.oldText);
  while (index !== -1) {
    positions.push(index);
    index = content.indexOf(edit.oldText, index + 1);
  }
  if (positions.length === 0) {
    throw new Error(`oldText not found: ${preview(edit.oldText)}`);
  }
  if (positions.length > 1) {
    throw new Error(`oldText is not unique (found ${positions.length} matches): ${preview(edit.oldText)}`);
  }
  return { ...edit, start: positions[0] };
}

/** Overlap check: a later match must not start inside the previous one's range (Pi: Do not include overlapping or nested edits). */
function assertNoOverlap(matches: Match[]): void {
  for (let i = 1; i < matches.length; i++) {
    const prev = matches[i - 1];
    if (matches[i].start < prev.start + prev.oldText.length) {
      throw new Error("edits overlap or are nested; merge them into one edit");
    }
  }
}

/** Apply all matches (join original file segments and new text in position order). */
function applyMatches(content: string, matches: Match[]): string {
  let result = "";
  let cursor = 0;
  for (const match of matches) {
    result += content.slice(cursor, match.start) + match.newText;
    cursor = match.start + match.oldText.length;
  }
  return result + content.slice(cursor);
}

/** Line-level diff and first changed line (teaching subset of Pi generateDiffString/generateUnifiedPatch). */
function buildDetails(content: string, matches: Match[]): { diff: string; firstChangedLine: number } {
  const diffLines: string[] = [];
  for (const match of matches) {
    for (const line of match.oldText.split("\n")) diffLines.push(`- ${line}`);
    for (const line of match.newText.split("\n")) diffLines.push(`+ ${line}`);
  }
  const firstChangedLine = content.slice(0, matches[0].start).split("\n").length;
  return { diff: diffLines.join("\n"), firstChangedLine };
}

/** Preview of a matched snippet (long text truncated). */
function preview(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
