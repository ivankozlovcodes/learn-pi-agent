/**
 * Chapter 12 core: assembly (teaching version of the Pi startup chain createAgentSessionRuntime (agent-session-runtime.ts L414)).
 *
 * Assemble all the mechanisms of 00-11 into a Coding Agent that runs:
 * - 00 base: Message/Tool/AgentLoopConfig/LLMAdapter (imported from the shared base)
 * - 07 Agent wrapper + TreeSession Session Tree (synced copies in this directory: src/agent.ts / session-tree.ts / jsonl.ts)
 * - 08 compaction: optional (passing compact thresholds enables Session Compaction; checked at saveSession,
 *   compacting only over the limit: CompactionEntry appended and persisted to disk + agent state refreshed to the rebuilt context;
 *   **does not go through transformContext**; compaction belongs to the Session lifecycle, see Chapter 08 semantics)
 * - 09 Skill catalog: formatSkillsForSystemPrompt lists only name/description/location; content is read on demand
 *   (Pi agent-session.ts L963 _rebuildSystemPrompt → buildSystemPrompt)
 * - 10 Extension Runtime: ExtensionRunner + createExtensionAwareConfig wiring
 *   (beforeToolCall → emitToolCall interception, transformContext → emitContext injection, loadTools dynamic tools,
 *   Pi core/sdk.ts L362-367 + _installAgentToolHooks L486-522）
 * - 11 permission-gate: the extension factory reuses the Chapter 11 implementation directly (dangerous bash is blocked in the Extension layer)
 * - product toolset: the five tools in src/tools/ (the assembly view of Pi tools/index.ts createAllToolDefinitions)
 *
 * Layers (in effect from Chapter 08; this file doesn't break them):
 *   Session Tree → buildSessionContext (reconstruction projection) → canonical state.messages
 *   → transformContext (extension injection seam) → call-time messages
 *
 * Boundary integrity: this file only does wiring and contains no workflow policy (dangerous command checks,
 * allowlists, etc. all live in Extensions). The test: remove the extensions array and the loop and tool semantics stay the same.
 */
import type { AgentLoopConfig, LLMAdapter, Tool } from "../../00-minimal-llm-call/src/index.ts";
import { ExtensionRunner } from "../../10-extension-runtime/src/runner.ts";
import { createExtensionAwareConfig } from "../../10-extension-runtime/src/index.ts";
import type { ExtensionContext, ExtensionFactory, RuntimeConfig } from "../../10-extension-runtime/src/extension-api.ts";
import { Agent } from "./agent.ts";
import { compactSession, type CompactionSettings } from "./compaction.ts";
import { formatSkillsForSystemPrompt, type Skill } from "./extensions.ts";
import { appendEntries, loadTree } from "./jsonl.ts";
import { TreeSession } from "./session-tree.ts";
import { createProductTools } from "./tools/index.ts";

/** Assembly options. */
export interface CodingAgentOptions {
  /** Project root: the cwd of the product tools and the base for path resolution. */
  cwd: string;
  model: string;
  llm: LLMAdapter;
  /** 09 Skill catalog (content stays in the skill file; the model reads it on demand). */
  skills: Skill[];
  /** 10/11 extension factories (e.g. permission-gate), optional. */
  extensions?: ExtensionFactory[];
  /** 07 session persistence file: restored automatically at construction, appended to disk at saveSession. */
  sessionFile?: string;
  /** System prompt prefix (the Skill catalog and tool list are appended automatically). */
  systemPromptPrefix?: string;
  /** Extra tools (appended after the product toolset). */
  extraTools?: Tool[];
  /** 08 Compaction: passing thresholds enables Session Compaction (checked at saveSession; no side effects when under the limit). */
  compact?: CompactionSettings;
}

/** Assembly output: an agent ready to prompt + the Extension Runtime + the Session Tree. */
export interface CodingAgentAssembly {
  agent: Agent;
  runner: ExtensionRunner;
  session: TreeSession;
  tools: Tool[];
  /**
   * Append the agent's current messages to the Session Tree and persist to disk (teaching version of Pi AgentSession auto-persistence, triggered by the caller).
   * With compact enabled, Session Compaction (08 layer) is checked and run here: after the messages are synced into the tree,
   * compactSession decides internally whether the limit is exceeded (under the limit / no cut point / summary failed all return null, with no side effects);
   * Compaction = append a CompactionEntry + refresh agent state to the rebuilt context; not a single old entry is touched.
   */
  saveSession(): Promise<void>;
}

