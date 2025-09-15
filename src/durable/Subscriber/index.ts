import { PING_INTERVAL, PING_TIMEOUT, type PublishMessage } from '@/durable/shared';
import { count, eq } from 'drizzle-orm';
import * as schema from './db/schema';
import migrations from './db/drizzle/migrations.js';
import { DrizzleDurableObject } from '@/extension';
import { Temporal } from 'temporal-polyfill';

type WsAttachment = {
	sessionId: string;
};

export class SubscriberDurableObject extends DrizzleDurableObject<typeof schema, Env> {
	protected readonly schema = schema;
	protected readonly migrations = migrations;

	async alarm(): Promise<void> {
		console.log('Running subscriber alarm');

		const db = await this.getDb();
		const publishers = await db.query.publishers.findMany({ columns: { publisherId: true, lastPing: true } });

		if (this.ctx.getWebSockets().length === 0) {
			this.cleanup();
			return;
		}

		await Promise.all(
			publishers.map(async ({ publisherId, lastPing }) => {
				const now = Temporal.Now.instant();
				const lastPingTimestamp = Temporal.Instant.fromEpochMilliseconds(lastPing.getTime());

				if (now.since(lastPingTimestamp).subtract(PING_TIMEOUT).milliseconds > 0) {
					console.log(`Resubscribing to ${publisherId} because last ping was ${now.since(lastPingTimestamp).toString()} ago`);
					await this.subscribe(this.ctx.id.toString(), publisherId);
				}
			})
		);

		this.ctx.storage.setAlarm(Temporal.Now.instant().add(PING_INTERVAL).epochMilliseconds);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
			const pair = new WebSocketPair();
			this.ctx.acceptWebSocket(pair[1]);

			const sessionId = crypto.randomUUID();
			pair[1].serializeAttachment({ sessionId } satisfies WsAttachment);

			const db = await this.getDb();
			await db.insert(schema.sessions).values({ sessionId });

			return new Response(null, {
				status: 101,
				webSocket: pair[0],
			});
		}
		return new Response('Not found', { status: 404 });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		console.log(`Received message: ${message}`);

		const tickers = message
			.toString()
			.split(',')
			.map((ticker) => ticker.trim().toUpperCase());

		const { sessionId } = ws.deserializeAttachment() as WsAttachment;

		// delete existing subscriptions for this session
		const db = await this.getDb();
		await db.delete(schema.tickerSubscriptions).where(eq(schema.tickerSubscriptions.sessionId, sessionId));
		await this.cleanupSubscriptions(); // TODO: this can be wasteful if the user is resubscribing to the some of the same tickers. Might want to do surgical updates in the future.

		await Promise.all(tickers.map((ticker) => this.subscribe(sessionId, ticker)));

		// Send latest ticker values for subscribed tickers to new WebSocket connection
		const latestValues = await db.query.latestTickerValues.findMany({
			where: (latestTickerValues, { inArray }) => inArray(latestTickerValues.ticker, tickers),
		});

		console.log(`Found ${latestValues.length} latest values for tickers: ${tickers.join(', ')}`);

		for (const latestValue of latestValues) {
			const message = {
				id: crypto.randomUUID(),
				publisherId: `publisher-${latestValue.ticker}`,
				content: {
					ticker: latestValue.ticker,
					value: latestValue.value,
				},
			};

			try {
				ws.send(JSON.stringify(message));
				console.log(`Sent latest value to new WebSocket connection for ${latestValue.ticker}: ${latestValue.value}`);
			} catch (error) {
				console.error('Error sending latest value to WebSocket:', error);
				await this.handleClose(ws);
				break;
			}
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
		await this.handleClose(ws);
	}

