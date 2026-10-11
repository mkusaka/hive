CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`uploader_actor_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`r2_key` text NOT NULL,
	`sha256` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`uploader_actor_id`) REFERENCES `actors`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`conversation_id`) REFERENCES `conversations`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`message_id`) REFERENCES `messages`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attachments_size" CHECK("attachments"."size" BETWEEN 1 AND 26214400),
	CONSTRAINT "attachments_state" CHECK("attachments"."state" IN ('pending', 'ready'))
);
--> statement-breakpoint
CREATE INDEX `attachments_gc` ON `attachments` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `attachments_message` ON `attachments` (`workspace_id`,`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_workspace_id_id_unique` ON `attachments` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_r2_key_unique` ON `attachments` (`r2_key`);