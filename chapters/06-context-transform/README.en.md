# Chapter 06: Context Transformation

The longer an Agent run goes on, the longer `context.messages` gets.

For example:

```text
U1
A1
Tool1
U2
A2
Tool2
U3
```

All of these messages have already happened.

Later we may still need them to restore the Session, trace what was executed, or keep going from the current state.

But the next model call doesn't necessarily need the whole history sent again.

The most direct approach is:

```ts
context.messages =
  context.messages.slice(-2);
```

The model input does get shorter.

The cost is just as direct: the history the Runtime keeps for itself gets trimmed along with it.

If all we want is to change what the model sees in this turn, we shouldn't also change history that has already happened.

## Runtime history and LLM input are two different things

Before actually calling the model, Pi first takes the current messages:

```ts
let messages = context.messages;

if (config.transformContext) {
  messages = await config.transformContext(
    messages,
    signal,
  );
}
```

The LLM call that follows uses the local variable `messages`.

For example:

```ts
transformContext: async (messages) => {
  return messages.slice(-2);
}
```

Suppose the Runtime currently holds:

```text
U1
A1
Tool1
U2
A2
Tool2
U3
```

In this turn the model only receives:

```text
Tool2
U3
```

But `context.messages` is still:

```text
U1
A1
Tool1
U2
A2
Tool2
U3
```

Once the model produces a new Assistant Message, it is also appended to this full history.

So there are two pieces of data here with different purposes:

```text
context.messages
→ the history the Runtime currently holds

the return value of transformContext(...)
→ the input for this turn's LLM call
```

There is no need for them to always be the same.

This step happens at the LLM call boundary.

Chapter 00 already handled something else here:

```text
Agent Message
    ↓
Provider Message
```

Now the call order becomes:

```text
Runtime history
      ↓
transformContext()
      ↓
current LLM context
      ↓
convertToLlm()
      ↓
Provider messages
```

A `toolResult` is still an Agent Message at the `transformContext()` stage.

Only after it enters `convertToLlm()` does it become a Provider representation, such as Anthropic's `tool_result` or OpenAI's `function_call_output`.

So Context policy and Provider protocol stop at two different boundaries.

## `transformContext()` doesn't own the history

There is an easy trap here.

What Pi passes to `transformContext()` is the original array reference of `context.messages`.

So:

```ts
transformContext: async (messages) => {
  return messages.slice(-2);
}
```

doesn't modify the original history, because `slice()` returns a new array.

But:

```ts
transformContext: async (messages) => {
  messages.splice(0, 3);
  return messages;
}
```

changes `context.messages` directly.

Pi doesn't copy or freeze this array before calling the Hook.

So the guarantee that actually holds here is:

> The Runtime won't automatically replace `context.messages` with the new messages just because `transformContext()` returned them.

If the Hook modifies its input in place, it can still change the Runtime history.

If the goal is only to build this turn's model input, it should return a new array.

There is another problem that `slice(-n)` can't paper over either.

Messages may have protocol relationships with each other:

```text
assistant(toolCall)
toolResult
```

If the window happens to start at `toolResult`:

```text
toolResult
user
assistant
```

the context finally sent to the Provider may have lost a valid Tool Call / Tool Result pairing.

So:

```ts
messages.slice(-n)
```

is only good for showing that "Runtime history and the current LLM context can differ".

A real Context strategy also has to understand message boundaries.

## Why not let the Loop manage the Context strategy directly

Context handling easily keeps growing more rules.

Some only want to keep the last few turns:

```ts
return messages.slice(-n);
```

Some need to filter out internal messages.

Some want to add project background temporarily before calling the model.

Long sessions may also need Compaction.

All of these strategies happen at the same place:

```text
Runtime already owns the history
        ↓
about to call the LLM
```

But the specific strategies aren't stable.

If the Agent Loop itself starts to know about:

```text
sliding window
summary
project context
message filtering
compaction
```

then the Loop has to change again for every new Context policy.

What Pi keeps here is a single intervention point:

```ts
transformContext(messages)
```

What exactly to remove, add or keep in this turn is left to the caller.

Here we start to see one choice Pi makes about the Core boundary.

The Loop needs to know that "Context can be prepared before calling the model".

It doesn't need to know "how Context should be prepared".

We'll run into this boundary again when we actually build Compaction for long sessions.

## There is another kind of change after a Turn ends

`transformContext()` only changes the view for the current LLM call.

If the Runtime itself needs to switch to a different state for the next turn, Pi has another entry point:

```ts
prepareNextTurn
```

It can return:

```ts
return {
  context: nextContext,
  model: nextModel,
};
```

The Runtime really updates:

```ts
currentContext =
  nextTurn.context ?? currentContext;
```

From the next turn on, Steering, model calls and Tool execution all work from the new `currentContext`.

So these two Hooks deal with problems at different levels.

`transformContext()`:

```text
current Runtime history
        ↓
what the model sees this turn
```

`prepareNextTurn()`:

```text
the current turn has ended
        ↓
what state the Runtime continues from next turn
```

The former only produces a view for one call.

The latter can really replace the Runtime state.

After a turn ends, Pi's order is:

```text
turn_end
prepareNextTurn
shouldStopAfterTurn
getSteeringMessages
```

That is, it first updates the next turn's state, then decides whether the run continues.

If:

```ts
shouldStopAfterTurn(...) === true
```

the current run ends right away, without reading Steering or Follow-up any more.

Otherwise it goes back to the message handling logic from Chapter 05.

Run:

```bash
npm run demo
```

You'll see:

```text
Runtime history: 3 messages
LLM input:       1 message
```

The old messages the model didn't see are still kept in the Runtime history.

At this point, the Agent has started to separate:

```text
what has happened
```

from:

```text
what the model needs to see this turn
```

But `context.messages` is still a single linear array.

If after a run ends we want to restore an old session, or branch off a new execution path from some point in the history, this array alone isn't enough.

Chapter 07 continues from this problem.
