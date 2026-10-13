-- ATIHx Community Calendar database (Cloudflare D1 / SQLite)
--
-- Apply with:
--   npx wrangler d1 execute atih-community-cal --remote --file=schema.sql
-- Safe to re-run: every statement uses IF NOT EXISTS / OR IGNORE.

PRAGMA foreign_keys = ON;

-- One row per ATIHx community. Add new cities here (or from the review page).
CREATE TABLE IF NOT EXISTS communities (
  id          TEXT PRIMARY KEY,              -- short slug used in URLs and feeds, e.g. 'philly'
  name        TEXT NOT NULL,                 -- 'Philadelphia, PA'
  short       TEXT NOT NULL,                 -- 'Philly'
  color       TEXT NOT NULL,                 -- hex color for calendar chips
  timezone    TEXT NOT NULL DEFAULT 'America/New_York',
  search      TEXT NOT NULL DEFAULT '',      -- extra words for the filter box
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Every submitted event, whatever its review status.
CREATE TABLE IF NOT EXISTS events (
  id               TEXT PRIMARY KEY,         -- random id, stable forever (used as the calendar UID)
  community_id     TEXT NOT NULL REFERENCES communities(id),
  title            TEXT NOT NULL,
  start_local      TEXT NOT NULL,            -- 'YYYY-MM-DDTHH:MM' in the community's timezone
  end_local        TEXT NOT NULL,
  event_date       TEXT NOT NULL,            -- 'YYYY-MM-DD', copied from start_local for fast lookups
  venue            TEXT NOT NULL DEFAULT '',
  address          TEXT NOT NULL DEFAULT '',
  host             TEXT NOT NULL DEFAULT '', -- hosts and sponsors, e.g. 'ATIHx Philly with Code for Philly'
  url              TEXT NOT NULL DEFAULT '', -- RSVP / details link
  description      TEXT NOT NULL DEFAULT '',

  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected')),
  dedupe_key       TEXT NOT NULL,            -- community|date|normalized title
  possible_duplicate_of TEXT,                -- id of a similar event, flagged for reviewers

  submitter_name   TEXT NOT NULL DEFAULT '',
  submitter_email  TEXT NOT NULL DEFAULT '', -- private, never returned by public endpoints
  review_note      TEXT NOT NULL DEFAULT '',
  reviewed_by      TEXT NOT NULL DEFAULT '',
  reviewed_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- The duplicate guard: the same community can't have two live or pending events
-- on the same day with the same (normalized) title. Rejected events don't count,
-- so a rejected submission can be corrected and resubmitted.
CREATE UNIQUE INDEX IF NOT EXISTS events_no_duplicates
  ON events (dedupe_key) WHERE status != 'rejected';

CREATE INDEX IF NOT EXISTS events_by_status_date ON events (status, event_date);
CREATE INDEX IF NOT EXISTS events_by_community_date ON events (community_id, event_date);

-- Who can review events. role 'admin' sees and manages everything (including
-- this table); role 'lead' reviews only their own community's events.
CREATE TABLE IF NOT EXISTS moderators (
  email         TEXT NOT NULL COLLATE NOCASE,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'lead')),
  community_id  TEXT NOT NULL DEFAULT '',   -- a community id for leads, '' for admins
  added_by      TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (email, community_id),
  CHECK ((role = 'admin' AND community_id = '') OR (role = 'lead' AND community_id != ''))
);

-- Light rate limiting for the public form, keyed by a salted hash of the
-- visitor's IP address (the raw address is never stored).
CREATE TABLE IF NOT EXISTS submission_log (
  ip_hash     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS submission_log_by_ip ON submission_log (ip_hash, created_at);

-- Starting communities.
INSERT OR IGNORE INTO communities (id, name, short, color, search) VALUES
  ('dc',     'Washington, D.C.', 'DC',     '#ff5c5c', 'dc washington district of columbia'),
  ('philly', 'Philadelphia, PA', 'Philly', '#2cb4fc', 'philly philadelphia pennsylvania pa');

-- Events visitors send through the site to the All Tech Is Human calendar on
-- Luma. A scheduled job ("the Luma bot") opens Luma in a headless browser,
-- signed in as the community's Luma account, and submits each one using
-- Luma's own Submit Event form. Luma's admins then accept or decline it there.
CREATE TABLE IF NOT EXISTS luma_queue (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('existing', 'external')),
  event_url        TEXT NOT NULL,             -- Luma link, or the external event page
  payload          TEXT NOT NULL DEFAULT '{}',-- JSON: name, host, location, date, endDate, startTime, endTime
  submitter_name   TEXT NOT NULL DEFAULT '',
  submitter_email  TEXT NOT NULL DEFAULT '',  -- private, only shown to admins
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'working', 'submitted', 'failed', 'needs_login')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  submitted_at     TEXT
);
CREATE INDEX IF NOT EXISTS luma_queue_by_status ON luma_queue (status, created_at);
CREATE INDEX IF NOT EXISTS luma_queue_by_url ON luma_queue (event_url);

-- A few facts about the Luma bot for the review page: last run, last success,
-- whether its Luma sign-in still works, and the last problem it hit.
CREATE TABLE IF NOT EXISTS bot_status (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
