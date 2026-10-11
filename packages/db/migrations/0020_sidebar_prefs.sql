CREATE TABLE `sidebar_prefs` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`prefs` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sidebar_prefs_size" CHECK(length(CAST("sidebar_prefs"."prefs" AS BLOB)) <= 65536)
);
