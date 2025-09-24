export { SubscriberDurableObject } from '@/durable/Subscriber';
export { PublisherDurableObject } from '@/durable/Publisher';
export { DistributorDurableObject } from '@/durable/Distributor';
export { DebugTrackerDurableObject } from '@/durable/DebugTracker';

import debugHtml from '../public/debug/index.html?raw';

// Curated ticker data with realistic prices - ~30 symbols across major sectors
const TICKERS = [
	// Major Tech Stocks
	{ symbol: 'AAPL', basePrice: 175 },
	{ symbol: 'GOOGL', basePrice: 2850 },
	{ symbol: 'AMZN', basePrice: 3200 },
	{ symbol: 'MSFT', basePrice: 420 },
	{ symbol: 'TSLA', basePrice: 240 },
	{ symbol: 'NVDA', basePrice: 875 },
	{ symbol: 'META', basePrice: 485 },
	{ symbol: 'NFLX', basePrice: 450 },

	// Financial Sector
	{ symbol: 'JPM', basePrice: 155 },
	{ symbol: 'BAC', basePrice: 32 },
	{ symbol: 'V', basePrice: 265 },
	{ symbol: 'MA', basePrice: 425 },
	{ symbol: 'BRK.B', basePrice: 365 },

	// Healthcare & Biotech
	{ symbol: 'JNJ', basePrice: 165 },
	{ symbol: 'UNH', basePrice: 525 },
	{ symbol: 'PFE', basePrice: 35 },
	{ symbol: 'LLY', basePrice: 585 },

	// Consumer & Retail
	{ symbol: 'WMT', basePrice: 165 },
	{ symbol: 'HD', basePrice: 365 },
	{ symbol: 'KO', basePrice: 62 },
	{ symbol: 'PEP', basePrice: 175 },
	{ symbol: 'DIS', basePrice: 95 },
	{ symbol: 'NKE', basePrice: 125 },

	// Industrial & Energy
	{ symbol: 'BA', basePrice: 225 },
	{ symbol: 'CAT', basePrice: 285 },
	{ symbol: 'XOM', basePrice: 115 },
	{ symbol: 'CVX', basePrice: 165 },

	// Growth & Others
	{ symbol: 'UBER', basePrice: 55 },
	{ symbol: 'SNOW', basePrice: 185 },
];

// Store last prices to ensure realistic fluctuations
let lastPrices: Record<string, number> = {};

function generateRealisticPrice(ticker: { symbol: string; basePrice: number }): number {
	const lastPrice = lastPrices[ticker.symbol] || ticker.basePrice;
	// Generate realistic price movement (-2% to +2%)
	const changePercent = (Math.random() - 0.5) * 0.04;
	const newPrice = Math.round(lastPrice * (1 + changePercent) * 100) / 100;
	lastPrices[ticker.symbol] = newPrice;
	return newPrice;
}

async function generateTickerData(env: Env): Promise<void> {
	const tickerUpdates = TICKERS.map((ticker) => ({
		body: {
			ticker: ticker.symbol,
			value: generateRealisticPrice(ticker),
		},
	}));

	await env.QUEUE_EVENTS.sendBatch(tickerUpdates);
}

async function handleDebugRequest(url: URL, env: Env): Promise<Response> {
	const debugTracker = env.DURABLE_DEBUG_TRACKER?.get(env.DURABLE_DEBUG_TRACKER.idFromName('global-debug-tracker'));

	if (!debugTracker) {
		return new Response('Debug tracker not available', { status: 503 });
	}

	const path = url.pathname.replace('/debug/', '');
	const searchParams = url.searchParams;

	try {
		switch (path) {
			case 'interactions':
				const limit = parseInt(searchParams.get('limit') || '100');
				const componentId = searchParams.get('componentId') || undefined;
				const operation = searchParams.get('operation') || undefined;
				const interactions = await debugTracker.getRecentInteractions(limit, componentId, operation);
				return new Response(JSON.stringify(interactions), {
					headers: { 'Content-Type': 'application/json' },
				});

			case 'stats':
				const stats = await debugTracker.getComponentStats();
				return new Response(JSON.stringify(stats), {
					headers: { 'Content-Type': 'application/json' },
				});

			case 'overview':
				const overview = await debugTracker.getSystemOverview();
				return new Response(JSON.stringify(overview), {
					headers: { 'Content-Type': 'application/json' },
				});

			case 'timeline':
				const minutes = parseInt(searchParams.get('minutes') || '5');
				const timeline = await debugTracker.getInteractionTimeline(minutes);
				return new Response(JSON.stringify(timeline), {
					headers: { 'Content-Type': 'application/json' },
				});

			default:
				return new Response('Unknown debug endpoint', { status: 404 });
		}
	} catch (error) {
		console.error('Debug API error:', error);
		return new Response('Internal server error', { status: 500 });
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
			const id: DurableObjectId = env.DURABLE_SUBSCRIBER.newUniqueId();
			const stub = env.DURABLE_SUBSCRIBER.get(id);
			return stub.fetch(request);
		}

		if (url.pathname === '/queue') {
			await generateTickerData(env);
			return new Response('Ticker data generated', { status: 200 });
		}

		// Debug API endpoints
		if (url.pathname.startsWith('/debug/')) {
			return handleDebugRequest(url, env);
		}

		// Debug dashboard
		if (url.pathname === '/debug') {
			return new Response(debugHtml, {
				headers: { 'Content-Type': 'text/html' },
			});
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
