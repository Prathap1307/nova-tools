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
