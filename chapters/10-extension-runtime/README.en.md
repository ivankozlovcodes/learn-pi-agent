# Chapter 10: Extension Runtime

In Chapter 09, extensions are still mostly data.

A Skill is a file.

A Custom Message is a message.

`addedToolNames` is also just a set of names.

Now take a different requirement.

We want to load a piece of real code:

```text
check permissions before delete_file executes

record state on message_end

register a new hello Tool

add a /todos command
```

The most direct way to write it could be:

```ts
import extension from "./my-extension";

extension({
  agent,
  session,
  tools,
  config,
  eventBus,
});
```

The feature gets wired in quickly.

But from this moment on, the Extension also knows the internal structure of the Harness.

It can change `agent.state` directly, operate on the Session directly, and depend on the concrete data structure the Tool Registry currently uses.

Refactor the Harness internals a little, and these Extensions may all break together.

So the real problem is not "how to dynamically import a module".

It is:

```text
Which Harness capabilities can outside code use?
How do these capabilities persist once loaded?
And at runtime, how do they enter the original Agent path?
```

## An Extension only gets a set of registrable capabilities

The most basic form of a Pi Extension is a module factory:

```ts
export default function (pi: ExtensionAPI) {
  // ...
}
```

The factory can also be async.

An Extension doesn't get the full `AgentSession` or the internal Registry directly.

What it gets is `ExtensionAPI`:

```ts
export default function (pi: ExtensionAPI) {
  pi.registerTool(helloTool);

  pi.registerCommand("todos", ...);

  pi.on("tool_call", async (event, ctx) => {
    // ...
  });
}
```

This factory's only job is registration.

For example:

```ts
export default function (pi: ExtensionAPI) {
  pi.registerTool(helloTool);
}
```

When the module loads, the factory runs once.

After it finishes, what stays behind is not the function, but:

```text
helloTool registration
```

Later, when the model calls:

```text
hello(...)
```

the Extension factory does not run again.

The Runtime finds the already registered Tool directly.

Handlers and Commands work the same way.

Load phase:

```text
extension module
      ↓
factory(api)
      ↓
register tool
register handler
register command
```

Run phase:

```text
Tool Call
→ registered tool

Agent Event
→ registered handler

/todos
→ registered command
```

The Extension module declares what it wants to add.

The Extension Runtime keeps these registrations and uses them later in the run.

This distinction matters.

If "loading an Extension" and "executing Extension behavior" are mixed together, the Runtime soon ends up re-interpreting the whole module every time a capability fires.

What Pi keeps is a set of already registered capabilities.

## An Extension loads completely, or leaves nothing behind

The factory itself is outside code too.

For example:

```ts
export default function (pi: ExtensionAPI) {
  pi.registerTool(toolA);

  throw new Error("boom");
}
```

If `registerTool()` modified the global Runtime the moment it was called, running up to this point would leave an awkward state:

```text
toolA is already registered

the Extension failed to load
```

The system now holds half an Extension.

So loading can't commit the final registrations directly while the factory is still running.

A safer order is:

```text
create temporary registrations
        ↓
run factory
        ↓
success?
```

Success:

```text
commit registrations
```

Failure:

```text
discard registrations
```

This way, when one Extension fails to load, no half set of Tools, Handlers or Commands is left behind.

The other Extensions can keep loading.

Pi's full loader also has to deal with module loading, packages, caching, reloading and so on.

Those belong to the outer layer of resource loading.

This chapter keeps only one runtime constraint:

```text
the set of registrations produced by one factory run
either all enter the Runtime
or none do
```

## An Extension Tool is still an ordinary Tool in the end

`registerTool()` does not add this to the Agent Loop:

```text
executeExtensionTool()
```

Once registered, an Extension Tool joins the Tool set the Agent already uses.

What the Loop sees is still:

```text
context.tools
```

The model emits:

```text
assistant
└── toolCall: hello(...)
```

and it still follows the path Chapter 03 already built:

```text
lookup
prepare
validate
beforeToolCall
execute
afterToolCall
normalize
```

The parallel / sequential batch semantics from Chapter 04 still hold too.

From the Agent Loop's point of view, built-in Tools and Extension Tools don't have two execution models.

At runtime, an Extension Tool sometimes also needs some context from the Harness, for example:

```text
the current working directory
the current Session
the current active tools
```

The Runtime can build an `ExtensionContext` with this information when it actually executes the Tool and pass it in.

