import { DrizzleDurableObject } from '@/extension';
import { Temporal } from 'temporal-polyfill';
import { desc, or, eq, gte, lt, and } from 'drizzle-orm';
import * as schema from './db/schema';
import migrations from './db/drizzle/migrations.js';

export interface ComponentInteraction {
	id: string;
	timestamp: Date;
	sourceComponent: 'queue' | 'publisher' | 'distributor' | 'subscriber' | 'websocket';
	sourceId: string;
	targetComponent: 'queue' | 'publisher' | 'distributor' | 'subscriber' | 'websocket';
	targetId: string;
	operation:
		| 'publish'
		| 'distribute_message'
		| 'distribute_ping'
		| 'subscribe'
		| 'unsubscribe'
		| 'ping'
		| 'message'
		| 'websocket_connect'
		| 'websocket_disconnect';
	data?: any;
	duration?: number;
	success: boolean;
	error?: string;
	metadata?: Record<string, any>;
}

export interface ComponentStats {
	componentId: string;
	componentType: 'publisher' | 'distributor' | 'subscriber';
	messagesSent: number;
	messagesReceived: number;
	errors: number;
	averageProcessingTime: number;
	lastActivity: Date;
	isAlive: boolean;
}

export class DebugTrackerDurableObject extends DrizzleDurableObject<typeof schema, Env> {
	protected readonly schema = schema;
	protected readonly migrations = migrations;

	private static readonly MAX_INTERACTIONS = 1000;
	private static readonly CLEANUP_INTERVAL = 60000; // 1 minute

	/**
	 * Track a component interaction
	 */
	async trackInteraction(interaction: ComponentInteraction): Promise<void> {
		const db = await this.getDb();

		await db.insert(schema.interactions).values({
			id: interaction.id,
			timestamp: interaction.timestamp,
			sourceComponent: interaction.sourceComponent,
			sourceId: interaction.sourceId,
			targetComponent: interaction.targetComponent,
			targetId: interaction.targetId,
			operation: interaction.operation,
			data: interaction.data ? JSON.stringify(interaction.data) : null,
			duration: interaction.duration,
			success: interaction.success,
			error: interaction.error,
			metadata: interaction.metadata ? JSON.stringify(interaction.metadata) : null,
		});

		// Update component stats
		await this.updateComponentStats(interaction);

		// Schedule cleanup if needed
		await this.scheduleCleanupIfNeeded();
	}

	/**
	 * Get recent interactions with optional filtering
	 */
	async getRecentInteractions(
		limit: number = 100,
		componentId?: string,
		operation?: string,
		sinceTimestamp?: Date
	): Promise<ComponentInteraction[]> {
		const db = await this.getDb();

		// Build conditions array
		const conditions = [];

		if (componentId) {
			conditions.push(or(eq(schema.interactions.sourceId, componentId), eq(schema.interactions.targetId, componentId)));
		}

		if (operation) {
			conditions.push(eq(schema.interactions.operation, operation));
		}

		if (sinceTimestamp) {
			conditions.push(gte(schema.interactions.timestamp, sinceTimestamp));
		}

		// Build the query in one go to avoid type issues
		const results =
			conditions.length > 0
				? await db
						.select()
						.from(schema.interactions)
						.where(and(...conditions))
						.orderBy(desc(schema.interactions.timestamp))
						.limit(limit)
				: await db.select().from(schema.interactions).orderBy(desc(schema.interactions.timestamp)).limit(limit);

		return results.map((row) => ({
			id: row.id,
			timestamp: row.timestamp,
			sourceComponent: row.sourceComponent as ComponentInteraction['sourceComponent'],
			sourceId: row.sourceId,
			targetComponent: row.targetComponent as ComponentInteraction['targetComponent'],
			targetId: row.targetId,
			operation: row.operation as ComponentInteraction['operation'],
			data: row.data ? JSON.parse(row.data) : undefined,
			duration: row.duration ?? undefined,
			success: row.success,
			error: row.error ?? undefined,
			metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
		}));
	}

