/**
 * Chapter 12 real-endpoint demo: assemble 00-11 into a Coding Agent that runs, and trace one real coding request through the whole system.
 *
 * Flow:
 *  1. copy the fixture temp project (src/calculator.ts with a deliberate bug + tests/ + skills/)
 *  2. assemble (07 Agent + 09 Skills + 10 Extension Runtime + 11 permission-gate + product toolset; 08 Compaction optional)
 *  3. request 1: fix the bug in calculator.ts and run the tests to confirm the fix
 *     (Skill on-demand loading → read/grep locate → edit fix → bash npm test → retry on failure → final reply)
 *  4. request 2: bash rm -rf deletes the dependency directory → blocked by the permission-gate Extension (real product chain)
 *  5. session persistence (07 tree): save → restore from the session file → continue the conversation
 *
 * Prerequisites: working LLM API credentials; the model is set through the CLAUDE_MODEL environment variable.
 * Run: npm run demo
 */
import { join } from "node:path";
import { AnthropicLlmAdapter } from "../../00-minimal-llm-call/src/index.ts";
import permissionGate from "../../11-extension-composition/src/permission-gate.ts";
import { createCodingAgent } from "./assembly.ts";
import { loadSkillFromFile } from "./extensions.ts";
import { copyFixtureToTemp } from "./fixture.ts";

/** Assembly layer trace (the core teaching output of Chapter 12: each layer maps to its Pi location and chapter). */
function assemblyLayer(name: string, pi: string, chapter: string): void {
  console.log(`[assembly] ${name}`);
  console.log(`        Pi: ${pi} / learn-pi-agent: ${chapter}`);
}

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("Set the CLAUDE_MODEL environment variable to the model to use");
  }

  // 1. Temp project (a copy of the fixture, so changes don't pollute the repo)
  const projectDir = copyFixtureToTemp();
  const sessionFile = join(projectDir, ".lpia-session.jsonl");
  console.log("=== learn-pi-agent Chapter 12: real coding toolset and assembly (real endpoint) ===\n");
  console.log(`Temp project: ${projectDir}`);
  console.log(`fixture contents: src/calculator.ts (with bug) + src/index.ts + tests/ + skills/\n`);

  // 2. Assemble 00-11
  assemblyLayer("00 base (types/adapter/EventStream)", "pi-ai + agent package types.ts", "00 Minimal LLM Call");
  assemblyLayer("07 Agent wrapper + TreeSession Session Tree", "agent-core agent.ts L173 + harness/session/", "07 Session Tree");
  assemblyLayer("08 Compaction (optional, not enabled in this demo)", "coding-agent core/compaction/compaction.ts (compactSession)", "08 Context Compaction");
  assemblyLayer("09 Skill catalog (content read on demand)", "agent-session.ts L963 buildSystemPrompt", "09 Skills");
  assemblyLayer("10 Extension Runtime wiring", "sdk.ts L362-367 + _installAgentToolHooks L486-522", "10 Extension Runtime");
  assemblyLayer("11 permission-gate Extension", "examples/extensions/permission-gate.ts", "11 Extension Composition");
  assemblyLayer("product toolset (read_file/write_file/edit/grep/bash)", "harness/tools/ + coding-agent core/tools/", "12 this file");

  const { agent, saveSession } = await createCodingAgent({
    cwd: projectDir,
    model,
    llm: new AnthropicLlmAdapter(),
    skills: [loadSkillFromFile(join(projectDir, "skills", "verify.md"), "verify", "Validate a fix: run npm test after fixing to confirm")],
    extensions: [permissionGate],
    sessionFile,
    systemPromptPrefix: "You are a coding assistant. When doing a task, first read the matching verify skill file and follow its workflow.",
  });

  agent.subscribe((event) => {
    if (event.type === "tool_execution_end") {
      const mark = event.isError ? " (error result)" : "";
      const preview = event.result.content.replace(/\n/g, " ").slice(0, 140);
      console.log(`  · tool: ${event.toolName}${mark} → ${preview}`);
    }
  });

  // 3. Request 1: a real coding task (Skill on-demand loading → locate → fix → validate → final reply)
  console.log("\n[request 1] Fix the bug in src/calculator.ts and run the tests to confirm the fix");
  await agent.prompt("Fix the bug in src/calculator.ts. First read the verify skill file to learn the validation workflow, then locate the problem, fix it and run the tests to confirm.");
  const finalReply = agent.state.messages.at(-1);
  console.log(`\n=== Final reply: ${finalReply?.text ?? "(none)"}`);

  // 4. Request 2: dangerous command blocking (permission-gate blocks rm -rf in the real product chain)
  console.log("\n[request 2] Try to run rm -rf node_modules with bash (should be blocked by permission-gate)");
  await agent.prompt("Use bash to run rm -rf node_modules to clean the dependency directory.");
  const blocked = agent.state.messages.at(-1);
  console.log(`Block result: ${blocked?.text ?? "(none)"}`);

  // 5. Session persistence (07 tree) → restore → continue
  await saveSession();
  console.log(`\nSession saved: ${sessionFile}`);
  const resumed = await createCodingAgent({
    cwd: projectDir,
    model,
    llm: new AnthropicLlmAdapter(),
    skills: [loadSkillFromFile(join(projectDir, "skills", "verify.md"), "verify", "Validate a fix: run npm test after fixing to confirm")],
    extensions: [permissionGate],
    sessionFile,
    systemPromptPrefix: "You are a coding assistant. When doing a task, first read the matching verify skill file and follow its workflow.",
  });
  console.log(`Messages after restore: ${resumed.agent.state.messages.length} (leaf = the last entry)`);
  await resumed.agent.prompt("Based on the current session, run npm test once more to confirm the project still passes.");
  console.log(`Messages after continuing: ${resumed.agent.state.messages.length}`);
  console.log(`Final reply after continuing: ${resumed.agent.state.messages.at(-1)?.text ?? "(none)"}`);

  console.log("\n=== Wrap-up ===");
  console.log("For the first time, all the mechanisms of 00-11 sit in one real execution chain: the tools are real (fs/child_process),");
  console.log("the permission policy lives in Extensions (the Chapter 10/11 mechanisms), and the loop and Agent need no knowledge of product policy.");
  console.log(`\nDemo workspace kept at: ${projectDir}`);
  console.log("(The temp project is kept: you can inspect the fixed src/calculator.ts and the session file .lpia-session.jsonl directly)");
}

main().catch((error: unknown) => {
  console.error("\nDemo failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
