/**
 * Chapter 12 product tool: grep (search file contents; Pi blueprint coding-agent/src/core/tools/grep.ts, 391 lines in full).
 *
 * Tool layering teaching point: grep is not in harness/tools/ (agent package), only in the product layer (coding-agent core/tools/):
 * it is a workflow tool of the Coding Agent product, not a required part of the agent mechanism. This is one of the anchors for Chapter 12's tool layering.
 *
 * Mechanisms aligned with Pi:
 * - parameters schema (Pi grepSchema L24-36): pattern / path / glob / ignoreCase / literal / context / limit
 * - match output format (Pi formatBlock L255-273): `file:line: content`, context lines use `file-line- content`
 * - match limit and hint (Pi L292-296/L344-348): on reaching limit, truncate and suggest refining the pattern
 * - a missing path throws (Pi L186-191: Path not found)
 * - no matches returns a notice text (Pi L314-318: No matches found)
 *
 * Trimmed for teaching:
 * - no ripgrep dependency (Pi spawn rg L226), a pure Node fs recursive scan; per-line truncation (Pi truncateLine
 *   GREP_MAX_LINE_LENGTH) is not taught; respecting .gitignore is simplified to skipping directories like node_modules/.git
 * - glob supports a minimal subset (* and ** wildcards); the full glob syntax Pi passes through to ripgrep is not taught
 * - output byte truncation (Pi DEFAULT_MAX_BYTES=50KB, truncate.ts L12): teaching falls back on limit semantics, with no byte truncation
 */
import { basename, join, relative, sep } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import type { Tool } from "../../../00-minimal-llm-call/src/index.ts";
import { describeError, resolveToolPath } from "./path-utils.ts";

/** Default match limit (Pi DEFAULT_LIMIT L44). */
export const GREP_DEFAULT_LIMIT = 100;

/** Teaching simplification: skip these directories (Pi relies on ripgrep respecting .gitignore). */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

/** A single match record. */
interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

/** Create the grep tool (Pi createGrepTool, coding-agent/src/core/tools/grep.ts). */
export function createGrepTool(cwd: string): Tool<{
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}> {
  return {
    name: "grep",
    description:
      "Search file contents for a pattern (regex or literal) and return matching lines (file path:line: content). Skips node_modules and .git.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern (regex or literal string)" },
        path: { type: "string", description: "Directory or file to search (defaults to the current directory)" },
        glob: { type: "string", description: "Filter files by glob, e.g. *.ts or **/*.test.ts" },
        ignoreCase: { type: "boolean", description: "Ignore case (default false)" },
        literal: { type: "boolean", description: "Treat pattern as a literal instead of a regex (default false)" },
        context: { type: "number", description: "Number of lines to show before and after each match (default 0)" },
        limit: { type: "number", description: "Maximum number of matches to return (default 100)" },
      },
      required: ["pattern"],
    },
    async execute(args) {
      const root = resolveToolPath(cwd, args.path ?? ".");
      let isDirectory: boolean;
      try {
        const info = await stat(root);
        isDirectory = info.isDirectory();
        if (!isDirectory && !info.isFile()) {
          throw new Error(`Path is neither a file nor a directory: ${root}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Path is neither")) throw error;
        throw new Error(`Path not found: ${root} (${describeError(error)})`);
      }

      let matcher: RegExp;
      try {
        matcher = compilePattern(args.pattern, args.literal ?? false, args.ignoreCase ?? false);
      } catch (error) {
        throw new Error(`Invalid regex: ${args.pattern} (${describeError(error)})`);
      }
      const globRe = args.glob ? compileGlob(args.glob) : undefined;
      const effectiveLimit = Math.max(1, args.limit ?? GREP_DEFAULT_LIMIT);
      const contextValue = args.context && args.context > 0 ? args.context : 0;

      const matches: GrepMatch[] = [];
      if (isDirectory) {
        await walkDirectory(root, root, matcher, globRe, effectiveLimit, matches);
      } else {
        await searchFile(root, basename(root), matcher, effectiveLimit, matches);
      }
      const limitReached = matches.length >= effectiveLimit;

      const lines = await formatMatches(matches, contextValue, limitReached, effectiveLimit, root);
      return {
        content: lines.length > 0 ? lines.join("\n") : "No matches found",
        details: limitReached ? { matchLimitReached: effectiveLimit } : undefined,
      };
    },
  };
}

/** Compile the search pattern: escape regex metacharacters when literal (teaching equivalent of Pi rg --fixed-strings). */
function compilePattern(pattern: string, literal: boolean, ignoreCase: boolean): RegExp {
  const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
  return new RegExp(source, ignoreCase ? "i" : "");
}

/** Minimal glob compile: * matches any characters within a segment, ** matches across directories (Pi passes the full glob syntax through to ripgrep).
 * Split on split("**") so that replacing * doesn't interfere with **. */
function compileGlob(glob: string): RegExp {
  const source = glob
    .split("**")
    .map((segment) => segment.replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

/** Scan the directory recursively, matching line by line and collecting results (Pi collects via ripgrep streaming; the teaching version walks recursively). */
async function walkDirectory(
  dir: string,
  root: string,
  matcher: RegExp,
  globRe: RegExp | undefined,
  limit: number,
  matches: GrepMatch[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (matches.length >= limit) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkDirectory(full, root, matcher, globRe, limit, matches);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = relative(root, full).split(sep).join("/");
    if (globRe && !globRe.test(rel)) continue;
    await searchFile(full, rel, matcher, limit, matches);
  }
}

/** Search a single file: match line by line, stop early at limit (Pi supports single files too). */
async function searchFile(
  filePath: string,
  relName: string,
  matcher: RegExp,
  limit: number,
  matches: GrepMatch[],
): Promise<void> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return; // Skip unreadable files (e.g. permission denied)
  }
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && matches.length < limit; i++) {
    if (matcher.test(lines[i])) {
      matches.push({ file: relName, line: i + 1, text: lines[i] });
    }
  }
}

/** Format match output: `file:line: content`, context lines use `file-line- content` (Pi formatBlock L255-273). */
async function formatMatches(
  matches: GrepMatch[],
  context: number,
  limitReached: boolean,
  effectiveLimit: number,
  root: string,
): Promise<string[]> {
  const lines: string[] = [];
  const fileCache = new Map<string, string[]>();
  const getLines = async (file: string): Promise<string[]> => {
    let cached = fileCache.get(file);
    if (!cached) {
      cached = (await readFile(join(root, file), "utf-8")).split("\n");
      fileCache.set(file, cached);
    }
    return cached;
  };

  for (const match of matches) {
    if (context === 0) {
      lines.push(`${match.file}:${match.line}: ${match.text}`);
      continue;
    }
    const fileLines = await getLines(match.file);
    const start = Math.max(1, match.line - context);
    const end = Math.min(fileLines.length, match.line + context);
    for (let current = start; current <= end; current++) {
      const text = fileLines[current - 1] ?? "";
      lines.push(current === match.line ? `${match.file}:${current}: ${text}` : `${match.file}-${current}- ${text}`);
    }
  }
  if (limitReached) {
    lines.push(`\n[${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine the pattern]`);
  }
  return lines;
}
