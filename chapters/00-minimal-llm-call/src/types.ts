/**
 * Chapter 00 shared base: the complete type definitions (done once; later chapters only evolve the implementation and never change the types).
 *
 * Maps to Pi's `packages/agent/src/types.ts` and the pi-ai base types:
 * - `Message`/`Tool`/`AgentContext`: simplified Pi `AgentMessage` (types.ts L325) / `AgentTool` (L386-409) / `AgentContext` (L412-419)
 * - `errorMessage`: Pi's error message text field (pi-ai L439)
 * - `StopReason`: five teaching values (Pi has seven, including pending/deferred; trimmed for teaching)
 * - `AssistantMessageEvent`: simplified Pi stream events (pi-ai L535-556) (separate toolcall_delta/thinking/error events not reproduced)
 * - `AgentEvent`: subset of Pi `AgentEvent` (types.ts L428-443) (message_update carries a reference to the streaming event)
 * - `AgentLoopConfig`: V0 subset of Pi `AgentLoopConfig` (types.ts L149-293). Later chapters extend this interface as needed
 */

/** Message role: matches the three roles of Pi's base `Message`. */
export type MessageRole = "user" | "assistant" | "toolResult";

/** Tool call block requested by the model: maps to Pi's `AgentToolCall` (types.ts L53). */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Unified message model: maps to Pi's `AgentMessage` (types.ts L325). */
export interface Message {
  role: MessageRole;
  text?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** Error text: carried when `stopReason === "error"` (Pi pi-ai types.ts L439). */
  errorMessage?: string;
  /** toolResult only: structured result details (Pi `AgentToolResult.details`, types.ts L365). */
  details?: unknown;
  /** toolResult only: tool execution usage (Pi types.ts L366-367; not billed to the main context). */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** toolResult only: signals that execution should stop after this tool batch (Pi types.ts L374; batch termination semantics). */
  terminate?: boolean;
  /** toolResult only: tool names introduced by this result and available from now on (Pi types.ts L368-369; Chapter 09 dynamic tools). */
  addedToolNames?: string[];
  /** UI-only message flag: filtered out by convertToLlm (Pi comment example: Filter out UI-only messages, types.ts L170-172). */
  uiOnly?: boolean;
}

/** Stop reason (five teaching values). */
export type StopReason = "end_turn" | "tool_use" | "length" | "error" | "aborted";

/** Assistant message: `stopReason` is what the loop branches on (used explicitly from Chapter 02). */
export interface AssistantMessage extends Message {
  role: "assistant";
  stopReason: StopReason;
  /**
   * Reasoning text (block-level, not streaming events).
   * Real endpoints return thinking blocks, and the Anthropic protocol requires sending them back as-is (otherwise 400).
   * Trimmed for teaching: no streaming thinking events, but the adapter keeps the text and sends it back.
   */
  thinking?: string;
  /** Signature of the thinking block (the protocol requires sending it back with the text; required in the SDK type). */
  thinkingSignature?: string;
}

/**
 * LLM streaming events (simplified Pi `AssistantMessageEvent`, pi-ai L535-556).
 * Every event carries `partial`: a snapshot of the current complete assistant message (the replacement mechanism in agent-loop.ts L335-343 relies on it).
 * - start: the stream begins (Pi L319-324 consumption point); note that partial.toolCalls is an empty array here
 *   (tool call blocks arrive mid-stream, so the start snapshot has none; they are complete at done, see the adapter implementation)
 * - text_* / toolcall_*: delta events (the separate toolcall_delta event is not reproduced; the adapter only emits events for
 *   text_delta, so a tool-call-only turn has no delta events and consumers rely on the done snapshot)
 * - done: the stream is complete and partial is the final message (errors are encoded in done's stopReason)
 */
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start" | "text_delta" | "text_end"; partial: AssistantMessage }
  | { type: "toolcall_start" | "toolcall_end"; partial: AssistantMessage }
  | { type: "done"; partial: AssistantMessage };

/** Minimal JSON Schema (validator in validate.ts; the index signature satisfies the Anthropic SDK InputSchema). */
export interface ToolParameters {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
  [key: string]: unknown;
}

/**
 * Tool execution result: maps to Pi `AgentToolResult` (types.ts L361-375).
 * From Chapter 03, tools return structured results, not just a content string.
 */
export interface ToolResult {
  /** Content sent back to the model (Pi `content`, types.ts L363). */
  content: string;
  /** Structured data for logs/UI (types.ts L365). */
  details?: unknown;
  /** Tool execution usage (types.ts L366-367). */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Signals that execution should stop after this tool batch (types.ts L374; batch termination semantics). */
  terminate?: boolean;
  /** Tool names introduced by this result and available from now on (types.ts L368-369). */
  addedToolNames?: string[];
}

/**
 * Tool definition: maps to Pi `AgentTool` (types.ts L386-409).
 * - `prepareArguments`: compatibility layer that converts the model's raw arguments into the format the tool expects (Pi L393-394)
 * - `execute`: throws on failure; `onUpdate` is the partial update callback; `signal` is the abort signal
 *   (Pi L395-400: execute(toolCallId, params, signal, onUpdate); toolCallId trimmed for teaching, signal kept)
 * - `executionMode`: per-tool execution mode override (Pi L402-408; used in Chapter 04)
 */
