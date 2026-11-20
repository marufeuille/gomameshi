CREATE TABLE `assist_proposals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`query_norm` text NOT NULL,
	`original_text` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assist_proposals_query_norm_unique` ON `assist_proposals` (`query_norm`);
