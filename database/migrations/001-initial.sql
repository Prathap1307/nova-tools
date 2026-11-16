CREATE TABLE IF NOT EXISTS crawl_runs (
  id INTEGER PRIMARY KEY,
  requested_url TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  state TEXT NOT NULL CHECK(state IN ('running','complete','failed')),
  error TEXT
);
CREATE TABLE IF NOT EXISTS page_snapshots (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL UNIQUE REFERENCES crawl_runs(id),
  requested_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  mode TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  extraction_version INTEGER NOT NULL,
  redirect_chain TEXT NOT NULL,
  fields TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshot_history ON page_snapshots(requested_url, mode, extraction_version, id);
CREATE TABLE IF NOT EXISTS page_links (
  snapshot_id INTEGER NOT NULL REFERENCES page_snapshots(id),
  position INTEGER NOT NULL,
  url TEXT NOT NULL,
  anchor TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY(snapshot_id,position)
);
CREATE TABLE IF NOT EXISTS page_changes (
  old_snapshot_id INTEGER NOT NULL REFERENCES page_snapshots(id),
  new_snapshot_id INTEGER NOT NULL REFERENCES page_snapshots(id),
  field TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  PRIMARY KEY(new_snapshot_id,field)
);
