# Nova Tools · Website crawler

Discover public pages, capture HTTP or Chromium snapshots, and compare compatible
captures in SQLite. Runs locally with Node.js 24 and Playwright Chromium.

## Setup

    npm ci
    npx playwright install chromium --only-shell
    npm test

On Windows, set PLAYWRIGHT_BROWSERS_PATH before installing and running if the
default browser cache is on a drive with limited space.

## Single page

    npm run scan -- --url https://www.simpleparking.uk/faq --mode auto --db crawler.sqlite --export faq.json

The legacy scan command defaults to http. browser captures the rendered DOM.
auto starts with HTTP and renders when usable content is absent. It keeps both
captures when it falls back. A title, canonical, or HTTP 200 alone does not make
a capture usable. An unsuccessful browser fallback preserves the HTTP capture
and reports renderError. The rendered capture can read question-and-answer
disclosures with safe button controls outside forms.

## Bounded site discovery

    npm run crawl -- --site https://www.simpleparking.uk/ --mode auto --db crawler.sqlite --max-pages 20 --sitemap-host pyczpjdxrzyoufaumryn.supabase.co --export simpleparking.json

The homepage starts the queue. Robots sitemap declarations (or /sitemap.xml as
a fallback), nested indexes, and in-scope links add unique URLs. Fragments are
removed; query strings and distinct canonical URLs remain separate. Site scans
default to 200 ms between starts on the same host. Adjust with --delay-ms.
The report includes attempted pages, usability, browser attempts, sitemap
outcomes, duplicates, skipped pages, and failures. A robots denial consumes
one attempted-page slot. Discovery caps are 30 sitemap files and 10,000 URLs.

--allow-host adds an exact hostname to page scope.
--sitemap-host permits metadata discovery without widening page scope.
--asset-host permits specific external scripts, styles and read requests in
Chromium without widening page scope. Third-party hosts are excluded by default.
Chromium is routed through the same public-address, redirect and robots checks
as HTTP scans. It blocks non-GET requests, WebSockets, service workers and
unsolicited document navigations. It does not sign in or submit forms.

## History and export

Existing databases upgrade automatically. Requested, final and canonical URLs
are stored separately. homepage_canonical_on_non_homepage flags a canonical
declared to a site's root without merging the pages. Changes compare the
latest snapshot for the same requested URL, capture mode and extraction version.
The first snapshot for a combination is a baseline. Browser captures have an
answers array and may also include those answers in page text.

--export writes a new JSON file with URLs, metadata, headings, clean text, links,
capture mode, timestamps, flags and diffs. Use a new filename for each export.
Site stdout contains compact snapshot references. Single-page stdout includes
the full capture. This version runs a bounded scan in one process and does not
schedule or resume background jobs.

## Audit captured pages

    npm run audit -- --db crawler.sqlite --site https://www.simpleparking.uk/ --export seo-audit.json

The checker opens the SQLite database read-only and uses the latest completed
or failed scan for each requested URL. If the latest scan produced a raw and
browser pair, it uses the browser capture and retains the raw snapshot as
evidence. Scope by exact hostname with --site, or omit it to audit all stored
sites. For a v0.1 database, run a crawl or scan to apply the existing migration
before auditing.

The JSON report groups homepage canonicals, duplicate titles and descriptions,
missing titles/descriptions/H1s, noindex and contradictory directives, unusable
captures and content available only after JavaScript rendering. Findings include
severity, a review action and snapshot IDs. Duplicate metadata uses usable pages
and groups by final hostname. Canonical and robots findings show declarations
observed on the site. Search Console data is needed to verify actual indexing.

### Compare and share audits

    npm run audit -- --db crawler.sqlite --site https://www.simpleparking.uk/ --export audit-current.json --csv findings-current.csv --compare audit-previous.json

The JSON summary lists each issue, its affected count, a review step, and up to
three example URLs. The CSV includes every affected URL with evidence and
snapshot IDs. Paired captures include a rawVsRendered object under each page
with raw and rendered canonical, title, description, meta robots and HTTP
X-Robots-Tag values. Each field is unchanged, added, removed or changed.
Only captures from the same scan are paired.

The optional comparison reports one status for each finding and URL. A missing
finding is resolved only after newer, comparable evidence verifies the page.
Missing, failed and unusable pages remain unverified. Duplicate groups also
require fresh comparable captures for previous members. Changing capture mode
or extraction version may leave a finding unverified. Use the same hostname and
scan coverage for the most informative comparisons. Original v0.3 JSON audits
can be used as baselines. Use new filenames for JSON and CSV exports.

