/**
 * Chapter 01 delta: Tool Calling, a minimal Agent Loop built on the Chapter 00 shared base.
 *
 * End-to-end streaming (Pi shape): the LLM interface is always an event stream (Chapter 00 shared base); this chapter **only cares about the final result**:
 * it consumes stream events but ignores deltas (start/delta are skipped, done gives the snapshot); deltas are first consumed in Chapter 03.
 *
 * Corresponds to the inner loop of Pi `runLoop` (agent-loop.ts L155-275). Trimmed for teaching:
 * - event model (AgentEvent) → Chapter 02
 * - termination ① error/aborted, newMessages semantics, truncation protection → Chapter 02
 * - steering/follow-up, parallel, hooks → Chapters 06/05/04
 * - AbortSignal pass-through (the loop takes no signal) → Chapter 02
 *
 * This chapter returns the **full history** (a copy of context.messages); Pi returns the newMessages added in this run (L103).
 * That semantics arrives in Chapter 02 ("what should the return value be" is a Chapter 02 teaching point).
 */
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentContext, AssistantMessage, Message, Tool, ToolCall } from "../../00-minimal-llm-call/src/index.ts";

/** agent_loop entry arguments. */
export interface AgentLoopOptions {
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: Tool[];
  llm: LLMAdapter;
}

/**
 * Minimal agent loop: alternate between the LLM and tools until the model stops requesting tools.
 * Returns the full session history (newMessages semantics deferred to Chapter 02).
 */
export async function agentLoop({ model, systemPrompt, messages, tools, llm }: AgentLoopOptions): Promise<Message[]> {
  const context: AgentContext = { systemPrompt, messages: [...messages], tools };

  let hasMoreToolCalls = true;
  while (hasMoreToolCalls) {
    // Consume the streaming interface: take only the done snapshot (simplified Pi streamAssistantResponse L317-361; deltas are handled from Chapter 03)
    let assistantMessage: AssistantMessage | null = null;
    for await (const event of llm.complete(
      { model, systemPrompt: context.systemPrompt, messages: context.messages, tools: context.tools ?? [] },
    )) {
      if (event.type === "done") {
        assistantMessage = event.partial;
        break;
      }
    }
    // Teaching guard: the Chapter 00 adapter always ends with done, so this branch is unreachable in practice (Pi has no such guard; it wraps up via response.result())
    if (!assistantMessage) {
      throw new Error("LLM stream ended without a done event");
    }
    context.messages.push(assistantMessage);

    const toolCalls = assistantMessage.toolCalls ?? [];
    hasMoreToolCalls = false;

    if (toolCalls.length > 0) {
      // Sequential execution (hooks/validation in Chapter 03; parallel in Chapter 04)
      for (const toolCall of toolCalls) {
        context.messages.push(await executeToolCall(context, toolCall));
      }
      hasMoreToolCalls = true;
    }
  }

  return context.messages;
}

/**
 * Execute a single tool call and build the toolResult message.
 * Corresponds to Pi `prepareToolCall` (L600-668, L607 lookup / L608-614 not found)
 * + `executePreparedToolCall` (L670-711, L701-707 exception to error result)
 * + `createToolResultMessage` (L777-791).
 */
async function executeToolCall(context: AgentContext, toolCall: ToolCall): Promise<Message> {
  const tool = context.tools?.find((t) => t.name === toolCall.name);
  if (!tool) {
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      text: `Tool ${toolCall.name} not found`,
      isError: true,
    };
  }

  try {
    const result = await tool.execute(toolCall.arguments);
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      text: result.content ?? "",  // Pi createToolResultMessage L782-784: content ?? []; null never reaches history/provider
      isError: false,
    };
  } catch (error) {
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      text: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}
