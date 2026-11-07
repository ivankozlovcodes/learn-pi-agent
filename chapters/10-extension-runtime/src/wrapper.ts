/**
 * Chapter 10 core: extension tool wrapping (a replica of the whole 45-line Pi wrapper.ts).
 *
 * Two jobs:
 * 1. ctx injection: adapt an extension tool's execute(..., ctx) to the 00 shared base Tool's execute(args, onUpdate, signal);
 *    ctx is taken from runner.createContext() at call time (Pi wrapper.ts L17-18: wrapToolDefinition(() => runner.createContext()));
 * 2. addedToolNames linkage: compare runner.getActiveTools() before and after execute, and merge newly added tool names into the result
 *    (Pi wrapper.ts L22-35: when an extension tool changes the active tools during execution, the result automatically declares "available from this message on",
 *    connecting to the Chapter 09 addedToolNames mechanism: 09 is a data-level declaration, 10 is a runtime-level capture).
 */
import type { Tool, ToolResult } from "../../00-minimal-llm-call/src/index.ts";
import type { ExtensionTool } from "./extension-api.ts";
import type { ExtensionRunner } from "./runner.ts";

/** Wrap a single extension tool (Pi wrapRegisteredTool, wrapper.ts L17-37). */
export function wrapRegisteredTool(registeredTool: ExtensionTool, runner: ExtensionRunner): Tool {
  return {
    name: registeredTool.name,
    description: registeredTool.description,
    parameters: registeredTool.parameters,
    async execute(args: Record<string, unknown>, onUpdate?: (partial: ToolResult) => void, signal?: AbortSignal) {
      const activeBefore = runner.getActiveTools();
      const result = await registeredTool.execute(args, runner.createContext(), onUpdate, signal);
      const activeAfter = runner.getActiveTools();
      // Pi wrapper.ts L26 guard: if any tool was removed, don't report additions (suppress addedToolNames when adds and removes happen together)
      if (!activeBefore.every((name) => activeAfter.includes(name))) {
        return result;
      }
      // New tools the extension introduced via ctx.setActiveTools during execute → merged into the result (Pi wrapper.ts L27-34)
      const beforeNames = new Set(activeBefore);
      const addedToolNames = activeAfter.filter((name) => !beforeNames.has(name));
      if (addedToolNames.length === 0) {
        return result;
      }
      return {
        ...result,
        addedToolNames: [...new Set([...(result.addedToolNames ?? []), ...addedToolNames])],
      };
    },
  };
}

/** Wrap all extension tools (Pi wrapRegisteredTools, wrapper.ts L43-45). */
export function wrapRegisteredTools(registeredTools: ExtensionTool[], runner: ExtensionRunner): Tool[] {
  return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}