## Check links from saved crawl snapshots

    npm run links -- --site https://www.simpleparking.uk/ --db crawler.sqlite --mode auto --max-links 20 --export links.json --csv links.csv

The checker opens SQLite read-only. It checks each unique in-scope destination
once, prioritized by likely booking or quote links, and retains all source
references and anchor text. Requests are paced per host. Robots denials,
rate limits, off-scope redirects and transport errors are unverified.
HTTP 404/410 and redirect loops or limits are broken. Homepage redirects,
multi-hop chains, soft-404 candidates and missing rendered anchors require review.
A soft-404 marker is a title or H1 heuristic and needs human confirmation.

Auto mode reuses the Chromium renderer for app shells and missing raw anchors.
New crawler snapshots preserve fragments. Existing snapshots from extraction
versions 1–3 still work for HTTP link health. Recrawl source pages to add
fragment evidence. The reports are point-in-time exports. Configured customer
journey assertions and cross-run link history comparison are future work.

## Check a booking or quote journey

    npm run journey -- --config journeys/config/simpleparking-t3.json --export journey.json --screenshot failure.png

The runner opens the configured public page in a 412×915 mobile Chromium
viewport, locates one visible and enabled booking CTA, and taps it once. It
checks the expected route and quote panel, required visible and enabled
controls, and optional terminal context. The SimpleParking configuration
expects the homepage quote panel and records Terminal 3 context as an
observation. It does not assume terminal preselection is required.

The browser applies the crawler's public-host, robots and request rules.
The journey authorizes one top-level GET navigation to an explicitly configured
same-origin path after the tap. It blocks submissions, POSTs, popups, other
document routes and service workers. Routes with a server redirect need a
separate configured step. It does not click Search Parking or enter form values.

The JSON includes the status and evidence for each step. With --screenshot,
failed or unverified steps with an open page save a viewport screenshot. Use
new output filenames. Exit codes are 0 for pass, 2 for a failed check, 3 for
unverified, and 1 for a CLI or input error.

## Track website regressions

    npm run monitor -- --site https://www.simpleparking.uk/ --db monitor.sqlite --crawl crawl.json --audit audit.json --links links.json --journey journey.json --export monitor-run.json

Use extracts from the existing commands for the same site. The audit must be
v0.4 or later and scoped with --site. Any report can be omitted on an
individual run. The first import creates a baseline; subsequent imports read
previous evidence from monitor.sqlite. The monitor stores source reports and
run summaries together, separately from the crawler database.

SEO findings are grouped and compared with the existing freshness rules.
Link and journey changes include previous evidence, the last healthy check
and the current result. Failed, missing and incompatible checks remain
unverified. A changed crawl page count is coverage information; the monitor
does not treat an omitted page as fixed.

Optionally provide --retry-journey-config, --retry-crawl-db or both to rerun
up to three failed critical checks. The journey config must match the original.
Alternatively provide repeat-check reports with --retry-journey and
--retry-links. A matching retry within 15 minutes can confirm the same issue
or mark it intermittent if it passes. A different or unavailable retry is
unverified. --retry-screenshot saves an image if the retried journey fails.
Choose new filenames for reports and screenshots.

This version combines point-in-time reports with optional live rechecks.
Schedules and notifications are not part of this release.

## Map keyword opportunities to saved pages

    npm run keywords -- --site https://www.simpleparking.uk/ --db crawler.sqlite --seed "Heathrow Terminal 3 meet and greet parking" --export opportunities.json

Repeat --seed to supply candidates or add --search-console query-pages.csv.
The optional CSV must have Query, Page (or Landing URL), Clicks, Impressions
and Position on each row, with one reporting period aggregated by query and
page. A Queries-only or Pages-only download cannot show page/query overlap.
Rows for other hostnames are excluded and counted.

The mapper ranks usable snapshots from the latest scan with editable
heuristics based on titles, paths, headings, body text and search intent.
T3 and Terminal 3 variants group together when their other terms match.
Scores measure content fit. Search volume and ranking difficulty are null
unless independently measured by a future source. Search Console impressions
are observed performance for the supplied rows. Overlap signals require
investigation, and an unmatched seed requires a coverage check before
planning a new page. The command does not crawl, call AI or modify SQLite.

## Build a content gap brief

    npm run brief -- --db crawler.sqlite --config brief/config/simpleparking-t3.json --keywords opportunities.json --journey journey.json --export brief.json --markdown brief.md

