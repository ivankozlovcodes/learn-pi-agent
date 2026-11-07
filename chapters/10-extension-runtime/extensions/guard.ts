/**
 * Teaching extension: the guard block (Intercept capability).
 * Subscribes to the tool_call event and blocks the dangerous tool (delete_file) outright (a minimal version of Pi permission-gate;
 * the full case is in Chapter 11 Extension Composition).
 */
import type { ExtensionAPI } from "../src/extension-api.ts";

export default function (pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    if (event.toolCall.name === "delete_file") {
      return { block: true, reason: "guard extension: deleting files is not allowed (dangerous operation)" };
    }
    return undefined;
  });
}
