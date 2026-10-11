ALTER TABLE `bots` ADD `instructions` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `provider_session_id` text;