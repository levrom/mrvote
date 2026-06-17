PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS elections (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK (type IN ('single', 'multiple')),
  max_selections INTEGER,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'stopped', 'closed')) DEFAULT 'draft',
  start_at TEXT,
  end_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS election_options (
  id TEXT PRIMARY KEY,
  election_id TEXT NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (election_id) REFERENCES elections(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS access_codes (
  id TEXT PRIMARY KEY,
  election_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'used', 'revoked')) DEFAULT 'available',
  issued_batch_id TEXT NOT NULL,
  FOREIGN KEY (election_id) REFERENCES elections(id) ON DELETE CASCADE,
  UNIQUE (election_id, code_hash)
);

CREATE TABLE IF NOT EXISTS votes (
  id TEXT PRIMARY KEY,
  election_id TEXT NOT NULL,
  ballot_json TEXT NOT NULL,
  verification_code TEXT NOT NULL UNIQUE,
  flow_marker TEXT NOT NULL UNIQUE,
  FOREIGN KEY (election_id) REFERENCES elections(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS attempt_windows (
  scope TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  time_bucket INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, ip_hash, time_bucket)
);

CREATE INDEX IF NOT EXISTS idx_elections_status ON elections(status);
CREATE INDEX IF NOT EXISTS idx_options_election ON election_options(election_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_access_codes_lookup ON access_codes(election_id, code_hash, status);
CREATE INDEX IF NOT EXISTS idx_votes_lookup ON votes(election_id, verification_code);

