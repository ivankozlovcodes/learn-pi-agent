/**
 * Teaching extension: the todo tool + the /todos command (a simplified Pi examples/extensions/todo.ts).
 *
 * Demonstrates three capabilities:
 * - Extend: registerTool (todo) + registerCommand (todos)
 * - Persist: state lives in the tool result's details and is rebuilt from the session tree branch path (Pi todo.ts L114-133
 *   reconstructState scans getBranch()), so state is automatically correct on a branch (the Chapter 07 tree paying off inside an extension)
 * - Observe: on("message_end") triggers a state rebuild (Pi uses the session_start/session_tree events)
 */
import type { ExtensionAPI, ExtensionContext } from "../src/extension-api.ts";
import type { MessageEntry } from "../../07-session-tree/src/session-tree.ts";

interface TodoItem {
  id: number;
  text: string;
  done: boolean;
}

interface TodoDetails {
  action: string;
  todos: TodoItem[];
  nextId: number;
  error?: string;
}

export default function (pi: ExtensionAPI): void {
  let todos: TodoItem[] = [];
  let nextId = 1;
  /** Which leaf's branch path the current state was rebuilt from (Pi has no such field; used for teaching leaf-change detection). */
  let stateBuiltFromLeaf: string | null = null;

  /** Rebuild state from the session tree branch path (teaching version of Pi todo.ts L114-133 reconstructState). */
  const reconstruct = (ctx: ExtensionContext): void => {
    todos = [];
    nextId = 1;
    for (const entry of ctx.session.getBranch()) {
      if (entry.type !== "message") continue;
      const m = (entry as MessageEntry).message;
      if (m.role === "toolResult" && m.toolName === "todo") {
        const details = m.details as TodoDetails | undefined;
        if (details) {
          // Copy, don't reference: a later todos.push must not pollute the historical details stored in the tree.
          // Pi isolates writes and reads with structuredClone at the storage boundary (jsonl/storage.ts L159); the teaching tree doesn't clone,
          // so the extension copies on rebuild itself (the aliasing lesson: deriving state from the tree = copy it out, then modify).
          todos = [...details.todos];
          nextId = details.nextId;
        }
      }
    }
  };

  /**
   * State authority policy (same as Pi: module state is the authority during the current run, session entries are the persistence log):
   * consecutive executions on the same leaf modify module state directly. In a parallel batch both executes increment from in-memory state
   * instead of each rebuilding from the old branch (whose toolResult isn't in the tree yet); only a leaf change (branch/restore) triggers a rebuild.
   */
  const ensureState = (ctx: ExtensionContext): void => {
    const leafId = ctx.session.getLeafId();
    if (leafId === stateBuiltFromLeaf) return;
    reconstruct(ctx);
    stateBuiltFromLeaf = leafId;
  };

  // Observe: after a message lands in the tree, detect by leaf and rebuild (teaching simplification; Pi rebuilds on session_start/session_tree)
  pi.on("message_end", async (_event, ctx) => {
    ensureState(ctx);
  });

  pi.registerTool({
    name: "todo",
    description: "Manage the todo list. Actions: list, add (text argument), toggle (id argument), clear",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "list | add | toggle | clear" },
        text: { type: "string", description: "Todo text for add" },
        id: { type: "number", description: "Todo number for toggle" },
      },
      required: ["action"],
    },
    async execute(args, ctx) {
      ensureState(ctx);
      const action = String(args.action ?? "list");
      switch (action) {
        case "add": {
          const text = String(args.text ?? "");
          if (!text) {
            return { content: "Error: add requires a text argument", details: { action, todos, nextId, error: "text required" } as TodoDetails };
          }
          const item: TodoItem = { id: nextId++, text, done: false };
          todos.push(item);
          return { content: `Added todo #${item.id}: ${item.text}`, details: { action, todos: [...todos], nextId } as TodoDetails };
        }
        case "toggle": {
          const id = Number(args.id);
          const item = todos.find((t) => t.id === id);
          if (!item) {
            return { content: `Error: todo #${id} does not exist`, details: { action, todos, nextId, error: "not found" } as TodoDetails };
          }
          item.done = !item.done;
          return { content: `Todo #${item.id} ${item.done ? "marked done" : "marked not done"}`, details: { action, todos: [...todos], nextId } as TodoDetails };
        }
        case "clear": {
          todos = [];
          nextId = 1;
          return { content: "Todos cleared", details: { action, todos: [], nextId: 1 } as TodoDetails };
        }
        default:
          return {
            content: todos.length
              ? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
              : "No todos",
            details: { action, todos: [...todos], nextId } as TodoDetails,
          };
      }
    },
  });

  pi.registerCommand("todos", {
    description: "Show the todo list on the current branch",
    handler: async (_args, ctx) => {
      ensureState(ctx);
      console.log(
        todos.length ? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n") : "No todos",
      );
    },
  });
}
