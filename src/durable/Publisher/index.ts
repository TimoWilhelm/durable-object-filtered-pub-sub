import { PING_INTERVAL, type MessageContent, type PublishMessage } from '@/durable/shared';
import { count, eq } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';
import * as schema from './db/schema';
import migrations from './db/drizzle/migrations.js';
import { DrizzleDurableObject } from '@/extension';
import type { DistributeMessageRequest } from '@/durable/Distributor';
import { DebugLogger } from '@/utils/debug';

export class PublisherDurableObject extends DrizzleDurableObject<typeof schema, Env> {
	protected readonly schema = schema;
	protected readonly migrations = migrations;

	private static readonly DISTRIBUTOR_BATCH_SIZE = 10;
	private debugLogger: DebugLogger;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.debugLogger = new DebugLogger(env);
	}

	/**
	 * Chunks subscriber IDs into batches and distributes them across DistributorDurableObjects
	 */
	private async distributeToSubscribers<T>(subscriberIds: string[], operation: 'message' | 'ping', data: T): Promise<void> {
		if (subscriberIds.length === 0) return;

		// Chunk subscribers into batches of 100
		const chunks: string[][] = [];
		for (let i = 0; i < subscriberIds.length; i += PublisherDurableObject.DISTRIBUTOR_BATCH_SIZE) {
			chunks.push(subscriberIds.slice(i, i + PublisherDurableObject.DISTRIBUTOR_BATCH_SIZE));
		}

		// Create distributor instances for each chunk and execute in parallel
		await Promise.all(
			chunks.map(async (chunk, index) => {
				// Create deterministic distributor ID based on publisher ID and batch index
				const distributorId = this.env.DURABLE_DISTRIBUTOR.idFromName(
					`${this.ctx.id.toString()}-${index}`
				);
				const distributorStub = this.env.DURABLE_DISTRIBUTOR.get(distributorId);

				if (operation === 'message') {
					const request: DistributeMessageRequest = {
						message: data as PublishMessage,
						subscriberIds: chunk,
					};

					await this.debugLogger.trackTimedOperation(
						'distribute_message',
						'publisher',
						this.ctx.id.toString(),
						'distributor',
						distributorId.toString(),
						async () => {
							await distributorStub.distributeMessage(request);
						},
						request,
						{ batchIndex: index, chunkSize: chunk.length }
					);
				} else if (operation === 'ping') {
					await this.debugLogger.trackTimedOperation(
						'distribute_ping',
						'publisher',
						this.ctx.id.toString(),
						'distributor',
						distributorId.toString(),
						async () => {
							await distributorStub.distributePing(this.ctx.id.toString(), chunk);
						},
						{ subscriberIds: chunk },
						{ batchIndex: index, chunkSize: chunk.length }
					);
				}
			})
		);
	}

	async alarm(): Promise<void> {
		console.log('Running publisher alarm');

		// send ping to all subscribers via distributors
		const db = await this.getDb();
		const subscribers = await db.query.subscribers.findMany();

		if (subscribers.length === 0) {
			this.cleanup();
			return;
		}

		const subscriberIds = subscribers.map(({ subscriberId }) => subscriberId);
		await this.distributeToSubscribers(subscriberIds, 'ping', null);

		this.ctx.storage.setAlarm(Temporal.Now.instant().add(PING_INTERVAL).epochMilliseconds);
	}

	async subscribe(subscriberId: string): Promise<void> {
		const db = await this.getDb();
		await db.insert(schema.subscribers).values({ subscriberId }).onConflictDoNothing();

		// Track subscription
		await this.debugLogger.trackSimpleInteraction('subscribe', 'subscriber', subscriberId, 'publisher', this.ctx.id.toString(), true);

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

			await this.debugLogger
				.trackTimedOperation(
					'message',
					'publisher',
					this.ctx.id.toString(),
					'subscriber',
					subscriberId,
					async () => {
						console.log(`Sending latest value to new subscriber ${subscriberId}:`, message);
						await stub.onPubSubMessage(message);
					},
					message,
					{ type: 'latest_value' }
				)
				.catch(async (error) => {
					console.error(`Error sending latest value to ${subscriberId}:`, error);
					await this.unsubscribe(subscriberId);
					throw error;
				});
		}
	}

	async unsubscribe(subscriberId: string): Promise<void> {
		const db = await this.getDb();
		await db.delete(schema.subscribers).where(eq(schema.subscribers.subscriberId, subscriberId));
		console.log(`Removed subscriber: ${subscriberId}`);

		// Track unsubscription
		await this.debugLogger.trackSimpleInteraction('unsubscribe', 'publisher', this.ctx.id.toString(), 'subscriber', subscriberId, true);

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
		await db
			.insert(schema.latestTickerValue)
			.values({
				ticker: content.ticker,
				value: content.value,
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: schema.latestTickerValue.id,
				set: {
					ticker: content.ticker,
					value: content.value,
					updatedAt: new Date(),
				},
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

		const subscriberIds = subscribers.map(({ subscriberId }) => subscriberId);
		console.log(`Publishing message to ${subscriberIds.length} subscribers via distributors:`, message);

		// Track publish operation
		await this.debugLogger.trackSimpleInteraction(
			'publish',
			'queue',
			'ticker-queue',
			'publisher',
			this.ctx.id.toString(),
			true,
			message,
			undefined,
			{ subscriberCount: subscriberIds.length }
		);

		await this.distributeToSubscribers(subscriberIds, 'message', message);
	}

	private cleanup() {
		void this.ctx.blockConcurrencyWhile(async () => {
			await this.ctx.storage.deleteAlarm();
			// await this.ctx.storage.deleteAll();
		});
	}
}
