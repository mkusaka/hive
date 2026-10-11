CREATE TABLE `routine_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`routine_id` text NOT NULL,
	`schedule_revision` integer NOT NULL,
	`scheduled_at` text NOT NULL,
	`state` text NOT NULL,
	`job_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`routine_id`) REFERENCES `routines`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`job_id`) REFERENCES `jobs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "routine_occurrences_state" CHECK("routine_occurrences"."state" IN ('created', 'skipped')),
	CONSTRAINT "routine_occurrences_job" CHECK(("routine_occurrences"."state" = 'created') = ("routine_occurrences"."job_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `routine_occurrences_routine_id_schedule_revision_scheduled_at_unique` ON `routine_occurrences` (`routine_id`,`schedule_revision`,`scheduled_at`);--> statement-breakpoint
CREATE TABLE `routines` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`name` text NOT NULL,
	`conversation_id` text,
	`task_id` text,
	`input_text` text NOT NULL,
	`schedule` text NOT NULL,
	`schedule_revision` integer DEFAULT 1 NOT NULL,
	`misfire` text DEFAULT 'coalesce' NOT NULL,
	`next_fire_at` text,
	`enabled` integer DEFAULT true NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`bot_id`) REFERENCES `bots`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`conversation_id`) REFERENCES `conversations`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`task_id`) REFERENCES `tasks`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "routines_misfire" CHECK("routines"."misfire" IN ('skip', 'coalesce'))
);
--> statement-breakpoint
CREATE INDEX `routines_due` ON `routines` (`enabled`,`next_fire_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `routines_workspace_id_id_unique` ON `routines` (`workspace_id`,`id`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `cancel_requested_at` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `started_at` text;