	/**
	 * Get component statistics
	 */
	async getComponentStats(): Promise<ComponentStats[]> {
		const db = await this.getDb();

		const stats = await db.select().from(schema.componentStats).orderBy(desc(schema.componentStats.lastActivity));

		return stats.map((row) => ({
			componentId: row.componentId,
			componentType: row.componentType as ComponentStats['componentType'],
			messagesSent: row.messagesSent,
			messagesReceived: row.messagesReceived,
			errors: row.errors,
			averageProcessingTime: row.averageProcessingTime,
			lastActivity: row.lastActivity,
			isAlive: row.isAlive,
		}));
	}

	/**
	 * Get real-time system overview
	 */
	async getSystemOverview(): Promise<{
		totalMessages: number;
		activePublishers: number;
		activeDistributors: number;
		activeSubscribers: number;
		recentErrors: ComponentInteraction[];
		topActiveComponents: ComponentStats[];
		messageFlow: { operation: string; count: number; successRate: number }[];
	}> {
		const db = await this.getDb();

		// Get recent stats (last 5 minutes)
		const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
		const recentInteractions = await db.select().from(schema.interactions).where(gte(schema.interactions.timestamp, fiveMinutesAgo));

		const recentErrors = await this.getRecentInteractions(10, undefined, undefined, fiveMinutesAgo);
		const errorInteractions = recentErrors.filter((i) => !i.success);

		const componentStats = await this.getComponentStats();
		const activeStats = componentStats.filter((s) => s.isAlive);

		// Calculate message flow statistics
		const messageFlowMap = new Map<string, { count: number; success: number }>();

		recentInteractions.forEach((interaction) => {
			const key = interaction.operation;
			if (!messageFlowMap.has(key)) {
				messageFlowMap.set(key, { count: 0, success: 0 });
			}
			const flow = messageFlowMap.get(key)!;
			flow.count++;
			if (interaction.success) flow.success++;
		});

		const messageFlow = Array.from(messageFlowMap.entries()).map(([operation, data]) => ({
			operation,
			count: data.count,
			successRate: data.count > 0 ? (data.success / data.count) * 100 : 0,
		}));

		return {
			totalMessages: recentInteractions.length,
			activePublishers: activeStats.filter((s) => s.componentType === 'publisher').length,
			activeDistributors: activeStats.filter((s) => s.componentType === 'distributor').length,
			activeSubscribers: activeStats.filter((s) => s.componentType === 'subscriber').length,
			recentErrors: errorInteractions,
			topActiveComponents: activeStats
				.sort((a, b) => b.messagesSent + b.messagesReceived - (a.messagesSent + a.messagesReceived))
				.slice(0, 10),
			messageFlow,
		};
	}

	/**
	 * Get interaction timeline for visualization
	 */
	async getInteractionTimeline(minutes: number = 5): Promise<
		{
			timestamp: Date;
			interactions: ComponentInteraction[];
		}[]
	> {
		const since = new Date(Date.now() - minutes * 60 * 1000);
		const interactions = await this.getRecentInteractions(500, undefined, undefined, since);

		// Group by minute
		const timelineMap = new Map<string, ComponentInteraction[]>();

		interactions.forEach((interaction) => {
			const minute = new Date(interaction.timestamp);
			minute.setSeconds(0, 0); // Round to minute
			const key = minute.toISOString();

			if (!timelineMap.has(key)) {
				timelineMap.set(key, []);
			}
			timelineMap.get(key)!.push(interaction);
		});

		return Array.from(timelineMap.entries())
			.map(([timestamp, interactions]) => ({
				timestamp: new Date(timestamp),
				interactions,
			}))
			.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
	}

