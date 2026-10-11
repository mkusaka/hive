CREATE TABLE `run_git` (
	`run_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`repository` text NOT NULL,
	`branch` text NOT NULL,
	`before` text NOT NULL,
	`after` text NOT NULL,
	`commits` text NOT NULL,
	`partial` integer NOT NULL,
	`prs` text NOT NULL,
	`pr_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`run_id`) REFERENCES `runs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action
);
