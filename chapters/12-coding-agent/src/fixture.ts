/**
 * Chapter 12 E2E temp project helper: copy fixture/ to the system temp directory.
 *
 * Why copy: the E2E scenarios (demo and tests) really modify project files (edit fixes the bug, npm test validates).
 * Editing the in-repo fixture directly would pollute the working tree; copying to a temp directory makes every run start from a clean state.
 */
import { cpSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** fixture directory (in-repo template, read-only). */
export const FIXTURE_DIR = fileURLToPath(new URL("../fixture/", import.meta.url));
const WORKSPACE_NODE_MODULES = fileURLToPath(new URL("../../../node_modules/", import.meta.url));

/** Copy the fixture to a temp directory and return the temp project root path. */
export function copyFixtureToTemp(): string {
  const dest = join(tmpdir(), `lpia-ch12-fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  cpSync(FIXTURE_DIR, dest, { recursive: true });
  mkdirSync(join(dest, "node_modules"), { recursive: true });
  symlinkSync(WORKSPACE_NODE_MODULES, join(dest, "node_modules", "workspace"), "dir");
  symlinkSync(join(WORKSPACE_NODE_MODULES, "tsx"), join(dest, "node_modules", "tsx"), "dir");
  symlinkSync(join(WORKSPACE_NODE_MODULES, "esbuild"), join(dest, "node_modules", "esbuild"), "dir");
  return dest;
}
