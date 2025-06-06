import { sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

export const publishers = sqliteTable('publishers', {
	publisherId: text('publisher_id').primaryKey(),
	ticker: text('ticker').notNull(),
});

export const sessions = sqliteTable('sessions', {
	sessionId: text('session_id').primaryKey(),
});

export const tickerSubscriptions = sqliteTable(
	'ticker_subscriptions',
	{
		sessionId: text('session_id').references(() => sessions.sessionId, { onDelete: 'cascade' }),
		publisherId: text('publisher_id').references(() => publishers.publisherId, { onDelete: 'cascade' }),
	},
	(table) => [unique('unique_session_ticker').on(table.sessionId, table.publisherId)]
);
