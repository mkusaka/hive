ALTER TABLE `conversations` ADD `root_message_id` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `parent_conversation_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_thread` ON `conversations` (`workspace_id`,`root_message_id`) WHERE "conversations"."kind" = 'thread';--> statement-breakpoint
CREATE INDEX `conversations_parent` ON `conversations` (`workspace_id`,`parent_conversation_id`);