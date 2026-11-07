/**
 * Chapter 07 baseline (snapshot): minimal Agent wrapper (Reduce it: a minimal rebuild after a close reading of the Pi `Agent` class (agent.ts L173)).
 *
 * The rebuilt design (all anchored in Pi):
 * - `subscribe` (L250): event subscription, returns an unsubscribe function
 * - `state` getter (L260, JSDoc from L255): the public AgentState (messages/isStreaming/streamingMessage/pendingToolCalls/errorMessage)
 * - `processEvents` (L540-580): the single entry point from events → state machine
 *   message_start/update → streamingMessage；message_end → streamingMessage=undefined + messages.push
 *   tool_execution_start/end → add/remove pendingToolCalls; turn_end + errorMessage → errorMessage; agent_end → streamingMessage=undefined
 * - `prompt` (L350-356): concurrency guard (activeRun check) + runAgentLoop wiring
 * - `continue` (L361-410): the last message must be user/toolResult (Pi L74-76 semantics)
 *
 * Trimmed for teaching: steering/followUp queues and QueueMode, abort/waitForIdle, thinkingLevel replacement.
 * Session persistence is in session.ts (a minimal version of Pi harness/session's JsonlSessionRepo).
 *
 * New in Chapter 08 (the only addition in this file):
 * - `replaceMessages`: replace the state messages with the reconstructed canonical context.
 *   Pi's equivalent is agent-session.ts L2004-2007/L2329-2332:
 *   agent.state.messages = buildSessionContext().messages (refreshed right after a successful compact,
 *   so the next run in the same process uses summary + retained tail without reloading the session).
 */
import { runAgentLoop, runAgentLoopContinue, type AgentEventSink } from "./agent-loop.ts";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AssistantMessage, Message } from "../../00-minimal-llm-call/src/index.ts";

/** Public state: a teaching subset of Pi `AgentState` (types.ts L333-358). */
export interface AgentState {
  systemPrompt: string;
  model: string;
  tools: unknown[];
  messages: Message[];
  isStreaming: boolean;
  streamingMessage?: Message;
  pendingToolCalls: ReadonlySet<string>;
  errorMessage?: string;
}

/** Agent constructor options. */
export interface AgentOptions {
  systemPrompt: string;
  tools: unknown[];
  llm: LLMAdapter;
  config: AgentLoopConfig;
  /** Initial session messages (e.g. restored from a session). */
  initialMessages?: Message[];
}

export class Agent {
  private listeners = new Set<AgentEventSink>();
  private _state: AgentState;  // same as Pi: underscored field, state is a getter (agent.ts L260)
  private llm: LLMAdapter;
  private config: AgentLoopConfig;
  private activeRun: Promise<Message[]> | null = null;

  constructor(options: AgentOptions) {
    this.llm = options.llm;
    this.config = options.config;
    this._state = {
      systemPrompt: options.systemPrompt,
      model: options.config.model,
      tools: [...options.tools],
      messages: [...(options.initialMessages ?? [])],
      isStreaming: false,
      pendingToolCalls: new Set<string>(),
    };
  }

  /** Subscribe to events (Pi L250-253); returns an unsubscribe function. */
  subscribe(listener: AgentEventSink): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Public state (Pi L260, the getter body; JSDoc from L255). */
  get state(): AgentState {
    return this._state;
  }

  /**
   * Chapter 08 seam: replace the state messages with the reconstructed canonical context
   * (Pi agent-session.ts L2004-2007: agent.state.messages = buildSessionContext().messages).
   * After a successful compact, the caller calls it with compactSession(...).context;
   * the next prompt/continue then uses summary + retained tail, without reloading the session.
   */
  replaceMessages(messages: Message[]): void {
    this._state.messages = [...messages];
  }

  /** Start a prompt (Pi L350-356: concurrency guard + runAgentLoop wiring). */
  async prompt(input: string | Message): Promise<Message[]> {
    if (this.activeRun) {
      throw new Error("Agent is already processing; wait for it to finish (Pi: Already processing a prompt)");
    }
    const message: Message = typeof input === "string" ? { role: "user", text: input } : input;

    const run = this.runWithLifecycle((emit) =>
      runAgentLoop([message], this.createContext(), this.config, this.llm, emit),
    );
    this.activeRun = run;
    try {
      return await run;
    } finally {
      this.activeRun = null;
    }
  }

