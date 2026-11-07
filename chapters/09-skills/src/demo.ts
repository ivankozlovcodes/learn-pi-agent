/**
 * Real API demo: Skills & Extensions, combining the three forms of extension.
 * Flow: the skill catalog goes into the system prompt (content isn't in it) → the model reads the skill file on demand (read_skill)
 * → follows the skill instructions → a tool result's addedToolNames dynamically unlocks the echo tool, which the model uses in later turns.
 * Prerequisites: working LLM API credentials; the model is set via the CLAUDE_MODEL environment variable.
 * Run: npm run demo
 */
import { fileURLToPath } from "node:url";
import { AnthropicLlmAdapter, createCalculatorTool, createEchoTool } from "../../00-minimal-llm-call/src/index.ts";
import type { Tool } from "../../00-minimal-llm-call/src/index.ts";
import { runAgentLoop } from "./agent-loop.ts";
import { createToolRegistry, formatSkillsForSystemPrompt, loadSkillFromFile, readSkillContent } from "./extensions.ts";

/** Skill file: content lives only here and doesn't go into the system prompt (Pi: skills are files). */
const SKILL_FILE = fileURLToPath(new URL("../skills/calc.md", import.meta.url));

/** Dynamic tool: unlocks echo. */
function unlockTool(): Tool {
  return {
    name: "unlock_echo",
    description: "Unlock the echo tool (available once unlocked)",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: "echo unlocked", addedToolNames: ["echo"] };
    },
  };
}

/** On-demand read tool: the model calls it once a skill description matches; returns the skill file's full instructions (Pi: the model reads skill files with the read tool). */
function readSkillTool(): Tool {
  return {
    name: "read_skill",
    description: "Read a skill file (the argument is the location from the skill catalog)",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Skill file path" } },
      required: ["path"],
    },
    async execute(args: { path: string }) {
      return { content: readSkillContent(args.path) };
    },
  };
}

async function main(): Promise<void> {
  const model = process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error("Set the CLAUDE_MODEL environment variable to the model to use");
  }

  const llm = new AnthropicLlmAdapter();
  const registry = createToolRegistry([createEchoTool()]);

  // The skill catalog goes into the system prompt (Pi formatSkillsForSystemPrompt: lists only name/description/location)
  const calcSkill = loadSkillFromFile(SKILL_FILE, "calc", "Handle arithmetic calculations");
  const skillsBlock = formatSkillsForSystemPrompt([calcSkill]);
  const systemPrompt = `You are a calculation assistant.\n${skillsBlock}`;

  console.log("=== System prompt (skill catalog, content isn't in it) ===");
  console.log(skillsBlock + "\n");

  const messages = await runAgentLoop(
    [
      {
        role: "user",
        text: "First use unlock_echo to unlock echo, then echo \"hello\", then compute 12 + 30. Read the calc skill file before calculating.",
      },
    ],
    { systemPrompt, messages: [], tools: [createCalculatorTool(), unlockTool(), readSkillTool()] },
    {
      model,
      loadTools: (names) => registry.load(names),
    },
    llm,
    (event) => {
      if (event.type === "tool_execution_end") {
        const tag = event.result.addedToolNames?.length ? ` (unlocked ${event.result.addedToolNames.join(",")})` : "";
        console.log(`· tool: ${event.toolName} → ${event.result.content}${tag}`);
      }
    },
  );

  console.log(`\n=== Final reply: ${messages.at(-1)?.text ?? "(none)"}`);
}

main().catch((error: unknown) => {
  console.error("\nDemo failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
