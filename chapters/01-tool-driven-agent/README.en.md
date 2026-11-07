# Chapter 01: Tool-driven Agent

The user asks:

> What is 12 + 30?

If the model answers with text directly, one LLM call is the end of it.

But now give the model a `calculator` Tool.

The first thing the model returns may not be the answer, but:

```text
assistant
└── calculator({ a: 12, b: 30 })
```

The program executes the tool and gets:

```text
42
```

At this point the task is not finished yet.

`42` exists only on the program side. The model only knows it just requested `calculator`; it doesn't know what the tool actually returned.

For the model to keep answering, this result has to go into the message history, and the model has to be called again:

```text
user
assistant(toolCall: calculator)
toolResult("42")
        ↓
       LLM
        ↓
assistant("12 + 30 = 42")
```

If on the next turn the model requests another Tool, the same process continues.

## Tool Result turns one call into a loop

Writing down the process we just walked through, the control logic is short:

```ts
let hasMoreToolCalls = true;

while (hasMoreToolCalls) {
  const assistantMessage = await callLlm(messages);
  messages.push(assistantMessage);

  hasMoreToolCalls = false;

  for (const toolCall of assistantMessage.toolCalls ?? []) {
    const result = await executeToolCall(toolCall);
    messages.push(result);
    hasMoreToolCalls = true;
  }
}
```

If the model doesn't request a Tool, this turn's reply is the final result.

If the model requests a Tool, execute it, append the result to history, then hand the updated history back to the model.

A multi-step execution then naturally grows into:

```text
user

assistant
└── toolCall A

toolResult A

assistant
└── toolCall B

toolResult B

assistant
└── final text
```

The Loop doesn't need to know in advance how many steps the model will take, and it doesn't need a fixed Workflow written up front.

Each turn only handles what has already happened:

```text
call the model
   ↓
execute this turn's Tool Call
   ↓
write the result back to history
   ↓
call the model again
```

What to do next is still decided by the model, based on the new messages.

Chapter 00 already defined the LLM interface as streaming, so the real `agentLoop()` iterates over events, but this chapter only takes the final `done`:

```ts
let hasMoreToolCalls = true;

while (hasMoreToolCalls) {
  let assistantMessage;

  for await (const event of llm.complete({
    model,
    systemPrompt,
    messages: context.messages,
    tools: context.tools,
  })) {
    if (event.type === "done") {
      assistantMessage = event.partial;
      break;
    }
  }

  if (!assistantMessage) {
    throw new Error("LLM stream ended without a done event");
  }

  context.messages.push(assistantMessage);
  hasMoreToolCalls = false;

  for (const toolCall of assistantMessage.toolCalls ?? []) {
    const result = await executeToolCall(context, toolCall);
    context.messages.push(result);
    hasMoreToolCalls = true;
  }
}
```

There are two history writes here:

```ts
context.messages.push(assistantMessage);
```

This records what the model just requested.

Then:

```ts
context.messages.push(result);
```

This records what happened after that request was executed.

Only when the next model call sees both can it match the Tool Call with the Tool Result.

## Tool failures also go back to the model

A successful Tool Call is straightforward:

```text
calculator({ a: 12, b: 30 })
        ↓
       42
        ↓
toolResult("42")
```

But the Tool may also not exist:

```text
assistant
└── weather(...)
```

Or it may throw an exception during execution:

```text
database_query(...)
        ↓
throw Error("connection timeout")
```

If the exception simply ends the whole Loop here, the last message the model sees is still its own Tool Call.

It doesn't know why the tool returned no result, and it gets no chance to try a different approach based on the reason for the failure.

So this chapter does one small thing first: it turns Tool execution failures into a `toolResult` too.

```ts
async function executeToolCall(context, toolCall) {
  const tool = context.tools?.find(
    (t) => t.name === toolCall.name,
  );

  if (!tool) {
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      text: `Tool ${toolCall.name} not found`,
      isError: true,
    };
  }

  try {
    const result = await tool.execute(toolCall.arguments);

    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      text: result.content ?? "",
      isError: false,
    };
  } catch (error) {
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      text:
        error instanceof Error
          ? error.message
          : String(error),
      isError: true,
    };
  }
}
```

On success:

```text
toolResult
├── text: "42"
└── isError: false
```

On failure:

```text
toolResult
├── text: "connection timeout"
└── isError: true
```

Both kinds of result go into history.

A Tool can still signal an execution failure with an exception; the Loop is only responsible for turning that failure into a message the model can read on the next turn.

The model can then change the arguments, switch to another Tool, or just tell the user the operation failed.

Argument preparation, Schema validation and permission checks stay out of here for now. Once `executeToolCall()` itself starts taking on more responsibilities, the Tool Runtime gets handled separately.

## The main loop in Pi

Pi's main loop also moves forward along the same feedback chain.

The model first produces an assistant message, which may contain Tool Calls:

```text
assistant message
      ↓
tool calls
      ↓
execute
```

After the tools finish executing, the results are written back to the current message history:

```ts
currentContext.messages.push(...toolResults);
newMessages.push(...toolResults);
```

The next LLM call naturally sees these results.

For this chapter, the only part that matters is:

```text
LLM
 ↓
tool call
 ↓
tool
 ↓
tool result
 ↓
LLM
```

Later, Pi also adds argument preparation, validation, lifecycle events and other handling around Tool execution.

None of that changes this most basic feedback path.

Run:

```bash
npm run demo
```

The simplest output looks something like:

```text
[user]
What is 12 + 30?

[assistant]
calculator({"a":12,"b":30})

[toolResult]
42

[assistant]
12 + 30 = 42
```

Now the model can keep executing based on Tool Results.

But `agentLoop()` is still one complete async call.

Until it returns, the outside can't see when the model starts replying or when a Tool executes, and doesn't know which turn it has reached.

Chapter 02 picks up from this problem.
