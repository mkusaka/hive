PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`job_id` text,
	`kind` text DEFAULT 'job' NOT NULL,
	`parent_run_id` text,
	`device_id` text NOT NULL,
	`execution_generation` integer,
	`state` text DEFAULT 'starting' NOT NULL,
	`lease_expires_at` text,
	`continued_from_run_id` text,
	`provider` text,
	`external_session_id` text,
	`cwd` text,
	`repository` text,
	`title` text,
	`first_user_message` text,
	`last_activity_at` text,
	`task_id` text,
	`result_summary` text,
	`result_error` text,
	`provider_session_id` text,
	`started_at` text,
	`finished_at` text,
	`persistence` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`job_id`) REFERENCES `jobs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`device_id`) REFERENCES `devices`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`parent_run_id`) REFERENCES `runs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`continued_from_run_id`) REFERENCES `runs`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`task_id`) REFERENCES `tasks`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "runs_kind" CHECK("__new_runs"."kind" IN ('job', 'native_child', 'external')),
	CONSTRAINT "runs_state" CHECK("__new_runs"."state" IN ('starting', 'running', 'waiting_approval', 'stopping', 'unknown', 'succeeded', 'failed', 'interrupted', 'cancelled', 'active', 'finished')),
	CONSTRAINT "runs_external" CHECK(("__new_runs"."kind" = 'external' AND "__new_runs"."job_id" IS NULL AND "__new_runs"."execution_generation" IS NULL
          AND "__new_runs"."parent_run_id" IS NULL AND "__new_runs"."continued_from_run_id" IS NULL AND "__new_runs"."lease_expires_at" IS NULL
          AND "__new_runs"."provider" IS NOT NULL AND "__new_runs"."external_session_id" IS NOT NULL AND "__new_runs"."cwd" IS NOT NULL
          AND "__new_runs"."repository" IS NOT NULL AND "__new_runs"."title" IS NOT NULL AND "__new_runs"."last_activity_at" IS NOT NULL
          AND "__new_runs"."state" IN ('active', 'finished'))
        OR ("__new_runs"."kind" != 'external' AND "__new_runs"."job_id" IS NOT NULL AND "__new_runs"."execution_generation" IS NOT NULL
            AND "__new_runs"."provider" IS NULL AND "__new_runs"."external_session_id" IS NULL AND "__new_runs"."task_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_runs`("id", "workspace_id", "job_id", "kind", "parent_run_id", "device_id", "execution_generation", "state", "lease_expires_at", "continued_from_run_id", "provider", "external_session_id", "cwd", "repository", "title", "first_user_message", "last_activity_at", "task_id", "result_summary", "result_error", "provider_session_id", "started_at", "finished_at", "persistence", "created_at", "updated_at") SELECT "id", "workspace_id", "job_id", CASE WHEN "kind" = 'root' THEN 'job' ELSE "kind" END, "parent_run_id", "device_id", "execution_generation", "state", "lease_expires_at", "continued_from_run_id", NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, "result_summary", "result_error", "provider_session_id", "started_at", "finished_at", "persistence", "created_at", "updated_at" FROM `runs`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
ALTER TABLE `__new_runs` RENAME TO `runs`;--> statement-breakpoint
CREATE UNIQUE INDEX `runs_one_active_job` ON `runs` (`job_id`) WHERE "runs"."kind" = 'job' AND "runs"."state" NOT IN ('succeeded', 'failed', 'interrupted', 'cancelled');--> statement-breakpoint
CREATE UNIQUE INDEX `runs_workspace_id_id_unique` ON `runs` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_job_id_execution_generation_unique` ON `runs` (`job_id`,`execution_generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_workspace_id_device_id_provider_external_session_id_unique` ON `runs` (`workspace_id`,`device_id`,`provider`,`external_session_id`);--> statement-breakpoint
CREATE TABLE `__new_search_documents` (
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
  CONSTRAINT "search_documents_source_kind" CHECK("__new_search_documents"."source_kind" IN ('message', 'task', 'memory', 'run'))
);
--> statement-breakpoint
INSERT INTO `__new_search_documents`("rowid", "workspace_id", "source_kind", "source_id", "source_revision", "chunk_key", "title", "body", "scope", "deleted_at", "indexed_at") SELECT "rowid", "workspace_id", "source_kind", "source_id", "source_revision", "chunk_key", "title", "body", "scope", "deleted_at", "indexed_at" FROM `search_documents`;
--> statement-breakpoint
DROP TABLE `search_documents`;
--> statement-breakpoint
ALTER TABLE `__new_search_documents` RENAME TO `search_documents`;
--> statement-breakpoint
CREATE INDEX `search_documents_workspace` ON `search_documents` (`workspace_id`,`indexed_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_documents_source_kind_source_id_chunk_key_unique` ON `search_documents` (`source_kind`,`source_id`,`chunk_key`);
--> statement-breakpoint
CREATE TRIGGER `search_documents_ai` AFTER INSERT ON `search_documents` BEGIN
  INSERT INTO search_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER `search_documents_ad` AFTER DELETE ON `search_documents` BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
--> statement-breakpoint
CREATE TRIGGER `search_documents_au` AFTER UPDATE ON `search_documents` BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO search_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;