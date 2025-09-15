import { PING_INTERVAL, type MessageContent, type PublishMessage } from '@/durable/shared';
import { count, eq } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';
import * as schema from './db/schema';
import migrations from './db/drizzle/migrations.js';
import { DrizzleDurableObject } from '@/extension';

export class PublisherDurableObject extends DrizzleDurableObject<typeof schema, Env> {
	protected readonly schema = schema;
	protected readonly migrations = migrations;

	async alarm(): Promise<void> {
		console.log('Running publisher alarm');

		// send ping to all subscribers
		const db = await this.getDb();
		const subscribers = await db.query.subscribers.findMany();

		if (subscribers.length === 0) {
			this.cleanup();
			return;
		}

		await Promise.all(
			subscribers.map(async ({ subscriberId }) => {
				const id = this.env.DURABLE_SUBSCRIBER.idFromString(subscriberId);
				const stub = this.env.DURABLE_SUBSCRIBER.get(id);
				try {
					await stub.onPubSubPing(this.ctx.id.toString());
				} catch (error) {
					console.error(`Error sending ping to ${subscriberId}:`, error);
					await this.unsubscribe(subscriberId);
				}
			})
		);

		this.ctx.storage.setAlarm(Temporal.Now.instant().add(PING_INTERVAL).epochMilliseconds);
	}

	async subscribe(subscriberId: string): Promise<void> {
		const db = await this.getDb();
		await db.insert(schema.subscribers).values({ subscriberId }).onConflictDoNothing();

		if ((await this.ctx.storage.getAlarm()) === null) {
			this.ctx.storage.setAlarm(Temporal.Now.instant().add(PING_INTERVAL).epochMilliseconds);
		}

		console.log(`New subscriber: ${subscriberId}`);

		// Send the latest ticker value to the new subscriber if available
		const latestValue = await db.query.latestTickerValue.findFirst();
		if (latestValue) {
			const message = {
				id: crypto.randomUUID(),
				publisherId: this.ctx.id.toString(),
				content: { ticker: latestValue.ticker, value: latestValue.value },
			} satisfies PublishMessage;

			const id = this.env.DURABLE_SUBSCRIBER.idFromString(subscriberId);
			const stub = this.env.DURABLE_SUBSCRIBER.get(id);
			try {
				console.log(`Sending latest value to new subscriber ${subscriberId}:`, message);
				await stub.onPubSubMessage(message);
			} catch (error) {
				console.error(`Error sending latest value to ${subscriberId}:`, error);
				await this.unsubscribe(subscriberId);
			}
		}
	}

	async unsubscribe(subscriberId: string): Promise<void> {
		const db = await this.getDb();
		await db.delete(schema.subscribers).where(eq(schema.subscribers.subscriberId, subscriberId));
		console.log(`Removed subscriber: ${subscriberId}`);
		const id = this.env.DURABLE_SUBSCRIBER.idFromString(subscriberId);
		const stub = this.env.DURABLE_SUBSCRIBER.get(id);
		await stub.onUnsubscribed(this.ctx.id.toString());

		const [{ count: numSubscribers }] = await db.select({ count: count() }).from(schema.subscribers);
		if (numSubscribers === 0) {
			this.cleanup();
			return;
		}
	}

	async publish(content: MessageContent): Promise<void> {
		const db = await this.getDb();

		// Store the latest ticker value in database table
		await db.insert(schema.latestTickerValue)
			.values({
				ticker: content.ticker,
				value: content.value,
				updatedAt: new Date()
			})
			.onConflictDoUpdate({
				target: schema.latestTickerValue.id,
				set: {
					ticker: content.ticker,
					value: content.value,
					updatedAt: new Date()
				}
			});

		const message = {
			id: crypto.randomUUID(),
			publisherId: this.ctx.id.toString(),
			content,
		} satisfies PublishMessage;

		const subscribers = await db.query.subscribers.findMany();

		if (subscribers.length === 0) {
			this.cleanup();
			return;
		}

		await Promise.all(
			subscribers.map(async ({ subscriberId }) => {
				const id = this.env.DURABLE_SUBSCRIBER.idFromString(subscriberId);
				const stub = this.env.DURABLE_SUBSCRIBER.get(id);
				try {
					console.log(`Sending message to ${subscriberId}:`, message);
					await stub.onPubSubMessage(message);
				} catch (error) {
					console.error(`Error sending message to ${subscriberId}:`, error);
					await this.unsubscribe(subscriberId);
				}
			})
		);
	}

	private cleanup() {
		void this.ctx.blockConcurrencyWhile(async () => {
			await this.ctx.storage.deleteAlarm();
			// await this.ctx.storage.deleteAll();
		});
	}
}
