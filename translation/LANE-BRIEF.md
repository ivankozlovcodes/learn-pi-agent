# Chapter lane brief

Repo: learn-pi-agent, a Chinese teaching monorepo that rebuilds the Pi agent harness, being translated into English. You work in your own git worktree on the lane for chapter **{{CH}}** (given in your task message; substitute it below). Set up node first: `export PATH=$HOME/.local/share/pi-node/current/bin:$PATH`. **Do NOT run `npm ci` / `npm install`**: your worktree's `node_modules` is a symlink to the main checkout, and reinstalling wipes it for every other lane. If `tsc` or `vitest` is missing, stop and report it.

Read first and follow exactly: `translation/STYLE.md` and `translation/GLOSSARY.md`.

## Your files (edit ONLY these)
- NEW `chapters/{{CH}}/README.en.md`: an English translation of `chapters/{{CH}}/README.md`. Keep the Chinese README.md unchanged.
- Every other file under `chapters/{{CH}}/` that contains Chinese (`rg -l '\p{Han}' chapters/{{CH}} --glob '!node_modules'`). That covers src/, test/, extensions/, fixture/, skills/, package.json `description`, vitest.config.ts. Translate them IN PLACE.
- If your task message says you are a PROVIDER lane: other chapters import your `src`, and their tests may assert on strings it produces. After translating, run the full `npm test` at the repo root. For each downstream failure caused by YOUR string changes, edit ONLY the failing assertion line(s) in that downstream test file, minimally, to match the new English, and list those edits in your return.

Don't edit translation/**, website/**, root files, other chapters' README*.md, or any file not listed above.

## Rules
- In markdown: translate everything outside code fences. Inside fences, translate only comments, user-visible strings and diagram labels. Every fence line without Chinese stays byte-identical, and each fence keeps its line count. The H1 is `# Chapter NN: <English title>`, using the English title already in the source H1.
- In TS: translate all comments and all Chinese strings: errors, tool descriptions, prompts, console/demo output, `describe`/`it` titles, mock replies. Never change identifiers, logic, keys or statement structure.
- If you translate a string that a test asserts on (`toContain` / `toThrow` / `toBe` / regex), update that assertion. Tests must pass.
- Code samples and `text`-fence demo output in the README must use the same English wording as the translated src/demo strings of this chapter.
- Imports from other chapters (e.g. `../../00-minimal-llm-call/src`) are already translated where merged. If a test here asserts on a string produced by another chapter, match that chapter's current (possibly already English) text.

## Checks (loop until clean)
- `node translation/check-residue.mjs chapters/{{CH}}`: no residue (README.md is allowlisted)
- `node translation/check-parity.mjs chapters/{{CH}}`: OK
- `cd chapters/{{CH}} && npm run build && npm test`: pass
- PROVIDER lanes only: `npm run build && npm test` at the repo root: all chapters pass
- `git diff --stat` touches only your files.

Commit in your worktree with the subject `i18n: translate chapter NN to English` and a 1-line body.

Return briefly: the commit SHA, the check results (one line each), judgement calls (≤8 bullets), and proposed glossary terms as `zh → en` lines. No long report.
