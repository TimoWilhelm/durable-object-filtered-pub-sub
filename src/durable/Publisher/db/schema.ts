import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const subscribers = sqliteTable('subscribers', {
	subscriberId: text('subscriber_id').primaryKey(),
});
