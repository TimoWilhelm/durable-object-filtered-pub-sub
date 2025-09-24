import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const interactions = sqliteTable('interactions', {
	id: text('id').primaryKey(),
	timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
	sourceComponent: text('source_component').notNull(),
	sourceId: text('source_id').notNull(),
	targetComponent: text('target_component').notNull(),
	targetId: text('target_id').notNull(),
	operation: text('operation').notNull(),
	data: text('data'), // JSON string
	duration: integer('duration'), // milliseconds
	success: integer('success', { mode: 'boolean' }).notNull(),
	error: text('error'),
	metadata: text('metadata'), // JSON string
});

export const componentStats = sqliteTable('component_stats', {
	componentId: text('component_id').primaryKey(),
	componentType: text('component_type').notNull(),
	messagesSent: integer('messages_sent').notNull().default(0),
	messagesReceived: integer('messages_received').notNull().default(0),
	errors: integer('errors').notNull().default(0),
	averageProcessingTime: real('average_processing_time').notNull().default(0),
	lastActivity: integer('last_activity', { mode: 'timestamp' }).notNull(),
	isAlive: integer('is_alive', { mode: 'boolean' }).notNull().default(true),
});
