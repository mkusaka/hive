CREATE TABLE `channel_members` (
	`workspace_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`workspace_id`, `channel_id`, `actor_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`channel_id`) REFERENCES `channels`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`actor_id`) REFERENCES `actors`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "channel_members_role" CHECK("channel_members"."role" IN ('owner', 'member'))
);
--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `delivery_mode` text DEFAULT 'wake' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `actors_workspace_user` ON `actors` (`workspace_id`,`user_id`) WHERE "actors"."user_id" IS NOT NULL;