CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`content` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`created_by_actor_id` text NOT NULL,
	`revision` integer NOT NULL,
	`supersedes_id` text,
	`deleted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`created_by_actor_id`) REFERENCES `actors`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "memories_scope_kind" CHECK("memories"."scope_kind" IN ('workspace', 'channel', 'project', 'bot', 'task')),
	CONSTRAINT "memories_source_kind" CHECK("memories"."source_kind" IN ('user', 'bot', 'system')),
	CONSTRAINT "memories_content_size" CHECK(length(CAST("memories"."content" AS BLOB)) <= 16384)
);
--> statement-breakpoint
CREATE INDEX `memories_scope` ON `memories` (`workspace_id`,`scope_kind`,`scope_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `memories_workspace_id_id_unique` ON `memories` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `memory_revisions` (
	`memory_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`content` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`created_by_actor_id` text NOT NULL,
	`revision` integer NOT NULL,
	`supersedes_id` text,
	`deleted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`memory_id`, `revision`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `search_documents` (
	`rowid` integer PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`chunk_key` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`scope` text NOT NULL,
	`deleted_at` text,
	`indexed_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "search_documents_source_kind" CHECK("search_documents"."source_kind" IN ('message', 'task', 'memory'))
);
--> statement-breakpoint
CREATE INDEX `search_documents_workspace` ON `search_documents` (`workspace_id`,`indexed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `search_documents_source_kind_source_id_chunk_key_unique` ON `search_documents` (`source_kind`,`source_id`,`chunk_key`);