PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_channel_members` (
	`workspace_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`workspace_id`, `channel_id`, `actor_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`channel_id`) REFERENCES `channels`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`actor_id`) REFERENCES `actors`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "channel_members_role" CHECK("__new_channel_members"."role" IN ('owner', 'member', 'viewer'))
);
--> statement-breakpoint
INSERT INTO `__new_channel_members`("workspace_id", "channel_id", "actor_id", "role", "created_at") SELECT "workspace_id", "channel_id", "actor_id", "role", "created_at" FROM `channel_members`;--> statement-breakpoint
DROP TABLE `channel_members`;--> statement-breakpoint
ALTER TABLE `__new_channel_members` RENAME TO `channel_members`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `bots` ADD `skills` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `bots` ADD `created_by_bot_id` text;