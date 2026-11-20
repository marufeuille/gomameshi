ALTER TABLE `food_research_jobs` ADD COLUMN `progress_stage` text;
--> statement-breakpoint
ALTER TABLE `recipe_imports` ADD COLUMN `progress` text;
--> statement-breakpoint
ALTER TABLE `recipe_imports` ADD COLUMN `progress_stage` text;
--> statement-breakpoint
CREATE TABLE `ai_metrics` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
