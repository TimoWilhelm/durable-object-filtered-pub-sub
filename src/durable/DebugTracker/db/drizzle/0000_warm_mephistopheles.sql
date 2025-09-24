CREATE TABLE `component_stats` (
	`component_id` text PRIMARY KEY NOT NULL,
	`component_type` text NOT NULL,
	`messages_sent` integer DEFAULT 0 NOT NULL,
	`messages_received` integer DEFAULT 0 NOT NULL,
	`errors` integer DEFAULT 0 NOT NULL,
	`average_processing_time` real DEFAULT 0 NOT NULL,
	`last_activity` integer NOT NULL,
	`is_alive` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` integer NOT NULL,
	`source_component` text NOT NULL,
	`source_id` text NOT NULL,
	`target_component` text NOT NULL,
	`target_id` text NOT NULL,
	`operation` text NOT NULL,
	`data` text,
	`duration` integer,
	`success` integer NOT NULL,
	`error` text,
	`metadata` text
);
