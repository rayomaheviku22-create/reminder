-- Follow-Up Tracker: D1 schema
-- Optional: the Worker creates these tables automatically on first use.
-- Safe to run more than once (uses IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS profiles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,                 -- e.g. "Company A Support"
  email       TEXT    NOT NULL,                 -- e.g. support@companya.com
  color       TEXT    NOT NULL DEFAULT 'indigo',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id      INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  client_name     TEXT    NOT NULL DEFAULT '',
  client_email    TEXT    NOT NULL,
  subject         TEXT    NOT NULL DEFAULT '',  -- thread subject / topic
  next_followup   TEXT    NOT NULL,             -- YYYY-MM-DD (user's local calendar date)
  notes           TEXT    NOT NULL DEFAULT '',  -- what to say in the next email
  cadence_days    INTEGER NOT NULL DEFAULT 3,   -- default gap after "Mark sent"
  status          TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  followup_count  INTEGER NOT NULL DEFAULT 0,
  last_contacted  TEXT,                         -- YYYY-MM-DD
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_profile ON contacts (profile_id);
CREATE INDEX IF NOT EXISTS idx_contacts_due     ON contacts (status, next_followup);
