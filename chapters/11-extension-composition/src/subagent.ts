/**
 * Case 3: Subagent (the extension version of the official "No sub-agents").
 * Pi anchor: examples/extensions/subagent/ (index.ts 1038 lines: spawn an independent pi process L346,
 * registerTool L472; agents/ planner/reviewer/scout/worker + prompts/ implement etc.).
 *
 * The official No list, verbatim (coding-agent README L501):
 * "No sub-agents. There's many ways to do this. Spawn pi instances via tmux, or build your own with extensions."
 *
 * Pi mechanism: every subagent call spawns an independent pi process (independent context window), supporting
 * three modes, Single/Parallel/Chain (L346 spawn, L472 registerTool); a child failure (abnormal exitCode/
 * stopReason) → the parent receives an isError ToolResult (L701-708).
 * Teaching subset: within the same process, use the Chapter 07 Agent + an independent TreeSession to simulate "another agent" (independent context),
 * and send the result back to the main agent. Process management (spawn/tmux/JSON mode/parallel and chain) is not taught, only outlined.
 * Teaching simplifications: llm/systemPrompt/tools hang off ctx.config (the Reconfigure extensible field);
 * a child failure is detected via 07 AgentState.errorMessage and then thrown → isError (aligned with Pi semantics);
 * abort has no public seam, so signal.aborted is only checked at the entry and completion boundaries (Pi uses child-process SIGTERM/SIGKILL).
 */
import { AnthropicLlmAdapter, createCalculatorTool } from "../../00-minimal-llm-call/src/index.ts";
import type { LLMAdapter, Tool } from "../../00-minimal-llm-call/src/index.ts";
import { Agent } from "../../07-session-tree/src/agent.ts";
import { TreeSession } from "../../07-session-tree/src/session-tree.ts";
import type { ExtensionAPI } from "../../10-extension-runtime/src/extension-api.ts";

/** Subagent config: hangs off the extensible field of ctx.config (Reconfigure capability; teaching simplification). */
export interface SubagentConfig {
  llm?: LLMAdapter;
  systemPrompt?: string;
  tools?: Tool[];
}

/** Extension factory: register the subagent delegation tool. */
export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent",
    description: "Delegate a task to a subagent that executes independently (independent context window) and return its final reply",
    parameters: {
      type: "object",
      properties: { task: { type: "string", description: "The task to delegate to the subagent" } },
      required: ["task"],
    },
    async execute(args, ctx, _onUpdate, signal) {
      if (signal?.aborted) throw new Error("Subagent execution aborted");
      const task = String(args.task);
      const config = ctx.config as unknown as SubagentConfig;
      const llm = config.llm ?? new AnthropicLlmAdapter();

      // Independent session tree: the subagent's context is fully isolated from the main session (Pi: an independent pi process)
      const subSession = new TreeSession();
      const subAgent = new Agent({
        systemPrompt: config.systemPrompt ?? "You are a subagent. Focus on completing the delegated task and keep your answer concise.",
        tools: config.tools ?? [createCalculatorTool()],
        llm,
        config: { model: ctx.config.model },
      });
      subAgent.subscribe((event) => {
        if (event.type === "message_end") {
          subSession.appendMessage(event.message);
        }
      });

      await subAgent.prompt(task);
      // Pi: abnormal child exitCode/stopReason → the parent receives an isError ToolResult (index.ts L701-708).
      // Teaching: the 07 Agent has no public abort seam, so cancellation mid-run does not propagate to the child run;
      // signal.aborted is only checked at the entry and completion boundaries; a child failure is detected via 07 AgentState.errorMessage
      // and then thrown, taking the error-result path (the 00 shared base ToolResult has no isError field; throw is the only isError channel).
      if (signal?.aborted) throw new Error("Subagent execution aborted");
      const failure = subAgent.state.errorMessage;
      if (failure) {
        throw new Error(`Subagent execution failed: ${failure}`);
      }
      const reply = subAgent.state.messages.at(-1)?.text ?? "(no reply)";
      return {
        content: `Subagent reply: ${reply}`,
        details: { task, subMessages: subSession.getEntries().length, subLeaf: subSession.getLeafId() },
      };
    },
  });
}