/** Assemble 00-11 (teaching version of the Pi startup chain; async because extension loading happens at construction). */
export async function createCodingAgent(options: CodingAgentOptions): Promise<CodingAgentAssembly> {
  const tools = [...createProductTools(options.cwd), ...(options.extraTools ?? [])];
  const toolNames = tools.map((t) => t.name);

  // 09 layer: system prompt construction (Skill catalog + tool list; Pi buildSystemPrompt, agent-session.ts L963)
  const skillsBlock = formatSkillsForSystemPrompt(options.skills);
  const systemPrompt = [options.systemPromptPrefix ?? "You are a coding assistant.", skillsBlock, `Available tools: ${toolNames.join(" / ")}`]
    .filter(Boolean)
    .join("\n\n");

  // 10 layer: Extension Runtime (ctx.config.activeTools = product tool names; the runner holds the 07 Session Tree)
  const config: RuntimeConfig = { model: options.model, activeTools: toolNames };
  const session = new TreeSession();
  const runner = new ExtensionRunner({
    cwd: options.cwd,
    config,
    // The Chapter 10 runner's ctx.session type points to the Chapter 07 TreeSession; this directory's copy has the same structure,
    // but private class fields create a nominal type difference, so we assert once here (the structure is identical)
    session: session as unknown as ExtensionContext["session"],
  });
  if (options.extensions) {
    await runner.load(options.extensions);
  }

  // 10 layer wiring: the three hooks beforeToolCall/transformContext/loadTools (Pi _installAgentToolHooks L486-522 + sdk.ts L362-367)
  // transformContext only does extension injection / call-time projection (06 layer);
  // compaction belongs to the Session lifecycle (08 layer) and does not go through this seam.
  const hooks = createExtensionAwareConfig(runner);
  const loopConfig: AgentLoopConfig = {
    model: options.model,
    beforeToolCall: hooks.beforeToolCall,
    transformContext: hooks.transformContext,
    loadTools: hooks.loadTools,
  };

  // 07 layer: Agent wrapper + session restore. Restore goes through buildSessionContext (the 08 reconstruction projection):
  // if the session file has a CompactionEntry, the canonical initial messages = summary + retained tail, not the full history
  // (leaf = the last entry in the file, Pi _buildIndex L959)
  const restored = options.sessionFile ? loadTree(options.sessionFile) : null;
  const initialMessages = restored?.tree.buildSessionContext();
  const agent = new Agent({
    systemPrompt,
    tools,
    llm: options.llm,
    config: loopConfig,
    initialMessages,
  });

  // 07 layer: session persistence (messages → Entry tree → JSONL; restored messages are not appended again)
  // savedCount semantics: the length of the prefix of agent.state.messages that is "already represented in the tree".
  // After compact refreshes state it is set to the rebuilt context length (the summary is represented by the CompactionEntry),
  // so the next save appends only truly new messages and never writes the summary again as a MessageEntry.
  let savedCount = initialMessages?.length ?? 0;
  const assembly: CodingAgentAssembly = {
    agent,
    runner,
    session,
    tools,
    async saveSession() {
      const fresh = agent.state.messages.slice(savedCount);
      savedCount = agent.state.messages.length;
      const entries = fresh.map((message) => session.appendMessage(message));
      if (options.sessionFile && entries.length > 0) {
        appendEntries(options.sessionFile, { version: 2, systemPrompt, model: options.model }, entries);
      }

      // 08 layer: optional Session Compaction (the trigger check is inside compactSession:
      // under the limit / no safe cut point / summary failed all return null, with no side effects on Session or agent state;
      // repeated Compaction when the active path already has a compaction entry is not rebuilt)
      if (options.compact) {
        const result = await compactSession(session, options.llm, options.model, options.compact);
        if (result) {
          // CompactionEntry is persisted to disk like a normal entry (persistent across runs: rebuilt by buildSessionContext on restore)
          const compactionEntry = session.getLeafId() ? session.getEntry(session.getLeafId()!) : undefined;
          if (options.sessionFile && compactionEntry) {
            appendEntries(options.sessionFile, { version: 2, systemPrompt, model: options.model }, [compactionEntry]);
          }
          // Refresh canonical state (Pi agent-session.ts L2004-2007): the next run uses summary + retained tail,
          // and the Session Tree still keeps all original entries (the source of truth is unchanged).
          agent.replaceMessages(result.context);
          savedCount = result.context.length;
        }
      }
    },
  };
  return assembly;
}
