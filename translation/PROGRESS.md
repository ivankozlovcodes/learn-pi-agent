# English translation — progress

- **Phase:** 0 — fork, clone, recon (running)
- **Upstream SHA:** fc9dbf67d68743d79ea6b44361faadfeebab4985 (yiz-hhh/learn-pi-agent `main`)
- **Fork:** https://github.com/ivankozlovcodes/learn-pi-agent (`main` = upstream mirror, `en-translation` = integration)
- **Layout:** TBD (after recon)

## Baseline (upstream fc9dbf6, 2026-11-07)
- `npm ci` root + website: ok
- `npm run build`: ok · `npm test`: ok (13 chapter suites, 211 tests passed) · `npm run check:docs`: ok (13 chapters) · `website: npm run docs:build`: ok
- Working tree clean after build (generated `website/chapters/*.md` unchanged).

## Lanes
| lane | files | status | commit |
|---|---|---|---|

## Open review findings
none

## Next action
Recon scouts running; then decide layout, write glossary/style + check scripts.
