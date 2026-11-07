/**
 * Chapter 10 core: the extension loader (teaching subset of Pi loader.ts).
 *
 * Pi's discovery logic (loader.ts): resolveExtensionEntries checks the pi.extensions field in package.json
 * or an index.ts entry (around L758); loadExtensions (L648) dynamically imports each file, and the default export is the extension factory.
 * Teaching simplification: every .ts/.js file in the directory is an extension entry (package.json field discovery is not covered).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionFactory } from "./extension-api.ts";

/** Load all extension factories from a directory (a simplified teaching version of Pi loadExtensions L648).
 *
 * Failure isolation (Pi collects errors per path and keeps loading; teaching version of loader.ts L566-588):
 * if a single file fails to import or its default export isn't a function, just warn and skip; the other extensions survive.
 * Failure isolation while a factory runs lives in runner.load's staging registry (commit/discard).
 */
export async function loadExtensionsFromDir(dir: string): Promise<ExtensionFactory[]> {
  const factories: ExtensionFactory[] = [];
  const entries = readdirSync(dir).sort();
  for (const name of entries) {
    if (!name.endsWith(".ts") && !name.endsWith(".js")) continue;
    try {
      const mod = await import(pathToFileURL(join(dir, name)).href);
      const factory = mod.default as unknown;
      if (typeof factory === "function") {
        factories.push(factory as ExtensionFactory);
      } else {
        // Pi reports a loader error for a non-function default export (loader.ts L578-580); the teaching version skips + warns
        console.warn(`Extension file ${name}: default export is not a function, skipping`);
      }
    } catch (error) {
      console.warn(`Extension file ${name} failed to load, skipping:`, error instanceof Error ? error.message : String(error));
    }
  }
  return factories;
}
