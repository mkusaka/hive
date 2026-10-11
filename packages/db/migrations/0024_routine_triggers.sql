CREATE TABLE `routine_webhook_deliveries` (
	`routine_id` text NOT NULL,
	`delivery_id` text NOT NULL,
	`received_at` text NOT NULL,
	PRIMARY KEY(`routine_id`, `delivery_id`),
	FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `routine_webhook_deliveries_expiry` ON `routine_webhook_deliveries` (`routine_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `routine_webhook_rate_limits` (
	`routine_id` text NOT NULL,
	`window_started_at` integer NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`routine_id`, `window_started_at`),
	FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `__new_routine_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`routine_id` text NOT NULL,
	`schedule_revision` integer NOT NULL,
	`scheduled_at` text NOT NULL,
	`occurrence_key` text NOT NULL,
	`payload` text,
	`state` text NOT NULL,
	`job_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`routine_id`) REFERENCES `routines`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`job_id`) REFERENCES `jobs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "routine_occurrences_state" CHECK(`state` IN ('created', 'skipped')),
	CONSTRAINT "routine_occurrences_job" CHECK((`state` = 'created') = (`job_id` IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_routine_occurrences`
  (`id`, `workspace_id`, `routine_id`, `schedule_revision`, `scheduled_at`, `occurrence_key`, `payload`, `state`, `job_id`, `created_at`)
SELECT `id`, `workspace_id`, `routine_id`, `schedule_revision`, `scheduled_at`, `scheduled_at`, NULL, `state`, `job_id`, `created_at`
  FROM `routine_occurrences`;
--> statement-breakpoint
DROP TABLE `routine_occurrences`;
--> statement-breakpoint
ALTER TABLE `__new_routine_occurrences` RENAME TO `routine_occurrences`;
--> statement-breakpoint
CREATE UNIQUE INDEX `routine_occurrences_routine_id_schedule_revision_occurrence_key_unique` ON `routine_occurrences` (`routine_id`,`schedule_revision`,`occurrence_key`);--> statement-breakpoint
ALTER TABLE `routines` ADD `webhook_secret_hash` text;