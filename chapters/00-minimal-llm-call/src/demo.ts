/**
 * Chapter 00 demo: one LLM call (the first use of the end-to-end streaming interface).
 * It consumes the stream events but only cares about the final result. Later chapters (from 01) add the loop on top of this.
 * Prerequisites: working LLM API credentials; the model is set through the CLAUDE_MODEL environment variable.
 * Run: npm run demo
 */
import { AnthropicLlmAdapter } from "./llm.ts";
import { createDemoTools } from "./tools.ts";

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("Set the CLAUDE_MODEL environment variable to the model to use");
  }

  const llm = new AnthropicLlmAdapter();
  let finalText = "";

  for await (const event of llm.complete(
    {
      model,
      systemPrompt: "You are a concise assistant.",
      messages: [{ role: "user", text: "Introduce yourself in one sentence" }],
      tools: createDemoTools(),
    },
  )) {
    if (event.type === "text_delta") {
      process.stdout.write(`\r· ${event.partial.text}`);
    }
    if (event.type === "done") {
      finalText = event.partial.text ?? "";
    }
  }

  console.log(`\n=== Final reply: ${finalText}`);
  console.log("(Chapter 00: one request → one response; from Chapter 01 on, a loop is added on top of this)");
}

main().catch((error: unknown) => {
  console.error("\nDemo failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
