# English translation — progress

- **Phase:** 1 — glossary + tooling (running)
- **Upstream SHA:** fc9dbf67d68743d79ea6b44361faadfeebab4985 (yiz-hhh/learn-pi-agent `main`)
- **Fork:** https://github.com/ivankozlovcodes/learn-pi-agent (`main` = upstream mirror, `en-translation` = integration)

## Layout (decided)
- VitePress `locales`: zh-CN at root (unchanged URLs), English at `/en/`, with the built-in language switcher.
- English chapter sources: `chapters/NN-*/README.en.md`. `website/scripts/sync-readmes.mjs` is extended to emit `website/en/chapters/*.md` (own output dir, own stale cleanup, canonical `/en/chapters/…`). The generated `website/chapters/*.md` (zh) must stay byte-identical.
- All zh UI copy for the root locale lives in `website/.vitepress/i18n/zh.ts` (residue-allowlisted). The English copy lives next to it in `en.ts`.
- Code: TS comments, strings and test titles are translated in place. Identifiers and logic don't change, and assertions are updated with their strings. The zh docs keep their own (Chinese) code samples.
- Why: it mirrors the existing root `README.en.md` convention, keeps the zh site and check-docs untouched, and the sync script stays the single source → site path.

## Baseline (upstream fc9dbf6, 2026-11-07)
- `npm ci` root + website: ok
- `npm run build`: ok · `npm test`: ok (13 chapter suites, 211 tests passed) · `npm run check:docs`: ok (13 chapters) · `website: npm run docs:build`: ok
- Working tree clean after build (generated `website/chapters/*.md` unchanged).

## Scheduling
Every chapter imports `00-minimal-llm-call/src`. 10 and 11 import 07; 11 imports 10; 12 imports 10 and 11. Downstream tests assert on some provider strings, so:
- Lanes are cut from the current `en-translation` HEAD at launch, which already includes the merged providers.
- Provider lanes (00, 07, 10, 11) may edit *assertion lines only* in downstream test files to follow their string changes. No downstream lane of theirs runs concurrently.
- Order: 00 (+ site) → 01–06, 08, 09, 07 → 10 (after 07) → 11 (after 10) → 12 (after 11). ≤4 Opus lanes at a time.

## Lanes
| lane | files | status | commit |
|---|---|---|---|
| tooling | translation/check-*.mjs, residue-allowlist, fixtures | running | |
| site | website/.vitepress/**, website/components/**, website/en/index.md, website/scripts/sync-readmes.mjs, website/public/og-cover-en.svg, website/package.json, package.json (description) | pending | |
| 00 | chapters/00-minimal-llm-call/** (+ downstream assertion lines) | pending | |
| 01 | chapters/01-tool-driven-agent/** | pending | |
| 02 | chapters/02-agent-runtime/** | pending | |
| 03 | chapters/03-tool-runtime/** | pending | |
| 04 | chapters/04-parallel-tools/** | pending | |
| 05 | chapters/05-steering-followup/** | pending | |
| 06 | chapters/06-context-transform/** | pending | |
| 07 | chapters/07-session-tree/** (+ downstream assertion lines in 10–12) | pending | |
| 08 | chapters/08-context-compaction/** | pending | |
| 09 | chapters/09-skills/** | pending | |
| 10 | chapters/10-extension-runtime/** (+ downstream assertion lines in 11–12) | pending | |
| 11 | chapters/11-extension-composition/** (+ downstream assertion lines in 12) | pending | |
| 12 | chapters/12-coding-agent/** | pending | |
| root | README.en.md alignment + upstream credit (parent, Phase 4) | pending | |

## Open review findings
none

## Next action
Merge the tooling lane, then launch the site + 00 lanes.
