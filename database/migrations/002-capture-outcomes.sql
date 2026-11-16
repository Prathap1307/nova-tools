ALTER TABLE crawl_runs ADD COLUMN parent_run_id INTEGER REFERENCES crawl_runs(id);
ALTER TABLE page_snapshots ADD COLUMN outcome TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE page_snapshots ADD COLUMN flags TEXT NOT NULL DEFAULT '[]';
