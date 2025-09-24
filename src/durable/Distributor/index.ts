import { type PublishMessage } from '@/durable/shared';
import { DurableObject } from 'cloudflare:workers';
import { DebugLogger } from '@/utils/debug';

export interface DistributeMessageRequest {
	message: PublishMessage;
	subscriberIds: string[];
}

export class DistributorDurableObject extends DurableObject<Env> {
	private debugLogger: DebugLogger;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.debugLogger = new DebugLogger(env);
	}
	/**
	 * Receives a message and list of subscriber IDs, then distributes the message to all specified subscribers
	 */
	async distributeMessage(request: DistributeMessageRequest): Promise<void> {
		const { message, subscriberIds } = request;

		console.log(`DistributorDurableObject: distributing message ${message.id} to ${subscriberIds.length} subscribers`);

		// Send message to all specified subscribers in parallel
		await Promise.all(
			subscriberIds.map(async (subscriberId) => {
				const id = this.env.DURABLE_SUBSCRIBER.idFromString(subscriberId);
				const stub = this.env.DURABLE_SUBSCRIBER.get(id);
				
				await this.debugLogger.trackTimedOperation(
					'message',
					'distributor',
					this.ctx.id.toString(),
					'subscriber',
					subscriberId,
					async () => {
						await stub.onPubSubMessage(message);
					},
					message,
					{ distributorBatch: true }
				).catch((error) => {
					console.error(`DistributorDurableObject: Error sending message to subscriber ${subscriberId}:`, error);
					// Note: We don't handle unsubscription here since this is the responsibility of the PublisherDurableObject
				});
			})
		);
	}

	/**
	 * Sends ping notifications to a batch of subscribers
	 */
	async distributePing(publisherId: string, subscriberIds: string[]): Promise<void> {
		console.log(`DistributorDurableObject: distributing ping from ${publisherId} to ${subscriberIds.length} subscribers`);

		await Promise.all(
			subscriberIds.map(async (subscriberId) => {
				const id = this.env.DURABLE_SUBSCRIBER.idFromString(subscriberId);
				const stub = this.env.DURABLE_SUBSCRIBER.get(id);
				
				await this.debugLogger.trackTimedOperation(
					'ping',
					'distributor',
					this.ctx.id.toString(),
					'subscriber',
					subscriberId,
					async () => {
						await stub.onPubSubPing(publisherId);
					},
					{ publisherId },
					{ distributorBatch: true }
				).catch((error) => {
					console.error(`DistributorDurableObject: Error sending ping to subscriber ${subscriberId}:`, error);
					// Note: We don't handle unsubscription here since this is the responsibility of the PublisherDurableObject
				});
			})
		);
	}
}
