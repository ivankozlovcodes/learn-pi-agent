# Chapter 08: Context Compaction

Chapter 07 can already save the full Session.

Now suppose the active branch keeps growing:

```text
U1
A1
Tool1
U2
A2
Tool2
...
U80
A80
```

The Session Tree can keep storing these Entries.

The problem shows up on the next run.

When we rebuild the branch along the active leaf, the resulting `messages` keep growing too. The Session wants to keep the full history, but the model can't take in everything forever.

The most direct approach is:

```ts
messages = compact(messages);
```

The current Context does get shorter.

But this Compaction only exists in memory.

After the program restarts, the Session still restores the old branch in full; and when we switch to another branch, it doesn't know which summary should apply.

So if long-session Compaction is to really become part of the Session, it can't just modify a temporary `Message[]`.

## Compaction is saved as an Entry too

After Compaction finishes, Pi does not delete the old Entries.

It appends a new `CompactionEntry` to the current branch:

```ts
type CompactionEntry = {
  type: "compaction";

  id: string;
  parentId: string | null;
  timestamp: string;

  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
};
```

Suppose the current branch is:

```text
U1 → A1 → T1 → U2 → A2 → U3 → A3
```

After one Compaction, all the original Entries are still there:

```text
U1 → A1 → T1 → U2 → A2 → U3 → A3 → C
```

`C` is this `CompactionEntry`.

Like every other Entry, it has:

```text
id
parentId
timestamp
```

And it becomes the new leaf.

The Session itself does not get shorter.

What is actually added is one record:

```text
When rebuilding Context from here on,
the earlier part of history can be replaced by the summary.
```

Suppose:

```text
U1 → A1 → T1 → U2 → A2
```

is compacted into the summary, while:

```text
U3 → A3
```

is kept verbatim.

Then the `CompactionEntry` stores:

```text
summary = "The earlier conversation completed..."

firstKeptEntryId = U3.id
```

`firstKeptEntryId` points to:

```text
the first Entry still kept verbatim
```

Not the last Entry covered by the summary.

Then more history is produced:

```text
U1 → A1 → T1 → U2 → A2 → U3 → A3 → C → U4 → A4
```

Still no Entry in the Session has been deleted.

The short Context appears in the next step.

## Compaction is applied only when rebuilding the current Context

Chapter 07 first finds the current path along the active leaf.

Without Compaction, Message Entries can be projected directly into `Message[]`.

If a `CompactionEntry` already appears on the active path, reconstruction finds the most recent Compaction on the current path.

Suppose the full path is:

```text
U1
A1
T1
U2
A2
U3
A3
C
U4
A4
```

Where:

```text
C.summary = "The earlier conversation completed..."
C.firstKeptEntryId = U3
```

After reconstruction, the Agent no longer gets:

```text
U1
A1
T1
U2
A2
U3
A3
U4
A4
```

But instead:

```text
Compaction Summary
U3
A3
U4
A4
```

The compacted `U1 ~ A2` still exist in the Session file.

Current Context reconstruction just no longer projects these Entries one by one to the Agent.

There is no second copy:

```text
compacted-session.json
```

Nor is the original Session rewritten into a summarized version.

The Session Tree keeps storing the full history.

The short Context is just a working view rebuilt from this tree.

This matters, because branch, restore and persistence can all keep using the Chapter 07 structure, with no need to maintain a parallel state just for Compaction.

## The retained tail can't start at an arbitrary position

`firstKeptEntryId` can't be picked arbitrarily by token count either.

For example, the history contains:

```text
assistant(toolCall)
toolResult
user
assistant
```

If the cut point lands on:

```text
toolResult
```

then the retained tail becomes:

```text
toolResult
user
assistant
```

The matching Tool Call has already been covered by the summary.

The next time it is sent to the Provider, this Tool Result has lost its preceding call.

Chapter 06 already ran into the same constraint:

```text
Context can get shorter
```

But it must not break the protocol relationship between Tool Call and Tool Result.

So besides meeting the token budget, the cut point must also land on a safe boundary.

For example, it can take:

```text
user
```

as the start.

Or keep the whole:

```text
assistant(toolCall)
toolResult
```

But it can't leave only the `toolResult` of that pair.

And what is finally written to the Session is not:

```text
array index = 37
```

But the stable:

```text
firstKeptEntryId
```

After the program restarts and reloads the JSONL, the Entry id can still find the start of the retained tail.

## Compaction belongs only to the branch that passes through it

A `CompactionEntry` is itself a node on the Session Tree.

So by nature it only affects paths that pass through this node.

Suppose:

```text
A → B → C → D → E → C1 → F → G
```

`C1` is a Compaction.

When the current leaf is at `G`, the active path passes through `C1`.

So reconstruction uses:

```text
C1 summary
+
retained tail
+
later messages
```

But if a new branch later forks from the earlier `C`:

```text
A → B → C → X → Y
```

this path never passes through `C1`.

So rebuilding `Y` won't use this summary.

There's no need to maintain an extra:

```text
session.compacted = true
```

Because "whether a Compaction has happened" is not a global property of the Session.

It is just an Entry on one history path.

A long session can later get a second one:

```text
...
C1
...
C2
...
```

The old `C1` stays in the tree.

If the current active path already passes through `C2`, reconstruction uses the most recent Compaction:

```text
C2 summary
retained tail after C2
later messages
```

There's no need to modify or delete `C1`.

This is also a direct result of putting Compaction into the Session Tree:

branch-local semantics need no extra design.

They reuse the path relationships `parentId` already expresses.

## Compaction and `transformContext()` handle different layers

After Compaction succeeds, it doesn't have to wait for a program restart to take effect.

Once the new `CompactionEntry` is written to the Session, the current Context can be rebuilt right away:

```ts
const result = await compactSession(...);

if (result) {
  agent.replaceMessages(result.context);
}
```

The next `prompt()` picks up from:

```text
summary
retained tail
```

and continues.

This also shows the difference between Chapter 06 and Chapter 08.

`transformContext()` handles:

```text
the current Agent Context already exists
        ↓
what this LLM call actually sends
```

Compaction handles:

```text
the full Session branch
        ↓
how to rebuild shorter canonical messages
```

So the order is:

```text
Session Tree
    ↓
apply latest CompactionEntry
    ↓
canonical Agent messages
    ↓
transformContext()
    ↓
current LLM input
```

Compaction does not replace `transformContext()`.

And `transformContext()` is not responsible for persisting Compaction.

Here Pi still doesn't make the Agent Loop aware of:

```text
summary format
token threshold
retained tail policy
branch compaction state
```

What the Loop finally gets is still just the new `messages`.

The history semantics of long sessions stay in the Session layer.

Run:

```bash
npm run demo
```

Before Compaction, the Session may have 7 Entries:

```text
U1
A1
T1
U2
A2
U3
A3
```

Afterward, the Session actually grows to 8, because it just gains one `CompactionEntry`.

But the rebuilt Context shrinks to:

```text
Compaction Summary
U3
A3
```

As the conversation continues, new messages work on from this canonical Context.

The original history is still saved in full in the Session Tree.

At this point, the Session can keep both:

```text
the full history
```

and:

```text
a bounded working Context
```

Next comes another kind of complexity.

Different projects have their own domain notes, workflows and knowledge that can be read on demand.

If we keep modifying the Harness every time we add a kind of knowledge, it will soon start to bloat again.

Chapter 09 picks up from this problem.
