/**
 * Chapter 04 Tool Runtime: the merged Chapter 03 pipeline split into two phases (faithful to Pi's function structure).
 *
 * In Pi these are already two functions:
 * - `prepareToolCall` (L600-668): lookup → prepareArguments → validate → beforeToolCall
 *   returns a PreparedToolCall (executable) or an ImmediateToolCallOutcome (not found/validation failed/blocked)
 * - `executePreparedToolCall` (L670-711)+ `finalizeExecutedToolCall` (L713-758):
 *   execute + onUpdate + afterToolCall, producing a FinalizedToolCallOutcome
 *
 * The two-phase split is a precondition for parallel execution (Pi L489-554): prepare runs serially (side-effect safe, immediate failures wrap up first),
 * execute runs concurrently. For the separation of message events and end events, see executeToolCallsParallel in agent-loop.ts.
 */
import { validateToolArguments } from "../../00-minimal-llm-call/src/index.ts";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AssistantMessage,
  Message,
  Tool,
  ToolCall,
  ToolResult,
} from "../../00-minimal-llm-call/src/index.ts";

/** Event output (same as the previous chapter). */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** A prepared, executable tool call (Pi `PreparedToolCall`, agent-loop.ts L556-561). */
export interface PreparedToolCall {
  kind: "prepared";
  tool: Tool;
  args: unknown;
  toolCall: ToolCall;
}

/** An immediately wrapped-up result: not found / validation failed / hook block (Pi `ImmediateToolCallOutcome` L563-567). */
export interface ImmediateToolOutcome {
  kind: "immediate";
  message: Message;
  terminate: boolean;
}

/** The result after execution and finalization (Pi `FinalizedToolCallOutcome` L574-578). */
export interface FinalizedToolOutcome {
  toolCall: ToolCall;
  result: ToolResult;
  isError: boolean;
}

/** The normalized tool result message (Pi `createToolResultMessage` L777-791). */
export interface ToolResultMessage {
  message: Message;
  terminate: boolean;
}

/**
 * Phase 1: prepare (Pi L600-668).
 * Runs serially (whether or not execution ends up parallel): lookup → argument compatibility → validation → beforeToolCall.
 * Immediate failures (not found/validation failed/blocked) wrap up here and never enter the concurrent phase.
 */
export async function prepareToolCall(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: ToolCall,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<PreparedToolCall | ImmediateToolOutcome> {
  // tool_execution_start: Pi L445-450 emits it before prepare, with the raw arguments (a not-found tool also gets a start, so every end has a matching start)
  await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });

  // lookup (Pi L607)
  const tool = context.tools?.find((t) => t.name === toolCall.name);
  if (!tool) {
    return immediate(toolCall, `Tool ${toolCall.name} not found`, false, emit);
  }

  // Argument compatibility layer (Pi L586-598)
  let args: unknown = toolCall.arguments;
  if (tool.prepareArguments) {
    try {
      args = tool.prepareArguments(toolCall.arguments);
    } catch (error) {
      return immediate(toolCall, `Argument conversion failed: ${messageOf(error)}`, false, emit);
    }
  }

  // schema validation (Pi L618)
  const validation = validateToolArguments(tool, args);
  if (!validation.ok) {
    return immediate(toolCall, `Argument validation failed: ${validation.error}`, false, emit);
  }

  // Pi L629-635: after an abort, prepare stops (Operation aborted semantics)
  if (signal?.aborted) {
    return immediate(toolCall, "Operation aborted", false, emit);
  }

  // beforeToolCall (Pi L619-647)
  if (config.beforeToolCall) {
    let before;
    try {
      before = await config.beforeToolCall({ assistantMessage, toolCall, args, context });
    } catch (error) {
      // Pi L616-667: hook threw → immediate error result, without breaking the batch
      return immediate(toolCall, `beforeToolCall hook threw: ${messageOf(error)}`, false, emit);
    }
    if (before?.block) {
      return immediate(toolCall, before.reason || "Tool execution blocked", before.terminate === true, emit);
    }
  }

  // Pi L648-654: check abort again after beforeToolCall
  if (signal?.aborted) {
    return immediate(toolCall, "Operation aborted", false, emit);
  }

  return { kind: "prepared", tool, args, toolCall };
}

