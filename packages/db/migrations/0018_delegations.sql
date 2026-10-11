CREATE TABLE `delegations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`task_id` text NOT NULL,
	`from_kind` text NOT NULL,
	`from_id` text NOT NULL,
	`parent_run_id` text,
	`parent_execution_id` text,
	`to_bot_id` text NOT NULL,
	`mode` text NOT NULL,
	`instructions` text NOT NULL,
	`scope_revision` integer NOT NULL,
	`deadline` text,
	`conversation_id` text,
	`hop` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`job_id` text NOT NULL,
	`outcome_summary` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`closed_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`task_id`) REFERENCES `tasks`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`to_bot_id`) REFERENCES `bots`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`job_id`) REFERENCES `jobs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`parent_run_id`) REFERENCES `runs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`parent_execution_id`) REFERENCES `executions`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`conversation_id`) REFERENCES `conversations`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delegations_from_kind" CHECK("delegations"."from_kind" IN ('user', 'bot')),
	CONSTRAINT "delegations_mode" CHECK("delegations"."mode" IN ('read', 'write')),
	CONSTRAINT "delegations_state" CHECK("delegations"."state" IN ('active', 'completed', 'revoked', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delegations_one_active` ON `delegations` (`workspace_id`,`task_id`,`to_bot_id`) WHERE "delegations"."state" = 'active';--> statement-breakpoint
CREATE INDEX `delegations_state` ON `delegations` (`state`,`deadline`);--> statement-breakpoint
CREATE UNIQUE INDEX `delegations_workspace_id_id_unique` ON `delegations` (`workspace_id`,`id`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `delegation_id` text;