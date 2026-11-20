ALTER TABLE `foods` ADD COLUMN `table_no` TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX `foods_table_no_unique` ON `foods` (`table_no`) WHERE `table_no` IS NOT NULL;
