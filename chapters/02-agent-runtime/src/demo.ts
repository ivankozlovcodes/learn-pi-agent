/**
 * Real API demo: the full Agent Runtime, with the event stream + streaming character-by-character output.
 * Output levels: agent (==) / turn (--) / message (·, indented 4 spaces).
 * Prerequisites: working LLM API credentials; the model is set through the CLAUDE_MODEL environment variable.
 * Run: npm run demo
 */
import { AnthropicLlmAdapter, createDemoTools } from "../../00-minimal-llm-call/src/index.ts";
import { agentLoop } from "./agent-loop.ts";

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("Set the CLAUDE_MODEL environment variable to the model to use");
  }

  const llm = new AnthropicLlmAdapter();
  const stream = agentLoop(
    [{ role: "user", text: "What is 12 + 30?" }],
    { systemPrompt: "You are a calculator assistant. Answer only by using the provided tools, and keep answers concise.", messages: [], tools: createDemoTools() },
    { model },
    llm,
  );

  // How Pi consumes it: EventStream is an AsyncIterable; for await takes it one event at a time (pi-ai event-stream.ts)
  for await (const event of stream) {
    switch (event.type) {
      case "agent_start":
      case "agent_end":
        console.log(`\n== ${event.type}`);
        break;
      case "turn_start":
        console.log("  -- turn start");
        break;
      case "message_update":
        // The real adapter only produces updates for text_delta (tool-call turns have no delta events; their arrival shows up as the toolResult message)
        if (event.message.text) {
          process.stdout.write(`\r    · ${event.message.text}`);
        }
        break;
      case "message_start": {
        const m = event.message;
        if (m.role === "user") console.log(`    · user: ${m.text}`);
        if (m.role === "toolResult") console.log(`    · toolResult: ${m.toolName}: ${m.text}${m.isError ? " (error)" : ""}`);
        break;
      }
      case "message_end":
        if (event.message.role === "assistant" && event.message.text) console.log("");
        break;
      case "turn_end":
        console.log(`  -- turn end (toolResults: ${event.toolResults.length})`);
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