	private async updateComponentStats(interaction: ComponentInteraction): Promise<void> {
		const db = await this.getDb();

		// Update source component stats
		await this.upsertComponentStat(db, interaction.sourceId, this.getComponentType(interaction.sourceComponent), {
			messagesSent: 1,
			duration: interaction.duration,
			success: interaction.success,
		});

		// Update target component stats
		await this.upsertComponentStat(db, interaction.targetId, this.getComponentType(interaction.targetComponent), {
			messagesReceived: 1,
			duration: interaction.duration,
			success: interaction.success,
		});
	}

	private async upsertComponentStat(
		db: any,
		componentId: string,
		componentType: ComponentStats['componentType'] | null,
		update: {
			messagesSent?: number;
			messagesReceived?: number;
			duration?: number;
			success: boolean;
		}
	): Promise<void> {
		if (!componentType) return;

		const existing = await db.select().from(schema.componentStats).where(eq(schema.componentStats.componentId, componentId)).limit(1);

		const now = new Date();

		if (existing.length === 0) {
			await db.insert(schema.componentStats).values({
				componentId,
				componentType,
				messagesSent: update.messagesSent || 0,
				messagesReceived: update.messagesReceived || 0,
				errors: update.success ? 0 : 1,
				averageProcessingTime: update.duration || 0,
				lastActivity: now,
				isAlive: true,
			});
		} else {
			const current = existing[0];
			const totalMessages = current.messagesSent + current.messagesReceived;
			const newAverageTime = update.duration
				? (current.averageProcessingTime * totalMessages + update.duration) / (totalMessages + 1)
				: current.averageProcessingTime;

			await db
				.update(schema.componentStats)
				.set({
					messagesSent: current.messagesSent + (update.messagesSent || 0),
					messagesReceived: current.messagesReceived + (update.messagesReceived || 0),
					errors: current.errors + (update.success ? 0 : 1),
					averageProcessingTime: newAverageTime,
					lastActivity: now,
					isAlive: true,
				})
				.where(eq(schema.componentStats.componentId, componentId));
		}
	}

	private getComponentType(component: ComponentInteraction['sourceComponent']): ComponentStats['componentType'] | null {
		switch (component) {
			case 'publisher':
				return 'publisher';
			case 'distributor':
				return 'distributor';
			case 'subscriber':
				return 'subscriber';
			default:
				return null;
		}
	}

	private async scheduleCleanupIfNeeded(): Promise<void> {
		const alarmTime = await this.ctx.storage.getAlarm();
		if (alarmTime === null) {
			const nextCleanup = Temporal.Now.instant().add({ milliseconds: DebugTrackerDurableObject.CLEANUP_INTERVAL });
			this.ctx.storage.setAlarm(nextCleanup.epochMilliseconds);
		}
	}

	async alarm(): Promise<void> {
		console.log('Running debug tracker cleanup');
		await this.cleanup();

		// Schedule next cleanup
		const nextCleanup = Temporal.Now.instant().add({ milliseconds: DebugTrackerDurableObject.CLEANUP_INTERVAL });
		this.ctx.storage.setAlarm(nextCleanup.epochMilliseconds);
	}

	private async cleanup(): Promise<void> {
		const db = await this.getDb();

		// Remove old interactions (keep only last 1000)
		const interactionCount = await db.select().from(schema.interactions);

		if (interactionCount.length > DebugTrackerDurableObject.MAX_INTERACTIONS) {
			const cutoffId = await db
				.select({ id: schema.interactions.id })
				.from(schema.interactions)
				.orderBy(desc(schema.interactions.timestamp))
				.limit(1)
				.offset(DebugTrackerDurableObject.MAX_INTERACTIONS);

			if (cutoffId.length > 0) {
				await db.delete(schema.interactions).where(lt(schema.interactions.id, cutoffId[0].id));
			}
		}

		// Mark components as inactive if no activity in last 5 minutes
		const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
		await db.update(schema.componentStats).set({ isAlive: false }).where(lt(schema.componentStats.lastActivity, fiveMinutesAgo));
	}
}
