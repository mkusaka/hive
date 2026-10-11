CREATE TABLE `run_capabilities` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text NOT NULL,
	`execution_generation` integer NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`run_id`) REFERENCES `runs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_capabilities_token_hash_unique` ON `run_capabilities` (`token_hash`);--> statement-breakpoint
CREATE INDEX `run_capabilities_run` ON `run_capabilities` (`run_id`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `kind` text DEFAULT 'channel' NOT NULL;--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `hop` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `correlation_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `waiting_for_message_id` text;--> statement-breakpoint
CREATE INDEX `jobs_correlation` ON `jobs` (`workspace_id`,`correlation_id`);--> statement-breakpoint
ALTER TABLE `messages` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `hop` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `reply_to_message_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `job_id` text;