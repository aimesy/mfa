# MFA viewer repository instructions

- This repository contains the public static viewer for the `aimesy/mfa-data` release of California impact fee collections.
- Keep release files out of this repo. The viewer reads the CSV, `sources/index.csv`, `manifest.json`, evidence PDFs and reports from `raw.githubusercontent.com/aimesy/mfa-data/<sha>/` at run time.
- Do not write to `aimesy/mfa-data` from here. Its release pipeline is the only writer to `main` and owns `manifest.json`, `validation/`, `README.md`, `docs/` and `data/`.
- The shared theme is pinned to one `aimesy/themes` commit. Bump all five URLs in `index.html` together; `check-static.mjs` enforces a single SHA.
- Release text reaches the DOM through `textContent` or attributes only. `check-static.mjs` fails on `innerHTML` and similar calls.
- pdf.js 4.10.38 is vendored in `vendor/`. Keep `isEvalSupported: false`.
- Tag symbols are drawn in black and white from the whole Noto Emoji face in `vendor/noto-emoji/` (Google's unicode-range subsets; a page loads only the ones it uses). Put symbols in a `.sym` span with U+FE0E so they never fall back to a colour emoji font.
- Sum primary rows only (`is_primary_in_figure_group`). A missing program-year is missing, never zero.
- `lib/fee-links.js` joins fee program names into one fee for display only. Add a link only with evidence from the reports (matching closing and opening balances, a reprint of the old figures, or a difference in wording alone) and record it; `tests/model.test.mjs` fails on a link the release no longer matches.
- Draw a box from `outline_rect_pdf_points` only after it is confirmed against the red outline in that figure's evidence file; otherwise draw none and say why.
- Run `node check-static.mjs` and `node tests/model.test.mjs` before pushing; `node tests/smoke.mjs` when the panel, loading or layout changes.
