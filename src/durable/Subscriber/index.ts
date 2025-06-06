import type { PublishMessage } from '@/durable/shared';
import { count, eq } from 'drizzle-orm';
import * as schema from './db/schema';
import migrations from './db/drizzle/migrations.js';
import { DrizzleDurableObject } from '@/extension';

export class SubscriberDurableObject extends DrizzleDurableObject<typeof schema, Env> {
	protected readonly schema = schema;
	protected readonly migrations = migrations;

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
			const pair = new WebSocketPair();
			this.ctx.acceptWebSocket(pair[1]);

			const sessionId = crypto.randomUUID();
			pair[1].serializeAttachment(sessionId);

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

		const sessionId = ws.deserializeAttachment() as string;

		await Promise.all(tickers.map((ticker) => this.subscribe(sessionId, ticker)));
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
		await this.handleClose(ws);
	}

	async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		await this.handleClose(ws);
	}

	async onMessage(message: PublishMessage): Promise<void> {
		console.log(`Received message from publisher ${message.publisherId}: ${message.content}`);

		const webSockets = this.ctx.getWebSockets();
		if (webSockets.length === 0) {
			await this.unsubscribe(message.publisherId);
			await this.ctx.blockConcurrencyWhile(async () => {
				await this.ctx.storage.deleteAlarm();
				await this.ctx.storage.deleteAll();
			});
			return;
		}

		const db = await this.getDb();
		const publishers = await db.query.publishers.findMany({columns: { publisherId: true }});
		if (!publishers.some((publisher) => publisher.publisherId === message.publisherId)) {
			console.warn('received message from invalid publisher', message.publisherId);
			await this.unsubscribe(message.publisherId);
			return;
		}

		// find all ws that are subscribed to this publisher
		const sessionIds = await db
			.select({ sessionId: schema.tickerSubscriptions.sessionId })
			.from(schema.tickerSubscriptions)
			.where(eq(schema.tickerSubscriptions.publisherId, message.publisherId));

		console.log(`Found ${sessionIds.length} sessions subscribed to publisher ${message.publisherId}`);

		await Promise.all(
			webSockets.map(async (webSocket) => {
				const sessionId = webSocket.deserializeAttachment() as string;
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

			await this.ctx.blockConcurrencyWhile(async () => {
				await this.ctx.storage.deleteAlarm();
				await this.ctx.storage.deleteAll();
			});
			return;
		}

		const sessionId = webSocket.deserializeAttachment() as string;
		await db.delete(schema.sessions).where(eq(schema.sessions.sessionId, sessionId));

		// Unsubscribe publishers that have no active ticker subscriptions
		const publishersWithoutSubscriptions = await db
			.select({ publisherId: schema.publishers.publisherId })
			.from(schema.publishers)
			.leftJoin(
				schema.tickerSubscriptions,
				eq(schema.publishers.publisherId, schema.tickerSubscriptions.publisherId)
			)
			.groupBy(schema.publishers.publisherId)
			.having(eq(count(schema.tickerSubscriptions.sessionId), 0));

		await Promise.all(
			publishersWithoutSubscriptions.map(async ({ publisherId }) => {
				await this.unsubscribe(publisherId);
			})
		);
	}

	private async unsubscribe(publisherId: string): Promise<void> {
		const id = this.env.DURABLE_PUBLISHER.idFromString(publisherId);
		const stub = this.env.DURABLE_PUBLISHER.get(id);
		await stub.unsubscribe(this.ctx.id.toString());
		const db = await this.getDb();
		await db.delete(schema.publishers).where(eq(schema.publishers.publisherId, publisherId));
	}

	private async subscribe(sessionId: string, ticker: string): Promise<void> {
		console.log('Subscribing to publisher...');

		const id = this.env.DURABLE_PUBLISHER.idFromName(ticker);

		const db = await this.getDb();
		const publisher = await db.query.publishers.findFirst({ where: eq(schema.publishers.publisherId, id.toString()) });

		if (publisher === undefined) {
			const stub = this.env.DURABLE_PUBLISHER.get(id);
			await stub.subscribe(this.ctx.id.toString());
			await db.insert(schema.publishers).values({ publisherId: id.toString(), ticker });
			console.log(`Subscribed to publisher: ${id.toString()}`);
		}

		await db.insert(schema.tickerSubscriptions).values({
			sessionId,
			publisherId: id.toString(),
		}).onConflictDoNothing();
	}
}
