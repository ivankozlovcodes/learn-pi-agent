/**
 * Chapter 04 delta: Parallel Tool Execution.
 *
 * Changes relative to Chapter 03 (all anchored to Pi):
 * - Tool batch execution mode: config.toolExecution defaults to "parallel" (Pi types.ts L266-268);
 *   the dispatch decision in executeToolCalls L411-426: explicit sequential, or any tool with executionMode="sequential" → sequential
 * - **Two-stage parallelism** in executeToolCallsParallel (L489-554):
 *   stage 1 prepares one by one (sequential, immediate failures wrap up first, L499-538)
 *   stage 2 executes concurrently (thunk + Promise.all, L540-542)
 * - **Ordered Concurrency**: tool_execution_end is emitted in completion order (inside the thunk),
 *   toolResult messages are produced in assistant source order (the ordered pass) — Pi's dual-order protocol
 * - Batch termination carries over: under parallel execution too, stop only if the whole batch terminates (L550-553)
 *
 * Trimmed (chapter ownership): steering/follow-up → 05, transform/stop hooks → 06.
 */
import { EventStream, type LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AssistantMessage, AssistantMessageEvent, Message, ToolCall } from "../../00-minimal-llm-call/src/index.ts";
import {
  emitToolResultMessage,
  executeAndFinalize,
  prepareToolCall,
  type FinalizedToolOutcome,
  type ImmediateToolOutcome,
  type PreparedToolCall,
  type ToolResultMessage,
} from "./tool-runtime.ts";

/** Event output (same as the previous chapter). */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** Top-level entry: EventStream wrapper (same as Chapters 02/03). */
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

/** Start one agent run (same as the previous chapter). */
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
        // Dispatch: Pi executeToolCalls L411-426
        const executed = await executeToolCalls(context, assistantMessage, toolCalls, config, emit, signal);
        for (const result of executed) {
          toolResults.push(result.message); // Pi L216-221: tool results go into toolResults (written back in one place + carried by turn_end)
        }
        // Batch termination: stop only if the whole batch terminates (L550-553)
        hasMoreToolCalls = !shouldTerminateToolBatch(executed);
      }
    }
    // Write back to history in one place (Pi L218-221): results from normal execution and the truncation guard both go into context/newMessages
    for (const result of toolResults) {
      context.messages.push(result);
      newMessages.push(result);
    }

    await emit({ type: "turn_end", message: assistantMessage, toolResults });
  }

  await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Tool batch execution: dispatch (Pi L411-426).
 * Explicit sequential, or any tool in the batch with executionMode === "sequential" → sequential; otherwise parallel (the default).
 */
async function executeToolCalls(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: ToolCall[],
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<ToolResultMessage[]> {
  const hasSequentialTool = toolCalls.some(
    (tc) => context.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
  );
  if (config.toolExecution === "sequential" || hasSequentialTool) {
    return executeToolCallsSequential(context, assistantMessage, toolCalls, config, emit, signal);
  }
  return executeToolCallsParallel(context, assistantMessage, toolCalls, config, emit, signal);
}

/** Sequential path (Pi L433-487): prepare → execute → message one by one; immediate failures wrap up in place. */
async function executeToolCallsSequential(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: ToolCall[],
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<ToolResultMessage[]> {
  const results: ToolResultMessage[] = [];
  for (const toolCall of toolCalls) {
    const prepared = await prepareToolCall(context, assistantMessage, toolCall, config, emit, signal);
    if (prepared.kind === "immediate") {
      // Pi sequential L472-474: end was already emitted by immediate; message events are emitted right away in execution order
      await emit({ type: "message_start", message: { ...prepared.message } });
      await emit({ type: "message_end", message: { ...prepared.message } });
      results.push({ message: prepared.message, terminate: prepared.terminate });
    } else {
      const finalized = await executeAndFinalize(prepared, config, emit, context, assistantMessage, signal);
      results.push(await emitToolResultMessage(finalized, emit));
    }
    // Pi L478-480: break after abort; the remaining tools are not executed
    if (signal?.aborted) {
      break;
    }
  }
  return results;
}

/**
 * Parallel path (Pi L489-554).
 * Stage 1: prepare one by one (sequential, L499-538); immediate failures wrap up in place into entries;
 * Stage 2: the prepared calls are wrapped as thunks and executed concurrently with Promise.all (L540-542),
 *         tool_execution_end is emitted inside the thunk in completion order (L532);
 * Wrap-up: toolResult messages are produced in assistant source order (L543-548) — Ordered Concurrency.
 */
async function executeToolCallsParallel(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: ToolCall[],
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<ToolResultMessage[]> {
  // Stage 1: sequential prepare
  const entries: ({ kind: "immediate"; message: Message; terminate: boolean } | (() => Promise<FinalizedToolOutcome>))[] = [];
  for (const toolCall of toolCalls) {
    const prepared = await prepareToolCall(context, assistantMessage, toolCall, config, emit, signal);
    if (prepared.kind === "immediate") {
      entries.push({ kind: "immediate", message: prepared.message, terminate: prepared.terminate });
    } else {
      entries.push(() => executeAndFinalize(prepared, config, emit, context, assistantMessage, signal));
    }
    // Pi L516-518/L535-537: break after abort; the remaining tools are not prepared
    if (signal?.aborted) {
      break;
    }
  }

  // Stage 2: execute the thunks concurrently (an immediate entry resolves to null in place, so positions stay aligned with entries)
  const ordered = await Promise.all(
    entries.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(null))),
  );

  // Wrap-up: produce messages in assistant source order (message order ≠ completion order)
  const results: ToolResultMessage[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (typeof entry !== "function") {
      // immediate: message events are emitted together at wrap-up in source order (Pi L543-548, in the same order as normal results)
      await emit({ type: "message_start", message: { ...entry.message } });
      await emit({ type: "message_end", message: { ...entry.message } });
      results.push({ message: entry.message, terminate: entry.terminate });
    } else {
      results.push(await emitToolResultMessage(ordered[i] as FinalizedToolOutcome, emit));
    }
  }
  return results;
}

/** Batch termination check (Pi L582-584): stop only if the whole batch terminates. */
function shouldTerminateToolBatch(results: ToolResultMessage[]): boolean {
  return results.length > 0 && results.every((r) => r.terminate === true);
}

/** Streaming assistant response (same as the previous chapter, Pi L281-372). */
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

/** Error result for the truncation guard (same as the previous chapter). */
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
