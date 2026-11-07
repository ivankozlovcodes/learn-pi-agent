/**
 * Real API demo: the Tool Calling loop (Chapter 00 shared base + Chapter 01 loop).
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

  const messages = await agentLoop({
    model,
    systemPrompt: "You are a calculator assistant. Answer only by using the provided tools, and keep answers concise.",
    messages: [{ role: "user", text: "What is 12 + 30?" }],
    tools: createDemoTools(),
    llm: new AnthropicLlmAdapter(),
  });

  for (const m of messages) {
    if (m.role === "assistant") {
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          console.log(`[assistant] requested tool: ${tc.name}(${JSON.stringify(tc.arguments)})`);
        }
      }
      if (m.text) {
        console.log(`[assistant] ${m.text}`);
      }
    } else if (m.role === "toolResult") {
      console.log(`[toolResult] ${m.toolName}: ${m.text}${m.isError ? " (error)" : ""}`);
    } else {
      console.log(`[user] ${m.text}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error("Demo failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