The Extension doesn't have to find the current Session through global variables, nor does it need to know how the Harness stores this state internally.

A new capability has entered the system.

The original Tool Runtime was not bypassed because of it.

## Handler registration order is execution order

When an Extension has only one handler, calling it directly is enough.

Once several Extensions coexist, the composition rules have to be settled first.

Say the load order is:

```text
Extension A
  handler 1
  handler 2

Extension B
  handler 1
```

The Runtime dispatches them one by one in registration order:

```text
A.handler1
A.handler2
B.handler1
```

Each handler is `await`ed.

There's no direct `Promise.all()` here like in Parallel Tool Execution.

The reason shows up in the `context` handler.

Say the initial messages are:

```text
messages0
```

A does one transform first:

```text
messages0
    ↓ A
messages1
```

Then B should continue from there:

```text
messages1
    ↓ B
messages2
```

rather than A and B both getting `messages0` at the same time, and then deciding whose result to keep.

So Context interception is a chain.

Chapter 06 already has:

```text
transformContext()
```

The Extension Runtime only needs to plug the registered context handlers into this spot:

```text
messages
   ↓
handler A
   ↓
handler B
   ↓
transformed messages
   ↓
LLM
```

The Core already has the Context seam.

The Extension just registers more behavior at this spot.

## Different Handlers merge in different ways

Some Handlers only observe events.

For example:

```text
message_end
turn_end
agent_end
```

Once they receive the event, they just record a log or state.

`tool_call` is different.

Say a Permission Guard receives:

```text
delete_file(...)
```

and returns:

```ts
{
  block: true,
  reason: "deleting files is not allowed",
}
```

At this point, the later `tool_call` handlers should not run.

The Runtime can short-circuit directly:

```ts
for (const handler of handlers) {
  const result = await handler(event, ctx);

  if (result?.block) {
    return result;
  }
}
```

So the Extension Runtime is not an EventEmitter that is only responsible for:

```text
emit(event)
```

Each seam has its own composition semantics:

```text
context
→ the previous output is passed on to the next

tool_call
→ stop right after a block

message_end
→ notify in order
```

Once these rules are fixed, Extensions can compose reliably within the same Runtime.

## An Extension error shouldn't drag down other Extensions

Extensions are outside code.

Sooner or later a Handler will throw.

Say:

```text
Extension A handler
→ throw
```

If the whole dispatch simply fails along with it:

```text
A throws
↓
B doesn't run
C doesn't run
the Agent run is interrupted too
```

one Extension's error grows into an error of the whole Harness.

Pi isolates exceptions around each individual handler.

So the run can continue:

```text
A throws
   ↓
report error
   ↓
B still runs
```

This is not the same layer of problem as a Tool error.

If a Tool registered by an Extension throws in `execute()`, it still follows the Chapter 03 path:

```text
Tool throws
    ↓
ToolResult(isError = true)
    ↓
the model sees the failure
```

Whereas a Handler such as `message_end` or `tool_call` throwing on its own is a fault in extension code inside the Extension Runtime.

The Runner records the error and moves on to the other handlers.

## Extensions finally plug back into the original Harness

Putting the registration behavior above back into the existing mechanisms, a few paths appear.

Registering a Tool:

```text
registerTool
    ↓
active tools
    ↓
Tool Runtime
```

Handling Context:

```text
on("context")
    ↓
transformContext
    ↓
LLM call
```

Intercepting a Tool Call:

```text
on("tool_call")
    ↓
beforeToolCall
    ↓
Tool Runtime
```

Listening to the Agent run:

```text
on("message_end")
    ↓
Agent Event
```

Saving extension state:

```text
appendEntry
    ↓
Session
```

The Extension Runtime itself does not rebuild:

```text
Extension Agent Loop
Extension Tool Loop
Extension Session
Extension Context
```

It mainly keeps two things:

```text
what outside modules can register
```

and:

```text
how these registrations execute on the existing seams
```

The Agent Loop still doesn't know Extension modules exist.

By now Pi's Core boundary is fairly clear.

Capabilities like Permission, Plan Mode and Sub-agent could of course be written straight into the Agent Runtime.

But we already have:

```text
Tool registration
Tool interception
Context interception
Event handlers
Commands
Session entries
```

The more interesting question is how far these ready-made primitives can already be composed.

Chapter 11 picks up from here.
