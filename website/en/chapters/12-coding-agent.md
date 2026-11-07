---
title: "Chapter 12: Coding Agent"
description: "Now give the Agent a concrete task:"
head: [["link",{"rel":"canonical","href":"https://yiz-hhh.github.io/learn-pi-agent/en/chapters/12-coding-agent"}]]
---
# Chapter 12: Coding Agent

Now give the Agent a concrete task:

```text
Fix the bug in calculator.ts and run the tests to confirm the fix.
```

The earlier chapters already have:

```text
LLM Call
Tool Runtime
Parallel Tool Execution
Session
Context
Compaction
Skills
Extensions
```

This chapter puts all of them into a real code change task.

The tools a Coding Agent needs are concrete too:

```text
read_file
write_file
edit
grep
bash
```

Plus:

```text
coding prompt
skills
extensions
workspace
```

There is no new Agent Loop.

These capabilities plug into the Runtime already built in earlier chapters.

## Assembling a Coding Agent

The entry point can live in a single `createCodingAgent()`:

```ts
const tools = [
  ...createProductTools(cwd),
  ...extraTools,
];

const systemPrompt = buildProductPrompt(
  prefix,
  skills,
  tools,
);

const session = new TreeSession();

const runner = new ExtensionRunner({
  cwd,
  config,
  session,
});

await runner.load(extensions);

const hooks =
  createExtensionAwareConfig(runner);

const agent = new Agent({
  systemPrompt,
  tools,
  llm,
  config: {
    model,
    beforeToolCall:
      hooks.beforeToolCall,
    transformContext:
      hooks.transformContext,
    loadTools:
      hooks.loadTools,
  },
  initialMessages,
});
```

These are still the same few objects from before:

```text
Agent
TreeSession
ExtensionRunner
Tool[]
```

Coding Tools go into `tools`.

Skills take part in the system prompt.

Extensions attach to the existing runtime Hooks.

An existing Session can first be restored into `initialMessages`, and then the Agent is created.

What the product layer mainly does is wire these parts together.

The file Tools share the same `cwd`.

Paths all go through:

```ts
resolveToolPath(cwd, path)
```

For example:

```text
src/calculator.ts
```

resolves against the current workspace.

But `cwd` is not a sandbox.

Something like:

```text
../outside.txt
```

can still resolve outside the workspace.

Absolute paths aren't automatically restricted just because they pass through this resolver either.

So:

```text
path resolution
```

only decides where a file is.

Project Trust, file access policy and process isolation belong to other boundaries.

## Coding Tools still go through the same Tool Runtime

This chapter adds:

```text
read_file
write_file
edit
grep
bash
```

Once the model calls them, the execution path doesn't change:

```text
Tool Call
    ↓
prepare / validate
    ↓
beforeToolCall
    ↓
execute
    ↓
ToolResult
```

A missing file, bad arguments, a failed command: all of them end up as a Tool Result the model can see.

The Agent Loop doesn't need to know:

```text
read_file is a file tool

bash starts a shell

edit modifies source code
```

It only handles Tool Calls and Tool Results.

### `edit` puts the change at an exact location

The model is good at judging:

```text
which code has the problem
what it should become
```

But when actually changing the file, it's best not to make the model compute character offsets itself.

This chapter's `edit` takes:

```text
path
oldText
newText
```

For example, the current code:

```ts
export function add(
  a: number,
  b: number,
) {
  return a - b;
}
```

The model submits:

```text
oldText = "return a - b;"
newText = "return a + b;"
```

The program then checks whether this text can be located uniquely:

```text
oldText not found
→ fail

oldText appears once
→ replace

oldText appears several times
→ fail
```

When one call contains several edits, all matches are based on the file content before the change, and the replaced ranges are checked for overlap.

The model makes the semantic judgment.

The program does the deterministic placement.

This matches the boundary kept all along: work the program can clearly do doesn't need to be handed back to the model to guess.

### `bash` only executes commands

The `bash` Tool is responsible for:

```text
cwd
timeout
AbortSignal
stdout
stderr
exit code
```

As for:

```text
whether this command may run
```

that doesn't go into `bash.execute()`.

The Chapter 11 Permission Extension can block before the Tool actually reaches the shell:

```text
bash("rm -rf keep/")
    ↓
tool_call
    ↓
permission extension
    ↓
block
```

After a block, the Runtime still returns a failed Tool Result.

Whereas:

```text
bash("npm test")
```

can keep running as a normal Tool execution.

So the same `bash` Tool can run under different policies.

The product layer decides which Extensions to load.

The Tool itself keeps the same execution responsibility.

## Skills enter the Context when the task needs them

When the Coding Agent starts, the Skill catalog goes into the system prompt.

