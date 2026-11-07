/**
 * Chapter 07 baseline (snapshot, runtime unchanged): the Chapter 06 additions Context Transformation + runAgentLoopContinue.
 *
 * Chapter 08 does not modify this file: Session Compaction is not implemented inside the loop.
 * Layers (in effect from Chapter 08):
 *   Session Tree → buildSessionContext (Chapter 08 reconstruction projection) → canonical state.messages
 *   → transformContext (Chapter 06 hook, the extension injection seam) → call-time messages
 * The loop only consumes canonical state and knows nothing about compaction (Pi: compaction lives in the
 * AgentSession/SessionManager layer; the low-level loop only has the generic transformContext option).
 *
 * Changes from Chapter 05 (all anchored in Pi):
 * - `transformContext` (L289-292): before the LLM call, AgentMessage[] → AgentMessage[] (context transformation)
 * - `getApiKey` (L304-306): resolve the API key dynamically before every LLM call (the OAuth expiry case)
 * - `prepareNextTurn` (L232-245): after turn_end, replace the next turn's context/model
 * - `shouldStopAfterTurn` (L247-257): stop gracefully after turn_end (tool results are already written normally)
 *
 * Timeline of one turn (hook positions):
 *   turn_start → [steering injection] → transformContext → convertToLlm → getApiKey → LLM
 *   → tool execution → turn_end → prepareNextTurn → shouldStopAfterTurn → [re-fetch steering at turn end]
 *
 * Context as a Hook: context transformation isn't built into the loop; it is a hook at the AgentMessage layer.
 * Note (Chapter 08 correction): compaction does not go through this seam (Pi sdk.ts L362-366 only wires extension
 * emitContext); Pi coding-agent's compaction does not use shouldStopAfterTurn.
 */
import { EventStream, type LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AssistantMessage, AssistantMessageEvent, Message, ToolCall } from "../../00-minimal-llm-call/src/index.ts";
import { emitToolResultMessage, executeAndFinalize, prepareToolCall, type FinalizedToolOutcome, type ToolResultMessage } from "./tool-runtime.ts";

/** Event output (same as the previous chapter). */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** Top-level entry: EventStream wrapper (same as the previous chapter). */
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
      stream.push({ type: "agent_end", messages: [] });  // emit agent_end so consumers can tell a crash from an empty result
    });

  return stream;
}

/** Start an agent run (same as the previous chapter). */
export async function runAgentLoop(
  prompts: Message[],
  context: AgentContext,
  config: AgentLoopConfig,
  llm: LLMAdapter,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<Message[]> {
  // Empty prompts guard: to continue, use runAgentLoopContinue (Pi L120-143); an empty array makes the LLM continue without a prompt or return a 400
  if (prompts.length === 0) {
    throw new Error("prompts must not be empty: use runAgentLoopContinue to continue an existing session");
  }
  const newMessages: Message[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  await runLoop(currentContext, newMessages, config, llm, emit, signal);
  return newMessages;
}

/** Continue entry (Pi `runAgentLoopContinue` L120-143): injects no new messages, continues from the current context. */
export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  llm: LLMAdapter,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<Message[]> {
  if (context.messages.length === 0) {
    throw new Error("No messages to continue from (Pi: Cannot continue: no messages in context)");
  }
  if (context.messages[context.messages.length - 1].role === "assistant") {
    throw new Error("Cannot continue from an assistant message (Pi: Cannot continue from message role: assistant)");
  }

  // Pi L135-136: newMessages starts empty (existing messages aren't repeated); context is used as is
  const newMessages: Message[] = [];
  const currentContext: AgentContext = { ...context, messages: [...context.messages] };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  await runLoop(currentContext, newMessages, config, llm, emit, signal);
  return newMessages;
}

/** Main loop: two-level structure (Chapter 05) + four new hooks. */
async function runLoop(
  context: AgentContext,
  newMessages: Message[],
  config: AgentLoopConfig,
  llm: LLMAdapter,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<void> {
  let currentContext = context;
  let currentConfig = config;
  let pendingMessages: Message[] = (await currentConfig.getSteeringMessages?.()) || [];

  let firstTurn = true;  // Pi L175-179: the first turn's turn_start is emitted by runAgentLoop
  while (true) {
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (firstTurn) {
        firstTurn = false;
      } else {
        await emit({ type: "turn_start" });
      }

      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          await emit({ type: "message_start", message });
          await emit({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      const assistantMessage = await streamAssistantResponse(currentContext, currentConfig, llm, emit, signal);
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
            // Pi L386-403: truncated results get the full set of events (tool_execution_start/end + message events, shallow copies)
            toolResults.push(await truncatedToolResult(toolCall, emit));
          }
          // Pi L216: a truncated batch has terminate=false → keep looping; the model re-sends complete arguments based on the error result
          hasMoreToolCalls = true;
        } else {
          const executed = await executeToolCalls(currentContext, assistantMessage, toolCalls, currentConfig, emit, signal);
          for (const result of executed) {
            toolResults.push(result.message);  // Pi L216-221: tool results go into toolResults (written together + carried by turn_end)
          }
          hasMoreToolCalls = !shouldTerminateToolBatch(executed);
        }
      }
      // Write history together (Pi L218-221): results from normal execution and from truncation protection both go into context/newMessages
      for (const result of toolResults) {
        currentContext.messages.push(result);
        newMessages.push(result);
      }

      await emit({ type: "turn_end", message: assistantMessage, toolResults });

      // prepareNextTurn (Pi L232-245): after turn_end, replace the next turn's context/model
      const turnContext = { message: assistantMessage, toolResults, context: currentContext, newMessages };
      const nextTurn = await currentConfig.prepareNextTurn?.(turnContext);
      if (nextTurn) {
        currentContext = nextTurn.context ?? currentContext;
        if (nextTurn.model) {
          currentConfig = { ...currentConfig, model: nextTurn.model };
        }
      }

      // shouldStopAfterTurn (Pi L247-257): graceful stop; the current turn has ended normally.
      // Use the context after prepareNextTurn replaced it (the stale pre-replacement reference can't decide the stop)
      if (await currentConfig.shouldStopAfterTurn?.({ ...turnContext, context: currentContext })) {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      pendingMessages = (await currentConfig.getSteeringMessages?.()) || [];
    }

    const followUpMessages = (await currentConfig.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }

    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}

/** Streaming assistant response: transformContext + getApiKey take effect here (the L289-306 range of Pi L281-372). */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  llm: LLMAdapter,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  // transformContext (Pi L289-292): AgentMessage[] → AgentMessage[], happens before convertToLlm
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }

  // getApiKey (Pi L304-306): resolved dynamically before every call
  const resolvedApiKey = config.getApiKey ? await config.getApiKey() : undefined;

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  for await (const event of llm.complete(
    { model: config.model, systemPrompt: context.systemPrompt, messages, tools: context.tools ?? [], apiKey: resolvedApiKey },
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
        await emit({ type: "message_end", message: finalMessage });
        return finalMessage;
      }
    }
  }

  throw new Error("LLM stream did not end with a done event");
}

