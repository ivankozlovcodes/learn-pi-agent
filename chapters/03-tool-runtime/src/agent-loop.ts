/**
 * Chapter 03 delta: Agent Runtime + Tool Runtime.
 *
 * Changes since Chapter 02 (all anchored to Pi):
 * - Tool execution goes from "find it and call it" to a five-step pipeline (see tool-runtime.ts)
 * - `tool_execution_start/update/end` events: completes the four-kind event model (L441-450/L767-775)
 * - **Batch Termination**: tool results carry a `terminate` hint, and the loop stops only when the **whole** batch terminates
 *   (Pi `shouldTerminateToolBatch` L582-584; semantics: terminate is "suggest stopping", not "order to stop")
 * - Hooks: `beforeToolCall` (L619-647) / `afterToolCall` (L724-751); hooks are boundaries (Philosophy 3)
 *
 * Trimmed for teaching (chapter ownership): parallel execution → 04, steering/follow-up → 05, transform/stop hooks → 06.
 */
import { EventStream, type LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AssistantMessage, AssistantMessageEvent, Message, ToolCall } from "../../00-minimal-llm-call/src/index.ts";
import { executeToolCall, type ToolExecutionOutcome } from "./tool-runtime.ts";

/** Event output (same as the previous chapter). */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** Top-level entry: EventStream wrapper (same as Chapter 02, Pi L31-54 + L145-150). */
export function agentLoop(
  prompts: Message[],
  context: AgentContext,
  config: AgentLoopConfig,
  llm: LLMAdapter,
  signal?: AbortSignal,
): EventStream<AgentEvent, Message[]> {
  const stream = new EventStream<AgentEvent, Message[]>(
    (event) => event.type === "agent_end",
    (event) => (event.type === "agent_end" ? event.messages : []),
  );

  void runAgentLoop(prompts, context, config, llm, (event) => stream.push(event), signal)
    .then((messages) => {
      stream.end(messages);
    })
    .catch((error: unknown) => {
      console.error("agent run failed:", error instanceof Error ? error.message : String(error));
      stream.end([]);
    });

  return stream;
}

