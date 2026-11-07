/**
 * Shared helpers for the Chapter 12 product tools: path resolution (Pi blueprint harness/tools/path-utils.ts resolveToolPath).
 *
 * Product tools are constructed with the project root (cwd) (same as Pi createGrepTool(cwd) / createBashTool(cwd)):
 * relative paths resolve against cwd, absolute paths are used as-is.
 */
import { resolve } from "node:path";

/** Resolve a path from tool arguments: relative paths against cwd, absolute paths as-is (Pi resolveToolPath). */
export function resolveToolPath(cwd: string, inputPath: string): string {
  return resolve(cwd, inputPath);
}

/** Error object → readable description (Node system errors carry a code, e.g. ENOENT). */
export function describeError(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    return `error code ${(error as NodeJS.ErrnoException).code}`;
  }
  return error instanceof Error ? error.message : String(error);
}