The checklist defines a target, supporting URLs, keyword group, customer
questions and evidence patterns. Each question is marked covered, partly
covered, missing, or needs verification. The report includes snapshot
references, excerpts, existing links and prioritized actions. The Markdown
file is ready for a website team to review. Keyword and journey reports
are optional contextual inputs. Usable saved target and support snapshots
are required. The builder does not crawl or send data to an AI API.

Patterns are checklist heuristics and a lack of a match means evidence was
not located in the supplied captures. For prices, insurance, cancellation
and handover claims, confirm the current terms with Operations before editing.

## Find internal link opportunities

    npm run internal-links -- --db crawler.sqlite --config internal-links/config/simpleparking-t3.json --link-health links.json --export link-opportunities.json

Supply source/target pairs and optional context patterns. The tool uses the
latest usable source snapshots, recorded links, target audit findings and
optional Link Health evidence. It distinguishes keep, move closer, add,
review target and unverified. A review-target row retains the underlying
placement recommendation. Filter and curate the candidate pairs before
treating them as editorial recommendations.

Crawler extraction v5 adds link placements inferred from semantic HTML
regions and explicit data-link-zone="cta" markers. Old snapshots still
work and their placements are unknown. Capture a fresh source snapshot
before making a placement claim. The command does not fetch or change
website pages.

## Run a quick SEO review

    npm run review -- --config review/config/simpleparking-t3.json --db review.sqlite --history monitor.sqlite --export review.json --screenshot failure.png

A review config references a page brief config and a booking journey config,
with paths relative to the review config. The command freshly captures the
target and up to nine supporting pages on the same origin. It audits those
URLs, checks the booking journey in mobile Chromium, builds the content brief,
and writes a run to the existing regression monitor history. The report includes
step outcomes, snapshot IDs and original audit, journey and brief evidence.

A capture failure does not stop the independent journey. If a required capture
is unusable, the brief is skipped to avoid relying on an older snapshot.
The command exits 0 on a complete review, 2 on a partial review, and 1 on a CLI
or setup error. A complete review can still have SEO findings. This quick mode
does not run full-site discovery or a separate link-health sweep.

## Run a bounded site-wide SEO review

    npm run review -- --mode site --config review/config/simpleparking-t3.json --db review.sqlite --history site-monitor.sqlite --export site-review.json

Site mode discovers pages from sitemap and internal links and attempts the
homepage, brief target and supporting pages before the rest of the queue.
The config's siteReview object sets maxPages, maxLinks, sitemapHosts and
optional assetHosts. Audit and link sources use only URLs attempted or captured
during the current review. The independent booking journey and content brief
remain part of the workflow.

The report orders failed booking journeys first, then actionable link and SEO
findings and content changes. It retains grouped evidence and the original
tool results. Site history defaults to site-monitor.sqlite to keep comparisons
separate from quick reviews. Out-of-scope or omitted checks are unverified
when comparing history. A completed run can still have actionable findings.

## Nova Tools Job Runner API

Run the local API with Node.js and Playwright Chromium installed as described above. In PowerShell:

```powershell
$env:NOVA_TOOLS_TOKEN = node -p "require('node:crypto').randomBytes(32).toString('hex')"
npm run jobs -- --config jobs/config/sites.json --data-dir .nova-jobs --port 8787
```

In a client using the same token, send an empty POST to start the configured SimpleParking review:

```powershell
curl.exe -X POST -H "Authorization: Bearer $env:NOVA_TOOLS_TOKEN" http://127.0.0.1:8787/v1/sites/simpleparking/jobs
```

| Method and path | Result |
| --- | --- |
| `POST /v1/sites/{site}/jobs` | HTTP 202 with a job and a status URL in `Location`. A repeated request while the site has an active job returns the same ID with `reused: true`. |
| `GET /v1/jobs/{id}` | Poll for `queued`, `running`, `complete`, `partial`, or `failed`, plus completed step results. |
| `GET /v1/jobs/{id}/report` | Returns the review and job metadata when the review is complete or partial. Returns HTTP 409 if the job has no report. |
| `GET /v1/sites/{site}/report` | Returns the latest complete or partial review for the configured site. |

All routes require the bearer token. The server listens on `127.0.0.1`. Site IDs resolve to operator-configured review files. SQLite persists the queue, progress and reports under the selected data directory. One review runs at a time per queue database. After a restart, queued work can continue and an interrupted run is marked failed once its lease expires.
