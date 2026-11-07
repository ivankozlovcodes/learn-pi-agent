/**
 * Chapter 10 wiring: plug the ExtensionRunner into the Core's moments (a teaching version of Pi's bridge).
 *
 * Pi's bridge lives in two places: sdk.ts wires transformContext → emitContext (L362-367);
 * agent-session.ts `_installAgentToolHooks` (L486-522) wires beforeToolCall → emitToolCall (L487-494)
 * and afterToolCall → emitToolResult (L508-511); AgentSession forwards agent events to the runner (Observe).
 * The teaching version wires only three hooks:
 *
 * - beforeToolCall → emitToolCall (Intercept: block means blocked; batch termination semantics are handled by Chapter 03)
 * - transformContext → emitContext (Inject: extensions can rewrite the context sent to the model)
 * - loadTools → load dynamically from the runner's registry (the addedToolNames protocol field is declared by the wrapper;
 *   the Chapter 07 loop baseline doesn't consume that field)
 *
 * Observe (event forwarding) is wired by hand via agent.subscribe in the demo/tests (in Pi, the assembly layer does it too).
 */
import type { AgentLoopConfig } from "../../00-minimal-llm-call/src/index.ts";
import type { ExtensionRunner } from "./runner.ts";

/** Extension-aware loop config (the returned hooks can go straight into AgentLoopConfig). */
export function createExtensionAwareConfig(runner: ExtensionRunner): {
  beforeToolCall: NonNullable<AgentLoopConfig["beforeToolCall"]>;
  transformContext: NonNullable<AgentLoopConfig["transformContext"]>;
  loadTools: NonNullable<AgentLoopConfig["loadTools"]>;
} {
  return {
    beforeToolCall: async (ctx) => {
      const verdict = await runner.emitToolCall({
        assistantMessage: ctx.assistantMessage,
        toolCall: ctx.toolCall,
        args: ctx.args,
      });
      return verdict?.block ? { block: true, reason: verdict.reason } : undefined;
    },
    transformContext: async (messages) => runner.emitContext(messages),
    loadTools: (names) => runner.getRegisteredTools().filter((t) => names.includes(t.name)),
  };
}

/** Event forwarding: Agent events → runner (Observe capability; a teaching version of Pi AgentSession._handleAgentEvent). */
export function forwardAgentEvents(runner: ExtensionRunner): (event: { type: string; [key: string]: unknown }) => void {
  return (event) => {
    switch (event.type) {
      case "message_end":
        void runner.emit("message_end", { message: event.message as never });
        break;
      case "turn_end":
        void runner.emit("turn_end", { message: event.message as never, toolResults: event.toolResults as never });
        break;
      default:
        break;
    }
  };
}
