# Chapter 04: Parallel Tool Execution

After Chapter 03, a single Tool Call already has a complete execution path.

But when several Tool Calls appear in the same turn, they are still executed one after another.

Suppose the model returns three independent calls at once:

```text
A = 300ms
B = 50ms
C = 150ms
```

With sequential execution:

```text
A  ─────────────── 300ms
                   B ── 50ms
                        C ─────── 150ms

total ≈ 500ms
```

B and C don't depend on A, yet they keep waiting just because they come later.

The most direct idea is:

```ts
await Promise.all(
  toolCalls.map((call) =>
    executeToolCall(call),
  ),
);
```

But Chapter 03's `executeToolCall()` is no longer just a function call.

## Concurrency only happens in the execute stage

Before a Tool Call actually executes, it also goes through:

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

If we throw the whole path straight into `Promise.all()`, the earlier prepare stage runs concurrently too.

That isn't always appropriate.

`beforeToolCall` may need to make a permission decision, or wait for the user to confirm. If several Tool Calls enter it at the same time, those external interactions all happen at once.

Pi's parallel path splits this chain into two parts.

First, prepare in the order the model gave:

```text
prepare A
prepare B
prepare C
```

Then put only the successfully prepared calls into the concurrent execution stage:

```text
execute A ───────────────
execute B ──
execute C ───────
```

So concurrency starts at `execute`.

The earlier:

```text
lookup
prepare
validate
beforeToolCall
```

still keep source order.

A call that fails in prepare can't disappear from the batch either.

Suppose the model returns:

```text
A  B  C
```

where B requests a Tool that doesn't exist.

B already gets an error result in the prepare stage:

```text
B
↓
lookup
↓
not found
↓
error result
```

Only A and C actually enter concurrent execution.

But the batch still keeps the original three positions:

```text
0 → execute A
1 → immediate error B
2 → execute C
```

After the whole batch finishes, B's error result still has to go back to the second position.

## Concurrency brings two orders

Still the same batch:

```text
source order:

A → B → C
```

Suppose the execution times are:

```text
A = 300ms
B = 50ms
C = 150ms
```

If all three Tools start at the same time, the actual completion order is:

```text
B → C → A
```

`tool_execution_end` should follow the real execution:

```text
end B
end C
end A
```

B has already finished, so there's no reason to delay its event while waiting for A.

UI, logs and tracing care about "what is happening now".

So execution events keep completion order.

Message history is a different matter.

If Tool Results were also written in order of completion speed:

```text
toolResult B
toolResult C
toolResult A
```

then the same assistant message:

```text
assistant
├── toolCall A
├── toolCall B
└── toolCall C
```

could leave history in different orders on different machines and under different loads.

There's no need for that here.

The model issued the Tool Calls in the order:

```text
A → B → C
```

and the results keep that order when written back:

```text
toolResult A
toolResult B
toolResult C
```

So a parallel batch holds two orders at once:

```text
execution events
B → C → A

message history
A → B → C
```

The first records the actual completion times.

The second keeps the model's original Tool Call arrangement.

The two orders serve different purposes to begin with.

The implementation can still use `Promise.all()`.

Its results keep the positions of the input Promises, so once all calls settle, the results can be committed again by source index:

```ts
const outcomes = await Promise.all(
  entries.map((entry) => execute(entry)),
);

for (let i = 0; i < entries.length; i++) {
  // commit Tool Result in source order
}
```

And `tool_execution_end` is sent the moment each execution actually finishes, so it is naturally in completion order.

## Pi's parallel batch

Pi's `executeToolCallsParallel` has the same structure.

The first half prepares in order:

```text
tool calls
    ↓
prepare A
prepare B
prepare C
```

After preparation, it executes concurrently:

```text
execute A ─────────
execute B ──
execute C ─────
```

Once the batch settles, the results are written back in the original Tool Call order. Calls that already failed in the prepare stage keep their original positions too.

Pi also keeps a sequential path.

If the global config requires sequential execution, or any Tool in the batch declares that it must be sequential, the batch doesn't enter the parallel path:

```text
A → B → C
```

The Tool Runtime doesn't need a second implementation.

The batch just decides before it starts between:

```text
sequential
```

and:

```text
parallel execute
```

## `terminate` doesn't cancel concurrent tasks

Chapter 03 already has:

```ts
terminate: true
```

With concurrent execution, this field is still just the result of one Tool.

Suppose B finishes first:

```text
B
↓
terminate = true
```

A and C are not canceled immediately because of it.

The Runtime keeps waiting for the current batch to finish.

Once all results have settled, it checks:

```ts
outcomes.every(
  (outcome) =>
    outcome.terminate === true,
)
```

Only when:

```text
A  true
B  true
C  true

→ stop
```

does the rest of the Loop end.

If it is:

```text
A  true
B  false
C  true

→ continue
```

it moves on to the next turn.

`terminate` expresses the Tool Result's suggestion for the rest of the Loop.

Canceling a Tool that is still executing is still a job for controls like `AbortSignal`.

Run:

```bash
npm run demo
```

When the model generates several Tool Calls in the same turn, you can see the executions overlap:

```text
start A
start B
start C

end B
end C
end A
```

while the Tool Results written back to history are still:

```text
A
B
C
```

At this point, several Tool Calls in one turn can execute together.

But the Loop only handles messages that were already in the context when the turn started.

If a Tool is still executing and the user sends new input, the current Loop doesn't change the turn in progress because of it.

Chapter 05 picks up from this problem.
