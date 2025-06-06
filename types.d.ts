type TickerQueueMessage = {
	ticker: string;
	value: number;
}

declare namespace Cloudflare {
	interface Env {
		QUEUE_EVENTS: Queue<TickerQueueMessage>;
	}
}
