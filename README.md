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
