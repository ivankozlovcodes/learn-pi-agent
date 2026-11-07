/**
 * Chapter 00 shared base: LLM adapter (streaming end to end, Pi-shaped).
 *
 * Maps to Pi's `StreamFn` (agent package types.ts L28-32). Pi has no non-streaming path:
 * `Models.streamSimple` always returns an `AssistantMessageEventStream`, and the loop consumes stream events uniformly
 * (agent-loop.ts L317-361). This chapter's interface follows that design: `complete()` returns an AsyncIterable event stream.
 *
 * Contract (same as the Pi StreamFn comment): failures don't throw, they are encoded in the stream. On error, the `done` event's
 * partial carries `stopReason: "error"` and the `errorMessage` text (pi-ai L439).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AssistantMessage, AssistantMessageEvent, Message, StopReason, Tool } from "./types.ts";

/** Input of one LLM call: the V0 shape of Pi `Context` (agent-loop.ts L298-302). */
export interface LLMRequest {
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: Tool[];
  /** API key resolved dynamically per call (where the Chapter 06 getApiKey hook lands; Pi L304-306). */
  apiKey?: string;
}

/** LLM adapter interface: `complete()` returns a sequence of streaming events (streaming end to end). */
export interface LLMAdapter {
  complete(input: LLMRequest, signal?: AbortSignal): AsyncIterable<AssistantMessageEvent>;
}

/**
 * The model ID is injected by the runtime environment (CLAUDE_MODEL); when unset, it is passed explicitly through the complete arguments. This chapter doesn't discuss model selection.
 */
const DEFAULT_MODEL = process.env.CLAUDE_MODEL ?? "";

/** Anthropic implementation: maps SDK `client.messages.stream()` events to unified stream events. */
export class AnthropicLlmAdapter implements LLMAdapter {
  private client: Anthropic;
  private model: string;

  constructor(opts?: { apiKey?: string; model?: string; baseURL?: string }) {
    this.client = new Anthropic({ apiKey: opts?.apiKey, baseURL: opts?.baseURL });
    this.model = opts?.model ?? DEFAULT_MODEL;
  }

