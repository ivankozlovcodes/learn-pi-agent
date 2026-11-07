# Chapter 11: Extension Composition

Chapter 10 has already let an Extension:

```text
register Tool
register Command
listen Agent Event
intercept Tool Call
transform Context
```

None of these interfaces is complicated on its own.

What's really worth validating is something else.

What if the requirements start changing how the Agent works, for example:

```text
dangerous commands need a permission check

after entering Plan Mode, the Agent can only analyze, not modify

the main Agent can hand a task to another Agent
```

Should these capabilities still go into the Agent Core?

Start with the smallest one.

## Permission Gate

Suppose the Agent already has an ordinary `bash` Tool:

```text
bash("ls -la")
bash("rm -rf /tmp/demo")
```

If we write the permission check directly into `bash.execute()`:

```ts
if (isDangerous(command)) {
  return deny();
}
```

then `bash` becomes responsible for both:

```text
how to execute a command
```

and:

```text
what the current environment allows to execute
```

The second one usually isn't something the Tool can decide by itself.

Different environments may have different policies:

```text
forbid outright

ask for confirmation

allow only an allowlist

already in an isolated environment, execute directly
```

Chapter 10 already has `tool_call` interception.

The Permission Extension only needs to check the `bash` arguments:

```ts
export default function permissionGate(
  pi: ExtensionAPI,
): void {
  pi.on("tool_call", async (event) => {
    if (event.toolCall.name !== "bash") {
      return;
    }

    const command =
      (event.args as { command?: string })
        .command ?? "";

    const verdict =
      decidePermission(command);

    if (verdict.block) {
      return {
        block: true,
        reason: verdict.reason,
      };
    }
  });
}
```

If it's allowed, the original Tool Runtime keeps executing.

If it's blocked:

```text
assistant
    ↓
toolCall: bash(...)
    ↓
Permission Extension
    ↓
block
    ↓
ToolResult(isError = true)
    ↓
LLM
```

The `bash` Tool doesn't need to know the Permission Extension exists.

The Agent Loop didn't gain this either:

```ts
if (permissionMode) {
  ...
}
```

A denied call still goes back to the model following the failure semantics of Chapter 03.

Permission Gate changes only a single Tool Call.

Plan Mode is a bit more involved.

## Plan Mode

After entering Plan Mode, we want the Agent to keep a set of constraints in place:

```text
write / edit are temporarily unavailable

bash allows only read-only commands

the model knows it should analyze and make a plan first
```

If we write this logic directly into the Agent Runtime, it easily turns into:

```ts
if (mode === "plan") {
  tools = planTools;
  systemPrompt += PLAN_MODE_PROMPT;
  blockWriteCommands();
}
```

From that moment on, the Agent Core itself knows about:

```text
plan mode
```

But Chapter 10 already has a few seams that can be composed.

Plan Mode only needs to keep its own state:

```ts
let enabled = false;

let toolsBeforePlanMode: string[] = [];
```

On entering `/plan`, first save the current Tool set:

```text
current active tools
        ↓
save
```

Then switch to the Tools allowed in Plan Mode:

```text
remove write
remove edit
remove other mutation tools
        ↓
setActiveTools(plan-safe tools)
```

On exit, restore:

```text
setActiveTools(toolsBeforePlanMode)
```

It can't restore a hardcoded:

```text
NORMAL_TOOLS
```

because before entering Plan Mode, other Extensions may already have changed the active tools.

For example:

```text
Extension A added tool-x

Extension B hid tool-y

then Plan Mode is entered
```

If exit just restored some fixed default set, the earlier extension state would be overwritten along with it.

So we need to save and restore the real active tools from before Plan Mode was entered.

`setActiveTools()` must also really act on the currently running Agent.

The next LLM call uses the Tool set the Agent holds at that moment.

So the path is:

```text
Plan Mode Extension
        ↓
setActiveTools(...)
        ↓
Extension Runtime
        ↓
running Agent tools
        ↓
next LLM call
```

There's no need to recreate the Agent.

### The same state keeps controlling bash

In Plan Mode we can't simply remove `bash` altogether.

These commands are still very useful:

```text
pwd
ls
cat
grep
```

But these may need to be forbidden:

```text
rm
mv
sudo
chmod
output redirection
```

So the same:

```ts
enabled
```

can also drive `tool_call` interception.

When Plan Mode is on:

```text
bash(command)
    ↓
check readonly policy
    ↓
allow / block
```

The seam Permission Gate used gets reused here.

### The model also needs to know it's in Plan Mode

Changing the Tool set alone isn't enough.

The model needs to know:

```text
analyze the current task first
make a plan first
don't try to modify files for now
```

Chapter 10 can already register a `context` handler:

```ts
pi.on("context", async (event) => {
  if (!enabled) {
    return event.messages;
  }

  return [
    ...event.messages,
    createPlanModeMessage(),
  ];
});
```