  /** Continue from the current session (Pi L361-410: the last message must be user/toolResult, otherwise throw). */
  async continue(): Promise<Message[]> {
    if (this.activeRun) {
      throw new Error("Agent is already processing; wait for it to finish");
    }
    const last = this._state.messages[this._state.messages.length - 1];
    if (!last) {
      throw new Error("No messages to continue from (Pi: No messages to continue from)");
    }
    if (last.role === "assistant") {
      throw new Error("Cannot continue from an assistant message (Pi: Cannot continue from message role: assistant)");
    }

    const run = this.runWithLifecycle((emit) =>
      runAgentLoopContinue(this.createContext(), this.config, this.llm, emit),
    );
    this.activeRun = run;
    try {
      return await run;
    } finally {
      this.activeRun = null;
    }
  }

  /** State → loop input context (Pi `createContextSnapshot`). */
  private createContext(): AgentContext {
    return {
      systemPrompt: this._state.systemPrompt,
      messages: [...this._state.messages],
      tools: this._state.tools as never,
    };
  }

  /** Run lifecycle: events → processEvents + subscribers; isStreaming is controlled by the run boundary. */
  private async runWithLifecycle(
    start: (emit: AgentEventSink) => Promise<Message[]>,
  ): Promise<Message[]> {
    this._state.isStreaming = true;
    // At the start of each run, clear the previous run's runtime state (leaked errorMessage, ghost pendingToolCalls)
    this._state.errorMessage = undefined;
    this._state.pendingToolCalls = new Set<string>();
    try {
      return await start(async (event: AgentEvent) => {
        await this.processEvents(event);
        for (const listener of this.listeners) {
          await listener(event);
        }
      });
    } catch (error) {
      // Pi handleRunFailure (agent.ts L512-526): the exception is neither silently swallowed nor rethrown;
      // a failure message goes into history + errorMessage is set (the error is observable, and the trailing assistant message makes the continue constraint apply)
      await this.handleRunFailure(error);
      return [];
    } finally {
      this._state.isStreaming = false;
      this._state.streamingMessage = undefined;
      // Pi finishRun (L528-536): finally clears pendingToolCalls (no ghost leftovers after an exception breaks through the run)
      this._state.pendingToolCalls = new Set<string>();
    }
  }

  /** Run failure → failure message + events (Pi handleRunFailure L512-526; goes straight to processEvents, not through listeners). */
  private async handleRunFailure(error: unknown): Promise<void> {
    const failureMessage: AssistantMessage = {
      role: "assistant",
      stopReason: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
    await this.processEvents({ type: "message_start", message: failureMessage });
    await this.processEvents({ type: "message_end", message: failureMessage });
    await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
    await this.processEvents({ type: "agent_end", messages: [failureMessage] });
  }

  /**
   * Events → state machine (Pi L540-580, simplified).
   * Single entry point: every state change happens here; outside code can only read state.
   */
  private async processEvents(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "message_start":
      case "message_update":
        this._state.streamingMessage = event.message;
        break;

      case "message_end":
        this._state.streamingMessage = undefined;
        this._state.messages.push(event.message);
        break;

      case "tool_execution_start": {
        const pending = new Set(this._state.pendingToolCalls);
        pending.add(event.toolCallId);
        this._state.pendingToolCalls = pending;
        break;
      }

      case "tool_execution_end": {
        const pending = new Set(this._state.pendingToolCalls);
        pending.delete(event.toolCallId);
        this._state.pendingToolCalls = pending;
        break;
      }

      case "turn_end":
        if (event.message.role === "assistant" && event.message.errorMessage) {
          this._state.errorMessage = event.message.errorMessage;
        }
        break;

      case "agent_end":
        this._state.streamingMessage = undefined;
        break;
    }
  }
}
