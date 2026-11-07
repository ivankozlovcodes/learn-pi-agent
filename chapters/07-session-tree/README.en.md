# Chapter 07: Session Tree

Up to Chapter 06, the history inside the Agent is still one linear `messages[]`:

```text
U1
A1
U2
A2
U3
A3
```

As long as we keep moving forward along the current conversation, this structure works fine.

But what if the user wants to go back to `A1` and start over from there?

The original history is:

```text
U1 → A1 → U2 → A2 → U3 → A3
```

Now we want another path:

```text
U1 → A1 → U2'
```

The most direct way is to cut off the messages after `A1`.

That gives us the new path, but:

```text
U2 → A2 → U3 → A3
```

disappears with it.

We could also copy a new `messages[]`.

But once we do that, we also have to record:

```text
Where did these two histories originally split?
Which one is the current branch?
How do we switch back to the old branch later?
```

The question is no longer just "which messages does the Agent have right now".

It is turning into "how is the history itself stored".

## Each Entry only remembers its parent node

Pi's Session doesn't keep extending `messages[]`.

It stores the session history as Entries.

Every Entry carries:

```ts
type Entry = {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
};
```

Message is just one kind of Entry.

Later we can also have:

```text
model change
custom entry
compaction
...
```

For now, look only at Message.

A normal conversation:

```text
U1 → A1 → U2 → A2
```

can be stored as:

```text
U1
id = 1
parentId = null

A1
id = 2
parentId = 1

U2
id = 3
parentId = 2

A2
id = 4
parentId = 3
```

The Session also keeps a current `leafId`:

```ts
private _leafId: string | null;
```

When a new Entry is added, its parent points at the current leaf:

```ts
const entry = {
  ...input,
  id: generateId(),
  parentId: this._leafId,
  timestamp: new Date().toISOString(),
};

this.entries.push(entry);
this.byId.set(entry.id, entry);

this._leafId = entry.id;
```

If we just keep appending, it still looks like a single chain:

```text
U1 → A1 → U2 → A2
                   ↑
                  leaf
```

The real change happens once the leaf can move.

Suppose the Session already has:

```text
U1 → A1 → U2 → A2 → U3 → A3
```

Move the leaf back to `A1`:

```ts
branch(a1Id);
```

Then keep appending `U2'` and `A2'`:

```text
U1
 │
 A1
  ├── U2 ── A2 ── U3 ── A3
  │
  └── U2' ── A2'
               ↑
              leaf
```

Not a single original Entry was modified.

`U2'` just adds one relation:

```text
parentId = A1
```

`branch()` itself is very light:

```ts
this._leafId = entryId;
```

It only changes "where the next piece of history continues from".

The existing history stays as it is.

## The current Agent still sees only one line

The Session can store multiple branches.

But each model call still accepts only one linear sequence of messages.

When the current leaf is at `A2'`, what the Agent needs is:

```text
U1 → A1 → U2' → A2'
```

not the whole Session Tree.

So `getBranch()` starts from the current leaf and follows `parentId` all the way up to the root:

```ts
getBranch(fromId = this._leafId) {
  const path = [];

  let current = this.byId.get(fromId);

  while (current) {
    path.push(current);

    current = current.parentId
      ? this.byId.get(current.parentId)
      : undefined;
  }

  path.reverse();
  return path;
}
```

Walking up gives:

```text
A2'
 ↑
U2'
 ↑
A1
 ↑
U1
```

Reversed, it is the current active branch:

```text
U1 → A1 → U2' → A2'
```

The old branch:

```text
U2 → A2 → U3 → A3
```

is still stored in the Session; it just doesn't enter this Agent Context.

There is one more layer of conversion.

Because:

```text
SessionEntry ≠ AgentMessage
```

The Session stores more than just Messages.

So after restoring the current branch, we still have to project out the messages the Agent actually needs:

```ts
return this.getBranch()
  .filter((entry) => entry.type === "message")
  .map((entry) => entry.message);
```

That makes the responsibilities on each side clear.

The Session stores:

```text
all Entries
parent relation
current leaf
other history branches
```

The Agent gets:

```text
the Message[] on the current active branch
```

The Agent Loop doesn't need to know about:

```text
parentId
leafId
branch()
Session Tree
```

It still only handles a plain `messages[]`.

## Why the Session stays out of the Agent Loop

If the Agent Runtime took on history management itself, it would soon have to handle all of these at once:

```text
current messages
history branches
rollback
restore
persistence
current leaf
```

All of these are about "session history", but none of them are execution semantics that a single Agent run must understand.

Pi puts the Session outside the Loop.

When restoring a session:

```text
load session
    ↓
reconstruct active branch
    ↓
get Message[]
    ↓
restore Agent state
    ↓
run Agent
```

After a run ends, the newly produced Messages are saved as new Session Entries.

So the Agent Loop built in Chapters 00–06 doesn't need any new Session API.

It keeps handling:

```text
AgentContext
messages
tools
model
```

The Session only decides:

```text
which history path these messages are restored from
```

This is also the difference between Chapter 06 and Chapter 07.

The Session Tree first decides:

```text
which branch is current
```

and restores:

```text
U1
A1
U2'
A2'
```

Right before the model is actually called, `transformContext()` can still decide:

```text
of these four messages,
which ones are actually sent to the model this turn
```

So the execution order is:

```text
Session Tree
    ↓
active branch
    ↓
Message[]
    ↓
transformContext()
    ↓
current LLM input
```

The Session manages the history structure.

`transformContext()` manages the Context view for a single model call.

They are not merged into one mechanism.

## How the Session is persisted

Pi coding-agent's v3 Session uses JSONL.

On disk it is still one record after another:

```text
header
entry
entry
entry
...
```

Each Entry stores its own:

```text
id
parentId
```

So the file doesn't need to maintain nested `children`.

After loading, we rebuild:

```text
entries[]
byId
```

When we need the active branch, we walk back from the leaf along `parentId`.

This format also suits continuous appending.

A new Entry is written straight to the end of the file, with no need to rewrite the whole tree each time.

v3 has one more detail related to the leaf.

The Runtime has:

```text
_leafId
```

But the file doesn't store it separately:

```json
{"leafId": "..."}
```

On reload, the last valid Entry becomes the current leaf.

So if we only do:

```ts
branch(oldEntryId);
```

and then exit, that leaf change is not persisted on its own.

If new history is produced after the branch:

```text
branch(A1)
   ↓
append(U2')
   ↓
append(A2')
```

the last entry in the file is already `A2'`.

On the next load, it naturally restores to the new branch.

`resetLeaf()` doesn't delete old history either:

```ts
resetLeaf() {
  this._leafId = null;
}
```

New Entries appended after it get:

```text
parentId = null
```

So the same Session can contain another root path:

```text
U1
└─ A1
   └─ ...

U1'
└─ A1'
   └─ ...
```

The old Entries still exist.

The only thing that changes is where the current path continues from.

Run:

```bash
npm run demo
```

It first builds:

```text
U: 12 + 30
└─ A: 42
```

then moves the leaf to a history position and continues:

```text
U: 12 + 30
└─ A: 42
   ├─ U: the original follow-up
   │  └─ ...
   │
   └─ U: a new question
      └─ ...
```

After the leaf switches, `getMessages()` restores only the current path.

The other branches are still fully stored in the Session.

At this point, history can branch and can be restored.

But the active branch itself keeps growing.

The Session can store hundreds of Entries in full, but the model's Context Window can't grow without limit.

Chapter 08 picks up from this problem.
