CREATE TABLE `effects` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text NOT NULL,
	`execution_generation` integer NOT NULL,
	`bot_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`kind` text NOT NULL,
	`request` text NOT NULL,
	`request_digest` text NOT NULL,
	`operation_marker` text NOT NULL,
	`state` text NOT NULL,
	`approval_id` text,
	`external_id` text,
	`external_url` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approval_id`) REFERENCES `approvals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`run_id`) REFERENCES `runs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`bot_id`) REFERENCES `bots`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`integration_id`) REFERENCES `integration_installations`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "effects_kind" CHECK("effects"."kind" IN ('slack.post', 'github.comment')),
	CONSTRAINT "effects_state" CHECK("effects"."state" IN ('prepared', 'approved', 'executing', 'succeeded', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE INDEX `effects_workspace_state` ON `effects` (`workspace_id`,`state`);--> statement-breakpoint
CREATE INDEX `effects_approval` ON `effects` (`approval_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `effects_workspace_id_id_unique` ON `effects` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `effects_run_id_request_digest_unique` ON `effects` (`run_id`,`request_digest`);