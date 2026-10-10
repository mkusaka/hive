CREATE TABLE `actors` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`user_id` text,
	`display_name` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "actors_kind" CHECK("actors"."kind" IN ('user', 'bot', 'service'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actors_workspace_id_id_unique` ON `actors` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `atomic_guards` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`ok` integer NOT NULL,
	CONSTRAINT "atomic_guards_ok" CHECK("atomic_guards"."ok" = 1)
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`data` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `bots` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`name` text NOT NULL,
	`placement_policy` text NOT NULL,
	`config_revision` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`actor_id`) REFERENCES `actors`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bots_workspace_id_id_unique` ON `bots` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bots_workspace_id_name_unique` ON `bots` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_workspace_id_id_unique` ON `channels` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `channels_workspace_id_name_unique` ON `channels` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`channel_id`) REFERENCES `channels`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_workspace_id_id_unique` ON `conversations` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `device_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`device_id` text NOT NULL,
	`secret_hash` text NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`device_id`) REFERENCES `devices`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_credentials_secret_hash_unique` ON `device_credentials` (`secret_hash`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`os` text NOT NULL,
	`agent_version` text NOT NULL,
	`capacity` integer DEFAULT 1 NOT NULL,
	`last_heartbeat_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_workspace_id_id_unique` ON `devices` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `event_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`event_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`lane` text NOT NULL,
	`purpose` text NOT NULL,
	`matched_subscription_ids` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`event_id`) REFERENCES `events`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`bot_id`) REFERENCES `bots`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_deliveries_workspace_id_id_unique` ON `event_deliveries` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_deliveries_workspace_id_event_id_bot_id_lane_purpose_unique` ON `event_deliveries` (`workspace_id`,`event_id`,`bot_id`,`lane`,`purpose`);--> statement-breakpoint
CREATE TABLE `event_receipts` (
	`workspace_id` text NOT NULL,
	`event_id` text NOT NULL,
	`consumer` text NOT NULL,
	`handler_version` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`event_id`, `consumer`, `handler_version`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`event_id`) REFERENCES `events`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`type` text NOT NULL,
	`schema_version` integer NOT NULL,
	`source_kind` text NOT NULL,
	`integration_id` text,
	`external_event_id` text,
	`source_device_id` text,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`subject_kind` text,
	`subject_id` text,
	`data` text NOT NULL,
	`correlation_id` text NOT NULL,
	`causation_id` text,
	`occurred_at` text NOT NULL,
	`received_at` text NOT NULL,
	`expires_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_source_dedupe` ON `events` (`workspace_id`,`source_kind`,`integration_id`,`external_event_id`) WHERE "events"."integration_id" IS NOT NULL AND "events"."external_event_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `events_workspace_id_id_unique` ON `events` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `executions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text NOT NULL,
	`task_id` text,
	`state` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`run_id`) REFERENCES `runs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "executions_state" CHECK("executions"."state" IN ('active', 'submitted', 'finished', 'failed', 'interrupted'))
);
--> statement-breakpoint
CREATE INDEX `executions_run` ON `executions` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `executions_workspace_id_id_unique` ON `executions` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`input_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`conversation_id` text,
	`lane` text NOT NULL,
	`purpose` text NOT NULL,
	`delivery_id` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`bot_id`) REFERENCES `bots`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`conversation_id`) REFERENCES `conversations`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`delivery_id`) REFERENCES `event_deliveries`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inbox_items_state" CHECK("inbox_items"."state" IN ('pending', 'claimed', 'processed', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_items_workspace_id_id_unique` ON `inbox_items` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_items_dedupe` ON `inbox_items` (`workspace_id`,`input_id`,`bot_id`,`lane`,`purpose`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`trigger_key` text NOT NULL,
	`placement` text NOT NULL,
	`inbox_batch_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`bot_id`) REFERENCES `bots`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "jobs_state" CHECK("jobs"."state" IN ('queued', 'waiting_device', 'waiting_input', 'active', 'recovery_required', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_workspace_id_id_unique` ON `jobs` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_workspace_id_trigger_key_unique` ON `jobs` (`workspace_id`,`trigger_key`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`actor_id` text NOT NULL,
	`client_message_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`conversation_id`) REFERENCES `conversations`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`actor_id`) REFERENCES `actors`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_workspace_id_id_unique` ON `messages` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conversation_id_seq_unique` ON `messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_actor_id_client_message_id_unique` ON `messages` (`actor_id`,`client_message_id`);--> statement-breakpoint
CREATE TABLE `operation_receipts` (
	`workspace_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`status` integer NOT NULL,
	`response` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`workspace_id`, `actor_id`, `idempotency_key`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`topic` text NOT NULL,
	`payload` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`available_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`lease_owner` text,
	`lease_until` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outbox_state" CHECK("outbox"."state" IN ('pending', 'sending', 'sent', 'dead'))
);
--> statement-breakpoint
CREATE INDEX `outbox_ready` ON `outbox` (`state`,`available_at`);--> statement-breakpoint
CREATE TABLE `resource_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`resource_key` text NOT NULL,
	`run_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`released_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`run_id`) REFERENCES `runs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resource_reservations_active` ON `resource_reservations` (`workspace_id`,`resource_key`) WHERE "resource_reservations"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX `resource_reservations_run` ON `resource_reservations` (`run_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`job_id` text NOT NULL,
	`kind` text NOT NULL,
	`parent_run_id` text,
	`device_id` text NOT NULL,
	`execution_generation` integer NOT NULL,
	`state` text DEFAULT 'starting' NOT NULL,
	`lease_expires_at` text,
	`continued_from_run_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`job_id`) REFERENCES `jobs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`device_id`) REFERENCES `devices`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`parent_run_id`) REFERENCES `runs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`continued_from_run_id`) REFERENCES `runs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "runs_kind" CHECK("runs"."kind" IN ('root', 'native_child')),
	CONSTRAINT "runs_state" CHECK("runs"."state" IN ('starting', 'running', 'waiting_approval', 'stopping', 'unknown', 'succeeded', 'failed', 'interrupted', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_one_active_root` ON `runs` (`job_id`) WHERE "runs"."kind" = 'root' AND "runs"."state" NOT IN ('succeeded', 'failed', 'interrupted', 'cancelled');--> statement-breakpoint
CREATE UNIQUE INDEX `runs_workspace_id_id_unique` ON `runs` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_job_id_execution_generation_unique` ON `runs` (`job_id`,`execution_generation`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`access_issuer` text NOT NULL,
	`access_subject` text NOT NULL,
	`email` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_access_issuer_access_subject_unique` ON `users` (`access_issuer`,`access_subject`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
