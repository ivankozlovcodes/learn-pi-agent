# Chapter 02: Agent Runtime

In Chapter 01, the call still looks like this:

```ts
const messages = await agentLoop(...);
```

As long as `agentLoop()` has not returned, the outside has no idea how far things have gotten inside.

One task may already have gone through:

```text
First LLM call
        ↓
    Tool Call
        ↓
  Tool execution
        ↓
    Tool Result
        ↓
Second LLM call
```

If one of those Tools runs for a dozen seconds, the caller still only sees a Promise that hasn't settled.

The LLMAdapter from Chapter 00 already produces streaming events continuously:

```text
start
text_delta
text_delta
...
done
```

Chapter 01 only took the final `done`.

Now the Agent Loop needs to expose its own execution process too.

## Turning the Loop's process into events

The simplest approach is to keep adding callbacks to `agentLoop()`:

```ts
agentLoop({
  onTextDelta(delta) {
    render(delta);
  },
});
```

When we only display model text, this works fine.

But a Tool-driven Loop has many other points in time:

```text
A run starts

A turn's LLM call starts

An assistant message starts being generated

A message is updated

A Tool Result is written into history

This turn ends

The whole run ends
```

If the UI, logs and Tracing each need their own set of callbacks, the Loop soon starts knowing what each of these consumers needs.

Pi unifies these runtime state changes into `AgentEvent`.

Chapter 02 starts with the most basic ones:

```text
agent_start
agent_end

turn_start
turn_end

message_start
message_update
message_end
```

A run that includes a Tool Call produces roughly:

```text
agent_start

turn_start

message_start(user)
message_end(user)

message_start(assistant)
message_update(assistant)
message_update(assistant)
message_end(assistant)

message_start(toolResult)
message_end(toolResult)

turn_end

turn_start

message_start(assistant)
message_update(assistant)
message_end(assistant)

turn_end

agent_end
```

A `turn` corresponds to one iteration of the Loop.

After the model returns a Tool Call, the Tool execution and its Tool Result still belong to that turn. Only after the result is written back to history does the next LLM call enter a new turn.

The original control flow has not changed:

```text
LLM
 ↓
assistant
 ↓
tool
 ↓
toolResult
 ↓
LLM
```

It's just that the points in time that used to be hidden inside the function now go into an `EventStream`.

The caller can consume it directly:

```ts
const stream = agentLoop(...);

for await (const event of stream) {
  console.log(event);
}
```

The UI, logs and Tracing all see the same Runtime event stream. The Agent Loop doesn't need to maintain three separate ways of notifying.

When a Tool itself starts executing, updates its progress or finishes is left out of this chapter. Chapter 03 adds these events once the Tool Runtime takes shape.

## `message_update` represents the current message state

`message_start` and `message_end` are straightforward.

The one that goes wrong more easily is `message_update`.

Suppose the model generates, in order:

```text
"12"
" + 30"
" = 42"
```

One approach is to only send out the raw deltas:

```text
message_update("12")
message_update(" + 30")
message_update(" = 42")
```

Then every consumer has to maintain this itself:

```ts
text += delta;
```

With only text, that's still simple.

But an Assistant Message can also contain a Tool Call at the same time:

```text
assistant
├── text
└── toolCall
    ├── name
    └── arguments
```

The Tool Call's arguments can also be in the middle of being generated.

If the Runtime only throws out character fragments, every consumer has to piece together again "what this Assistant Message looks like right now".

Pi's LLM stream already carries the current `partial` Assistant Message in its events.

When the Runtime receives an update, it directly replaces the assistant being generated in context with the latest partial:

```ts
partialMessage = event.partial;

context.messages[
  context.messages.length - 1
] = partialMessage;
```

Then it sends out the current state:

```ts
await emit({
  type: "message_update",
  message: { ...partialMessage },
  assistantMessageEvent: event,
});
```

So what consumers get is:

```text
message_update
└── "12"

message_update
└── "12 + 30"

message_update
└── "12 + 30 = 42"
```

And not three character deltas that depend on each other.

Missing an update in the middle doesn't affect the later state, because the next event still carries the current complete partial.

A Tool Call that is still forming is handled the same way.

There is also an execution boundary here.

A Tool Call appearing in an Assistant Message doesn't mean it can necessarily be executed.

If the model stops midway because of the token limit:

```text
write_file({
  path: "config.json",
  content: "...
```

The Runtime may already hold an incomplete Tool Call.

Pi looks at the Assistant Message's `stopReason`.

When it ends normally or produces a Tool Call normally, the usual flow continues.

If it is:

```text
error
aborted
```

The current run ends right away.

If it is:

```text
length
```

The Tool Calls already generated are not executed directly; they are turned into failed Tool Results instead:

```text
assistant
stopReason = length
      ↓
Tool Call not executed
      ↓
toolResult(isError = true)
      ↓
history
      ↓
next LLM turn
```

In the next turn, the model can regenerate a complete call based on the failure reason.

The Runtime can store a partial Assistant Message that hasn't ended normally yet; actually executing a Tool Call has to wait until that message completes in an executable state.

## `agent_end` closes out a run

`agentLoop()` now returns an `EventStream`.

When the stream is created, `agent_end` is designated as the completion event:

```ts
const stream = new EventStream<AgentEvent, Message[]>(
  (event) => event.type === "agent_end",
  (event) =>
    event.type === "agent_end"
      ? event.messages
      : [],
);
```

So the same run can be consumed in two ways.

Keep reading events:

```ts
for await (const event of stream) {
  // render / logging / tracing
}
```

Or just wait for the final result:

```ts
const messages = await stream.result();
```

After `agent_end` is emitted, the event stream ends, and `result()` gets the messages newly produced by this run.

This is not the complete history.

Suppose that before entering the Loop there already are:

```text
A
B
```

This run adds:

```text
C  user
D  assistant
E  toolResult
F  assistant
```

What is finally returned is:

```text
C
D
E
F
```

The original `A B` is still held by the caller.

The Agent Loop only reports what this run produced. How the complete history is later saved and restored is not a problem this layer has to handle yet.

Pi's Agent Runtime works along this same boundary: the Loop keeps emitting `AgentEvent` while running, and at the end returns the messages added by this run through `agent_end`.

Run:

```bash
npm run demo
```

You will see something like:

```text
== agent_start

-- turn_start

   user: What is 12 + 30?

   assistant: calculator(...)

   toolResult: 42

-- turn_end

-- turn_start

   assistant: 12
   assistant: 12 + 30
   assistant: 12 + 30 = 42

-- turn_end

== agent_end
```

The Tool Loop from Chapter 01 has not been replaced.

It's just that now we can see from the outside what it is doing.

But Tool execution itself is still a single line:

```ts
await tool.execute(...)
```

When arguments are validated, whether a call can be blocked before execution, and how a long-running Tool reports progress: these questions are still left inside.

Chapter 03 continues from this problem.
