/**
 * Real API demo: Parallel Tool Execution — two-stage parallelism and the dual event order.
 * Output levels: agent (==) / turn (--) / tool (·, indented 4 spaces) / toolResult message (indented 6 spaces).
 * Prerequisites: working LLM API credentials; the model is set via the CLAUDE_MODEL environment variable.
 * Run: npm run demo
 */
import { AnthropicLlmAdapter, createCalculatorTool, createEchoTool } from "../../00-minimal-llm-call/src/index.ts";
import type { Tool } from "../../00-minimal-llm-call/src/index.ts";
import { agentLoop } from "./agent-loop.ts";

/** Slow tool: demonstrates concurrency (800ms delay; run in parallel with fast tools, the total time is about that of the slowest). */
function slowTool(name: string, delayMs: number): Tool {
  return {
    name,
    description: `Finishes after ${delayMs}ms`,
    parameters: { type: "object", properties: {} },
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { content: `${name} done (${delayMs}ms)` };
    },
  };
}

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("Set the CLAUDE_MODEL environment variable to the model to use");
  }

  const stream = agentLoop(
    [
      {
        role: "user",
        text: "Do three tasks in turn: 1) compute 12+30; 2) echo \"parallel\"; 3) use the slow tool (it adds a delay). Then summarize the results.",
      },
    ],
    {
      systemPrompt: "You are a calculator assistant. Keep answers concise.",
      messages: [],
      tools: [createEchoTool(), createCalculatorTool(), slowTool("slow", 800)],
    },
    { model },
    new AnthropicLlmAdapter(),
  );

  const startTime = Date.now();
  let sawMultiToolBatch = false; // whether any turn had >1 tool call (a parallel batch)
  for await (const event of stream) {
    switch (event.type) {
      case "turn_start":
        console.log("  -- turn start");
        break;
      case "tool_execution_start":
        console.log(`    · tool start: ${event.toolName}`);
        break;
      case "tool_execution_end":
        console.log(`    · tool end: ${event.toolName} → ${event.isError ? "(error)" : event.result.content} (+${Date.now() - startTime}ms)`);
        break;
      case "message_start": {
        const m = event.message;
        if (m.role === "toolResult") {
          console.log(`      · toolResult message: ${m.toolName}`);
        }
        break;
      }
      case "turn_end":
        if (event.toolResults.length > 1) {
          sawMultiToolBatch = true;
        }
        console.log(`  -- turn end (toolResults: ${event.toolResults.length})`);
        break;
      case "agent_end":
        console.log("\n== agent_end");
        break;
      default:
        break;
    }
  }

  const messages = await stream.result();
  console.log(`\n=== Final reply: ${messages.at(-1)?.text ?? "(none)"}`);
  console.log(`Total time: ${Date.now() - startTime}ms`);
  // Only explain parallelism when a multi-tool batch actually happened; the tests provide stable evidence of the dual order
  if (sawMultiToolBatch) {
    console.log("A parallel batch occurred: the total time should be close to the slowest tool, not the sum (see the tests for the dual order).");
  } else {
    console.log("This time the model did not generate several tool calls in the same turn, so no parallel batch was triggered (the tests lock down the dual order).");
  }
}

main().catch((error: unknown) => {
  console.error("\nDemo failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
