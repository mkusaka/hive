PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text NOT NULL,
	`task_id` text,
	`task_scope_revision` integer,
	`state` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`run_id`) REFERENCES `runs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`task_id`) REFERENCES `tasks`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "executions_state" CHECK("__new_executions"."state" IN ('active', 'submitted', 'finished', 'failed', 'interrupted'))
);
--> statement-breakpoint
INSERT INTO `__new_executions`("id", "workspace_id", "run_id", "task_id", "task_scope_revision", "state", "created_at", "updated_at") SELECT "id", "workspace_id", "run_id", "task_id", "task_scope_revision", "state", "created_at", "updated_at" FROM `executions`;--> statement-breakpoint
DROP TABLE `executions`;--> statement-breakpoint
ALTER TABLE `__new_executions` RENAME TO `executions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `executions_run` ON `executions` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `executions_workspace_id_id_unique` ON `executions` (`workspace_id`,`id`);