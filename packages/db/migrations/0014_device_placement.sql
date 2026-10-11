-- Placement (docs/architecture.md §10.1, §10.2): the unused `capacity` becomes the background capacity, and the
-- heartbeat's capabilities are stored next to it. Hand-written: drizzle-kit would ask interactively about the rename.
ALTER TABLE `devices` RENAME COLUMN `capacity` TO `capacity_background`;--> statement-breakpoint
ALTER TABLE `devices` ADD `capabilities` text DEFAULT '[]' NOT NULL;
