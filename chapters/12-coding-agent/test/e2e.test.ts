/**
 * Chapter 12 tests: E2E assembly integration (offline scripted LLM, full chain).
 *
 * Scenario: in a temp project (a copy of the fixture), fix the deliberate bug in calculator.ts; the full chain:
 *   Skill on-demand loading (09 catalog + read tool) → grep/read locate → edit fix → bash npm test
 *   → retry on failure → final reply → session persistence (07 tree) → restore and continue.
 * Dangerous bash (rm -rf) is blocked by the Chapter 11 permission-gate Extension in the real product chain (boundary integrity E:
 * the check is in the Extension layer, with zero changes to the loop and tools and zero file system contact).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AssistantMessageEvent, Message } from "../../00-minimal-llm-call/src/index.ts";
import { isDangerousCommand } from "../../11-extension-composition/src/permission-gate.ts";
import { createCodingAgent } from "../src/assembly.ts";
import { loadSkillFromFile } from "../src/extensions.ts";
import { copyFixtureToTemp } from "../src/fixture.ts";
import { loadTree } from "../src/jsonl.ts";
import permissionGate from "../../11-extension-composition/src/permission-gate.ts";

/** Streaming mock LLM: replays steps (repeats the last step once exhausted). */
class ScriptedLlm implements LLMAdapter {
  private steps: AssistantMessageEvent[][];
  private next = 0;

  constructor(steps: AssistantMessageEvent[][]) {
    this.steps = steps;
  }

  async *complete(): AsyncIterable<AssistantMessageEvent> {
    const events = this.steps[Math.min(this.next, this.steps.length - 1)];
    this.next++;
    yield* events;
  }
}

function textStream(text: string): AssistantMessageEvent[] {
  return [
    { type: "start", partial: { role: "assistant", stopReason: "end_turn" } },
    { type: "done", partial: { role: "assistant", stopReason: "end_turn", text } },
  ];
}

function toolStream(calls: { id: string; name: string; args: Record<string, unknown> }[]): AssistantMessageEvent[] {
  const partial = {
    role: "assistant",
    stopReason: "tool_use",
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args })),
  } as const;
  return [
    { type: "start", partial },
    ...calls.map((c) => ({ type: "toolcall_start" as const, partial })),
    { type: "done", partial },
  ];
}

/** Clean up all temp projects created by this test run. */
const projectDirs: string[] = [];
afterAll(() => {
  for (const dir of projectDirs) rmSync(dir, { recursive: true, force: true });
});

