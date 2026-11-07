# Chapter 09: Skills

By Chapter 08, Session and Context can already run for a long time.

But what the Agent should do when it meets a certain kind of problem is, much of the time, still written in the program.

Say we are building a database troubleshooting Agent and want to tell it:

```text
For connection problems, check the instance status first
For slow SQL, look at the execution plan first
When there is blocking, then check lock waits
Don't judge the root cause directly when evidence is lacking
```

The most direct way is to keep editing `systemPrompt`.

For one project, that's fine.

But if the Agent later also has to handle:

```text
database debugging
payment debugging
deployment debugging
code review
...
```

putting the full body of every rule set into the Prompt soon turns into:

```text
database debugging full text

payment debugging full text

deployment debugging full text

code review full text

...
```

And this time the user may only ask:

```text
The database connection keeps timing out, help me troubleshoot it
```

The model has no need to reread every domain description each time.

## First let the model know which Skills exist

Put the database troubleshooting instructions in a file:

```text
database-debugging/SKILL.md
```

For example:

```markdown
---
name: database-debugging
description: Troubleshoot database connections, slow queries and lock waits
---

When troubleshooting database problems:

1. First confirm the connection and instance status;
2. Then check slow SQL;
3. Finally check lock waits and transaction blocking;
4. Don't judge the root cause directly when evidence is lacking.
```

When the Agent starts, it could of course read the whole file directly.

Pi doesn't do that.

Only the Skill metadata goes into the system prompt:

```text
name
description
location
```

For example:

```text
database-debugging

Troubleshoot database connections, slow queries and lock waits

/project/skills/database-debugging/SKILL.md
```

The final Prompt can contain:

```xml
<available_skills>
  <skill>
    <name>database-debugging</name>
    <description>
      Troubleshoot database connections, slow queries and lock waits
    </description>
    <location>
      /project/skills/database-debugging/SKILL.md
    </location>
  </skill>
</available_skills>
```

There is no Skill body here.

The model first knows:

```text
Which Skills exist
What problem each one handles
Where the body is
```

Skills are already discovered at startup.

What is really deferred is when the body enters the Context.

## Read the body only when needed

Now the user asks:

```text
The database connection keeps timing out, help me troubleshoot it
```

After seeing the catalog, the model can judge that:

```text
database-debugging
```

is relevant to the current task.

Then it calls the existing `read` tool:

```text
read(
  /project/skills/database-debugging/SKILL.md
)
```

The body comes back into the current run as an ordinary Tool Result:

```text
First confirm the connection and instance status
Then check slow SQL
Finally check lock waits
...
```

Next the Agent keeps troubleshooting with the existing tools.

The whole process is still:

```text
system prompt
└── database-debugging metadata

user
└── The database connection keeps timing out

assistant
└── read(SKILL.md)

toolResult
└── Skill body

assistant
└── Keep calling existing tools per the Skill
```

The Agent Loop doesn't add:

```text
loadSkill()
executeSkill()
```

The Skill itself doesn't have:

```ts
execute()
```

What it provides is task-related instructions and procedures.

What actually performs operations is still the Tool.

For example, a Skill can say:

```text
First use the sql tool to check slow queries,
then use the shell tool to confirm the instance status.
```

Here `sql` and `shell` still execute through the Tool Runtime built in Chapter 03.

The Skill body just enters the Agent through the existing `read → ToolResult → Message` path.

## Skills aren't saved with the Session

Skill files come from the current project environment.

Discovering:

```text
database-debugging
```

doesn't add to the Session Tree a new:

```text
SkillEntry
```

When an old Session is reopened, the Harness rediscovers Skills from the current environment.

So these two kinds of data have different sources:

```text
Skill catalog
→ the current project environment

Session
→ the conversation and execution history that already happened
```

This also affects Compaction.

The Skill catalog can be regenerated every time the system prompt is built.

Chapter 08's Session Compaction doesn't need to save or summarize it.

But once the model actually reads a Skill file:

```text
read(SKILL.md)
    ↓
toolResult
```

that Tool Result already belongs to the current run.

Like any ordinary tool result, it goes into the Session and may later be summarized by Compaction.

So:

```text
Skill file
```

stays outside the Session for the long term.

While:

```text
The Skill content actually read in this run
```

becomes part of the execution history.

Here we keep using boundaries that already existed.

Session doesn't need to understand Skills.

Compaction doesn't need to understand Skills.

The Agent Loop doesn't need to understand Skills either.

What they see is still just the existing Message and Tool Result.

## New capabilities first try to enter along existing boundaries

Skill is the most complete example in this chapter.

Pi also has some smaller extension points that show the same thing.

For example, an application may need an internal message used only by the UI:

```text
U1
A1
PROGRESS
U2
```

`PROGRESS` means something to the Runtime, but shouldn't be handed to the Provider.

Chapter 00 already has `convertToLlm()`.

So the Runtime can keep:

```text
U1
A1
PROGRESS
U2
```

and filter it out when actually going into the Provider:

```text
U1
A1
U2
```

Pi provides `CustomAgentMessages` at the type level, and applications can extend `AgentMessage` through TypeScript declaration merging.

Whether the Provider ultimately sees the message is still decided by `convertToLlm()`.

Another example shows up in the Tool Result.

After a Tool executes, it may make new Tools available starting from the next turn.

For example, before authentication there is only:

```text
login
```

After authentication succeeds, these are added:

```text
write_file
deploy
```

The Tool can return:

```ts
addedToolNames = [
  "write_file",
  "deploy",
];
```

The Harness then uses these names to update the Tool set for later turns.

There is a clear time boundary here.

If the same Assistant Message requests at once:

```text
login()
deploy()
```

and `deploy` doesn't exist yet when this turn starts, it won't suddenly become available in the current batch just because `login()` is about to succeed.

The tool set is updated after this batch ends.

Only in the next turn can the model actually see the new Tool.

Neither mechanism requires redesigning the Agent Loop.

The existing Message boundary and Tool boundary can already catch them.

## Pi's Skills end up leaving only a very short runtime path

Pi coding-agent discovers Skills from places like the project, user configuration and packages, and also handles frontmatter, name conflicts, priority and diagnostics.

These belong to the resource discovery layer.

Once inside the Agent, the path is short:

```text
Skill file
    ↓
metadata catalog
    ↓
system prompt
    ↓
model chooses Skill
    ↓
read Skill body
    ↓
existing Tool / Message loop
```

So when adding domain capabilities like:

```text
database debugging
payment debugging
code review
```

there's no need to add to the Agent Loop, one by one:

```text
if (database) ...
if (payment) ...
if (codeReview) ...
```

They first exist outside the Core as files and metadata.

When actually needed, they enter the current run through the existing Prompt, Tool and Message boundaries.

Run:

```bash
npm run demo
```

After startup you first see the Skill catalog:

```xml
<available_skills>
  <skill
    name="calc"
    location=".../skills/calc.md">

    <description>
      Handle arithmetic calculations
    </description>
  </skill>
</available_skills>
```

It doesn't contain the full Skill body.

When the model judges that the current task needs `calc`, it then reads the corresponding file.

At this point, a lot of domain knowledge can already stay outside the Harness.

But a Skill is still just a file, and Custom Message and `addedToolNames` are also just data.

If we want to load a piece of real code that registers Tools, listens for events and intercepts calls, these data entry points alone aren't enough.

Chapter 10 continues from this problem.
