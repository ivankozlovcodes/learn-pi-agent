/**
 * Chapter 10 core: ExtensionRunner (teaching subset of Pi runner.ts L268).
 *
 * Four responsibilities:
 * 1. Event dispatch: hasHandlers (L569) + emit (L801) + emitToolCall (L932, short-circuits on block) + emitContext (L984, chained);
 * 2. Context: createContext (L673; Pi uses lazy getters + assertActive, simplified here to a plain object);
 * 3. Collection: registerTool / registerCommand (the factory writes into a staging registry via ExtensionAPI, merged into the runner on success;
 *    on throw it is discarded as a whole: a teaching version of Pi initializeExtension's commit/discard);
 * 4. Reconfigure action: bindToolRuntime binds the assembly layer's tool universe and the running Agent,
 *    and ctx.setActiveTools goes through it to write agent.state.tools right away (teaching version of Pi setActiveToolsByName L950-972).
 */
import type { Message } from "../../00-minimal-llm-call/src/index.ts";
import type {
  ExtensionContext,
  ExtensionEvents,
  ExtensionFactory,
  ExtensionTool,
  RegisteredCommand,
  RuntimeConfig,
  ToolCallEventResult,
  ToolRuntimeBinding,
} from "./extension-api.ts";
import { wrapRegisteredTools } from "./wrapper.ts";
import type { Tool } from "../../00-minimal-llm-call/src/index.ts";

/** Runtime context snapshot (used by createContext). */
export interface RunnerOptions {
  cwd: string;
  config: RuntimeConfig;
  session: ExtensionContext["session"];
}

/** Staging registry for a single extension factory (a teaching compression of Pi's per-extension Extension object registry). */
interface PendingRegistrations {
  handlers: Map<string, Set<(event: unknown, ctx: ExtensionContext) => unknown>>;
  tools: ExtensionTool[];
  commands: RegisteredCommand[];
}

export class ExtensionRunner {
  private handlers = new Map<string, Set<(event: unknown, ctx: ExtensionContext) => unknown>>();
  private tools: ExtensionTool[] = [];
  private commands: RegisteredCommand[] = [];
  private ctx: ExtensionContext;
  private toolBinding: ToolRuntimeBinding | undefined;

  constructor(options: RunnerOptions) {
    this.ctx = {
      cwd: options.cwd,
      mode: "cli",
      config: options.config,
      session: options.session,
      getActiveTools: () => this.getActiveTools(),
      setActiveTools: (toolNames) => this.setActiveTools(toolNames),
    };
  }