describe("E2E: full chain fixing calculator.ts (00-11 in one real execution chain)", () => {
  it("Skill on-demand loading → grep/read locate → edit fix → npm test retry on failure → final reply → session persistence", async () => {
    const project = copyFixtureToTemp();
    projectDirs.push(project);
    const sessionFile = join(project, ".lpia-session.jsonl");
    const skillFile = join(project, "skills", "verify.md");
    const calcFile = join(project, "src", "calculator.ts");
    // Target of the dangerous command: a real directory, to verify zero contact after blocking
    const victimDir = join(project, "keep");
    mkdirSync(victimDir);
    writeFileSync(join(victimDir, "keep.txt"), "must not be deleted", "utf8");

    const skill = loadSkillFromFile(skillFile, "verify", "Validate a fix: run npm test after fixing to confirm");
    const script = new ScriptedLlm([
      // 1. Dangerous command: rm -rf should be blocked by permission-gate (beforeToolCall hook, zero file contact)
      toolStream([{ id: "c1", name: "bash", args: { command: `rm -rf ${victimDir}` } }]),
      // 2. Skill on-demand loading (09 catalog + read tool)
      toolStream([{ id: "c2", name: "read_file", args: { path: skillFile } }]),
      // 3. grep locate (line number and content)
      toolStream([{ id: "c3", name: "grep", args: { pattern: "function add", path: "src" } }]),
      // 4. read the source
      toolStream([{ id: "c4", name: "read_file", args: { path: "src/calculator.ts" } }]),
      // 5. Run the tests before fixing: they fail (proving the bug exists)
      toolStream([{ id: "c5", name: "bash", args: { command: "npm test", timeout: 120 } }]),
      // 6. edit fix (targeted string replacement)
      toolStream([{ id: "c6", name: "edit", args: { path: "src/calculator.ts", edits: [{ oldText: "a - b", newText: "a + b" }] } }]),
      // 7. Rerun the tests: pass
      toolStream([{ id: "c7", name: "bash", args: { command: "npm test", timeout: 120 } }]),
      // 8. Final reply
      textStream("Fixed and validated"),
    ]);

    const { agent, runner, saveSession } = await createCodingAgent({
      cwd: project,
      model: "m",
      llm: script,
      skills: [skill],
      extensions: [permissionGate],
      sessionFile,
      systemPromptPrefix: "You are a coding assistant. First read the verify skill file to learn the validation workflow.",
    });

    const toolEvents: string[] = [];
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end") toolEvents.push(event.toolName);
    });

    await agent.prompt("Fix the bug in src/calculator.ts and run the tests to confirm the fix");

    // 1. The tool call chain is complete (read → grep → edit → bash → retry)
    expect(toolEvents).toEqual(["bash", "read_file", "grep", "read_file", "bash", "edit", "bash"]);

    // 2. Skill on-demand loading (09): the catalog is in the system prompt, content is not; read_file brings the skill content back
    expect(agent.state.systemPrompt).toContain("<available_skills>");
    expect(agent.state.systemPrompt).toContain(skillFile);
    expect(agent.state.systemPrompt).not.toContain("Fix workflow");
    const skillRead = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "read_file" && m.text?.includes("Fix workflow"));
    expect(skillRead?.text).toContain("npm test");

    // 3. The dangerous command is blocked by permission-gate (boundary integrity E: decided in the Extension layer, zero file contact)
    const blocked = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "bash" && m.isError);
    expect(blocked?.text).toContain("blocked");
    expect(existsSync(join(victimDir, "keep.txt"))).toBe(true);

    // 4. Tests fail before the fix (error result) → edit fix → rerun passes
    const failing = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "bash" && m.text?.includes("Command exited with code"));
    expect(failing?.text).toContain("expected 5");
    expect(failing?.text).not.toContain("All tests passed");
    const passing = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "bash" && m.text?.includes("All tests passed"));
    expect(passing).toBeDefined();
    expect(await import("node:fs/promises").then((fs) => fs.readFile(calcFile, "utf8"))).toContain("return a + b;");

    // 5. grep locate output (line number and content)
    const grepResult = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "grep");
    expect(grepResult?.text).toContain("calculator.ts:5: export function add");

    // 6. Final reply
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", text: "Fixed and validated" });
    expect(agent.state.isStreaming).toBe(false);

    // 7. Session persistence (07 tree): save → restore (leaf = the last entry)
    await saveSession();
    expect(existsSync(sessionFile)).toBe(true);
    const loaded = loadTree(sessionFile);
    expect(loaded).not.toBeNull();
    expect(loaded!.tree.getMessages()).toHaveLength(agent.state.messages.length);
    expect(loaded!.tree.getLeafId()).toBe(loaded!.tree.getEntries().at(-1)!.id);

    // 8. Restore and continue (memory across runs)
    const script2 = new ScriptedLlm([textStream("Continuing to confirm")]);
    const resumed = await createCodingAgent({
      cwd: project,
      model: "m",
      llm: script2,
      skills: [skill],
      extensions: [permissionGate],
      sessionFile,
      systemPromptPrefix: "You are a coding assistant. First read the verify skill file to learn the validation workflow.",
    });
    expect(resumed.agent.state.messages[0]).toMatchObject({ role: "user", text: "Fix the bug in src/calculator.ts and run the tests to confirm the fix" });
    await resumed.agent.prompt("Continue");
    expect(resumed.agent.state.messages).toHaveLength(agent.state.messages.length + 2);

    // 9. Boundary integrity (E): the blocking decision is in the Extension layer, not in the loop or tools
    expect(runner.hasHandlers("tool_call")).toBe(true);
    expect(isDangerousCommand(`rm -rf ${victimDir}`)).toBe(true);
  }, 60000);

  it("dangerous bash blocking in focus: zero file contact, blocking is provided by the Extension (reverse check of boundary integrity E)", async () => {
    const project = copyFixtureToTemp();
    projectDirs.push(project);
    const victimDir = join(project, "keep");
    mkdirSync(victimDir);
    writeFileSync(join(victimDir, "keep.txt"), "must not be deleted", "utf8");

    const skill = loadSkillFromFile(join(project, "skills", "verify.md"), "verify", "Validate a fix: run npm test after fixing to confirm");
    const script = new ScriptedLlm([
      toolStream([{ id: "c1", name: "bash", args: { command: `rm -rf ${victimDir}` } }]),
      textStream("Blocked"),
    ]);
    const { agent, runner } = await createCodingAgent({
      cwd: project,
      model: "m",
      llm: script,
      skills: [skill],
      extensions: [permissionGate],
    });

    await agent.prompt("Use bash to delete the keep directory");

    const blocked = agent.state.messages.find((m) => m.role === "toolResult" && m.toolName === "bash");
    expect(blocked?.isError).toBe(true);
    expect(blocked?.text).toContain("permission-gate");
    expect(existsSync(join(victimDir, "keep.txt"))).toBe(true);
    expect(runner.hasHandlers("tool_call")).toBe(true);
  });
});
