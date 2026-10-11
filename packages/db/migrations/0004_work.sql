CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`primary_channel_id` text,
	`task_counter` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`primary_channel_id`) REFERENCES `channels`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "projects_status" CHECK("projects"."status" IN ('active', 'paused', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_workspace_id_id_unique` ON `projects` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_workspace_id_key_unique` ON `projects` (`workspace_id`,`key`);--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`workspace_id` text NOT NULL,
	`prerequisite_task_id` text NOT NULL,
	`dependent_task_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`prerequisite_task_id`, `dependent_task_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`prerequisite_task_id`) REFERENCES `tasks`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`dependent_task_id`) REFERENCES `tasks`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_dependencies_not_self" CHECK("task_dependencies"."prerequisite_task_id" <> "task_dependencies"."dependent_task_id")
);
--> statement-breakpoint
CREATE INDEX `task_dependencies_dependent` ON `task_dependencies` (`dependent_task_id`);--> statement-breakpoint
CREATE TABLE `task_results` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`task_id` text NOT NULL,
	`execution_id` text NOT NULL,
	`run_id` text NOT NULL,
	`scope_revision` integer NOT NULL,
	`state` text NOT NULL,
	`summary` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`task_id`) REFERENCES `tasks`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`execution_id`) REFERENCES `executions`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`run_id`) REFERENCES `runs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_results_state" CHECK("task_results"."state" IN ('succeeded', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `task_results_task` ON `task_results` (`task_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text,
	`parent_task_id` text,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`assignee_kind` text,
	`assignee_id` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`scope_revision` integer DEFAULT 1 NOT NULL,
	`completion_policy` text DEFAULT 'declaration' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`project_id`) REFERENCES `projects`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`parent_task_id`) REFERENCES `tasks`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_status" CHECK("tasks"."status" IN ('pending', 'in_progress', 'completed', 'cancelled')),
	CONSTRAINT "tasks_assignee_kind" CHECK("tasks"."assignee_kind" IN ('user', 'bot')),
	CONSTRAINT "tasks_assignee" CHECK(("tasks"."assignee_kind" IS NULL) = ("tasks"."assignee_id" IS NULL)),
	CONSTRAINT "tasks_completion_policy" CHECK("tasks"."completion_policy" IN ('declaration', 'human', 'checks', 'children'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_workspace_id_id_unique` ON `tasks` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_workspace_id_key_unique` ON `tasks` (`workspace_id`,`key`);--> statement-breakpoint
ALTER TABLE `executions` ADD `task_scope_revision` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `task_id` text REFERENCES tasks(id);