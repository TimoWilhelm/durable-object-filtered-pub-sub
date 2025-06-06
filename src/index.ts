export { SubscriberDurableObject } from '@/durable/Subscriber';
export { PublisherDurableObject } from '@/durable/Publisher';

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
			const id: DurableObjectId = env.DURABLE_SUBSCRIBER.idFromName("foo");
			const stub = env.DURABLE_SUBSCRIBER.get(id);
			return stub.fetch(request);
		}

		if (url.pathname === '/queue') {
			await env.QUEUE_EVENTS.sendBatch([
				{
					body: {
						ticker: 'AAPL',
						value: 150,
					},
				},
				{
					body: {
						ticker: 'GOOGL',
						value: 2800,
					},
				},
				{
					body: {
						ticker: 'AMZN',
						value: 3400,
					},
				},
			]);
			return new Response('Batch sent', { status: 200 });
		}

		return new Response('Not found', { status: 404 });
	},

	async queue(batch, env, ctx): Promise<void> {
		for (const message of batch.messages) {
			try {
				const id: DurableObjectId = env.DURABLE_PUBLISHER.idFromName(message.body.ticker);
				const stub = env.DURABLE_PUBLISHER.get(id);
				await stub.publish(message.body.value.toString());
				message.ack();
				console.log(`QUEUE: ${message.body.value} for ticker: ${message.body.ticker} (id: ${id.toString()})`);
			} catch {
				message.retry();
			}
		}
	},
} satisfies ExportedHandler<Env, TickerQueueMessage>;
