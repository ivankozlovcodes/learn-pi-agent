/**
 * Chapter 10 core: the teaching subset of ExtensionAPI (Reduce it, a close reading of Pi coding-agent extensions/types.ts).
 *
 * Pi's ExtensionAPI (types.ts from L1237-1261) has 70+ APIs: about 35 events on on(), registerTool,
 * registerCommand/registerShortcut/registerFlag, registerProvider, getCommands, the UI domain, and more.
 * The teaching version takes only a minimal skeleton of six capabilities (all anchored in Pi):
 *
 * | Capability | Pi anchor | Teaching subset |
 * |---|---|---|
 * | Observe (subscribe) | on() event family L1237-1261 | on("message_end"/"turn_end") |
 * | Intercept (intercept) | on("tool_call") → ToolCallEventResult | on("tool_call") → { block, reason } |
 * | Extend (extend) | registerTool (ToolDefinition type L449, method signature L1286) / registerCommand L1295 | same as left |
 * | Reconfigure (configure) | ExtensionAPI config domain (setActiveTools L1384) | ctx.getActiveTools/setActiveTools actions (bindToolRuntime writes the running Agent; config.activeTools is synced data) |
 * | Inject (inject) | on("context") → ContextEventResult; sdk.ts transformContext → emitContext | on("context") → returns Message[] |
 * | Persist (persist) | ctx.sessionManager + appendCustomEntry | ctx.session (Chapter 07 TreeSession) |
 *
 * Teaching simplifications: 35+ events → 4, multiple ExtensionMode modes → "cli",
 * registerProvider / the UI domain (theme/keybindings/statusline) / getArgumentCompletions are not covered.
 */
import type { AssistantMessage, Message, Tool, ToolCall, ToolParameters, ToolResult } from "../../00-minimal-llm-call/src/index.ts";
import type { TreeSession } from "../../07-session-tree/src/session-tree.ts";

/** Event set: the teaching subset of Pi's on() event family (types.ts L1237-1261). */
export interface ExtensionEvents {
  /** Intercept: before a tool call (Pi ToolCallEvent, L932 emitToolCall). */
  tool_call: { assistantMessage: AssistantMessage; toolCall: ToolCall; args: unknown };
  /** Inject: context transform before the LLM call (Pi ContextEvent + sdk.ts L362-367 emitContext). */
  context: { messages: Message[] };
  /** Observe: a single message ends (Pi MessageEndEvent). */
  message_end: { message: Message };
  /** Observe: turn end (Pi TurnEndEvent). */
  turn_end: { message: Message; toolResults: Message[] };
}

/** Return value of the tool_call event: block semantics (teaching subset of Pi ToolCallEventResult: block/reason). */
export interface ToolCallEventResult {
  block?: boolean;
  reason?: string;
}

/** Return value of the context event: the messages after injection (Pi ContextEventResult simplified for teaching: return Message[] or nothing). */
export type ContextEventResult = Message[] | void;

/** Event handler function: Pi ExtensionHandler (types.ts L1225-1227, event + ctx). */
export type ExtensionHandler<K extends keyof ExtensionEvents> = (
  event: ExtensionEvents[K],
  ctx: ExtensionContext,
) => unknown;

/**
 * Tool runtime binding: the assembly layer (demo/tests) hands the runner "name → Tool" resolution and "write to the running Agent"
 * (Pi bindCore's setActiveTools action, agent-session.ts L2583 → setActiveToolsByName L950-972).
 * invariant: an Extension only calls the ctx.setActiveTools action and never gets the Agent instance.
 */
export interface ToolRuntimeBinding {
  /** Resolve names to Tools (the assembly layer holds the full tool universe: built-in tools + extension registry); unknown names are ignored. */
  resolve(toolNames: string[]): Tool[];
  /** Write the resolved tools to the running Agent's state.tools right away (visible on the next provider call). */
  apply(tools: Tool[]): void;
}

/** Extension context: the teaching subset of Pi ExtensionContext (types.ts from L310; L307-309 is ExtensionMode). */
export interface ExtensionContext {
  /** Current working directory (Pi ctx.cwd). */
  cwd: string;
  /** Run mode (Pi ExtensionMode L307 has several modes; the teaching version covers only "cli"). */
  mode: "cli";
  /** Minimal Reconfigure domain: runtime config (activeTools is data synced by the action; switching must go through setActiveTools). */
  config: RuntimeConfig;
  /** Minimal Persist domain: the Chapter 07 session tree (a teaching simplification of Pi's read-only ctx.sessionManager access). */
  session: TreeSession;
  /** Reconfigure action: the current active tool names (Pi ExtensionAPI getActiveTools L1378). */
  getActiveTools(): string[];
  /**
   * Reconfigure action: switch the active tool set (Pi ExtensionAPI setActiveTools L1384 →
   * setActiveToolsByName: resolve by name, ignore unknown names, write agent.state.tools right away, sync config.activeTools.
   * Pi also rebuilds the system prompt; the teaching version doesn't cover that).
   */
  setActiveTools(toolNames: string[]): void;
}

/** Minimal runtime config (Reconfigure capability). */
export interface RuntimeConfig {
  /** Current model. */
  model: string;
  /**
   * Tool names currently visible to the model (query interface: declared initially by the assembly layer, written back by the setActiveTools action;
   * extensions must not mutate it directly: switching must go through ctx.setActiveTools).
   */
  activeTools: string[];
}

/** Extension tool: Pi ToolDefinition.execute(..., ctx) (ToolDefinition type from types.ts L449) simplified for teaching; ctx is injected by the wrapper. */
export interface ExtensionTool {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute(
    args: Record<string, unknown>,
    ctx: ExtensionContext,
    onUpdate?: (partial: ToolResult) => void,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
}

/** Registered command: the teaching subset of Pi RegisteredCommand (L1295 registerCommand). */
export interface RegisteredCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

/** Extension factory: the default export receives ExtensionAPI (Pi loader: a module's default export is the extension entry point). */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

/** Extension API: the surface passed to the extension factory (teaching subset of Pi ExtensionAPI). */
export interface ExtensionAPI {
  /** Subscribe to events (the single entry point for Observe / Intercept / Inject). */
  on<K extends keyof ExtensionEvents>(event: K, handler: ExtensionHandler<K>): void;
  /** Register a tool (Extend): a tool the LLM can call; the wrapper injects ctx. */
  registerTool(tool: ExtensionTool): void;
  /** Register a command (Extend): a user command. */
  registerCommand(name: string, options: Omit<RegisteredCommand, "name">): void;
}
