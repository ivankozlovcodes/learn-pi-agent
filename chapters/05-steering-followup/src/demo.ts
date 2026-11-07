/**
 * Real API demo: Steering & Follow-up — the two-level loop.
 * steering and follow-up are simulated by scripted providers (config hooks; Pi's mechanism is hooks too).
 * steering is returned on the 2nd poll (the initial poll is empty → picked up after turn 1 completes) —
 * this shows steering that "arrives during the run and takes effect between turns", not a message queued before the run.
 * Prerequisites: working LLM API credentials; the model is set via the CLAUDE_MODEL environment variable.
 * Run: npm run demo
 */
import { AnthropicLlmAdapter, createCalculatorTool, createEchoTool } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentLoopConfig } from "../../00-minimal-llm-call/src/index.ts";
import { agentLoop } from "./agent-loop.ts";

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("Set the CLAUDE_MODEL environment variable to the model to use");
  }

  let steeringCalls = 0;
  let followUpCalls = 0;
  const config: AgentLoopConfig = {
    model,
    // Simulate the user sending a message while the agent is running (injected during the run).
    // Poll 1 is the initial poll (before the run starts, no messages); poll 2 is picked up after the first turn completes —
    // the message is injected at the start of the next turn (takes effect between turns, without interrupting the current turn's tool execution).
    // Contract: must return [] when there are no messages (Pi types.ts L242-243), or the inner loop never stops
    getSteeringMessages: async () => {
      steeringCalls++;
      if (steeringCalls === 2) {
        console.log("\n[steering] After the first turn ends, the user sends: \"Also echo hello\" (takes effect next turn)");
        return [{ role: "user", text: "Also echo hello back to me" }];
      }
      return [];
    },
    // Simulate the user adding a task just as the agent is about to exit (injected after stopping).
    // Contract: also bounded (Pi types.ts L255-256), or the outer loop never stops
    getFollowUpMessages: async () => {
      followUpCalls++;
      if (followUpCalls === 1) {
        console.log("\n[follow-up] The agent is about to exit; the user adds: \"Calculate 100-40\"");
        return [{ role: "user", text: "Now calculate 100 minus 40" }];
      }
      return [];
    },
  };

  const stream = agentLoop(
    [{ role: "user", text: "What is 12 + 30?" }],
    { systemPrompt: "You are a calculator assistant. Keep answers concise.", messages: [], tools: [createEchoTool(), createCalculatorTool()] },
    config,
    new AnthropicLlmAdapter(),
  );

  for await (const event of stream) {
    switch (event.type) {
      case "turn_start":
        console.log("-- turn start");
        break;
      case "message_start": {
        const m = event.message;
        if (m.role === "user") console.log(`· user: ${m.text}`);
        break;
      }
      case "tool_execution_end":
        console.log(`· tool: ${event.toolName} → ${event.result.content}`);
        break;
      case "turn_end":
        console.log(`-- turn end`);
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
