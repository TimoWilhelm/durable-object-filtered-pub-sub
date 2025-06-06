CREATE TABLE `publishers` (
	`publisher_id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`session_id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ticker_subscriptions` (
	`session_id` text,
	`publisher_id` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`publisher_id`) REFERENCES `publishers`(`publisher_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unique_session_ticker` ON `ticker_subscriptions` (`session_id`,`publisher_id`);