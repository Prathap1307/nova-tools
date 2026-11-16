# Nova Tools · Single-page crawler

A standalone Node.js CLI. It records public HTML page snapshots and field-level
changes in SQLite. Node.js 24 is required. No Nova account or AI key is needed.

From this directory:

    npm ci
    npm test
    node crawler/cli.mjs --url https://example.com/ --db crawler.sqlite

Run the same command again to compare with the latest compatible snapshot for
that exact requested URL. The CLI prints JSON. Failures are recorded in
crawl_runs and the CLI exits with a nonzero status.

Redirects stay on the original hostname by default. For a known redirect to
another public host, explicitly add a flag such as --allow-host www.example.com.
The scanner checks robots.txt, limits redirects and response size, and refuses
private network addresses. It extracts HTTP HTML, including title, headings,
description, canonical, robots directives, anchor links and candidate quote links.
A quote link is inferred from its label or path. It does not click or submit a form.
The tool captures the main text separately, so a heading change can also change
the main-text field.

SQLite migration 001 creates crawl_runs, page_snapshots, page_links and
page_changes. Snapshots, links and diffs commit together. Snapshots with a
different extraction version or capture mode are outside the comparison.

The current slice scans one URL at a time. Sitemap discovery, JavaScript browser
rendering, queued jobs, export and Nova API integration are future slices.
