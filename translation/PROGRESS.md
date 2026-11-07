# English translation — progress

- **Phase:** done (2026-11-07)
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
| tooling | translation/check-*.mjs, residue-allowlist, fixtures | merged | ff7f7cc→cherry-picked |
| site | website/.vitepress/**, website/components/**, website/en/index.md, website/scripts/sync-readmes.mjs, website/public/og-cover-en.svg, website/package.json, package.json (description) | merged | 1ed499f |
| 00 | chapters/00-minimal-llm-call/** (+ downstream assertion lines) | merged | 4c661a2 |
| 01 | chapters/01-tool-driven-agent/** | merged | add3e34 |
| 02 | chapters/02-agent-runtime/** | merged | 47c7b3f |
| 03 | chapters/03-tool-runtime/** | merged | f09c02d |
| 04 | chapters/04-parallel-tools/** | merged | 471cf4e |
| 05 | chapters/05-steering-followup/** | merged | 4caec73 |
| 06 | chapters/06-context-transform/** | merged | ea7d064 |
| 07 | chapters/07-session-tree/** (+ downstream assertion lines in 10–12) | merged | fbe8675 |
| 08 | chapters/08-context-compaction/** | merged | 076db65 |
| 09 | chapters/09-skills/** | merged | 0432fb0 |
| 10 | chapters/10-extension-runtime/** (+ downstream assertion lines in 11–12) | merged | 0e23ca5 |
| 11 | chapters/11-extension-composition/** (+ downstream assertion lines in 12) | merged | dc117d4 |
| 12 | chapters/12-coding-agent/** | merged | 2be6780 |
| root | README.en.md alignment + upstream credit (parent) | merged | b1b01e8 |

## Open review findings
- Review wave 1 (Opus reviewers, read-only): `translation/reviews/ch00-03.md` (12 low), `ch04-07.md` (14 low, 10 med: glossary drift on truncation guard / sequential, full-width punctuation), `ch08-11-site.md` (23 low, 2 med). No high.
- Full-width punctuation leftovers: fixed by the parent (f86a549); residue check now also flags CJK punctuation.
- Wave 1 fixes merged (07fda1f, d247087, 9c051a2); cross-copy term sweep 349d19d. Final reviews (`reviews/ch12.md`, `reviews/cross-cutting.md`) applied in ef268e9. Skips are recorded in the report.

## Next action
None. Deployed: https://minerva.tail9e3eb4.ts.net/learn-pi-agent/en/ (user unit `learn-pi-agent-en`, tailscale serve path `/learn-pi-agent`). Still open for the owner: set the default branch to `en-translation` (the gh token lacks admin). Report: vault `pi/2026-11-07 learn-pi-agent english`.

## Notes
- Lanes must not run `npm ci`: worktree `node_modules` symlinks to the main checkout (it was wiped once and restored; after 01–03 + 07 the full suite is green, 211 tests).