/**
 * Real API demo: Extension Runtime.
 * Flow: load the four extensions in extensions/ → print the registered tools/commands → assemble (07 Agent + TreeSession
 * + createExtensionAwareConfig + event forwarding) → the model uses the hello/todo tools, delete_file is blocked
 * by guard → the /todos command shows the todos.
 * Prerequisites: working LLM API credentials; the model is set via the CLAUDE_MODEL environment variable.
 * Run: npm run demo
 */
import { fileURLToPath } from "node:url";
import { AnthropicLlmAdapter, createCalculatorTool } from "../../00-minimal-llm-call/src/index.ts";
import { Agent } from "../../07-session-tree/src/agent.ts";
import { TreeSession } from "../../07-session-tree/src/session-tree.ts";
import { ExtensionRunner } from "./runner.ts";
import { loadExtensionsFromDir } from "./loader.ts";
import { createExtensionAwareConfig, forwardAgentEvents } from "./index.ts";

const EXTENSIONS_DIR = fileURLToPath(new URL("../extensions", import.meta.url));

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("Set the CLAUDE_MODEL environment variable to the model to use");
  }

  // 1. Load the extensions (loader: directory discovery + default export factory)
  const factories = await loadExtensionsFromDir(EXTENSIONS_DIR);
  const runner = new ExtensionRunner({
    cwd: process.cwd(),
    config: { model, activeTools: [] },
    session: new TreeSession(),
  });
  await runner.load(factories);

  // 2. Activate all registered tools (Reconfigure action: ctx.setActiveTools, the same seam as Chapter 11 plan-mode)
  const ctx = runner.createContext();
  ctx.setActiveTools(runner.getRegisteredTools().map((t) => t.name));

  console.log("=== Extensions loaded ===");
  console.log("· tools:", runner.getVisibleTools().map((t) => t.name).join(", "));
  console.log("· commands:", runner.getCommands().map((c) => `/${c.name}`).join(", "));
  console.log(`· tool_call interception registered: ${runner.hasHandlers("tool_call")}`);

  // 3. Assemble: 07 Agent + extension hooks (beforeToolCall → Intercept, transformContext → Inject, loadTools linkage)
  //    + event forwarding (Observe) + messages written to the session tree (where Persist lands)
  const agent = new Agent({
    systemPrompt: "You are an assistant. Available tools: calculator (math), hello (greeting), todo (todos), delete_file (delete a file).",
    tools: [createCalculatorTool(), ...runner.getVisibleTools()],
    llm: new AnthropicLlmAdapter(),
    config: { model, ...createExtensionAwareConfig(runner) },
  });
  agent.subscribe(forwardAgentEvents(runner));
  agent.subscribe((event) => {
    if (event.type === "message_end") {
      ctx.session.appendMessage(event.message);
    }
  });
  agent.subscribe((event) => {
    if (event.type === "tool_execution_end") {
      const tag = event.isError ? " (blocked)" : "";
      console.log(`· tool: ${event.toolName} → ${event.result.content}${tag}`);
    }
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.text) {
      console.log(`· reply: ${event.message.text}`);
    }
  });

  console.log("\n=== Run (hello + todo + delete_file blocked) ===");
  await agent.prompt(
    "First greet Alice with the hello tool, then add two todos with the todo tool: write code review, fix bug. Finally, try to delete /tmp/learn-pi-agent-demo-remove-me.txt with delete_file.",
  );

  // 4. Command demo: /todos shows the todos on the current branch (Persist: state is derived from the session tree)
  console.log("\n=== /todos command (state derived from the session tree branch) ===");
  await runner.runCommand("todos", ctx);
  console.log(`session tree leaf: ${ctx.session.getLeafId()}`);
}

main().catch((error: unknown) => {
  console.error("\nDemo failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
