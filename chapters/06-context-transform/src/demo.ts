/**
 * Real API demo: Context Transformation, the projection from canonical context to LLM view (the core).
 * Old history stays in the canonical context; transformContext projects only the messages the current task needs to the LLM.
 * It doesn't rely on the model producing a second turn: whether the model uses a tool or answers directly, the projection is shown reliably.
 * Prerequisites: working LLM API credentials; the model is set through the CLAUDE_MODEL environment variable.
 * Run: npm run demo
 */
import { AnthropicLlmAdapter, createCalculatorTool } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentLoopConfig, AssistantMessage, Message } from "../../00-minimal-llm-call/src/index.ts";
import { agentLoop } from "./agent-loop.ts";

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("Set the CLAUDE_MODEL environment variable to the model to use");
  }

  // canonical history: an old conversation unrelated to the current task (kept in the Runtime, not in this LLM view)
  const oldReply: AssistantMessage = { role: "assistant", text: "Yesterday was sunny, 24 degrees.", stopReason: "end_turn" };
  const oldHistory: Message[] = [
    { role: "user", text: "What was the weather like yesterday?" },
    oldReply,
  ];

  const config: AgentLoopConfig = {
    model,
    // Core: the input is the full canonical context; the view projected to the LLM starts at the last user message.
    // Protocol constraint: a toolResult must be preceded by its matching assistant tool_use block, or the real endpoint returns 400,
    // so a plain slice(-N) won't do; cutting from "the last user message" is a protocol-safe window.
    // The return value is only the messages for this LLM request; it is not written back to canonical automatically
    transformContext: async (messages) => {
      let lastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      const view = messages.slice(lastUserIdx);
      console.log(`[transformContext] canonical=${messages.length} messages → llmView=${view.length} messages`);
      return view;
    },
    // getApiKey: resolved before every LLM call (for expiring OAuth tokens); this demo uses environment credentials and returns undefined
    getApiKey: () => {
      console.log("[getApiKey] resolved before each call (this demo returns undefined and uses environment credentials)");
      return undefined;
    },
    // shouldStopAfterTurn: shows the after-turn checkpoint; this demo doesn't rely on it to stop (the model's path varies), it only logs the call
    shouldStopAfterTurn: async () => {
      console.log("[shouldStopAfterTurn] after-turn check → don't stop");
      return false;
    },
  };

  const stream = agentLoop(
    [{ role: "user", text: "What is 12 + 30?" }],
    { systemPrompt: "You are a calculation assistant. Keep answers concise.", messages: oldHistory, tools: [createCalculatorTool()] },
    config,
    new AnthropicLlmAdapter(),
  );

  for await (const event of stream) {
    switch (event.type) {
      case "tool_execution_end":
        console.log(`· tool: ${event.toolName} → ${event.result.content}`);
        break;
      case "agent_end":
        console.log("== agent_end");
        break;
      default:
        break;
    }
  }

  const messages = await stream.result();
  console.log(`\n=== Final reply: ${messages.at(-1)?.text ?? "(none)"}`);
  console.log(`newMessages in this run: ${messages.length} (the ${oldHistory.length} old history messages in canonical were not trimmed automatically)`);
}

main().catch((error: unknown) => {
  console.error("\nDemo failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
