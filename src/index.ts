export { SubscriberDurableObject } from '@/durable/Subscriber';
export { PublisherDurableObject } from '@/durable/Publisher';

// Ticker data with realistic prices
const TICKERS = [
	{ symbol: 'AAPL', basePrice: 175 },
	{ symbol: 'GOOGL', basePrice: 2850 },
	{ symbol: 'AMZN', basePrice: 3200 },
	{ symbol: 'MSFT', basePrice: 420 },
	{ symbol: 'TSLA', basePrice: 240 },
	{ symbol: 'NVDA', basePrice: 875 },
	{ symbol: 'META', basePrice: 485 },
	{ symbol: 'NFLX', basePrice: 450 },
];

// Store last prices to ensure realistic fluctuations
let lastPrices: Record<string, number> = {};

function generateRealisticPrice(ticker: { symbol: string; basePrice: number }): number {
	const lastPrice = lastPrices[ticker.symbol] || ticker.basePrice;
	// Generate realistic price movement (-2% to +2%)
	const changePercent = (Math.random() - 0.5) * 0.04;
	const newPrice = Math.round((lastPrice * (1 + changePercent)) * 100) / 100;
	lastPrices[ticker.symbol] = newPrice;
	return newPrice;
}

async function generateTickerData(env: Env): Promise<void> {
	const tickerUpdates = TICKERS.map(ticker => ({
		body: {
			ticker: ticker.symbol,
			value: generateRealisticPrice(ticker),
		},
	}));

	await env.QUEUE_EVENTS.sendBatch(tickerUpdates);
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
			const id: DurableObjectId = env.DURABLE_SUBSCRIBER.idFromName('foo');
			const stub = env.DURABLE_SUBSCRIBER.get(id);
			return stub.fetch(request);
		}

		if (url.pathname === '/queue') {
			await generateTickerData(env);
			return new Response('Ticker data generated', { status: 200 });
		}

		// Default to 404 for other paths

		return new Response('Not found', { status: 404 });
	},

	async scheduled(event, env, ctx): Promise<void> {
		// Generate ticker data every 2 seconds during market hours simulation
		ctx.waitUntil(generateTickerData(env));
	},

	async queue(batch, env, ctx): Promise<void> {
		for (const message of batch.messages) {
			try {
				const id: DurableObjectId = env.DURABLE_PUBLISHER.idFromName(message.body.ticker);
				const stub = env.DURABLE_PUBLISHER.get(id);
				await stub.publish({
					ticker: message.body.ticker,
					value: message.body.value,
				});
				message.ack();
				console.log(`QUEUE: ${message.body.value} for ticker: ${message.body.ticker} (id: ${id.toString()})`);
			} catch {
				message.retry();
			}
		}
	},
} satisfies ExportedHandler<Env, TickerQueueMessage>;
