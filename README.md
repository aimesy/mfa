# MFA viewer

A static site for looking at every figure in the `aimesy/mfa-data` release beside the page it was read from. It uses the shared `aimesy/themes` theme, loaded live from `https://aimesy.github.io/themes/src/`.

This repository is the viewer; `aimesy/mfa-data` is the release it reads, as `aimesy/kcsc` is to `aimesy/kcsc-data`.

Published site:

```text
https://mfa.amyc.us/
```

Fallback GitHub Pages URL:

```text
https://aimesy.github.io/mfa/
```

Cloudflare DNS must keep a DNS-only `CNAME` from `mfa` to `aimesy.github.io`
so GitHub Pages can issue and renew the custom-domain certificate.

## What it is for

The release claims that every figure was read from the original report, outlined on its page, checked against the report's own arithmetic and reviewed twice. The site lets a reader check that claim one figure at a time:

- **Jurisdictions.** Each agency gets a matrix of its fees by fiscal year. Every cell opens its evidence, and a program year with no figure stays empty.
- **Fees.** Each fee's history, year by year: what was collected, the name the report printed, and the page. An agency that renamed or renumbered a fund keeps one fee, labelled with every number it carried (Woodland's "Road Development Fund (Fund 582/1582)"). Each join is listed in `lib/fee-links.js` with its evidence (the old name's closing balance is the new name's opening balance, the new report reprints the old figures, or the names differ only in wording) and shown on the year the name changed. The release's rows are unchanged. A jurisdiction's name filters the list to its fees; clicked again, it opens the jurisdiction's page.
- **Sources.** Each original report can be opened in the viewer, with every published figure in it listed and boxed. An agency's name filters the list to its reports; clicked again, it opens the jurisdiction's page.
- **Figures.** Each row is one printed figure. Filter and search it (the search also covers caveats), sort it, and export it. A jurisdiction's name filters the table to it; clicked again, it opens the jurisdiction's page. Opening a row shows the outlined evidence page, scrolled to the figure. One click then opens the complete original report at that page, with the figure boxed and the other published figures on the page marked; **Go to document** opens that report with every figure published from it listed.
- **Stats.** Figures by fiscal year, fee category, jurisdiction type and land use, each linking to the figures it counts; the cohort accounting, refusals by reason, row counts for each data table, and links to the downloads and method documents.

Every view is in the URL, so any figure, filter or page is a link. **Cite** copies a citation with a link pinned to the release commit.

## How it differs from tentatives

It follows `aimesy/tentatives` in layout: a chip toolbar, a table plus a detail panel, URL-driven state, CSV export, links to the PDF page, and the same shared theme. The unit is different, though. A tentative ruling is a document; here the unit is a number at a spot on a page. That changes six things:

1. **The detail panel is an evidence viewer.** pdf.js renders the page in the panel and boxes the figure on it, which a browser's own PDF viewer opened at `#page=N` has no way to do.
2. **Sums add primary rows only.** A printed number recorded at two measure grains is shown once and added once. Each sum covers the figures shown, and coverage differs by agency and year.
3. **Missing stays empty.** The jurisdiction matrix leaves absent program years empty. A zero appears only where the report prints one.
4. **Every file is checked.** Each evidence PDF and original report is hashed in the browser (SHA-256) and compared with the hash the release records. Large reports are read by byte range; their hash is checked on request.
5. **A box is drawn only when it can be trusted.** Before drawing a box from `outline_rect_pdf_points` (one rectangle, or one per printed line where the outlined words wrap), the viewer confirms each rectangle sits on the red outline in that figure's own evidence file. Where it does not, it draws nothing and says why. The reviewers' drawn outline is the evidence; the rectangle is metadata about it.
6. **Arithmetic lines are never named by guessing.** Each line in an arithmetic table takes the name its page prints beside the amount, read from the text layer of the figure's hash-checked evidence file, or failing that the name the note gives. The page is read only in the figure's own column, and only where every amount in the equation is printed there once, under one whole name. An equation with a line that neither names is shown as the note's own text.

## Data

The site reads the release's own files from `raw.githubusercontent.com/aimesy/mfa-data/<commit>/`: the CSV, `sources/index.csv`, and on demand `manifest.json`, the evidence PDFs and the original reports. It first resolves `main` to a commit so every file comes from one release, and shows that commit in the header.

URL parameters:

| Parameter | Meaning |
|---|---|
| `ref=<sha or branch>` | read that release commit instead of the current `main` |
| `data=../` | read from a same-origin path instead of GitHub (local development) |
| `view` | `entities` (default), `fees`, `sources`, `figures`, `stats` (`about` still opens it) |
| `f=<figure_group_id>` | open that figure's evidence; `tab=original&pg=N` for the original report |
| `doc=<source_id>` | open that report |
| `q`, `type`, `county`, `cat`, `scope`, `from`, `to`, `arith`, `entity`, `source`, `sort`, `page`, `size` | figures filters |
| `e=<name>` | open a jurisdiction (with `view=fees&fee=<printed name>`, that fee) |
| `fq`, `fcat`, `ftype`, `fcounty`, `fentity`, `fsort` | fees filters |
| `sq`, `sentity`, `ssort` | sources filters |

## Run it locally

Check out `aimesy/mfa-data` next to this repository (or point `MFA_DATA_ROOT` at a checkout), then:

```bash
node tests/serve.mjs          # this repo at /mfa/, the release at /mfa-data/, with byte-range support
# open http://127.0.0.1:8765/mfa/?data=../mfa-data/
```

## Tests

```bash
node check-static.mjs         # shared theme, page policy, no HTML injection, data rules
node tests/model.test.mjs     # CSV reader, figure model, outline geometry (plus the real release when a checkout is present)
node tests/smoke.mjs          # Chromium via Playwright against the local release
```

The tests find the release through `MFA_DATA_ROOT`, or `../mfa-data` beside this repository. `smoke.mjs` also accepts `THEMES_DIR` (serve the shared theme from a local `aimesy/themes` checkout), `BROWSER_PROXY` and `SCREENSHOT_DIR`.

## Deployment

`.github/workflows/pages.yml` runs the static checks and model tests, then deploys the repository root to GitHub Pages on every push to `master`. Pages must be enabled once in Settings → Pages with "Source: GitHub Actions" and the custom domain `mfa.amyc.us`. With an Actions deployment GitHub takes the domain from that setting; `CNAME` records it in the repository, as in `aimesy/kcsc`. Pages holds only the viewer; the release's data, evidence PDFs and reports are read from `raw.githubusercontent.com` at run time.

The viewer was first staged under `site/` in `aimesy/mfa-data` (`8371df8`). It lives here so that the release pipeline stays the only writer to `aimesy/mfa-data`, which owns that repository's manifest and validation. Release 03 (`4d90bdd`) still carries a copy under `site/`; this repository is the one to change and deploy.

Third-party code: pdf.js 4.10.38 (Apache-2.0) in `vendor/`, verified against the npm registry's integrity hash. Noto Emoji, the black-and-white face (SIL OFL 1.1), in `vendor/noto-emoji/`.
