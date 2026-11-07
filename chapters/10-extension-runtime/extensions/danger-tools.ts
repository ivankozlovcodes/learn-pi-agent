/**
 * Teaching extension: a set of dangerous tools (the demo target that guard blocks).
 * delete_file: deletes a single file (a temp file for the demo); it doesn't run when guard's tool_call hook blocks it.
 * Note: it deletes only a single file, not recursively; after guard blocks it, execute never fires.
 */
import { rm } from "node:fs/promises";
import type { ExtensionAPI } from "../src/extension-api.ts";

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "delete_file",
    description: "Delete the given file (dangerous operation; guard blocks it)",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Path of the file to delete" } },
      required: ["path"],
    },
    async execute(args) {
      const path = String(args.path);
      await rm(path, { force: true });
      return { content: `Deleted ${path}` };
    },
  });
}
