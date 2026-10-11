DROP INDEX `transcript_streams_run_id_unique`;--> statement-breakpoint
ALTER TABLE `transcript_streams` ADD `kind` text DEFAULT 'run' NOT NULL;--> statement-breakpoint
ALTER TABLE `transcript_streams` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `transcript_streams` ADD `subpath` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `transcript_streams` ADD `last_part_seq` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `transcript_streams_run` ON `transcript_streams` (`run_id`) WHERE "transcript_streams"."kind" = 'run';--> statement-breakpoint
CREATE UNIQUE INDEX `transcript_streams_session` ON `transcript_streams` (`run_id`,`session_id`,`subpath`) WHERE "transcript_streams"."kind" = 'session';--> statement-breakpoint
CREATE INDEX `transcript_streams_session_lookup` ON `transcript_streams` (`workspace_id`,`provider`,`session_id`,`subpath`);