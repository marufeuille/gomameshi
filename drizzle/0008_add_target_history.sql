CREATE TABLE `target_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`effective_date` text NOT NULL,
	`kcal` real NOT NULL,
	`protein_g` real NOT NULL,
	`fat_g` real NOT NULL,
	`carbs_g` real NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `target_history_effective_date_unique` ON `target_history` (`effective_date`);
