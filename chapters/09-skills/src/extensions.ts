/**
 * Chapter 09's minimal extension points: let capabilities enter the Harness as data.
 *
 * 1. **Skill** (Pi harness/types.ts L46-56): name/description/content/filePath.
 *    content lives only in the skill file; the system prompt lists only the catalog (name/description/location),
 *    and the model reads it on demand with the read tool once a description matches (the Pi system-prompt.ts L3-25 mechanism).
 * 2. **formatSkillsForSystemPrompt** (Pi harness/system-prompt.ts): the catalog block.
 *    Teaching simplification: attribute format `<skill name=… location=…>` (Pi uses child elements), no XML escaping.
 * 3. **readSkillContent / loadSkillFromFile** (Pi harness/skills.ts L50-76): read the skill file on demand.
 *    Teaching simplification: read the file directly; no directory scanning/frontmatter/ignore parsing.
 * 4. **formatSkillInvocation** (Pi harness/skills.ts L38-41): the full skill block injected after reading.
 * 5. **addedToolNames** (Pi types.ts L368-369 + the ToolResultMessage comment): a tool result brings in new tools
 *    (paired with the loadTools hook in the 00 shared base and the dynamic merge on the loop side).
 *
 * Together with the uiOnly message filter in the 00 shared base (Pi comment example: Filter out UI-only messages),
 * Chapter 09 covers three forms of extension: message model extension, prompt extension, tool set extension.
 */
import { readFileSync } from "node:fs";
import type { Tool } from "../../00-minimal-llm-call/src/index.ts";

/** Skill: a teaching subset of Pi `Skill` (harness/types.ts L46-56) (4 fields; disableModelInvocation is not covered). */
export interface Skill {
  /** Stable skill name (used in the model-visible list). */
  name: string;
  /** Short description of when to use the skill (the model decides from it whether to read). */
  description: string;
  /** Full skill instructions (loaded from the skill file; not injected into the system prompt). */
  content: string;
  /** Skill file location: the location in the catalog block, which the model reads from (Pi filePath). */
  filePath: string;
}

/**
 * Skills → system prompt catalog block (Pi `formatSkillsForSystemPrompt`, system-prompt.ts L3-25).
 * Mechanism aligned with Pi: list only name/description/location; content stays in the skill file,
 * and the model reads it on demand once a description matches (Pi L9 instruction: Read the full skill file when the task matches its description).
 * Teaching simplification: attribute format (Pi uses child elements), no XML escaping.
 */
export function formatSkillsForSystemPrompt(skills: Skill[]): string {
  if (skills.length === 0) {
    return "";
  }
  const lines = [
    "The following skills provide specialized instructions for specific tasks. When a task matches a skill's description, first read that skill file (location), then follow its full instructions.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push(`  <skill name="${skill.name}" location="${skill.filePath}">`);
    lines.push(`    <description>${skill.description}</description>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

/** Read a skill file on demand (Pi: skills are files the model reads with a tool once a description matches; the teaching version reads the file directly). */
export function readSkillContent(filePath: string): string {
  return readFileSync(filePath, "utf-8");
}

/**
 * Load a skill from a skill file: content = the file body (a minimal version of Pi `loadSkills`;
 * file discovery details like directory scanning/SKILL.md/frontmatter/ignore are not covered).
 */
export function loadSkillFromFile(filePath: string, name: string, description: string): Skill {
  return { name, description, content: readSkillContent(filePath), filePath };
}

/** Skill invocation block (Pi `formatSkillInvocation`, skills.ts L38-41): the full instruction format injected after reading.
 * Aligned with Pi: additionalInstructions uses a truthiness check (passing "" appends nothing, skills.ts L40);
 * Trimmed: Pi's block includes a references guide line (L39 References are relative to...); the teaching version doesn't resolve relative references. */
export function formatSkillInvocation(skill: Skill, additionalInstructions?: string): string {
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\n${skill.content}\n</skill>`;
  return additionalInstructions ? `${block}\n\n${additionalInstructions}` : block;
}

/** Simple tool registry: used by loadTools hook implementations (name → Tool). */
export function createToolRegistry(initial: Tool[]): { find: (name: string) => Tool | undefined; load: (names: string[]) => Tool[] } {
  const tools = new Map(initial.map((t) => [t.name, t]));
  return {
    find: (name) => tools.get(name),
    load: (names) => names.map((name) => tools.get(name)).filter((t): t is Tool => t !== undefined),
  };
}
