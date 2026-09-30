# MFA viewer

A static site for looking at every figure in the `aimesy/mfa-data` release beside the page it was read from. It uses the shared `aimesy/themes` theme, pinned to one commit.

This repository is the viewer; `aimesy/mfa-data` is the release it reads, as `aimesy/kcsc` is to `aimesy/kcsc-data`. Once Pages is enabled it is published at:

```text
https://aimesy.github.io/mfa/
```

## What it is for

The release claims that every figure was read from the original report, outlined on its page, checked against the report's own arithmetic and reviewed twice. The site lets a reader check that claim one figure at a time:

- **Figures.** Each row is one printed figure. Filter and search it (the search also covers caveats), sort it, and export it. Opening a row shows the outlined evidence page, scrolled to the figure. One click then opens the complete original report at that page, with the figure boxed and the other published figures on the page marked.
- **Jurisdictions.** Each agency gets a matrix of fee programs by fiscal year. Every cell opens its evidence, and an empty cell is shown as missing, not zero.
- **Sources.** Each original report can be opened in the viewer, with every published figure in it listed and boxed.
- **About.** Coverage by fiscal year, the cohort accounting, refusals by reason, the empty stronger tables, and links to the method documents.

Every view is in the URL, so any figure, filter or page is a link. **Cite** copies a citation with a link pinned to the release commit.

## How it differs from tentatives

It follows `aimesy/tentatives` in layout: a chip toolbar, a table plus a detail panel, URL-driven state, CSV export, links to the PDF page, and the same pinned theme. The unit is different, though. A tentative ruling is a document; here the unit is a number at a spot on a page. That changes five things:

1. **The detail panel is an evidence viewer, not a text reader.** pdf.js renders the page in the panel instead of linking out. A browser's PDF viewer can open at `#page=N` but cannot point at a spot on the page.
2. **Sums add primary rows only.** A printed number recorded at two measure grains is shown once and added once. Totals are labelled as sums of what is shown, not statewide totals, because coverage differs by agency and year.
3. **Missing is never zero.** The jurisdiction matrix marks absent program-years as missing. A zero appears only where the report prints one.
4. **Every file is checked.** Each evidence PDF and original report is hashed in the browser (SHA-256) and compared with the hash the release records. Large reports are read by byte range; their hash is checked on request.
5. **A box is drawn only when it can be trusted.** Before drawing a box from `outline_rect_pdf_points`, the viewer confirms the rectangle sits on the red outline in that figure's own evidence file. Where it does not, it draws nothing and says why. The reviewers' drawn outline is the evidence; the rectangle is metadata about it.

## Data

The site holds no copy of the data. It reads the release's own files from `raw.githubusercontent.com/aimesy/mfa-data/<commit>/`: the CSV, `sources/index.csv`, and on demand `manifest.json`, the evidence PDFs and the original reports. It first resolves `main` to a commit so every file comes from one release, and shows that commit in the header.

URL parameters:

| Parameter | Meaning |
|---|---|
| `ref=<sha or branch>` | read that release commit instead of the current `main` |
| `data=../` | read from a same-origin path instead of GitHub (local development) |
| `view` | `figures` (default), `entities`, `sources`, `about` |
| `f=<figure_group_id>` | open that figure's evidence; `tab=original&pg=N` for the original report |
| `doc=<source_id>` | open that report |
| `q`, `type`, `county`, `cat`, `scope`, `from`, `to`, `arith`, `entity`, `source`, `sort`, `page`, `size` | figures filters |
| `e=<name>` | open a jurisdiction |

## Run it locally

Check out `aimesy/mfa-data` next to this repository (or point `MFA_DATA_ROOT` at a checkout), then:

```bash
node tests/serve.mjs          # this repo at /mfa/, the release at /mfa-data/, with byte-range support
# open http://127.0.0.1:8765/mfa/?data=../mfa-data/
```

## Tests

```bash
node check-static.mjs         # pinned theme, page policy, no HTML injection, data rules
node tests/model.test.mjs     # CSV reader, figure model, outline geometry (plus the real release when a checkout is present)
node tests/smoke.mjs          # Chromium via Playwright against the local release
```

The tests find the release through `MFA_DATA_ROOT`, or `../mfa-data` beside this repository. `smoke.mjs` also accepts `THEMES_DIR` (serve the pinned theme from a local `aimesy/themes` checkout), `BROWSER_PROXY` and `SCREENSHOT_DIR`.

## Deployment

`.github/workflows/pages.yml` runs the static checks and model tests, then deploys the repository root to GitHub Pages on every push to `main`. Pages must be enabled once in Settings → Pages with "Source: GitHub Actions". Pages holds only the viewer; the release's data, evidence PDFs and reports are read from `raw.githubusercontent.com` at run time.

The viewer was first staged under `site/` in `aimesy/mfa-data` (`8371df8`). It lives here so that the release pipeline stays the only writer to `aimesy/mfa-data`, which owns that repository's manifest and validation. Release 03 (`4d90bdd`) still carries a copy under `site/`; this repository is the one to change and deploy.

Third-party code: pdf.js 4.10.38 (Apache-2.0) in `vendor/`, verified against the npm registry's integrity hash.
