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
- **Fees.** Each fee's history, year by year: what was collected, the name the report printed, and the page. An agency that renamed or renumbered a fund keeps one fee, labelled with every number it carried (Woodland's "Road Development Fund (Fund 582/1582)"). Each join is listed in `lib/fee-links.js` with its evidence (the old name's closing balance is the new name's opening balance, the new report reprints the old figures, or the names differ only in wording) and shown on the year the name changed. The release's rows are unchanged. A jurisdiction's name (in the table, or on an open figure) filters the list to its fees; clicked again, it opens the jurisdiction's page.
- **Sources.** Each original report can be opened in the viewer, with every published figure in it listed and boxed. An agency's name (in the table, or on an open report or figure) filters the list to its reports, and the panel stays open; clicked again, it opens the jurisdiction's page.
- **Figures.** Each row is one printed figure. Filter and search it (the search also covers caveats), sort it, and export it. A jurisdiction's name filters the table to it; clicked again, it opens the jurisdiction's page. Opening a row shows the outlined evidence page, scrolled to the figure. One click then opens the complete original report at that page, with the figure boxed and the other published figures on the page marked; **Go to document** opens that report with every figure published from it listed.
- **Stats.** Figures by fiscal year, fee category, jurisdiction type and land use, each linking to the figures it counts; the cohort accounting, refusals by reason, row counts for each data table, and links to the method documents. The site offers no bulk downloads.

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

