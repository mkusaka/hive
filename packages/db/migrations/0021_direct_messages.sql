ALTER TABLE `conversations` ADD `dm_user_id` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `dm_bot_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_dm` ON `conversations` (`workspace_id`,`dm_user_id`,`dm_bot_id`) WHERE "conversations"."kind" = 'dm';