# Chapter 00: Minimal LLM Call

The simplest chat program only needs to keep a list of messages and hand them to the model.

```ts
const response = await anthropic.messages.create({
  model,
  system,
  messages,
});
```

If there is only plain `user` and `assistant` text, this is already enough. Messages can use the Provider SDK types directly, and the response can go straight back into history.

At this point there is no visible need to design our own Message.

Once Tool Calling shows up, things start to change.

## Tool Calling lets Provider differences into the Runtime

Suppose the user asks:

```text
What's the weather like in Singapore right now?
```

The model decides to call:

```text
get_weather({ city: "Singapore" })
```

Anthropic puts this call in a `tool_use` block of the assistant message:

```ts
{
  role: "assistant",
  content: [
    {
      type: "tool_use",
      id: "call_123",
      name: "get_weather",
      input: {
        city: "Singapore"
      }
    }
  ]
}
```

The program executes the tool and gets:

```text
31°C, cloudy
```

To hand the result back to Anthropic, we build a `user` message and put a `tool_result` block inside it:

```ts
{
  role: "user",
  content: [
    {
      type: "tool_result",
      tool_use_id: "call_123",
      content: "31°C, cloudy"
    }
  ]
}
```

Here `role: "user"` is how the Anthropic Messages API protocol represents it. What actually marks this as a tool result is the `tool_result` inside.

Switch to the OpenAI Responses API, and the same process looks different.

When the model requests a tool, it returns:

```ts
{
  type: "function_call",
  call_id: "call_123",
  name: "get_weather",
  arguments: "{\"city\":\"Singapore\"}"
}
```

After the tool finishes executing, we send back:

```ts
{
  type: "function_call_output",
  call_id: "call_123",
  output: "31°C, cloudy"
}
```

Both sides are really expressing the same thing:

```text
Model requests get_weather
        ↓
Program executes the tool
        ↓
Returns "31°C, cloudy"
```

But the representations in the APIs are already clearly different:

| | Anthropic Messages | OpenAI Responses |
| --- | --- | --- |
| Tool Call | `tool_use` content block | `function_call` item |
| Call arguments | `input` object | `arguments` JSON string |
| Call ID | `id` | `call_id` |
| Tool Result | `tool_result` content block | `function_call_output` item |
| Result correlation | `tool_use_id` | `call_id` |
| Where the result lives | inside a `role: "user"` message | separate input item |

Plain text messages still map fairly directly. With Tool Calling, the difference is no longer just a few renamed fields.

If the Runtime stores Anthropic's message format internally, then after a tool finishes executing, the Tool Runtime also has to know:

```text
role: user
content:
  type: tool_result
  tool_use_id: ...
```

Later, when OpenAI is added, this part also has to understand:

```text
type: function_call_output
call_id
output
```

That way the Provider protocol leaves the one place where the model is called and moves on into the Tool Runtime.

Further on, the Session stores Provider Messages too, and Context handling still operates on Provider Messages. What started as a difference in how models are integrated ends up affecting the whole run path.

Only at this point does it become necessary to separate the two.

## Give the Agent its own messages

From the Agent Runtime's point of view, it doesn't need to know why Anthropic uses `tool_result`, or why OpenAI calls it `function_call_output`.

Which tool the model requested:

```ts
{
  role: "assistant",
  toolCalls: [
    {
      id: "call_123",
      name: "get_weather",
      arguments: {
        city: "Singapore"
      }
    }
  ]
}
```

What happened after the tool executed:

```ts
{
  role: "toolResult",
  toolCallId: "call_123",
  toolName: "get_weather",
  text: "31°C, cloudy",
  isError: false
}
```

This information is already enough for the rest of the Runtime.

So the history can store the Agent's own `Message`:

```text
Message
├── user
├── assistant
│   ├── text
│   └── toolCalls
└── toolResult
    ├── toolCallId
    ├── toolName
    ├── text
    └── isError
```

Only when we are about to call the Provider do we convert it into the matching protocol.

Take the Anthropic adapter as an example:

```text
Message[]
    ↓
convertToLlm()
    ↓
Anthropic Message[]
    ↓
LLM
```

A `toolResult` in the Runtime:

```text
toolResult
toolCallId = call_123
text = "31°C, cloudy"
```

only becomes Anthropic's form in the adapter:

```text
user
└── tool_result
    └── tool_use_id = call_123
```

The matching conversion code is roughly:

```ts
case "toolResult":
  pendingToolResults.push({
    type: "tool_result",
    tool_use_id: m.toolCallId ?? "",
    content: m.text ?? "",
    is_error: m.isError ?? false,
  });
  break;
```

If an OpenAI adapter is added later, the same Runtime Message can become this in another adapter:

```text
function_call_output
└── call_id = call_123
```

The Agent Loop doesn't need to change along with it.

Provider differences stop at `convertToLlm()`.

In the plain-text stage, we didn't add this layer ahead of time "in case we support more Providers later". Only when Tool Calling started pushing the protocol into the Runtime did our own Message actually become useful.

## Pi keeps the conversion at the LLM call boundary

Pi's Agent Loop also always works with its own `AgentMessage`.

`agent-loop.ts` has a very direct comment:

> "Agent loop that works with AgentMessage throughout. Transforms to Message[] only at the LLM call boundary."

The path before calling the model is:

```text
AgentMessage[]
      ↓
transformContext()
      ↓
convertToLlm()
      ↓
Message[]
      ↓
LLM
```

The specific Provider protocols stay in the implementations further down. What the Agent Loop sees is still the unified `user`, `assistant`, `toolResult` and other messages.

Chapter 00 keeps only the smallest piece of this:

```text
Agent Message
      ↓
Anthropic adapter
      ↓
Anthropic API
```

For now there is only the Anthropic adapter, but that doesn't make the internal Message just adopt the Anthropic Message.

The code also keeps a streaming interface:

```ts
interface LLMAdapter {
  complete(
    input: LLMRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AssistantMessageEvent>;
}
```

One streaming call may produce, one after another:

```text
start
text_delta
text_delta
...
done
```

This chapter only needs the final `AssistantMessage`, so for now we consume `done`. The delta events don't need to be carried further into the Runtime yet; we handle them later, when we actually need to observe the Agent's execution.

Run:

```bash
npm run demo
```

For now the whole call chain is still very short:

```text
Message[]
   ↓
convertToLlm()
   ↓
Provider
   ↓
AssistantMessage
```

Once a plain text reply comes back, the call is over.

A Tool Call is different.

```text
LLM
 ↓
tool call
 ↓
execute
 ↓
tool result
```

The program already knows what the tool returned, but the model doesn't yet.

This Tool Result still has to get back into the next model call.

Chapter 01 picks up from this problem.
