/**
 * Chapter 03 core: the tool execution pipeline (Tool Runtime).
 *
 * A tool call goes from "find it and call it" (Chapters 01/02) to a five-step pipeline, all anchored to Pi:
 *   lookup    → find the tool (Pi L607; not found → error result L608-614)
 *   prepare   → argument compatibility layer (Pi `prepareToolCallArguments` L586-598)
 *   validate  → schema validation (Pi `validateToolArguments` L618)
 *   execute   → execution + onUpdate delta callback (Pi L670-711 + L683-697)
 *   normalize → result normalization: details/usage/terminate/addedToolNames/isError (Pi `createToolResultMessage` L777-791)
 *
 * Two hooks (Pi's boundary design, Philosophy 3):
 *   beforeToolCall  → can block before execution (L619-647)
 *   afterToolCall   → field-level override after execution (L724-751)
 *
 * The three tool_execution_* events complete Pi's four-kind event model (L441-450/L767-775).
 */
import { validateToolArguments } from "../../00-minimal-llm-call/src/index.ts";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AssistantMessage,
  Message,
  ToolCall,
  ToolResult,
} from "../../00-minimal-llm-call/src/index.ts";

/** Event output (same as the previous chapter). */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** The outcome of one tool execution: the normalized message + whether it suggests stopping. */
export interface ToolExecutionOutcome {
  message: Message;
  /** Whether this result suggests stopping after this turn (Pi `result.terminate`, types.ts L374). */
  terminate: boolean;
}

/**
 * Execute a single tool call through the five-step pipeline.
 * Corresponds to the sequential path of Pi `prepareToolCall` (L600-668) + `executePreparedToolCall` (L670-711)
 * + `finalizeExecutedToolCall` (L713-758) + `createToolResultMessage` (L777-791).
 */
export async function executeToolCall(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: ToolCall,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<ToolExecutionOutcome> {
  // tool_execution_start: Pi L445-450 emits it before prepare, with the raw arguments (not found also gets a start, so end stays paired)
  await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });

  // 0. lookup: Pi L607
  const tool = context.tools?.find((t) => t.name === toolCall.name);
  if (!tool) {
    // Pi L608-614: not found → immediate error result (errors are data)
    return immediateOutcome(toolCall, `Tool ${toolCall.name} not found`, false, emit);
  }

  // 1. prepare: argument compatibility layer (Pi L586-598). A failed conversion also becomes an error result and does not break the loop.
  let args: unknown = toolCall.arguments;
  if (tool.prepareArguments) {
    try {
      args = tool.prepareArguments(toolCall.arguments);
    } catch (error) {
      return immediateOutcome(toolCall, `Argument conversion failed: ${messageOf(error)}`, false, emit);
    }
  }

  // 2. validate: schema validation (Pi L618). Validation failures are caught before execute, so bad arguments never reach the tool.
  const validation = validateToolArguments(tool, args);
  if (!validation.ok) {
    return immediateOutcome(toolCall, `Argument validation failed: ${validation.error}`, false, emit);
  }

  // Pi L629-635: after abort, prepare does not continue (Operation aborted semantics)
  if (signal?.aborted) {
    return immediateOutcome(toolCall, "Operation aborted", false, emit);
  }

  // 3. beforeToolCall hook (Pi L619-647): can block (with a reason); a block can also take part in the batch termination check
  if (config.beforeToolCall) {
    let before;
    try {
      before = await config.beforeToolCall({ assistantMessage, toolCall, args, context });
    } catch (error) {
      // Pi L616-667: hook threw → immediate error result, without breaking the batch
      return immediateOutcome(toolCall, `beforeToolCall hook threw: ${messageOf(error)}`, false, emit);
    }
    if (before?.block) {
      return immediateOutcome(toolCall, before.reason || "Tool execution blocked", before.terminate === true, emit);
    }
  }

  // Pi L648-654: check abort again after beforeToolCall
  if (signal?.aborted) {
    return immediateOutcome(toolCall, "Operation aborted", false, emit);
  }

  // 5. execute + onUpdate (Pi L670-711; partial updates flow out as tool_execution_update events L683-697)
  let result: ToolResult;
  let isError = false;
  let acceptingUpdates = true;  // Pi L676/L684: ignore late onUpdate calls after execute settles

  try {
    // Pi L679-682: signal is passed through to the tool's execute (long tasks can abort themselves)
    result = await tool.execute(args as never, (partial) => {
      if (!acceptingUpdates) return;  // Pi L684: ignore after settle
      void emit({
        type: "tool_execution_update",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args: toolCall.arguments,  // Pi L691: raw arguments (the model's arguments before prepare)
        partialResult: partial,
      });
    }, signal);
  } catch (error) {
    // Pi L701-707: exception → error result (carry on)
    result = { content: messageOf(error) };
    isError = true;
  } finally {
    acceptingUpdates = false;  // Pi L708-710
  }

  // 6. afterToolCall hook (Pi L724-751): field-level override, no deep merge
  if (config.afterToolCall) {
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

  // 7. normalize (Pi L777-791) + tool_execution_end (L767-775) + message events (L793-796)
  const message: Message = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    text: result.content ?? "",  // Pi L782-784: content ?? [], null never reaches history/provider
    isError,
    ...(result.details !== undefined ? { details: result.details } : {}),
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
    ...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
    ...(result.addedToolNames?.length ? { addedToolNames: result.addedToolNames } : {}),
  };
  await emit({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result, isError });
  await emit({ type: "message_start", message: { ...message } });
  await emit({ type: "message_end", message: { ...message } });
  return { message, terminate: result.terminate === true };
}

/** Tool not found / prepare / validate failure: error result + events (Pi L608-614 path; end and message events are always emitted). */
async function immediateOutcome(
  toolCall: ToolCall,
  text: string,
  terminate: boolean,
  emit: AgentEventSink,
): Promise<ToolExecutionOutcome> {
  const message: Message = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    text,
    isError: true,
    ...(terminate ? { terminate: true } : {}),
  };
  await emit({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result: { content: text }, isError: true });
  await emit({ type: "message_start", message: { ...message } });
  await emit({ type: "message_end", message: { ...message } });
  return { message, terminate };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