`aimesy/mfa-data` is private, so the site reads the release's own files through the data Worker at `https://mfa-data.amyc.us/<commit>/` (see [Data Worker](#data-worker)): the CSV, `sources/index.csv`, and on demand `manifest.json` and `evidence/index.json`. The evidence PDFs and the original reports are GitHub release assets, which the CSVs list by their `github.com/aimesy/mfa-data/releases/download/<tag>/<name>` URL; the viewer reads each from the Worker at the same path. It first asks the Worker's `/ref` for the commit at `main`, so every file comes from one release, and shows that commit in the header. If that fails it reads `main` itself. It passes a Turnstile check (see [Data Worker](#data-worker)) when the Worker asks for one, on a first visit or once the 12-hour session has ended; a reload or a new tab uses the session it has. Most readers never see the check.

URL parameters:

| Parameter | Meaning |
|---|---|
| `ref=<sha>` | read that release commit instead of the current `main` (the Worker serves a full commit hash, or `main`) |
| `data=../` | read from a same-origin path instead of the Worker (local development) |
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
node tests/worker.test.mjs    # data Worker: path allowlist, origin check, rate limit, headers
node tests/smoke.mjs          # Chromium via Playwright against the local release
```

The tests find the release through `MFA_DATA_ROOT`, or `../mfa-data` beside this repository. `smoke.mjs` also accepts `THEMES_DIR` (serve the shared theme from a local `aimesy/themes` checkout), `BROWSER_PROXY` and `SCREENSHOT_DIR`.

## Deployment

`.github/workflows/pages.yml` runs the static checks and model tests, then deploys the repository root to GitHub Pages on every push to `master`. Pages must be enabled once in Settings → Pages with "Source: GitHub Actions" and the custom domain `mfa.amyc.us`. With an Actions deployment GitHub takes the domain from that setting; `CNAME` records it in the repository, as in `aimesy/kcsc`. Pages holds only the viewer; the release's data, evidence PDFs and reports are read through the data Worker at run time. The same workflow deploys the Worker first (job `release-worker`) and the Pages deploy waits for it, so a failed Worker deploy leaves the current site live. Each Worker deploy empties its cache, so a push redeploys the Worker only when `worker/` or the workflow changed; run the workflow by hand (Actions, Deploy Pages, Run workflow) to redeploy it anyway, for example after replacing `MFA_DATA_ACCESS`.

The viewer was first staged under `site/` in `aimesy/mfa-data` (`8371df8`). It lives here so that the release pipeline stays the only writer to `aimesy/mfa-data`, which owns that repository's manifest and validation. Release 03 (`4d90bdd`) still carries a copy under `site/`; this repository is the one to change and deploy.

## Search engines

The viewer draws everything in the browser from the data Worker, which search engines cannot pass, so the deploy also writes static pages from the current release: `about/`, `jurisdictions/` (one page for each jurisdiction, with its fee programs and the years they cover, and no dollar amounts) and `sitemap.xml` (`seo/build.mjs`). A scheduled run of the workflow rebuilds them daily. `index.html` carries a short description and Dataset markup; `robots.txt` points to the sitemap.

## Data Worker

`worker/` is a Cloudflare Worker on the custom domain `mfa-data.amyc.us`. It holds a GitHub token and serves the release to the viewer, because the repository is private, a token cannot be given to the browser, and the release (about 5 GB) is too large for Pages, which caps a site at 1 GB. Its URLs mirror `raw.githubusercontent.com`:

| Path | Answer |
|---|---|
| `/<commit>/<path>` | that file, cached for a year as immutable |
| `/main/<path>` | that file at the head of `main`, cached for 60 seconds |
| `/releases/download/<tag>/<name>.pdf` | that release asset (the release's PDFs), cached for a day |
| `/ref` | the commit at `main`, as text, cached for 60 seconds, so a new release shows up without a redeploy |
| `/robots.txt` | disallows everything; every answer also carries `X-Robots-Tag: noindex` |

`<path>` must match the viewer's `RELEASE_PATH`, and an asset path its `ASSET_PATH` (`check-static.mjs` keeps each pair equal); anything else is a 404. GitHub serves a private repository's assets only through its API, so for an asset `Release` looks up the asset's id in the release's list (kept for ten minutes at the internal path `/_assets/<tag>`, which the default entrypoint never forwards), then fetches it from the signed URL the API redirects to, without the token.

It has two entrypoints. The default one is uncached. It answers CORS preflights and refuses (403) any request whose `Origin`, or failing that `Referer`, is not listed in `ALLOWED_ORIGINS` in `worker/wrangler.toml`. Then it applies the browser check and the limits in `worker/gate.js`, the same file every data Worker carries (aimesy/kcsc, nysc, tentatives and sfsc):

- **A session.** The viewer runs Cloudflare Turnstile in Managed mode, shown only when Cloudflare wants an interaction, and posts the token to `/session`. The Worker checks it with Turnstile and sets a session cookie for 12 hours, bound to the address (an IPv4 address, or an IPv6 /64), and on the first check a browser ID cookie for 400 days. With `REQUIRE_SESSION = "true"` a data request without a valid session gets 401, and the viewer runs the check again; otherwise the state is only reported in `X-MFA-Session`.
- **Limits a minute for each address.** 50 files (requests without a byte range) and 600 slices (byte ranges up to 8 MB; the viewer reads big reports in 256 KB slices), with the Workers Rate Limiting binding. Over either it answers 429 with `Retry-After: 60`. Cloudflare keeps these counts on each of its machines, so they are a brake, not an exact count.
- **Document limits for each browser.** Documents are the evidence PDFs and reports (`documentKey` in `worker/release.js`); the CSVs, the indexes, `manifest.json` and `/ref` are index files and never count. The limits are there to stop mass downloading of the documents, not to ration the data: every row is in the CSV the viewer reads. An ended or paused session cannot read index files either; a session whose batch of documents is spent can keep browsing. A document counts once a UTC day, however often it is reopened and in however many slices. A browser may open 100 distinct documents before a displayed Turnstile recheck gives the next 100; early renewal preserves that count. Managed mode decides whether interaction is required; a browser may open 500 a UTC day and 1,000 in any 7 days, and an address 2,000 a day. Past those it answers 429 "File limit exceeded. For bulk access, please email db@amyc.us." More than 50 distinct documents in a minute ends the session and asks for a visible check after 10 minutes, and 30 new sessions an hour or 3 such trips a day from one address make that address wait or always see the check. Every number is a variable in `worker/wrangler.toml`. The `DailyQuota` Durable Object keeps the counts, one object for each browser ID and one for each address. If it cannot be reached, requests go through; the session check never does.
- **Trusted keys.** A person given a key opens `https://mfa.amyc.us/#key=<key>` once; the viewer sends it with the check and takes it out of the address bar. A session from a key whose SHA-256 is in `TRUSTED_KEY_HASHES` has no document limits and lasts 30 days, and the browser stays trusted for those 30 days while the hash is listed. `node scripts/new-trusted-key.mjs <initial>` prints a new key once and the line to add to all five data Workers; deleting the line and redeploying revokes it.

It then sends the cached `Release` entrypoint a fresh request built from the path and `Range` alone. `Release` fetches the file from GitHub with the token and returns it with its own content type, `ETag` and cache headers; Workers Caching stores it, and serves byte ranges from the stored copy. The default entrypoint must stay uncached, or a cache hit would skip the checks and the limits.

Secrets, in this repository's Actions secrets:

- `MFA_DATA_ACCESS`: a fine-grained GitHub token with read access to the contents of `aimesy/mfa-data` and nothing else. The workflow stores it as the Worker secret `MFA_DATA_TOKEN`.
- `TURNSTILE_SECRET_KEY`: the secret key of the Turnstile widget "MFA viewer (mfa.amyc.us)"; its site key is in `app.js`. The workflow stores it as the Worker secret of the same name, with a new random `SESSION_KEY` on each deploy.
- `CLOUDFLARE_API_KEY`: a Cloudflare API token from the "Edit Cloudflare Workers" template, limited to the account and the `amyc.us` zone (Workers Routes edit covers the custom domain). The workflow hands it to Wrangler as `CLOUDFLARE_API_TOKEN`.

The gateway lets the browser keep an index file read at a commit, which never changes, so the CSV is read once a release rather than on every page load. It never lets the browser keep a document, `/ref` or `main`, so each of those passes the session check and the limits every time. Account request, CPU and Durable Object allowances depend on the current Workers subscription; protected requests check session state, and document requests update their counters.

After each deploy the workflow checks the live Worker from the runner. Bot Fight Mode on `amyc.us` answers GitHub's runners with a challenge before the Worker runs; the check then warns that it could not reach the Worker, and the Pages deploy goes ahead.

In local mode (`?data=`) the viewer reads assets from `releases/download/<tag>/<name>` under the local path.

To run it locally, put `MFA_DATA_TOKEN=<token>`, `SESSION_KEY=<any string>` and Turnstile's test secret `TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA` with `TURNSTILE_HOSTNAMES=example.com` (the host the test secret answers for) in `worker/.dev.vars` (git ignores it), run `npx wrangler@4 dev` in `worker/`, and point the viewer's `DATA_ROOT` at the address it prints.

Third-party code: pdf.js 4.10.38 (Apache-2.0) in `vendor/`, verified against the npm registry's integrity hash. Noto Emoji, the black-and-white face (SIL OFL 1.1), in `vendor/noto-emoji/`.
