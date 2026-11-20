CREATE TABLE `consumption_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`food_ids` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
