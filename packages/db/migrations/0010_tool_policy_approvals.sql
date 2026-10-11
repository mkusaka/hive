CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text NOT NULL,
	`execution_generation` integer NOT NULL,
	`job_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`action_kind` text NOT NULL,
	`args_hash` text NOT NULL,
	`args_summary` text NOT NULL,
	`cwd_label` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`requested_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by` text,
	`decision_reason` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`run_id`) REFERENCES `runs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`job_id`) REFERENCES `jobs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`bot_id`) REFERENCES `bots`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "approvals_state" CHECK("approvals"."state" IN ('pending', 'approved', 'denied', 'expired'))
);
--> statement-breakpoint
CREATE INDEX `approvals_state_expires` ON `approvals` (`state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `approvals_run` ON `approvals` (`run_id`);--> statement-breakpoint
CREATE TABLE `device_environments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`device_id` text NOT NULL,
	`name` text NOT NULL,
	`repository` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`device_id`) REFERENCES `devices`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_environments_device_id_name_unique` ON `device_environments` (`device_id`,`name`);--> statement-breakpoint
ALTER TABLE `bots` ADD `tool_policy` text DEFAULT '{"tools":{},"cwdMode":"run_scratch"}' NOT NULL;