export interface Tool<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: ToolParameters;
  prepareArguments?: (args: unknown) => TArgs;
  execute(args: TArgs, onUpdate?: (partial: ToolResult) => void, signal?: AbortSignal): Promise<ToolResult>;
  executionMode?: "sequential" | "parallel";
}

/** Loop input context: maps to Pi `AgentContext` (types.ts L412-419). */
export interface AgentContext {
  systemPrompt: string;
  messages: Message[];
  tools?: Tool[];
}

/** Return value of `beforeToolCall`: can block execution (Pi `BeforeToolCallResult`, types.ts L61-69). */
export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
  /** Also counts toward the batch termination decision when blocking. */
  terminate?: boolean;
}

/** Input of `beforeToolCall` (Pi types.ts L98-107). */
export interface BeforeToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: ToolCall;
  args: unknown;
  context: AgentContext;
}

/** Return value of `afterToolCall`: field-level overrides (Pi `AfterToolCallResult`, types.ts L84-95, no deep merge). */
export interface AfterToolCallResult {
  content?: string;
  details?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  terminate?: boolean;
  addedToolNames?: string[];
  isError?: boolean;
}

/** Input of `afterToolCall` (Pi types.ts L110-123). */
export interface AfterToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: ToolCall;
  args: unknown;
  result: ToolResult;
  isError: boolean;
  context: AgentContext;
}

/** Tool execution mode: Pi `ToolExecutionMode` (types.ts L37-42). Defaults to "parallel". */
export type ToolExecutionMode = "sequential" | "parallel";

/** Return value of `prepareNextTurn`: replaces the context/model/thinkingLevel for the next turn (Pi `AgentLoopTurnUpdate`, types.ts L138-145). */
export interface AgentLoopTurnUpdate {
  context?: AgentContext;
  model?: string;
}

/**
 * Loop configuration: subset of Pi `AgentLoopConfig` (types.ts L149-293).
 * The type surface is declared here in one place; the matching runtime mechanisms are implemented step by step in later chapters
 * (transformContext/prepareNextTurn/shouldStopAfterTurn/getApiKey → Chapter 06).
 */
export interface AgentLoopConfig {
  model: string;
  /** Hook before tool execution: can block (Pi L619-647). */
  beforeToolCall?: (context: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined>;
  /** Hook after tool execution: field-level overrides of the result (Pi L724-751). */
  afterToolCall?: (context: AfterToolCallContext) => Promise<AfterToolCallResult | undefined>;
  /** Execution mode for a tool batch: parallel by default (Pi types.ts L266-268; dispatch decision L411-426). */
  toolExecution?: ToolExecutionMode;
  /**
   * Mid-run injection (steering): fetched once after each turn ends (Pi L259, initial fetch point L167).
   * The returned messages enter history before the next LLM call (L182-190): "an interruption within the current workflow".
   * Contract (Pi types.ts L242-243/L255-256): with no messages it must return []; it must not return undefined or throw.
   * Otherwise the inner loop condition (pendingMessages.length > 0) is never satisfied and the loop never ends.
   */
  getSteeringMessages?: () => Promise<Message[]>;
  /**
   * Post-stop injection (follow-up): fetched once after the inner loop exits (no tools, no steering) (Pi L263-268).
   * If non-empty, control goes back to the outer loop and continues: "a new start after the current workflow ends".
   * Same contract as steering: return [] when there are no messages.
   */
  getFollowUpMessages?: () => Promise<Message[]>;
  /**
   * Context transform before the LLM call (Pi L289-292): AgentMessage[] → AgentMessage[].
   * Used for context window management (trimming old messages) and injecting external material (types.ts L180-200).
   * Runs before convertToLlm and transforms internal messages (Context as a Hook).
   */
  transformContext?: (messages: Message[], signal?: AbortSignal) => Promise<Message[]>;
  /**
   * Resolves the API key dynamically before every LLM call (Pi L304-306; OAuth expiry scenario types.ts L202-210).
   * Returns undefined when not set.
   */
  getApiKey?: () => Promise<string | undefined> | string | undefined;
  /**
   * Called after turn_end: returns a replacement context/model for the next turn (Pi L232-245 + types.ts L138-145).
   * Returning undefined keeps the current ones.
   */
  prepareNextTurn?: (context: { message: AssistantMessage; toolResults: Message[]; context: AgentContext; newMessages: Message[] }) => Promise<AgentLoopTurnUpdate | undefined>;
  /**
   * Called after turn_end: returning true stops gracefully (Pi L247-257, e.g. when the context is about to fill up, types.ts L218).
   * Unlike termination ① (stop immediately on error): the current turn's tool results have already been persisted normally.
   */
  shouldStopAfterTurn?: (context: { message: AssistantMessage; toolResults: Message[]; context: AgentContext; newMessages: Message[] }) => boolean | Promise<boolean>;
  /**
   * Dynamic tool loading: called when a tool result carries addedToolNames, adding the new tools to context.tools for later turns
   * (Pi ToolResultMessage comment: Names from Context.tools that became available after this result).
   */
  loadTools?: (names: string[]) => Tool[];
}

/**
 * Event model: all four categories of Pi `AgentEvent` (types.ts L428-443).
 * Chapter 03 completes `tool_execution_*` (the tool execution lifecycle, L441-450/L767-775).
 */
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: Message[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: Message; toolResults: Message[] }
  | { type: "message_start"; message: Message }
  | { type: "message_update"; message: Message; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: Message }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: ToolResult }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResult; isError: boolean };
