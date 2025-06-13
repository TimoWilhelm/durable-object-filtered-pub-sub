PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_publishers` (
	`publisher_id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`lastPing` integer DEFAULT '"2025-06-13T11:35:54.105Z"' NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_publishers`("publisher_id", "ticker", "lastPing") SELECT "publisher_id", "ticker", "lastPing" FROM `publishers`;--> statement-breakpoint
DROP TABLE `publishers`;--> statement-breakpoint
ALTER TABLE `__new_publishers` RENAME TO `publishers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;