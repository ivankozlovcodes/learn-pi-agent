1. Chapter-ending formula: the same source line `Chapter NN 从这个问题继续` is translated two ways · med · chapters/05-steering-followup/README.en.md, last line, "Chapter 06 picks up from this question." The other 8 chapters (00, 01, 02, 03, 04, 06, 07, 08, 09) end with "Chapter NN picks up from this problem." I checked the sources of 04, 05 and 06 and all three say `从这个问题继续`. Chapters 10 and 11 end with "Chapter NN picks up from here.", which correctly matches their different source `从这里继续`, so leave those two alone. · standardize on "Chapter NN picks up from this problem."

2. 恢复 is rendered as "recovery" instead of the glossary's "restore" · low · README.en.md, chapter table row 07: "Session persistence, branching, and recovery". Chapter 07 itself uses "restore" throughout ("restore the Session", "restores only the current path"). · standardize on "Session persistence, branching, and restoring"

3. Serial (Oxford) comma is used in the root README but nowhere else · low · README.en.md uses it in the intro ("…Compaction, Skills, and Extensions"), in "Why Pi" ("…Todo, and Background Bash") and in the chapter-table rows for 02, 03, 04, 07, 10 and 11 (e.g. "Turns, EventStream, and streaming execution"; "Permission Gate, Plan Mode, and Subagent"). The chapter READMEs and en.ts leave it out, e.g. 01 "Argument preparation, Schema validation and permission checks", 02 "The UI, logs and Tracing", 09 "frontmatter, name conflicts, priority and diagnostics", en.ts ogDescription "Core, Harness, Extension and Coding Agent". · standardize on no serial comma ("A, B and C"), as in the chapters

4. Things I checked and that are consistent or follow the source, so not reported:
   - **H1 headings:** all 13 use `# Chapter NN: Title`, and every Title exactly matches its sidebar entry in config.ts.
   - **"Sub-agent" / "sub-agents":** used in 10 and 11 instead of "Subagent", but the 10 source itself says `Sub-agent`.
   - **"Permission Guard" (10):** the source has the same wording.
   - **"Hook" (06, 12):** the source writes the English `Hook`.
   - **"tracing" vs "Tracing" (04 vs 02):** follows the source's casing.
   - **"Runtime History" in the root README:** the source has the same.
   - **"Agent loop example" in en.ts:** zh.ts also says `Agent loop`.

   **Line numbers:** I couldn't produce exact file:line references. I had only the Read tool, with no `rg` or shell, and its output doesn't show line numbers, so I've cited by quoted text instead. To get line numbers and confirm the counts, run: `rg -n 'picks up from' chapters/*/README.en.md`, `rg -n 'recovery' README.en.md`, `rg -n ', and ' README.en.md chapters/*/README.en.md`.