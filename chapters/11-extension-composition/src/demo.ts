/**
 * Real API demo: Extension Composition (workflows with zero Core changes).
 * Flow: load three case extensions (permission-gate / plan-mode / subagent) + the teaching bash tool →
 * assemble (07 Agent + Chapter 10 runtime hooks + bindToolRuntime binding) → trigger the three workflows in turn:
 * 1. permission-gate: bash rm -rf is blocked (the extension version of the official "No permission popups")
 * 2. plan-mode: /plan turns on read-only → the same Agent's tool list changes immediately (allowlisted commands pass,
 *    others are blocked) → /plan off restores it
 * 3. subagent: delegate to an independent agent (the extension version of the official "No sub-agents")
 * Wrap-up: three workflows done with extension composition; the core loop stays unchanged.
 * Prerequisites: working LLM API credentials; the model is set via the CLAUDE_MODEL environment variable.
 * Run: npm run demo
 */
import { AnthropicLlmAdapter, createCalculatorTool } from "../../00-minimal-llm-call/src/index.ts";
import type { Tool } from "../../00-minimal-llm-call/src/index.ts";
import { Agent } from "../../07-session-tree/src/agent.ts";
import { TreeSession } from "../../07-session-tree/src/session-tree.ts";
import { ExtensionRunner } from "../../10-extension-runtime/src/runner.ts";
import { createExtensionAwareConfig } from "../../10-extension-runtime/src/index.ts";
import type { RuntimeConfig } from "../../10-extension-runtime/src/extension-api.ts";
import { createBashTool } from "./bash-tool.ts";
import permissionGate from "./permission-gate.ts";
import planMode from "./plan-mode.ts";
import subagent from "./subagent.ts";

/** Demo tool set (tool names that really exist: built-in bash/calculator + registered subagent). */
const DEMO_TOOLS = ["bash", "calculator", "subagent"];

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("Set the CLAUDE_MODEL environment variable to the model to use");
  }

  // 1. Load the three case extensions (all through the Chapter 10 runtime, zero Core changes)
  const config: RuntimeConfig = { model, activeTools: [...DEMO_TOOLS] };
  const runner = new ExtensionRunner({ cwd: process.cwd(), config, session: new TreeSession() });
  await runner.load([permissionGate, planMode, subagent]);
  console.log("=== Three case extensions loaded (all through the Chapter 10 runtime) ===");
  console.log("· Commands:", runner.getCommands().map((c) => `/${c.name}`).join(", "));

  // 2. Assemble: 07 Agent + extension hooks + tool runtime binding. The assembly layer holds the full tool universe;
  //    an Extension only takes effect through the ctx.setActiveTools action and never gets the Agent instance.
  const allTools: Tool[] = [createBashTool(), createCalculatorTool(), ...runner.getRegisteredTools()];
  const agent = new Agent({
    systemPrompt: "You are an assistant. Available tools: bash (execute commands), calculator (calculate), subagent (delegate to a subagent).",
    tools: [...allTools],
    llm: new AnthropicLlmAdapter(),
    config: { model, ...createExtensionAwareConfig(runner) },
  });
  runner.bindToolRuntime({
    resolve: (names) => allTools.filter((t) => names.includes(t.name)),
    apply: (tools) => {
      agent.state.tools = tools;
    },
  });
  agent.subscribe((event) => {
    if (event.type === "tool_execution_end") {
      console.log(`· Tool: ${event.toolName} → ${event.result.content}${event.isError ? " (blocked)" : ""}`);
    }
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.text) {
      console.log(`· Reply: ${event.message.text}`);
    }
  });
  console.log("· Initial tools (visible to provider):", agent.state.tools.map((t) => (t as Tool).name).join(", "));

  // 3. Case 1: permission-gate (No permission popups → extension)
  console.log("\n=== Case 1: permission-gate (No permission popups → extension) ===");
  await agent.prompt(
    "First use bash to execute rm -rf /tmp/learn-pi-agent-demo-remove-me (permission-gate will block it), then use bash to execute echo hello to confirm commands still work.",
  );

  // 4. Case 2: plan-mode (No plan mode → extension)
  console.log("\n=== Case 2: plan-mode (No plan mode → extension) ===");
  await runner.runCommand("plan");
  console.log(`· Same Agent tool list (after /plan): ${agent.state.tools.map((t) => (t as Tool).name).join(", ")}`);
  await agent.prompt(
    "You are now in read-only exploration mode: first use bash to execute ls -la, then try to use bash to execute rm -rf /tmp/learn-pi-agent-demo-remove-me (plan mode should block it).",
  );
  await runner.runCommand("plan");
  console.log(`· Same Agent tool list (after exiting /plan): ${agent.state.tools.map((t) => (t as Tool).name).join(", ")}`);

  // 5. Case 3: subagent (No sub-agents → extension)
  console.log("\n=== Case 3: subagent (No sub-agents → extension) ===");
  await agent.prompt(
    "Delegate a task to subagent: \"Research the number of chapters under the chapters directory of the learn-pi-agent project and summarize the structure\"; pass the subagent's reply on to me once you receive it.",
  );

  // 6. Conclusion: policy comes from extension composition; the core loop stays unchanged.
  console.log("\n=== Extension composition done: the core loop stays unchanged ===");
  console.log("All three workflows come from the Chapter 10 Extension Runtime (on/registerTool/registerCommand/ctx.setActiveTools).");
  console.log("Zero changes to the loop, the Agent and the session tree. Every item on the official No list can be built on top of where the Harness stops.");
}

main().catch((error: unknown) => {
  console.error("\nDemo failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