/** Tool batch execution: dispatch (same as Chapters 04/05, Pi L411-426). */
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

/** Serial path (same as the previous chapter, Pi L433-487). */
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
      // Pi serial L472-474: immediate already emitted end; message events are emitted immediately in execution order
      await emit({ type: "message_start", message: { ...prepared.message } });
      await emit({ type: "message_end", message: { ...prepared.message } });
      results.push({ message: prepared.message, terminate: prepared.terminate });
    } else {
      const finalized = await executeAndFinalize(prepared, config, emit, context, assistantMessage, signal);
      results.push(await emitToolResultMessage(finalized, emit));
    }
    // Pi L478-480: break after an abort, don't execute the remaining tools
    if (signal?.aborted) {
      break;
    }
  }
  return results;
}

/** Parallel path (same as the previous chapter, Pi L489-554). */
async function executeToolCallsParallel(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: ToolCall[],
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<ToolResultMessage[]> {
  const entries: ({ kind: "immediate"; message: Message; terminate: boolean } | (() => Promise<FinalizedToolOutcome>))[] = [];
  for (const toolCall of toolCalls) {
    const prepared = await prepareToolCall(context, assistantMessage, toolCall, config, emit, signal);
    if (prepared.kind === "immediate") {
      entries.push({ kind: "immediate", message: prepared.message, terminate: prepared.terminate });
    } else {
      entries.push(() => executeAndFinalize(prepared, config, emit, context, assistantMessage, signal));
    }
    // Pi L516-518/L535-537: break after an abort, don't prepare the remaining tools
    if (signal?.aborted) {
      break;
    }
  }

  const ordered = await Promise.all(
    entries.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(null))),
  );

  const results: ToolResultMessage[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (typeof entry !== "function") {
      // immediate: message events are emitted together at wrap-up in source order (Pi L543-548, same order as normal results)
      await emit({ type: "message_start", message: { ...entry.message } });
      await emit({ type: "message_end", message: { ...entry.message } });
      results.push({ message: entry.message, terminate: entry.terminate });
    } else {
      results.push(await emitToolResultMessage(ordered[i] as FinalizedToolOutcome, emit));
    }
  }
  return results;
}

/** Batch termination check (same as the previous chapter, Pi L582-584). */
function shouldTerminateToolBatch(results: ToolResultMessage[]): boolean {
  return results.length > 0 && results.every((r) => r.terminate === true);
}

/** Error result for truncation protection (same as the previous chapter). */
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
  // Pi L400-403: tool_execution_end + message events (shallow copies, so consumer changes don't pollute internal history)
  await emit({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result: { content: message.text ?? "" }, isError: true });
  await emit({ type: "message_start", message: { ...message } });
  await emit({ type: "message_end", message: { ...message } });
  return message;
}
