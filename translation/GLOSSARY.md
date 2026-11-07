# Glossary (zh → en)

Use these renderings everywhere: chapter READMEs, site UI, code comments, strings and test titles. If a term isn't listed, pick a plain rendering, use it consistently, and report it as a proposed term.

## Keep as-is (already English in the source; never translate, never re-case)

Agent, Agent Harness, Agent Loop, Agent Core, Agent Runtime, Coding Agent, Tool, Tool Calling, Tool Call, Tool Result, Tool Runtime, Tool Execution, Runtime, Turn, EventStream, AgentEvent, Steering, Follow-up, Context, Session, Session Tree, Entry, Compaction, CompactionEntry, Skill, Extension, Extension Runtime, Handler, Provider, Provider Boundary, LLM call boundary, Permission Gate, Plan Mode, Subagent, Harness, Loop, Tool-driven Loop, Assistant Message, partial, history, seam, branch, retained tail, Tracing, Prompt, Package, MCP, Todo, Background Bash, Pi.

Also keep every code identifier, event type (`agent_start`, `message_update` …), file path, CLI flag, env var, npm script and the Pi source references (`types.ts L61-69`).

Keep the source's casing. The source mixes `Tool Result` (concept) with `toolResult` (role/identifier) on purpose, so keep both forms.

## Fixed renderings

| zh | en | notes |
|---|---|---|
| 第 NN 章 / Chapter NN | Chapter NN | cross-references stay plain text "Chapter NN" |
| 调用 | call | 一次 LLM 调用 → one LLM call |
| 调用方 | caller | |
| 一轮 / 轮 | a turn / turn | `turn` when it means the Loop iteration |
| 一次运行 / run | a run | |
| 消息 | message | |
| 历史 / history | history | Runtime history |
| 上下文 | Context (concept) / context (variable) | follow source casing |
| 工具 | Tool (concept) / tool | follow source casing; lowercase in plain prose like "tool failure" |
| 执行 | execute / execution | |
| 校验 / 验证 | validate / validation | 参数校验失败 → "Argument validation failed" |
| 参数 | arguments (call values) / parameters (schema) | 缺少必填参数 → "Missing required argument" |
| 事件 / 事件流 | event / event stream | `EventStream` when it means the class |
| 流式 | streaming | |
| 增量 / delta | delta | |
| 中止 | abort / aborted | 操作已中止 → "Operation aborted" |
| 取消 | cancel | |
| 并发 | concurrency / concurrent | |
| 并行 | parallel | |
| 完成顺序 / 消息顺序 | completion order / message order | |
| 会话 | Session (concept) / session | |
| 分支 | branch | |
| 节点 / 父节点 | node / parent node | |
| 条目 | Entry | |
| 持久化 | persist / persistence | |
| 恢复 | restore (state) / resume (a run) | |
| 重建 | rebuild / reconstruct | Context Reconstruction |
| 压缩 | Compaction | |
| 摘要 | summary | |
| 技能 | Skill | |
| 正文 | body | Skill body |
| 按需加载 | on-demand loading | |
| 扩展 | Extension | 扩展工厂 → extension factory |
| 注册 | register / registration | |
| 钩子 | hook | 钩子抛错 → "hook threw" |
| 合并 | merge | |
| 拦截 | block (permission/guard) / intercept (generic) | 危险命令被拦截 → "Dangerous command blocked" |
| 白名单 | allowlist | |
| 只读 | read-only | |
| 子 agent | subagent | `Subagent` as the chapter concept |
| 委托 | delegate | |
| 边界 | boundary | |
| 能力 | capability | |
| 消费者 / 订阅者 | consumer / subscriber | |
| 模型 | model | |
| 提示词 / 系统提示 | prompt / system prompt | |
| 写回 | write back | |
| 收口 | wrap up / close out | e.g. "`agent_end` closes out a run" |
| 待办 | todo | |
| 损坏行 | corrupted line | |
| 无输出 / 无回复 | (no output) / (no reply) | |
| 适配器 | adapter | `LLMAdapter` |
| 契约 | contract | |
| 快照 | snapshot | |
| 共享基座 | shared base | chapter 00 as the shared library |
| 回传 | send back | |
| 教学裁剪 / 教学剪裁 | trimmed for teaching | |
| 锚点（Pi 锚点） | Pi anchor | source reference to Pi |
| 批终止 | batch termination | |
| 生产-消费解耦 | producer-consumer decoupling | |
| 加数 | addend | |
| 参数校验失败 | Argument validation failed | |
| 缺少必填参数 | Missing required argument | 00/src/validate.ts |
| 操作已中止 | Operation aborted | 00/src/llm.ts |
| 本章目录 / 上一章 / 下一章 | On this page / Previous chapter / Next chapter | site UI |

## Punctuation and typography
- Full-width punctuation becomes ASCII: `：` → `: `, `，` → `, `, `（）` → ` ()`, `。` → `.`, `、` → `, `. Chinese quotes `「」“”` → `"…"`.
- `（Pi：Cannot continue …）` → `(Pi: Cannot continue …)`.
- H1: `# Chapter NN：Title` → `# Chapter NN: Title`, where Title is exactly the English sidebar title.
