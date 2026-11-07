# Chapter 05: Steering & Follow-up

The user first sends:

```text
Check A, B and C
```

The model has already returned three Tool Calls, and the current batch is executing.

Then the user adds:

```text
Skip B, check D instead
```

When should this message reach the model?

If it is pushed into the current turn right now, the problems pile up at once:

```text
Should Tools that have already started be canceled?

What happens to the Assistant Message that is being generated?

Where in the current history should the change happen?
```

Pi does not let the new message preempt the current turn.

Tool Calls that have already started keep executing, and their results are written back to history as usual.

Once this turn ends, the new message takes part in the next LLM call.

## Steering only changes the next turn

Suppose the current Assistant Message has already requested:

```text
toolCall A
toolCall B
toolCall C
```

Steering arrives while these three Tools are executing.

The current turn still runs to completion:

```text
assistant
    ↓
tool batch
    ↓
tool results
    ↓
turn_end
    ↓
check steering
    ↓
next turn
```

So history first becomes:

```text
user:
Check A, B and C

assistant:
  toolCall A
  toolCall B
  toolCall C

toolResult A
toolResult B
toolResult C
```

Only then is the new user message appended:

```text
user:
Skip B, check D instead
```

The next model call sees both:

```text
The results from the previous turn
+
The new request the user just added
```

What Steering changes is the input of the next LLM call.

It does not take back an Assistant Message that has already been generated, and it does not cancel a Tool execution that has already started.

The original Loop had only one reason to keep going:

```ts
while (hasMoreToolCalls) {
  ...
}
```

With Steering, there is one more:

```ts
while (
  hasMoreToolCalls ||
  pendingMessages.length > 0
) {
  ...
}
```

After each turn fully ends, Steering is read once more:

```ts
pendingMessages =
  (await config.getSteeringMessages?.()) ?? [];
```

If there are no new messages, the Loop exits on its original condition.

If there are, they are written into history at the start of the next turn:

```ts
for (const message of pendingMessages) {
  await emit({
    type: "message_start",
    message: { ...message },
  });

  await emit({
    type: "message_end",
    message: { ...message },
  });

  context.messages.push(message);
  newMessages.push(message);
}

pendingMessages = [];
```

There is no dedicated:

```text
role: steering
```

What the model finally sees is still an ordinary user message.

The term Steering only describes at which point in the run this message enters the Loop.

## Follow-up comes at a later point

There is another case.

The model has already finished its answer:

```text
assistant:
The task is done.
```

There is no Tool Call right now, and no Steering waiting to be handled.

By the inner Loop's condition, this run can already end.

Right at this moment, the user sends:

```text
Now sum it up in three points
```

This message arrives later than Steering.

If messages were only checked at the end of each turn, this checkpoint would already have been missed.

So before ending normally, we need to look once more:

```ts
const followUpMessages =
  (await config.getFollowUpMessages?.()) ?? [];

if (followUpMessages.length > 0) {
  pendingMessages = followUpMessages;
  continue;
}

break;
```

Without Follow-up:

```text
current task finished
        ↓
follow-up = []
        ↓
agent_end
```

With Follow-up:

```text
current task finished
        ↓
follow-up exists
        ↓
pendingMessages = follow-up
        ↓
next turn
```

Follow-up enters history the same way Steering does.

In the end it is still:

```text
user message
```

The only difference is where the check happens.

Steering:

```text
turn_end
    ↓
check steering
    ↓
continue current run
```

Follow-up:

```text
inner loop would stop
    ↓
check follow-up
    ↓
continue instead of agent_end
```

If these two entry points were forced into one `getPendingMessages()` that can be read at any time, the timing would get blurry.

Read it every turn, and a Follow-up that should wait until the run is about to end gets in early.

Read it only at the end, and Steering can no longer affect the next LLM call in time.

What really needs to be kept here are two different checkpoints.

## Pi's two-level loop

With these two checkpoints, the Loop naturally gains another level:

```ts
pendingMessages =
  await getSteeringMessages();

while (true) {

  while (
    hasMoreToolCalls ||
    pendingMessages.length > 0
  ) {

    // inject pending messages
    // call LLM
    // execute tools
    // turn_end

    pendingMessages =
      await getSteeringMessages();
  }

  const followUpMessages =
    await getFollowUpMessages();

  if (followUpMessages.length > 0) {
    pendingMessages = followUpMessages;
    continue;
  }

  break;
}

agent_end
```

The inner loop handles the task currently in progress.

After each turn ends, Steering can make the next turn continue.

When the inner loop has no more Tool Calls and no pending Steering, the outer loop then checks Follow-up.

Only if there are no new messages here either is `agent_end` actually emitted.

One boundary has not changed.

If the Assistant Message ends with:

```text
error
aborted
```

the current run terminates right away.

Steering and Follow-up are not polled again at that point.

Follow-up can catch a run that is about to end normally, but it will not restart a run that has already been aborted.

Run:

```bash
npm run demo
```

The first message can enter after a complete turn ends:

```text
turn 1
  user: What is 12 + 30?
  calculator → 42
turn_end

steering:
  Also echo hello back to me

turn 2
  user: Also echo hello back to me
  echo → hello
```

The other one comes when the run was already about to end:

```text
assistant final response
    ↓
no tool call
no steering
    ↓
follow-up:
  Now calculate 100 - 40
    ↓
new turn
```

In the end, both messages are just ordinary user messages.

Their effect on the Loop comes from when they enter.

At this point, the input of a run is no longer decided only by the batch of messages given at startup.

Before the next model call, what else can the Runtime do with the Context it has built up?

Chapter 06 picks up from this problem.
