# Chapter 03: Tool Runtime

After Chapter 02, the Agent Loop can already expose its own run.

Tool execution is still simple:

```ts
const tool = context.tools?.find(
  (t) => t.name === toolCall.name,
);

try {
  const result = await tool.execute(
    toolCall.arguments,
  );

  return createToolResult(result);
} catch (error) {
  return createErrorResult(error);
}
```

For:

```text
calculator({ a: 12, b: 30 })
```

That is plenty.

But the model may also generate:

```text
calculator({
  a: "twelve",
  b: 30
})
```

`calculator` clearly requires `a` to be a number.

If the Runtime still calls `execute()` directly, argument checks end up scattered back into every Tool.

Some calls have perfectly fine arguments but still need extra checks before execution:

```text
write_file(...)
    ↓
permission check
    ↓
execute
```

After a tool executes, we may also need to add metadata, adjust the result, or tell the Loop that the current task is done.

More and more things start to pile up around `tool.execute(args)`.

These things don't need to keep piling into the Agent Loop.

## What a Tool Call goes through before execution

First, lay out the steps before the Tool actually executes:

```text
tool call
   ↓
lookup
   ↓
prepare
   ↓
validate
   ↓
beforeToolCall
   ↓
execute
```

The first step is lookup.

The model only gives a Tool name:

```text
calculator
```

The Runtime has to find the implementation among the currently available tools.

If it can't find one:

```text
toolCall("weather")
      ↓
lookup
      ↓
not found
      ↓
error ToolResult
```

The call ends here and never reaches the Tool.

Once the Tool is found, the model's arguments can first go through `prepare`.

```text
model arguments
      ↓
prepare
      ↓
tool arguments
```

This step can handle the conversion between the model-side arguments and the Tool's actual input.

Then comes schema validation.

Suppose the Tool declares:

```text
a: number
b: number
```

The model returns instead:

```text
a: "twelve"
b: 30
```

The call fails right in the Runtime, and `calculator.execute()` is never called.

Once the arguments are valid, there is one more interception point before execution:

```text
validated arguments
        ↓
beforeToolCall
        ↓
   allow / block
```

Policies such as permissions and call limits can hook in here.

If the call is blocked, the Runtime still produces a failed Tool Result so the model sees the reason in the next turn.

By the time the Tool actually executes, the call has already gone through:

```text
lookup
  ↓
prepare
  ↓
validate
  ↓
beforeToolCall
  ↓
execute
```

The Agent Loop doesn't need to know why each of these stages failed.

In the end it only receives one Tool Result.

## Tool Execution needs events too

Chapter 02 already exposes:

```text
agent
turn
message
```

A Tool itself can also run for a long time.

So the Runtime adds:

```text
tool_execution_start
tool_execution_update
tool_execution_end
```

`tool_execution_start` has an important timing: it happens before lookup.

For example, the model requests a Tool that doesn't exist at all:

```text
tool_execution_start
        ↓
      lookup
        ↓
     not found
        ↓
tool_execution_end
```

Here `start` means:

```text
Runtime starts handling this Tool Call
```

not:

```text
the Tool's execute() has started running
```

So a failed lookup, invalid arguments, a block before execution, and the Tool throwing on its own all land in the same Tool Call lifecycle.

A long-running Tool can also report progress on its own:

```ts
await tool.execute(
  args,
  (partialResult) => {
    emit({
      type: "tool_execution_update",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
      partialResult,
    });
  },
);
```

For example:

```text
tool_execution_start

tool_execution_update  10%
tool_execution_update  40%
tool_execution_update  80%

tool_execution_end
```

These updates only describe the current execution state and don't enter the message history.

Only the final Tool Result is written back to history.

## Tool return values end up as a uniform Tool Result

A Tool's own return value can be richer than an Agent Message:

```ts
{
  content,
  details,
  usage,
  terminate,
  addedToolNames,
}
```

The Agent Loop doesn't need to understand each Tool's return shape.

So after a Tool executes, the result still goes through:

```text
execute
   ↓
afterToolCall
   ↓
normalize
   ↓
ToolResult
```

`afterToolCall` gives the execution result one last chance to be processed.

`normalize` then shapes the result into a uniform `ToolResultMessage`:

```text
ToolResultMessage
├── role
├── toolCallId
├── toolName
├── text
├── details
├── usage
├── terminate
└── isError
```

So the path the Loop sees is still always:

```text
assistant(toolCall)
        ↓
    Tool Runtime
        ↓
    toolResult
```

Errors take the same exit.

The Tool doesn't exist:

```text
lookup
  ↓
ToolResult(isError = true)
```

Bad arguments:

```text
validate
  ↓
ToolResult(isError = true)
```

The Tool throws an exception itself:

```text
execute
  ↓
throw
  ↓
ToolResult(isError = true)
```

A Tool can keep using exceptions to express execution failure.

The Runtime is responsible for turning failures from these different stages into uniform results the model can see in the next turn.

## How Pi splits this execution path

Pi doesn't stuff all of this logic into an ever-growing `executeToolCall()`.

The main stages are split into:

```text
prepareToolCall

  lookup
  prepare
  validate
  beforeToolCall

        ↓

executePreparedToolCall

  execute
  onUpdate

        ↓

finalizeExecutedToolCall

  afterToolCall

        ↓

createToolResultMessage

  normalize
```

Chapter 03 doesn't copy Pi's function split, but keeps the same execution stages.

This shows a boundary that matters more than the function names:

The Agent Loop only decides:

```text
there is a batch of Tool Calls
→ execute them
→ write the results back to history
```

The Tool Runtime decides:

```text
whether this call exists
whether the arguments are valid
whether it can proceed before execution
how the Tool runs
what the result finally looks like
```

As Tool-related complexity grows, the Loop no longer has to grow with it.

This layer also has one field that affects the Loop:

```ts
terminate: true
```

It means a Tool thinks the current task can end.

But one assistant message may request several Tools at once:

```text
tool A
tool B
tool C
```

So a single Tool returning `terminate: true` can't end the whole batch right away.

Pi waits until the whole batch is done and then checks:

```ts
finalizedCalls.length > 0 &&
finalizedCalls.every(
  (call) => call.result.terminate === true,
)
```

For example:

```text
A  true
B  true
C  true

→ stop
```

Whereas:

```text
A  true
B  false
C  true

→ continue
```

A single Tool only describes its own execution result.

Whether the Loop stops is decided by the batch's results together.

Run:

```bash
npm run demo
```

A normal Tool Call now goes through:

```text
assistant(toolCall)
        ↓
tool_execution_start
        ↓
lookup
prepare
validate
beforeToolCall
        ↓
execute
        ↓
afterToolCall
normalize
        ↓
tool_execution_end
        ↓
toolResult
```

In the end the Agent Loop still only handles Tool Calls and Tool Results.

But if one turn has several independent Tool Calls, it currently still does:

```ts
for (const call of toolCalls) {
  outcomes.push(
    await executeToolCall(call),
  );
}
```

The time taken by three Tools simply adds up.

Chapter 04 picks up from this problem.
