CREATE TABLE `latest_ticker_value` (
	`id` integer PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`value` real NOT NULL,
	`updatedAt` integer DEFAULT '"2025-09-15T08:26:08.218Z"' NOT NULL
);