For example:

```text
name: verify
description: after changing code, run the tests to confirm the result
location: skills/verify.md
```

The body stays in the file.

The model sees the current task:

```text
Fix the bug in calculator.ts,
and run the tests to confirm the fix.
```

Once it decides `verify` is relevant, it can call:

```text
read_file("skills/verify.md")
```

Then the body enters the current run as an ordinary Tool Result.

The flow after that has no Skill-specific branch:

```text
read Skill
    ↓
ToolResult
    ↓
model continues
    ↓
grep / read / edit / bash
```

The Skill describes how this kind of task should be done.

The actual execution stays with the existing Tools.

This chapter can load only the Permission Gate.

Chapter 11 already showed that Plan Mode and Subagent can be composed from the Extension Runtime, so there's no need to turn on every Extension here just to be "complete".

The product entry point picks only the capabilities it needs right now.

## Session and Compaction keep following the same path

A code change task also produces ordinary run history:

```text
user
assistant
toolResult
assistant
toolResult
...
```

The Session doesn't need to save anything extra:

```text
code-edit entry
grep entry
test entry
```

`grep` is a Tool Call.

`edit` is a Tool Call.

`npm test` is still a Tool Call.

After the run ends, they are all already in the Session through Messages / Tool Results.

If the Session gets long, Compaction still uses the Chapter 08 path:

```text
Session Tree
    ↓
CompactionEntry
    ↓
buildSessionContext()
    ↓
Agent messages
    ↓
transformContext()
    ↓
LLM
```

Compaction first decides which canonical messages to rebuild from the persisted Session.

The Extension's Context handler still runs before the model is called.

These two layers don't merge just because we're now in a Coding Agent.

## Running a full Bug Fix

The test in the fixture requires:

```text
add(2, 3) = 5
```

But the source currently says:

```ts
return a - b;
```

The user types:

```text
Fix the bug in calculator.ts,
and run the tests to confirm the fix.
```

One run might unfold like this.

First a dangerous command shows up:

```text
bash("rm -rf keep/")
```

The Permission Extension blocks it at the `tool_call` stage:

```text
bash
 ↓
permission extension
 ↓
block
 ↓
error ToolResult
```

The model sees the reason for the refusal and continues.

Next it reads the verification Skill:

```text
read_file("skills/verify.md")
```

Then it looks for the target code:

```text
grep("function add", "src")
```

Reads the file:

```text
read_file("src/calculator.ts")
```

Runs the tests first:

```text
bash("npm test")
```

The tests fail.

The Bash Tool treats a non-zero exit code as an execution failure and throws; the Tool Runtime turns it into:

```text
ToolResult(isError = true)
```

With the real test output in hand, the model goes on to change the code:

```text
edit(
  oldText = "return a - b;",
  newText = "return a + b;"
)
```

Then runs again:

```text
bash("npm test")
```

This time the tests pass.

The whole process can be written as:

```text
user
│
│  Fix calculator.ts and run the tests
│
├─ bash("rm -rf keep/")
│    ↓
│  permission extension blocks
│    ↓
│  error ToolResult
│
├─ read_file("skills/verify.md")
│
├─ grep("function add", "src")
│
├─ read_file("src/calculator.ts")
│
├─ bash("npm test")
│    ↓
│  test fails
│    ↓
│  error ToolResult
│
├─ edit(
│    oldText = "return a - b;",
│    newText = "return a + b;"
│  )
│
├─ bash("npm test")
│    ↓
│  test passes
│
└─ final answer
```

The file reads, source changes and tests here are all real executions.

The model doesn't need to know in advance how many steps the whole flow will take.

Each turn it decides the next step based only on the current history and the latest Tool Result.

After the run ends, new messages keep being appended to the Session.

On restart:

```text
load TreeSession
    ↓
buildSessionContext()
    ↓
restore messages
    ↓
create Agent
    ↓
continue
```

The restored Coding Agent still uses the same:

```text
Agent Loop
Tool Runtime
Context
Extension
```

There's no separate "Coding Session" or "Coding Loop".

Pi's full Coding Agent of course has a lot more:

```text
more file tools
a more complete edit
resource loading
process management
Trust
CLI / TUI
```

This chapter doesn't bring all of them in.

We only took one task that can run from start to finish:

```text
the user asks for a change
    ↓
a Skill provides the task instructions
    ↓
Tools explore and change the code
    ↓
Extensions control the execution policy
    ↓
real tests validate the result
    ↓
the Session saves the execution history
```

The mechanisms taken apart earlier work together as one Coding Agent here for the first time.

And that is the thing most worth keeping:

A concrete product can keep adding capabilities, but the Agent Loop from before doesn't have to be rewritten because of it.
