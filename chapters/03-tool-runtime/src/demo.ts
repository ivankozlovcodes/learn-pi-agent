/**
 * Real API demo: Tool Runtime — the tool execution pipeline and tool_execution_* events.
 * Output levels: agent (==) / turn (--) / tool and message (·, indented 4 spaces).
 * Prerequisites: working LLM API credentials; the model is set via the CLAUDE_MODEL environment variable.
 * Run: npm run demo
 */
import { AnthropicLlmAdapter, createDemoTools } from "../../00-minimal-llm-call/src/index.ts";
import { agentLoop } from "./agent-loop.ts";

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("Set the CLAUDE_MODEL environment variable to the model to use");
  }

  const stream = agentLoop(
    [{ role: "user", text: "What is 12 + 30?" }],
    { systemPrompt: "You are a calculator assistant. Answer only by using the provided tools, and keep answers concise.", messages: [], tools: createDemoTools() },
    { model },
    new AnthropicLlmAdapter(),
  );

  for await (const event of stream) {
    switch (event.type) {
      case "turn_start":
        console.log("  -- turn start");
        break;
      case "tool_execution_start":
        console.log(`    · tool start: ${event.toolName}(${JSON.stringify(event.args)})`);
        break;
      case "tool_execution_end":
        console.log(`    · tool end: ${event.toolName} → ${event.isError ? "(error)" : event.result.content}`);
        break;
      case "message_start": {
        const m = event.message;
        if (m.role === "toolResult") {
          console.log(`    · toolResult: ${m.text}${m.terminate ? " (suggests stopping)" : ""}`);
        }
        break;
      }
      case "turn_end":
        console.log(`  -- turn end (toolResults: ${event.toolResults.length})`);
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
}

main().catch((error: unknown) => {
  console.error("\nDemo failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