/**
 * Phase 2a: execute + finalize (Pi `executePreparedToolCall` L670-711 + `finalizeExecutedToolCall` L713-758).
 * Wrapped in a thunk for concurrent execution: emits only tool_execution_end (completion order), no message events (messages are all generated in source order).
 */
export async function executeAndFinalize(
  prepared: PreparedToolCall,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  context: AgentContext,
  assistantMessage: AssistantMessage,
  signal?: AbortSignal,
): Promise<FinalizedToolOutcome> {
  const { tool, args, toolCall } = prepared;
  let result: ToolResult;
  let isError = false;
  let acceptingUpdates = true;  // Pi L676/L684: ignore late onUpdate calls after execute settles

  try {
    // Pi L679-682: pass signal through to the tool's execute (long tasks can abort themselves)
    result = await tool.execute(args as never, (partial) => {
      // A subscriber throwing on an update event doesn't kill tool execution (fire-and-forget plus catch to prevent unhandled rejections)
      // A subscriber throwing on an update event doesn't kill tool execution (Promise.resolve wrapper to prevent unhandled rejections)
      if (!acceptingUpdates) return;  // Pi L684: ignore after settle
      void Promise.resolve(
        emit({
          type: "tool_execution_update",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: toolCall.arguments,  // Pi L691: raw arguments (the model's arguments before prepare)
          partialResult: partial,
        }),
      ).catch((error: unknown) => {
        console.error("Subscriber failed to handle tool_execution_update:", error instanceof Error ? error.message : String(error));
      });
    }, signal);
  } catch (error) {
    result = { content: messageOf(error) };
    isError = true;
  } finally {
    acceptingUpdates = false;  // Pi L708-710
  }

  if (config.afterToolCall) {
    // Pi L726-736: afterToolCall receives the current context and assistantMessage
    let after;
    try {
      after = await config.afterToolCall({ assistantMessage, toolCall, args, result, isError, context });
    } catch (error) {
      // Pi L747-750: hook threw → error result, without breaking the whole batch
      result = { content: messageOf(error) };
      isError = true;
    }
    if (after) {
      result = {
        content: after.content ?? result.content,
        details: after.details ?? result.details,
        usage: after.usage ?? result.usage,
        terminate: after.terminate ?? result.terminate,
        addedToolNames: after.addedToolNames ?? result.addedToolNames,
      };
      if (after.isError !== undefined) {
        isError = after.isError;
      }
    }
  }

  // Pi L767-775: tool_execution_end is emitted right after finalize (completion order)
  await emit({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result, isError });
  return { toolCall, result, isError };
}

/** Phase 2b: normalize + message events (Pi `createToolResultMessage` L777-791 + `emitToolResultMessage` L793-796). Called in the assistant's source order. */
export async function emitToolResultMessage(
  finalized: FinalizedToolOutcome,
  emit: AgentEventSink,
): Promise<ToolResultMessage> {
  const message: Message = {
    role: "toolResult",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    text: finalized.result.content ?? "",  // Pi L782-784: content ?? [], null never reaches history/provider
    isError: finalized.isError,
    ...(finalized.result.details !== undefined ? { details: finalized.result.details } : {}),
    ...(finalized.result.usage !== undefined ? { usage: finalized.result.usage } : {}),
    ...(finalized.result.terminate !== undefined ? { terminate: finalized.result.terminate } : {}),
    ...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
  };
  await emit({ type: "message_start", message: { ...message } });
  await emit({ type: "message_end", message: { ...message } });
  return { message, terminate: finalized.result.terminate === true };
}

/** Wrap up an immediate failure: end event + message event (Pi L454-459 serial path / L508-519 parallel path). */
async function immediate(toolCall: ToolCall, text: string, terminate: boolean, emit: AgentEventSink): Promise<ImmediateToolOutcome> {
  const message: Message = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    text,
    isError: true,
    ...(terminate ? { terminate: true } : {}),
  };
  // Pi parallel L508-519: immediate emits only end (completion order); the execution path emits message events in order
  // (serial: emitted immediately in execution order L472-474; parallel: emitted together in source order at wrap-up L543-548)
  await emit({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result: { content: text }, isError: true });
  return { kind: "immediate", message, terminate };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