	async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		await this.handleClose(ws);
	}

	async onPubSubMessage(message: PublishMessage): Promise<void> {
		console.log(`Received message from publisher ${message.publisherId}: ${message.content}`);

		const webSockets = this.ctx.getWebSockets();
		if (webSockets.length === 0) {
			await this.unsubscribe(message.publisherId);
			this.cleanup();
			return;
		}

		const db = await this.getDb();
		const publishers = await db.query.publishers.findMany({ columns: { publisherId: true } });
		if (!publishers.some((publisher) => publisher.publisherId === message.publisherId)) {
			console.warn('received message from invalid publisher', message.publisherId);
			await this.unsubscribe(message.publisherId);
			return;
		}

		// Store latest ticker value in subscriber database
		console.log(`Storing latest ticker value for ${message.content.ticker}: ${message.content.value}`);
		await db
			.insert(schema.latestTickerValues)
			.values({
				ticker: message.content.ticker,
				value: message.content.value,
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: schema.latestTickerValues.ticker,
				set: {
					value: message.content.value,
					updatedAt: new Date(),
				},
			});

		// find all ws that are subscribed to this publisher
		const sessionIds = await db
			.select({ sessionId: schema.tickerSubscriptions.sessionId })
			.from(schema.tickerSubscriptions)
			.where(eq(schema.tickerSubscriptions.publisherId, message.publisherId));

		console.log(`Found ${sessionIds.length} sessions subscribed to publisher ${message.publisherId}`);

		await Promise.all(
			webSockets.map(async (webSocket) => {
				const { sessionId } = webSocket.deserializeAttachment() as WsAttachment;
				if (!sessionIds.some((s) => s.sessionId === sessionId)) {
					return;
				}

				try {
					webSocket.send(JSON.stringify(message));
				} catch (error) {
					console.error('Error sending message to WebSocket:', error);
					await this.handleClose(webSocket);
				}
			})
		);
	}

	async onPubSubPing(publisherId: string): Promise<void> {
		console.log(`Received ping from publisher ${publisherId}`);

		const db = await this.getDb();
		const publishers = await db.query.publishers.findMany({ columns: { publisherId: true } });
		if (!publishers.some((publisher) => publisher.publisherId === publisherId)) {
			console.warn('received ping from invalid publisher', publisherId);
			await this.unsubscribe(publisherId);

			if (this.ctx.getWebSockets().length === 0) {
				this.cleanup();
			}

			return;
		}

		await db.update(schema.publishers).set({ lastPing: new Date() }).where(eq(schema.publishers.publisherId, publisherId));
	}

	async onUnsubscribed(publisherId: string): Promise<void> {
		const db = await this.getDb();
		await db.delete(schema.publishers).where(eq(schema.publishers.publisherId, publisherId));
		console.log(`Unsubscribed from: ${publisherId}`);
	}

	private async handleClose(webSocket: WebSocket): Promise<void> {
		console.log('WebSocket closed');
		webSocket.close(1011); // ensure websocket is closed

		const db = await this.getDb();

		const webSockets = this.ctx.getWebSockets();
		if (webSockets.length === 0) {
			const publishers = await db.query.publishers.findMany();
			await Promise.all(
				publishers.map(async (publisher) => {
					await this.unsubscribe(publisher.publisherId);
				})
			);

			this.cleanup();
			return;
		}

		const { sessionId } = webSocket.deserializeAttachment() as WsAttachment;
		await db.delete(schema.sessions).where(eq(schema.sessions.sessionId, sessionId));

		await this.cleanupSubscriptions();
	}

	private async cleanupSubscriptions(): Promise<void> {
		const db = await this.getDb();

		// Unsubscribe publishers that have no active ticker subscriptions
		const publishersWithoutSubscriptions = await db
			.select({ publisherId: schema.publishers.publisherId })
			.from(schema.publishers)
			.leftJoin(schema.tickerSubscriptions, eq(schema.publishers.publisherId, schema.tickerSubscriptions.publisherId))
			.groupBy(schema.publishers.publisherId)
			.having(eq(count(schema.tickerSubscriptions.sessionId), 0));

		await Promise.all(
			publishersWithoutSubscriptions.map(async ({ publisherId }) => {
				await this.unsubscribe(publisherId);
			})
		);
	}

	private async unsubscribe(publisherId: string): Promise<void> {
		try {
			const id = this.env.DURABLE_PUBLISHER.idFromString(publisherId);
			const stub = this.env.DURABLE_PUBLISHER.get(id);
			await stub.unsubscribe(this.ctx.id.toString());
		} finally {
			const db = await this.getDb();
			await db.delete(schema.publishers).where(eq(schema.publishers.publisherId, publisherId));
		}
	}

	private async subscribe(sessionId: string, ticker: string): Promise<void> {
		const id = this.env.DURABLE_PUBLISHER.idFromName(ticker);

		const db = await this.getDb();
		const publisher = await db.query.publishers.findFirst({ where: eq(schema.publishers.publisherId, id.toString()) });

		console.log(`Found publisher: ${id.toString()}`);

		if (publisher === undefined) {
			const stub = this.env.DURABLE_PUBLISHER.get(id);
			await db.insert(schema.publishers).values({ publisherId: id.toString(), ticker });
			try {
				await stub.subscribe(this.ctx.id.toString());
				console.log(`Subscribed to publisher: ${id.toString()}`);
				this.ctx.storage.setAlarm(Temporal.Now.instant().add(PING_INTERVAL).epochMilliseconds);
			} catch (error) {
				await this.unsubscribe(id.toString());
			}
		}

		await db
			.insert(schema.tickerSubscriptions)
			.values({
				sessionId,
				publisherId: id.toString(),
			})
			.onConflictDoNothing();
	}

	private cleanup() {
		void this.ctx.blockConcurrencyWhile(async () => {
			await this.ctx.storage.deleteAlarm();
			await this.ctx.storage.deleteAll();
		});
	}
}
