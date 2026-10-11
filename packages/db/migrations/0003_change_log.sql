CREATE TABLE `change_log` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`op` text NOT NULL,
	`revision` integer,
	`scope` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "change_log_op" CHECK("change_log"."op" IN ('upsert', 'delete'))
);
--> statement-breakpoint
CREATE INDEX `change_log_workspace_seq` ON `change_log` (`workspace_id`,`seq`);--> statement-breakpoint
ALTER TABLE `workspaces` ADD `auth_epoch` integer DEFAULT 1 NOT NULL;