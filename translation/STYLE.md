# Translation style guide

## Voice
- Plain technical English that matches the source register. The source is short, direct sentences, often one per paragraph, explaining by building up the design step by step. Keep that rhythm and the one-line paragraphs.
- Translate the meaning, not word by word. Don't add, drop, explain or "improve" content. No extra transitions, no summaries the source doesn't have.
- Use present tense and "we"/imperative sparingly, where the source does. "Pi does X" stays "Pi does X".
- American spelling.

## Structure (checked by `translation/check-parity.mjs`)
- Keep the same headings at the same levels, in the same order. Keep the same paragraphs, lists, tables (same rows), blockquotes, images and links.
- Keep the front matter keys, but translate their values.
- Code fences: keep the same count, the same language tag and the same number of lines in each fence.
  - Lines without Chinese stay byte-identical.
  - Lines with Chinese: translate only the comment / string / diagram label part. Never change code, identifiers, indentation or alignment characters (`↓ ├── └──`).
  - In `text` diagrams, keep the arrows and tree glyphs aligned as well as is reasonable.
- Internal links: chapter cross-references are plain text "Chapter NN". If you meet a site link (`/chapters/NN-…`), point it at `/en/chapters/NN-…`.

## Code (TS sources, tests, fixtures)
- Translate every comment (`//`, `/** */`, JSDoc) and every user-visible or test-local string: error messages, tool descriptions, prompts, console output, demo text, `describe`/`it` titles, and mock LLM replies.
- Never change identifiers, logic, types, file names, object keys, or the order and number of statements. Don't reformat.
- If a test asserts on a string that you translate (`toContain`, `toThrow`, `toBe`, regex), update the assertion in the same change. Tests must still pass.
- Strings that also appear in the chapter README (code samples, demo output in `text` fences) must use the same English wording in both places.
- Keep Pi source references verbatim (`Pi \`BeforeToolCallResult\`, types.ts L61-69`).

## Done check per file
- `node translation/check-residue.mjs <files>` finds no Chinese.
- `node translation/check-parity.mjs <chapter dir>` is OK.
- The chapter's `npm test` and `npm run build` pass.
