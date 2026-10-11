CREATE TABLE `transcript_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`stream_id` text NOT NULL,
	`part_seq` integer NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`entry_count` integer NOT NULL,
	`r2_key` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`stream_id`) REFERENCES `transcript_streams`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transcript_parts_seq" CHECK("transcript_parts"."part_seq" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transcript_parts_stream_id_part_seq_unique` ON `transcript_parts` (`stream_id`,`part_seq`);--> statement-breakpoint
CREATE TABLE `transcript_streams` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text NOT NULL,
	`provider` text NOT NULL,
	`confirmed_through_seq` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`run_id`) REFERENCES `runs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transcript_streams_run_id_unique` ON `transcript_streams` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transcript_streams_workspace_id_id_unique` ON `transcript_streams` (`workspace_id`,`id`);--> statement-breakpoint
ALTER TABLE `runs` ADD `finished_at` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `persistence` text DEFAULT 'pending' NOT NULL;