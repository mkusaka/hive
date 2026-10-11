ALTER TABLE workspaces ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE jobs ADD COLUMN job_kind TEXT NOT NULL DEFAULT 'normal' CHECK (job_kind IN ('normal', 'summarize', 'consolidate'));
ALTER TABLE jobs ADD COLUMN conversation_id TEXT;
ALTER TABLE jobs ADD COLUMN consolidation_scope_kind TEXT CHECK (consolidation_scope_kind IN ('bot', 'channel'));
ALTER TABLE jobs ADD COLUMN consolidation_scope_id TEXT;
ALTER TABLE runs ADD COLUMN context_snapshot TEXT;
ALTER TABLE routines ADD COLUMN job_kind TEXT NOT NULL DEFAULT 'normal' CHECK (job_kind IN ('normal', 'summarize', 'consolidate'));
ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'explicit' CHECK (source IN ('explicit', 'consolidation'));
ALTER TABLE memories ADD COLUMN merged_from_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memories ADD COLUMN source_conversation_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memories ADD COLUMN proposed_scope TEXT CHECK (proposed_scope IN ('workspace'));
ALTER TABLE memory_revisions ADD COLUMN source TEXT NOT NULL DEFAULT 'explicit' CHECK (source IN ('explicit', 'consolidation'));
ALTER TABLE memory_revisions ADD COLUMN merged_from_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memory_revisions ADD COLUMN source_conversation_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memory_revisions ADD COLUMN proposed_scope TEXT CHECK (proposed_scope IN ('workspace'));
CREATE TABLE conversation_summaries (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  conversation_id TEXT NOT NULL,
  bot_id TEXT,
  covers_from_seq INTEGER NOT NULL,
  covers_to_seq INTEGER NOT NULL,
  text TEXT NOT NULL CHECK (length(CAST(text AS BLOB)) <= 8192),
  pinned_facts TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (covers_from_seq <= covers_to_seq)
);
CREATE INDEX conversation_summaries_latest ON conversation_summaries (workspace_id, conversation_id, bot_id, covers_to_seq);
CREATE UNIQUE INDEX conversation_summaries_run ON conversation_summaries (created_by_run_id);
CREATE UNIQUE INDEX jobs_active_consolidation_scope ON jobs (workspace_id, consolidation_scope_kind, consolidation_scope_id) WHERE job_kind = 'consolidate' AND state IN ('queued', 'waiting_device', 'active', 'waiting_input', 'recovery_required');
CREATE UNIQUE INDEX jobs_active_summary_conversation ON jobs (workspace_id, conversation_id) WHERE job_kind = 'summarize' AND state IN ('queued', 'waiting_device', 'active', 'waiting_input', 'recovery_required');
INSERT INTO routines (id, workspace_id, bot_id, name, input_text, job_kind, schedule, misfire, next_fire_at)
SELECT lower(hex(randomblob(16))), b.workspace_id, b.id, 'Nightly memory consolidation', '', 'consolidate', '{"kind":"cron","expr":"0 3 * * *","timezone":"UTC"}', 'coalesce', strftime('%Y-%m-%dT03:00:00.000Z', 'now', CASE WHEN strftime('%H', 'now') < '03' THEN 'start of day' ELSE '+1 day' END, 'start of day') FROM bots b;
