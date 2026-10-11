CREATE TABLE `inbox_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`lane` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`seal_at` text NOT NULL,
	`max_items` integer NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`bot_id`) REFERENCES `bots`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inbox_batches_state" CHECK("inbox_batches"."state" IN ('open', 'sealed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_batches_open` ON `inbox_batches` (`workspace_id`,`bot_id`,`lane`) WHERE "inbox_batches"."state" = 'open';--> statement-breakpoint
CREATE INDEX `inbox_batches_seal` ON `inbox_batches` (`state`,`seal_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_batches_workspace_id_id_unique` ON `inbox_batches` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `integration_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`external_account_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "integration_installations_kind" CHECK("integration_installations"."kind" IN ('github', 'slack'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_installations_workspace_id_id_unique` ON `integration_installations` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `subscription_revisions` (
	`subscription_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`integration_id` text,
	`event_types` text NOT NULL,
	`filter` text NOT NULL,
	`destination` text NOT NULL,
	`delivery` text NOT NULL,
	`enabled` integer NOT NULL,
	`expires_at` text,
	`revision` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`subscription_id`, `revision`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`integration_id` text,
	`event_types` text NOT NULL,
	`filter` text NOT NULL,
	`destination` text NOT NULL,
	`delivery` text NOT NULL,
	`enabled` integer NOT NULL,
	`expires_at` text,
	`revision` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`bot_id`) REFERENCES `bots`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`integration_id`) REFERENCES `integration_installations`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `subscriptions_workspace_enabled` ON `subscriptions` (`workspace_id`,`enabled`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_workspace_id_id_unique` ON `subscriptions` (`workspace_id`,`id`);--> statement-breakpoint
ALTER TABLE `events` ADD `logical_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `events_logical_dedupe` ON `events` (`workspace_id`,`logical_key`) WHERE "events"."logical_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `batch_id` text REFERENCES inbox_batches(id);