/** Start one agent run (same as Chapter 02). */
export async function runAgentLoop(
  prompts: Message[],
  context: AgentContext,
  config: AgentLoopConfig,
  llm: LLMAdapter,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<Message[]> {
  // Empty prompts guard — use runAgentLoopContinue to continue (Pi L120-143); an empty array makes the LLM continue without a prompt or return 400
  if (prompts.length === 0) {
    throw new Error("prompts must not be empty: to continue an existing session, use continue semantics (Chapter 07 runAgentLoopContinue)");
  }
  const newMessages: Message[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    // Snapshot: message event payloads are always shallow copies, so consumer changes don't affect the internal history
    await emit({ type: "message_start", message: { ...prompt } });
    await emit({ type: "message_end", message: { ...prompt } });
  }

  await runLoop(currentContext, newMessages, config, llm, emit, signal);
  return newMessages;
}

/** Main loop: a single-level loop (Pi inner loop L174-260, steering trimmed). */
async function runLoop(
  context: AgentContext,
  newMessages: Message[],
  config: AgentLoopConfig,
  llm: LLMAdapter,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<void> {
  let hasMoreToolCalls = true;
  let firstTurn = true;  // Pi L175-179: the first turn_start is emitted by runAgentLoop

  while (hasMoreToolCalls) {
    if (firstTurn) {
      firstTurn = false;
    } else {
      await emit({ type: "turn_start" });
    }

    const assistantMessage = await streamAssistantResponse(context, config, llm, emit, signal);
    newMessages.push(assistantMessage);

    if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
      await emit({ type: "turn_end", message: assistantMessage, toolResults: [] });
      await emit({ type: "agent_end", messages: newMessages });
      return;
    }

    const toolCalls = assistantMessage.toolCalls ?? [];
    const toolResults: Message[] = [];
    hasMoreToolCalls = false;

    if (toolCalls.length > 0) {
      if (assistantMessage.stopReason === "length") {
        for (const toolCall of toolCalls) {
          toolResults.push(await truncatedToolResult(toolCall, emit));
        }
        // Pi L216: a truncated batch has terminate=false → keep looping; the model re-sends complete arguments based on the error results
        hasMoreToolCalls = true;
      } else {
        // Sequential execution pipeline (parallel is in Chapter 04): each tool call goes through the five steps + hooks + tool events
        const outcomes: ToolExecutionOutcome[] = [];
        for (const toolCall of toolCalls) {
          outcomes.push(await executeToolCall(context, assistantMessage, toolCall, config, emit, signal));
          // Pi L478-480: break after abort; the remaining tools are not executed
          if (signal?.aborted) {
            break;
          }
        }
        for (const outcome of outcomes) {
          toolResults.push(outcome.message);  // Pi L216-221: tool results go into toolResults (written back in one place + carried by turn_end)
        }
        // Batch termination: stop only if the whole batch terminates (Pi L582-584)
        hasMoreToolCalls = !shouldTerminateToolBatch(outcomes);
      }
    }
    // Write back to history in one place (Pi L218-221): results from normal execution and truncation protection both go into context/newMessages
    for (const result of toolResults) {
      context.messages.push(result);
      newMessages.push(result);
    }

    await emit({ type: "turn_end", message: assistantMessage, toolResults });
  }

  await emit({ type: "agent_end", messages: newMessages });
}

/** Streaming assistant response (same as Chapter 02, Pi L281-372). */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  llm: LLMAdapter,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  for await (const event of llm.complete(
    { model: config.model, systemPrompt: context.systemPrompt, messages: context.messages, tools: context.tools ?? [] },
    signal,
  )) {
    switch (event.type) {
      case "start":
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        addedPartial = true;
        await emit({ type: "message_start", message: { ...partialMessage } });
        break;

      case "text_start":
      case "text_delta":
      case "text_end":
      case "toolcall_start":
      case "toolcall_end":
        if (partialMessage) {
          partialMessage = event.partial;
          context.messages[context.messages.length - 1] = partialMessage;
          await emit({
            type: "message_update",
            message: { ...partialMessage },
            assistantMessageEvent: event,
          });
        }
        break;

      case "done": {
        const finalMessage = event.partial;
        if (addedPartial) {
          context.messages[context.messages.length - 1] = finalMessage;
        } else {
          context.messages.push(finalMessage);
          await emit({ type: "message_start", message: { ...finalMessage } });
        }
        await emit({ type: "message_end", message: { ...finalMessage } });  // Snapshot: message event payloads are always shallow copies
        return finalMessage;
      }
    }
  }

  throw new Error("LLM stream did not end with a done event");
}

/**
 * Batch termination check (Pi `shouldTerminateToolBatch` L582-584):
 * Stop only when the batch is non-empty and **every** result has terminate === true.
 * Semantics: terminate is each tool's suggestion that "it's time to stop", not an order; one tool suggesting a stop must not cut off the other tools in the batch.
 */
function shouldTerminateToolBatch(outcomes: ToolExecutionOutcome[]): boolean {
  return outcomes.length > 0 && outcomes.every((outcome) => outcome.terminate === true);
}

/** Error result for truncation protection (same as Chapter 02). */
async function truncatedToolResult(toolCall: ToolCall, emit: AgentEventSink): Promise<Message> {
  // Pi L387-392: tool_execution_start carries the raw arguments
  await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });
  const message: Message = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    text: `Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
    isError: true,
  };
  // Pi L400-403: tool_execution_end + message events (shallow copies, so consumer changes don't pollute the internal history)
  await emit({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result: { content: message.text ?? "" }, isError: true });
  await emit({ type: "message_start", message: { ...message } });
  await emit({ type: "message_end", message: { ...message } });
  return message;
}