  /**
   * Load extension factories (Pi loadExtensions: the default export receives ExtensionAPI).
   * Failure isolation (teaching version of Pi initializeExtension + createExtensionAPI commit/discard):
   * each factory first writes into a staging registry, merged into the runner on success; on throw it is discarded as a whole,
   * leaving no half-registered extension and not affecting the other factories.
   */
  async load(factories: ExtensionFactory[]): Promise<void> {
    for (const factory of factories) {
      const pending: PendingRegistrations = { handlers: new Map(), tools: [], commands: [] };
      try {
        await factory(this.createAPI(pending));
        // commit: merge into the runner registry (keeping load order × registration order)
        for (const [type, handlers] of pending.handlers) {
          const set = this.handlers.get(type) ?? new Set();
          for (const handler of handlers) {
            set.add(handler);
          }
          this.handlers.set(type, set);
        }
        this.tools.push(...pending.tools);
        this.commands.push(...pending.commands);
      } catch (error) {
        // discard: drop the whole staging registry (teaching version of Pi load.discard())
        console.warn(
          `Extension factory failed; all its registrations were discarded:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  /** Whether anyone subscribes to the event type (Pi hasHandlers L569). */
  hasHandlers(type: string): boolean {
    return (this.handlers.get(type)?.size ?? 0) > 0;
  }

  /** Generic event dispatch (Pi emit L801): Observe / Inject. Returns all handler results. */
  async emit<K extends keyof ExtensionEvents>(type: K, event: ExtensionEvents[K]): Promise<unknown[]> {
    const hs = this.handlers.get(type);
    if (!hs || hs.size === 0) return [];
    const ctx = this.createContext();
    const results: unknown[] = [];
    for (const handler of hs) {
      try {
        results.push(await handler(event, ctx));
      } catch (error) {
        // An extension handler that throws doesn't break the loop (Pi runner's error listener; simplified to a warning here)
        console.warn(`Extension event ${type} handler threw:`, error instanceof Error ? error.message : String(error));
      }
    }
    return results;
  }

  /**
   * Intercept: the tool_call event short-circuits as soon as any handler returns block (Pi emitToolCall L932:
   * after a block, later handlers don't run; permission-gate style policies rely on this).
   */
  async emitToolCall(event: ExtensionEvents["tool_call"]): Promise<ToolCallEventResult | undefined> {
    const hs = this.handlers.get("tool_call");
    if (!hs || hs.size === 0) return undefined;
    const ctx = this.createContext();
    for (const handler of hs) {
      try {
        const verdict = (await handler(event, ctx)) as ToolCallEventResult | undefined;
        if (verdict?.block) {
          return { block: true, reason: verdict.reason };
        }
      } catch (error) {
        console.warn(`Extension event tool_call handler threw:`, error instanceof Error ? error.message : String(error));
      }
    }
    return undefined;
  }

  /** Inject: chained transform for the context event (Pi emitContext L984: each handler sees the previous one's output). */
  async emitContext(messages: Message[]): Promise<Message[]> {
    const hs = this.handlers.get("context");
    if (!hs || hs.size === 0) return messages;
    const ctx = this.createContext();
    let current = [...messages];
    for (const handler of hs) {
      try {
        const result = (await handler({ messages: current }, ctx)) as Message[] | void;
        if (Array.isArray(result)) {
          current = result;
        }
      } catch (error) {
        console.warn(`Extension event context handler threw:`, error instanceof Error ? error.message : String(error));
      }
    }
    return current;
  }

  /** Current context (Pi createContext L673; the teaching version returns the snapshot directly). */
  createContext(): ExtensionContext {
    return this.ctx;
  }

  /** Currently visible tool names (Pi getActiveTools; teaching version = a snapshot of config.activeTools). */
  getActiveTools(): string[] {
    return [...this.ctx.config.activeTools];
  }

  /**
   * Bind the tool runtime (the assembly layer calls this once after constructing the Agent):
   * - resolve: the assembly layer's full tool universe (built-in tools + extension registry), resolved by name;
   * - apply: write the resolved tools to the running Agent's state.tools right away.
   * invariant: an Extension can only call the action via ctx.setActiveTools and never gets the Agent instance.
   */
  bindToolRuntime(binding: ToolRuntimeBinding): void {
    this.toolBinding = binding;
  }

  /**
   * Reconfigure action: switch the active tool set (teaching version of Pi setActiveToolsByName, agent-session.ts L950-972).
   * 1. Resolve by name (with a binding, use the assembly layer's universe; without one, fall back to the extension registry: a config-only case with no running Agent to write);
   * 2. Ignore unknown names;
   * 3. Sync config.activeTools (update the same array reference in place, so the config held by the assembly layer/tests stays consistent);
   * 4. Write the running agent.state.tools right away (visible on the next provider call);
   * 5. Don't modify the Agent Loop.
   */
  setActiveTools(toolNames: string[]): void {
    const resolve =
      this.toolBinding?.resolve ??
      ((names: string[]) => this.getRegisteredTools().filter((t) => names.includes(t.name)));
    const tools = resolve([...toolNames]);
    const resolvedNames = tools.map((t) => t.name);
    this.ctx.config.activeTools.splice(0, this.ctx.config.activeTools.length, ...resolvedNames);
    this.toolBinding?.apply(tools);
  }

  /** All registered tools (including inactive ones; used by loadTools for dynamic loading). */
  getRegisteredTools(): Tool[] {
    return wrapRegisteredTools(this.tools, this);
  }

  /** Currently visible tools (the teaching simplification where registered means active + filtered by config.activeTools). */
  getVisibleTools(): Tool[] {
    const active = new Set(this.ctx.config.activeTools);
    return wrapRegisteredTools(this.tools, this).filter((t) => active.has(t.name));
  }

  /** Registered commands. */
  getCommands(): RegisteredCommand[] {
    return [...this.commands];
  }

  /** Dispatch a command (user input "name args" → the matching handler). */
  async runCommand(input: string, ctx?: ExtensionContext): Promise<void> {
    const [name, ...rest] = input.trim().split(/\s+/);
    const command = this.commands.find((c) => c.name === name);
    if (!command) {
      throw new Error(`Command not found: ${name}`);
    }
    await command.handler(rest.join(" "), ctx ?? this.createContext());
  }

  /** The API the factory sees: exposes only on/registerTool/registerCommand (a minimal version of Pi createExtensionRuntime + bindCore).
   *  Registrations go into pending first (the per-factory staging registry) and are merged into the runner once load succeeds. */
  private createAPI(pending: PendingRegistrations) {
    return {
      on<K extends keyof ExtensionEvents>(event: K, handler: (event: ExtensionEvents[K], ctx: ExtensionContext) => unknown) {
        const set = pending.handlers.get(event) ?? new Set();
        set.add(handler as (event: unknown, ctx: ExtensionContext) => unknown);
        pending.handlers.set(event, set);
      },
      registerTool(tool: ExtensionTool) {
        pending.tools.push(tool);
      },
      registerCommand(name: string, options: Omit<RegisteredCommand, "name">) {
        pending.commands.push({ name, ...options });
      },
    };
  }
}
