---
title: Sample Chapter
---

# Sample Chapter

This is a small document for the self-test; see the official docs.

## Message Structure

| Field | Meaning |
| --- | --- |
| `role` | Role |
| `content` | Content |

```ts
// Create a user message
const message = { role: 'user', content: 'Hello' };
sendMessage(message);
```

Run Flow

```text
User input
   │
   ▼
Agent Loop ──► Tool call
```

### Sequence Diagram

```mermaid
sequenceDiagram
  participant U as User
  participant A as Agent
  U->>A: Send message
  A-->>U: Return result
```

![Architecture diagram](./images/arch.png)

> Note: tool calls can run in parallel.
