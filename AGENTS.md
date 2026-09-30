# MFA viewer repository instructions

- This repository contains the public static viewer for the `aimesy/mfa-data` release of California impact fee collections.
- Keep release files out of this repo. The viewer reads the CSV, `sources/index.csv`, `manifest.json`, evidence PDFs and reports from `raw.githubusercontent.com/aimesy/mfa-data/<sha>/` at run time.
- Do not write to `aimesy/mfa-data` from here. Its release pipeline is the only writer to `main` and owns `manifest.json`, `validation/`, `README.md`, `docs/` and `data/`.
- The shared theme is pinned to one `aimesy/themes` commit. Bump all five URLs in `index.html` together; `check-static.mjs` enforces a single SHA.
- Release text reaches the DOM through `textContent` or attributes only. `check-static.mjs` fails on `innerHTML` and similar calls.
- pdf.js 4.10.38 is vendored in `vendor/`. Keep `isEvalSupported: false`.
- Land-use symbols are drawn from `vendor/noto-emoji/`, a black-and-white Noto Emoji subset of four glyphs. A new symbol needs a new subset (Google Fonts `css2?family=Noto+Emoji&text=...`) and its code point in the `unicode-range`. Never let one fall back to a colour emoji font.
- Sum primary rows only (`is_primary_in_figure_group`). A missing program-year is missing, never zero.
- Draw a box from `outline_rect_pdf_points` only after it is confirmed against the red outline in that figure's evidence file; otherwise draw none and say why.
- Run `node check-static.mjs` and `node tests/model.test.mjs` before pushing; `node tests/smoke.mjs` when the panel, loading or layout changes.