  async *complete({ model, systemPrompt, messages, tools, apiKey }: LLMRequest, signal?: AbortSignal): AsyncIterable<AssistantMessageEvent> {
    const resolvedModel = model || this.model;
    if (!resolvedModel) {
      throw new Error("No model specified: pass a model ID via the CLAUDE_MODEL environment variable or the complete arguments");
    }
    let textAcc = "";
    let thinkingAcc = "";
    let thinkingSignature: string | undefined;
    // blockIndex: the SDK's content block index (counts text blocks too, so it can't be used as an array index)
    let toolCalls: { id: string; name: string; argsJson: string; blockIndex: number }[] = [];
    let stopReason: StopReason = "end_turn";
    let errorMessage: string | undefined;
    let sawStopReason = false;  // whether the stream received a stop_reason in message_delta (Pi L775-777 errors if not)

    const snapshot = (): AssistantMessage => ({
      role: "assistant",
      text: textAcc || undefined,
      thinking: thinkingAcc || undefined,
      thinkingSignature,
      toolCalls: toolCalls.map(({ id, name, argsJson }) => ({ id, name, arguments: parseArgs(argsJson) })),
      stopReason,
      errorMessage,
    });

    try {
      const stream = this.client.messages.stream(
        {
          model: resolvedModel,
          max_tokens: 16000,
          system: systemPrompt,
          messages: convertToLlm(messages),
          tools: tools.map(toAnthropicTool),
        },
        // apiKey: resolved dynamically per call (where the Chapter 06 getApiKey hook lands).
        // SDK 0.121's RequestOptions has no apiKey field, so the per-request override goes through the x-api-key request header.
        { signal, ...(apiKey ? { headers: { "x-api-key": apiKey } } : {}) },
      );

      // Contract (Pi L319-324): emit start as soon as the stream begins. It must be yielded after stream() is set up:
      // the request body is snapshotted when stream() is called, so a consumer pushing start's partial into its context no longer affects the sent request
      yield { type: "start", partial: snapshot() };

      for await (const event of stream) {
        switch (event.type) {
          case "content_block_start":
            if (event.content_block.type === "thinking") {
              thinkingSignature = event.content_block.signature;
            } else if (event.content_block.type === "redacted_thinking") {
              // Moderation rewrite: Pi L629-638 maps it to a [Reasoning redacted] thinking block + signature=data
              // (data is an opaque payload, sent back as-is as the signature, as the protocol requires)
              thinkingAcc = "[Reasoning redacted]";
              thinkingSignature = event.content_block.data;
            } else if (event.content_block.type === "tool_use") {
              toolCalls.push({
                id: event.content_block.id,
                name: event.content_block.name,
                argsJson: "",
                blockIndex: event.index,
              });
            }
            break;
          case "content_block_delta":
            if (event.delta.type === "text_delta") {
              textAcc += event.delta.text;
              yield { type: "text_delta", partial: snapshot() };
            } else if (event.delta.type === "thinking_delta") {
              // Reasoning delta: accumulated at block level (no streaming thinking events)
              thinkingAcc += event.delta.thinking;
            } else if (event.delta.type === "input_json_delta") {
              const tc = toolCalls.find((t) => t.blockIndex === event.index);
              if (tc) {
                tc.argsJson += event.delta.partial_json;
              }
            } else if (event.delta.type === "signature_delta") {
              // The thinking signature arrives in streamed signature_delta chunks (accumulated in Pi anthropic-messages.ts L691-697);
              // the signature in content_block_start is usually empty; without accumulating, the signature send-back guard would never be satisfied
              thinkingSignature = (thinkingSignature ?? "") + event.delta.signature;
            }
            break;
          case "message_delta":
            if (event.delta.stop_reason) {
              sawStopReason = true;
              const mapped = mapStopReason(event.delta.stop_reason);
              stopReason = mapped.reason;
              errorMessage = mapped.errorMessage ?? errorMessage;
            }
            break;
        }
      }

      // Pi L775-777: stream ended without stop_reason → report an explicit error (for teaching, encoded in done's stopReason)
      if (!sawStopReason) {
        stopReason = "error";
        errorMessage = "Stream ended without receiving a stop_reason";
      }
    } catch (error) {
      // Contract: failures don't throw, everything is encoded in the stream (Pi L784-794: all errors → error event); abort → aborted
      if (signal?.aborted) {
        stopReason = "aborted";
        errorMessage = "Operation aborted";
      } else {
        stopReason = "error";
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    }

    yield { type: "done", partial: snapshot() };
  }
}

/** provider stop_reason → unified StopReason (with error text, for cases like refusal). */
function mapStopReason(reason: Anthropic.Message["stop_reason"]): { reason: StopReason; errorMessage?: string } {
  switch (reason) {
    case "tool_use":
      return { reason: "tool_use" };
    case "max_tokens":
      return { reason: "length" };
    case "end_turn":
      return { reason: "end_turn" };
    case "refusal":
      // A safety refusal is a real response (HTTP 200), distinct from a hard API error: error + explicit text
      return { reason: "error", errorMessage: "The model refused the request (refusal)" };
    case "pause_turn":
    case "stop_sequence":
      // Pi L1365-1390: both count as a normal end (pause_turn comment "Stop is good enough -> resubmit");
      // they must not be misreported as error (pause_turn shows up with long outputs)
      return { reason: "end_turn" };
    default:
      return { reason: "error" };
  }
}

/** Parse failures degrade to an empty object: semantic argument validation belongs to the later Tool Runtime chapters; this chapter only provides a fallback for provider decoding. */
function parseArgs(json: string): Record<string, unknown> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * ★ Boundary conversion (Pi design point 1): unified `Message[]` → provider `MessageParam[]`
 * (Pi call site agent-loop.ts L295; defined in agent.ts L33-37).
 *
 * Consecutive toolResults are merged into one user message: Pi does the same in the provider-layer convertMessages
 * (anthropic-messages.ts L1266-1291, comment "needed for z.ai Anthropic endpoint").
 * Folding this provider normalization into this function is a teaching simplification; Pi does not
 * merge inside convertToLlm. Protocol reason: Anthropic recommends putting all tool results in the same user message
 * (splitting them into several messages confuses the model about parallel tool calls); tested on a real endpoint: when split, the second-turn call gets
 * an error (see the Chapter 05 demo diagnosis).
 */
export function convertToLlm(messages: Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];
  let pendingToolResults: Anthropic.ToolResultBlockParam[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length > 0) {
      result.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const m of messages) {
    // Filter UI-only messages (Pi comment example: Filter out UI-only messages, types.ts L170-172)
    if (m.uiOnly) {
      continue;
    }
    switch (m.role) {
      case "toolResult":
        pendingToolResults.push({
          type: "tool_result",
          tool_use_id: m.toolCallId ?? "",
          content: m.text ?? "",
          is_error: m.isError ?? false,
        });
        break;
      case "user":
        flushToolResults();
        // Pi convertMessages L1169-1176: user messages with empty/whitespace text are filtered out (protocol hygiene); never send content:""
        if (m.text?.trim()) {
          result.push({ role: "user", content: m.text });
        }
        break;
      case "assistant": {
        flushToolResults();
        const blocks: Anthropic.ContentBlockParam[] = [];
        // thinking send-back (protocol requirement: thinking blocks returned by the model must be passed back as-is, otherwise 400;
        // the SDK type requires the signature together with the text). Send-back conditions (the thinking block is sent only if met):
        // 1) both text and signature exist (missing signature, e.g. lost in a JSON round trip → drop thinking and send only text)
        // 2) the message also has text or toolCalls (the protocol requires thinking to be followed by text/tool_use;
        //    a thinking-only block (e.g. the partial of a mid-stream error/aborted) → skip thinking to avoid a 400)
        const assistant = m as AssistantMessage;
        if (assistant.thinking) {
          if (assistant.thinkingSignature && (assistant.text || (assistant.toolCalls?.length ?? 0) > 0)) {
            // Send-back condition: both text and signature exist, and the message has text or toolCalls (teaching guard to avoid a 400)
            blocks.push({ type: "thinking", thinking: assistant.thinking, signature: assistant.thinkingSignature });
          } else if (!assistant.thinkingSignature) {
            // No signature (aborted / lost in a JSON round trip): Pi L1232-1243 turns it into a text block to keep the reasoning instead of dropping it
            blocks.push({ type: "text", text: assistant.thinking });
          }
        }
        if (m.text) {
          blocks.push({ type: "text", text: m.text });
        }
        for (const tc of m.toolCalls ?? []) {
          blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
        }
        // Empty assistant (no blocks at all): Pi L1261 drops the whole message (no content: [], which removes the same protocol 400 risk)
        if (blocks.length === 0) {
          break;
        }
        result.push({ role: "assistant", content: blocks });
        break;
      }
    }
  }
  flushToolResults();
  return result;
}

function toAnthropicTool(tool: Tool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}
