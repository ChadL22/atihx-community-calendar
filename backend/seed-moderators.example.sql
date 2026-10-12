-- Copy this file to seed-moderators.sql, put in real email addresses, then run:
--   npx wrangler d1 execute atih-community-cal --remote --file=seed-moderators.sql
--
-- These must be the same addresses people use to sign in through Cloudflare
-- Access. After this first run, admins can add and remove leads from the
-- review page instead.

-- You: full access to every community and to the moderator list.
INSERT OR IGNORE INTO moderators (email, role, community_id, added_by)
VALUES ('you@example.com', 'admin', '', 'setup');

-- Community leads: each reviews only their own city's events.
INSERT OR IGNORE INTO moderators (email, role, community_id, added_by)
VALUES ('philly-lead@example.com', 'lead', 'philly', 'setup');

INSERT OR IGNORE INTO moderators (email, role, community_id, added_by)
VALUES ('dc-lead@example.com', 'lead', 'dc', 'setup');
