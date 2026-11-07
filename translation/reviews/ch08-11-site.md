1. chapters/08-context-compaction/src/demo.ts:132 · low · awkward English · a full-width colon is left over: `console.log("\n=== Reconstructed Context: buildSessionContext ===");`
2. chapters/08-context-compaction/src/demo.ts:129 · low · awkward English · `// Persist to disk: the CompactionEntry is appended to the session file like any other entry (Pi AgentSession persists automatically; the teaching demo calls it explicitly)`
3. chapters/08-context-compaction/src/compaction.ts:9 · low · awkward English · `Pi also allows bashExecution/custom/branchSummary/compactionSummary, which the teaching version does not have),` (the same "teaching has/does not…" wording appears in other comments in this file; reword them to "the teaching version …")
4. chapters/08-context-compaction/test/compaction.test.ts:179 · low · awkward English · full-width punctuation is left over: `// appendCompaction: structural invariant (additive)`
5. chapters/08-context-compaction/test/compaction.test.ts:182 · low · awkward English · full-width parentheses are left over: `describe("appendCompaction (additive invariant)", () => {`
6. chapters/08-context-compaction/test/compaction.test.ts:211 · low · awkward English · full-width parentheses are left over: `describe("buildContextEntries / buildSessionContext (reconstruction)", () => {`
7. chapters/08-context-compaction/test/compaction.test.ts:398 · low · awkward English · full-width parentheses are left over: `describe("multiple compactions (latest wins)", () => {`
8. chapters/08-context-compaction/test/compaction.test.ts:459 · med · mistranslation · the in-memory tree already contains the compaction here, so "pre-Compaction" is wrong; the comparison is with the state before saving: `// reconstruction matches the in-memory state before saving: summary + U3 + A3 + Q4 + R4`
9. chapters/09-skills/README.en.md:310 · low · awkward English · `and filter it out when the messages actually go to the Provider:`
10. chapters/09-skills/README.en.md:367 · low · awkward English · `The existing Message boundary and Tool boundary can already handle them.`
11. chapters/09-skills/README.en.md:442 · low · awkward English · the source line "Chapter NN 从这个问题继续" is translated differently from chapter to chapter (Chapter 08 uses "picks up from"): `Chapter 10 picks up from this problem.`
12. chapters/09-skills/src/agent-loop.ts:176 · low · glossary · 截断保护 → truncation guard: `// Write history together (Pi L218-221): results from normal execution and from the truncation guard both go into context/newMessages`
13. chapters/09-skills/src/agent-loop.ts:311 · low · glossary · 串行 → sequential: `/** Sequential path (same as the previous chapter, Pi L433-487). */`
14. chapters/09-skills/src/agent-loop.ts:324 · low · glossary · 串行 → sequential: `// Pi sequential L472-474: immediate already emitted end; message events are emitted immediately in execution order`
15. chapters/09-skills/src/agent-loop.ts:387 · low · glossary · 截断保护 → truncation guard: `/** Error result for the truncation guard (same as the previous chapter). */` (items 12–15 apply to every copied `agent-loop.ts` that contains the same lines)
16. chapters/10-extension-runtime/README.en.md:348 · low · mistranslation · "继续注册行为" means registering more behavior, not continuing to register: `The Extension just registers more behavior at this spot.`
17. chapters/10-extension-runtime/README.en.md:559 · low · awkward English · make this match the chapter-ending phrase used elsewhere: `Chapter 11 picks up from here.`
18. chapters/10-extension-runtime/extensions/todo.ts:71 · low · awkward English · the parenthetical glosses repeat the English verbs: `description: "Manage the todo list. Actions: list, add (text argument), toggle (id argument), clear",`
19. chapters/10-extension-runtime/extensions/todo.ts:101 · low · awkward English · `return { content: \`Todo #${item.id} ${item.done ? "marked done" : "marked not done"}\`, details: { action, todos: [...todos], nextId } as TodoDetails };`
20. chapters/11-extension-composition/README.en.md:69 · low · awkward English · `allow only allowlisted commands`
21. chapters/11-extension-composition/README.en.md:464 · low · awkward English · `Chapter 04's batch execution can handle them directly.`
22. chapters/11-extension-composition/README.en.md:550 · low · awkward English · `This is also why the Extension Runtime only really shows its value in this chapter.`
23. chapters/11-extension-composition/src/demo.ts:10 · low · awkward English · the other chapters' demos say "working": ` * Prerequisites: working LLM API credentials; the model is set via the CLAUDE_MODEL environment variable.`
24. chapters/11-extension-composition/src/demo.ts:91 · med · mistranslation · the point is building on top of where the Harness stops, not after it stops running: `console.log("Zero changes to the loop, the Agent and the session tree. Every item on the official No list can be built on top of where the Harness stops.");`
25. website/public/og-cover-en.svg:8 · low · omission · the Chinese title "从零拆解" includes "take apart", which the English title drops; this replacement still fits at size 72: `<text x="72" y="315" fill="#e7eee8" font-family="sans-serif" font-size="72" font-weight="700">Pi Agent, Taken Apart</text>`
26. website/.vitepress/i18n/en.ts: none
27. website/en/index.md: none
28. chapters/08-context-compaction/README.en.md: none