So the same piece of state:

```text
enabled
```

affects all of:

```text
active tools

bash policy

LLM context
```

Each of these changes goes into one of three places that already exist:

```text
setActiveTools

tool_call

context
```

The Agent Loop itself gains no Plan Mode branch.

Pi's full Plan Mode example also handles more product-level details, such as Session restore, `before_agent_start`, keyboard shortcuts, UI state and todo items.

This chapter doesn't need to copy all of that in.

Here we first confirm a more basic fact:

```text
a mode that persists
can keep its own state in an Extension,
and change the current Agent through existing seams.
```

One step further.

## Subagent

If the main Agent wants to hand an independent task to another Agent, it's easy to just add this to the Parent Loop:

```ts
if (needsSubagent) {
  runChildAgent();
}
```

From then on, the Parent Runtime needs to know about:

```text
child agent
delegation
child session
child lifecycle
```

Pi's Subagent example looks much simpler from the Parent side.

What it registers is an ordinary Tool:

```text
subagent
```

The Parent still only goes through:

```text
Parent Agent
    ↓
toolCall: subagent
    ↓
Tool Runtime
    ↓
child execution
    ↓
ToolResult
    ↓
Parent Agent continues
```

The Parent Loop needs no new control path.

This chapter's implementation can create an independent Agent and Session inside the `subagent` Tool:

```ts
const subSession =
  new TreeSession();

const subAgent =
  new Agent({
    systemPrompt,
    tools,
    llm,
    config: { model },
  });
```

The Child has its own:

```text
messages
tools
systemPrompt
session
```

What it produces internally:

```text
assistant
toolCall
toolResult
```

all belongs to the Child's own run.

The Parent history keeps only:

```text
assistant
    ↓
subagent Tool Call
    ↓
ToolResult: child final answer
    ↓
assistant continues
```

If the Child fails, the `subagent` Tool can simply throw.

Then the Tool Runtime from Chapter 03 turns it into:

```text
ToolResult(isError = true)
```

To the Parent, an internal failure of the Child Runtime ultimately still shows up as an ordinary Tool execution failure.

### Concurrency doesn't need a redesign either

Because `subagent` is still a Tool in the end, if the model emits in the same turn:

```text
subagent(task A)
subagent(task B)
```

Chapter 04's batch execution can take them as they are.

The two Children each maintain their own Agent state and Session, and run at the same time.

The Parent doesn't need an extra:

```text
Subagent Scheduler
```

Pi's official Subagent example goes further on isolation: it starts an independent `pi` process.

This chapter uses an in-process Agent, so it runs differently.

The boundary on the Parent side doesn't change:

```text
task
 ↓
child execution
 ↓
final ToolResult
```

The Parent only cares about the final Tool Result.

## The three examples end up back at the same set of seams

Now look at these three capabilities again.

Permission Gate:

```text
tool_call
    ↓
allow / block
```

Plan Mode:

```text
state
 ├─ setActiveTools
 ├─ tool_call
 └─ context
```

Subagent:

```text
registerTool("subagent")
    ↓
Tool Runtime
    ↓
child execution
    ↓
ToolResult
```

The scope of what they change in the Agent grows step by step.

But every implementation ends up back on mechanisms that already existed:

```text
Permission
→ Tool interception

Plan Mode
→ active tools
→ Context interception
→ Tool interception

Subagent
→ Tool registration
→ Tool Runtime
→ parallel batch
```

At this point, the Agent Core still hasn't gained:

```text
permission
planMode
subagent
```

This is also where the Extension Runtime only really shows its value, in this chapter.

On their own, the APIs in Chapter 10 are just registration interfaces.

Composed, they can already express features that keep changing the Agent's behavior.

The Pi README leaves behaviors like permission popups, plan mode and sub-agents out of the default workflow.

These features have no single correct product form.

Different Harnesses can keep using the same set of Core primitives and compose their own implementations.

Run:

```bash
npm run demo
```

You can watch each of these:

```text
dangerous bash
→ Permission Gate block
→ error ToolResult
```

After entering `/plan`:

```text
active tools changed

bash readonly policy enabled

Plan Mode context injected
```

On exit, the Tool set from before the mode was entered is restored.

When the Parent calls `subagent`:

```text
Parent
→ subagent Tool
→ independent Child
→ ToolResult
→ Parent continues
```

The Child's internal messages don't get mixed into the Parent Session.

At this point, the Extension Runtime is no longer just "adding a few plugins to the Harness".

It can already compose complete Agent behavior, while the Agent Loop itself keeps its original shape.

One question is left.

Once:

```text
read
write
edit
grep
bash

Workspace

Session
Compaction

Skills
Extensions
```

are really assembled into a Coding Agent, do these boundaries still hold?

Chapter 12 picks up from here.
