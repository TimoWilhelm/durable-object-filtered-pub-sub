import type { PublishMessage } from '@/durable/shared';
import { count, eq } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';
import * as schema from './db/schema';
import migrations from './db/drizzle/migrations.js';
import { DrizzleDurableObject } from '@/extension';

export class PublisherDurableObject extends DrizzleDurableObject<typeof schema, Env> {
	protected readonly schema = schema;
	protected readonly migrations = migrations;

	async subscribe(subscriberId: string) {
		const db = await this.getDb();
		await db.insert(schema.subscribers).values({ subscriberId });

		if ((await this.ctx.storage.getAlarm()) === null) {
			this.ctx.storage.setAlarm(Temporal.Now.instant().add({ seconds: 1 }).epochMilliseconds);
		}

		console.log(`New subscriber: ${subscriberId}`);
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
			await this.ctx.blockConcurrencyWhile(async () => {
				await this.ctx.storage.deleteAlarm();
				await this.ctx.storage.deleteAll();
			});
		}
	}

	async echo(content: string): Promise<string> {
		console.log(`Echoing message: ${content}`);
		await new Promise((resolve) => setTimeout(resolve, 100)); // Simulate some processing delay
		return content;
	}

	async publish(content: string): Promise<void> {
		const message = {
			id: crypto.randomUUID(),
			publisherId: this.ctx.id.toString(),
			content,
		} satisfies PublishMessage;

		const db = await this.getDb();
		const subscribers = await db.query.subscribers.findMany();

		await Promise.all(
			subscribers.map(async ({ subscriberId }) => {
				const id = this.env.DURABLE_SUBSCRIBER.idFromString(subscriberId);
				const stub = this.env.DURABLE_SUBSCRIBER.get(id);
				try {
					console.log(`Sending message to ${subscriberId}:`, message);
					await stub.onMessage(message);
				} catch (error) {
					console.error(`Error sending message to ${subscriberId}:`, error);
					await this.unsubscribe(subscriberId);
				}
			})
		);
	}
}
