import { sqliteTable, text, real, integer } from 'drizzle-orm/sqlite-core';

export const subscribers = sqliteTable('subscribers', {
	subscriberId: text('subscriber_id').primaryKey(),
});

export const latestTickerValue = sqliteTable('latest_ticker_value', {
	id: integer('id').primaryKey(),
	ticker: text('ticker').notNull(),
	value: real('value').notNull(),
	updatedAt: integer({ mode: 'timestamp_ms' }).notNull().default(new Date()),
});
