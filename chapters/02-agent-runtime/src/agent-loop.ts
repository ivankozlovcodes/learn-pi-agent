/**
 * Chapter 02 delta: the full Agent Runtime. On top of the minimal loop from 01, it fills in all the core mechanisms of Pi `runLoop` + `streamAssistantResponse`.
 *
 * Changes relative to Chapter 01 (all anchored to Pi; line numbers are from the pinned commit):
 * - Event model: three kinds of events (agent/turn/message), including the streaming-only `message_update` (Pi `AgentEvent` types.ts L428-443)
 * - **Streaming delta consumption**: the partial snapshot replaces the last context entry (L335-343) + message_update (L438).
 *   Chapter 01 "only takes done"; this upgrades it to full consumption (start → deltas → done)
 * - Explicit stopReason (end_turn/tool_use/length/error/aborted) + errorMessage text
 * - Termination ①②: error/aborted stops immediately (L196-200) / no tool call ends the run (L216+L274)
 * - newMessages delta semantics and context snapshot isolation (L103/L104-107)
 * - Truncation guard: on length, every tool call is marked as an error and not executed (L208-213+L381-406)
 * - `agentLoop` top-level entry: EventStream wrapper (L31-54 + createAgentStream L145-150)
 * - AbortSignal: abort → stopReason aborted → termination ①
 *
 * Trimmed (chapter ownership): steering/follow-up→05, parallel→04, tool events and argument validation→03,
 * shouldStopAfterTurn/prepareNextTurn/transformContext/getApiKey→06.
 */
import { EventStream, type LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AssistantMessage, AssistantMessageEvent, Message, ToolCall } from "../../00-minimal-llm-call/src/index.ts";

/** Event output: Pi `AgentEventSink` (agent-loop.ts L25). */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Top-level entry: creates the EventStream and starts runAgentLoop in the background.
 * Corresponds to Pi `agentLoop` (L31-54) + `createAgentStream` (L145-150):
 * end signal = the agent_end event; result = the newMessages carried by that event.
 */
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

  // Pi L40-51: runs in the background and passes the result through stream.end(messages) at the end;
  // the agent_end event itself is emitted by emit inside runLoop (not duplicated)
  void runAgentLoop(prompts, context, config, llm, (event) => stream.push(event), signal)
    .then((messages) => {
      stream.end(messages);
    })
    .catch((error: unknown) => {
      // A hook/stream exception inside the loop must not leave consumers hanging forever: end the stream and leave a trace (the errors-encoded-in-the-stream contract does not cover hooks)
      console.error("agent run failed:", error instanceof Error ? error.message : String(error));
      stream.end([]);
    });

  return stream;
}

/** Starts one agent run: newMessages holds only what this run adds; context snapshot isolation (Pi L103-107). */
export async function runAgentLoop(
  prompts: Message[],
  context: AgentContext,
  config: AgentLoopConfig,
  llm: LLMAdapter,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<Message[]> {
  // Empty prompts guard: to continue, use runAgentLoopContinue (Pi L120-143); an empty array makes the LLM continue without a prompt or return 400
  if (prompts.length === 0) {
    throw new Error("prompts must not be empty: to continue an existing session, use continue semantics (Chapter 07 runAgentLoopContinue)");
  }
  const newMessages: Message[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  // Pi L109-114: agent lifecycle start + first turn + message events for the prompts
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    // Snapshot: message event payloads are always shallow copies, so consumer changes do not affect the internal history
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

    // Full streaming consumption: Pi L193 streamAssistantResponse (L281-372)
    const assistantMessage = await streamAssistantResponse(context, config, llm, emit, signal);
    newMessages.push(assistantMessage);

    // Termination ①: Pi L196-200 (error/aborted → turn_end + agent_end, return immediately)
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
        // Truncation guard: Pi L208-213 + L381-406 (streamed arguments may be incomplete, so all are marked as errors)
        for (const toolCall of toolCalls) {
          toolResults.push(await truncatedToolResult(toolCall, emit));
        }
        // Pi L216: truncated batch terminate=false → keep looping; the model re-issues complete arguments based on the error results
        hasMoreToolCalls = true;
      } else {
        // Sequential execution: Pi executeToolCallsSequential (L433-487)
        for (const toolCall of toolCalls) {
          toolResults.push(await executeToolCall(context, toolCall, emit, signal));
          // Pi L478-480: break after abort, do not execute the remaining tools
          if (signal?.aborted) {
            break;
          }
        }
        hasMoreToolCalls = true;
      }

      for (const result of toolResults) {
        context.messages.push(result);
        newMessages.push(result);
      }
    }

    // Pi L224: turn ends
    await emit({ type: "turn_end", message: assistantMessage, toolResults });
  }

  // Termination ②: no tool calls → agent_end (Pi L274; Pi checks follow-up before exiting, introduced in Chapter 05)
  await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Streaming assistant response: fully consumes the stream events and maintains the partial snapshot.
 * Corresponds to Pi `streamAssistantResponse` (L281-372):
 * - start: partial goes into context + message_start (L319-324)
 * - deltas (text/toolcall): partial **replaces** the last context entry + message_update (L335-343). Chapter 01 only took done; this chapter starts handling deltas
 * - done: the final message is settled + message_end (L346-359)
 */
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

/** Executes a single tool call and builds the toolResult message (Pi L600-668/L670-711/L777-791; the message events correspond to emitToolResultMessage L793-796). */
async function executeToolCall(context: AgentContext, toolCall: ToolCall, emit: AgentEventSink, signal?: AbortSignal): Promise<Message> {
  const tool = context.tools?.find((t) => t.name === toolCall.name);
  let resultMessage: Message;
  if (!tool) {
    resultMessage = {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      text: `Tool ${toolCall.name} not found`,
      isError: true,
    };
  } else {
    try {
      // Pi L679-682: signal is passed through to the tool execute (long tasks can abort on their own)
      const result = await tool.execute(toolCall.arguments as never, undefined, signal);
      resultMessage = { role: "toolResult", toolCallId: toolCall.id, toolName: toolCall.name, text: result.content, isError: false };
    } catch (error) {
      resultMessage = {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        text: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }
  // Snapshot: message event payloads are always shallow copies (resultMessage then goes into context; a shared reference would let consumer changes pollute the history)
  await emit({ type: "message_start", message: { ...resultMessage } });
  await emit({ type: "message_end", message: { ...resultMessage } });
  return resultMessage;
}

/** Error result for the truncation guard (message shape of Pi failToolCallsFromTruncatedMessage L381-406). */
async function truncatedToolResult(toolCall: ToolCall, emit: AgentEventSink): Promise<Message> {
  // Pi L387-392: tool_execution_start carries the original arguments
  await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });
  const message: Message = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    text: `Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
    isError: true,
  };
  // Pi L400-403: tool_execution_end + message events (shallow copies, so consumer changes do not pollute the internal history)
  await emit({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result: { content: message.text ?? "" }, isError: true });
  await emit({ type: "message_start", message: { ...message } });
  await emit({ type: "message_end", message: { ...message } });
  return message;
}
