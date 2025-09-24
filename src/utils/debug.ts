import type { ComponentInteraction } from '@/durable/DebugTracker';

export class DebugLogger {
	constructor(private env: Env) {}

	/**
	 * Track an interaction between components
	 */
	async trackInteraction(interaction: Omit<ComponentInteraction, 'id' | 'timestamp'>): Promise<void> {
		try {
			const debugTracker = this.getDebugTracker();
			const fullInteraction: ComponentInteraction = {
				id: crypto.randomUUID(),
				timestamp: new Date(),
				...interaction,
			};

			await debugTracker.trackInteraction(fullInteraction);
		} catch (error) {
			console.error('Failed to track debug interaction:', error);
			// Don't throw - debugging should not break the main flow
		}
	}

	/**
	 * Track a timed operation
	 */
	async trackTimedOperation<T>(
		operation: ComponentInteraction['operation'],
		sourceComponent: ComponentInteraction['sourceComponent'],
		sourceId: string,
		targetComponent: ComponentInteraction['targetComponent'],
		targetId: string,
		fn: () => Promise<T>,
		data?: any,
		metadata?: Record<string, any>
	): Promise<T> {
		const startTime = Date.now();
		let success = false;
		let error: string | undefined;
		let result: T;

		try {
			result = await fn();
			success = true;
			return result;
		} catch (err) {
			success = false;
			error = err instanceof Error ? err.message : String(err);
			throw err;
		} finally {
			const duration = Date.now() - startTime;
			
			await this.trackInteraction({
				sourceComponent,
				sourceId,
				targetComponent,
				targetId,
				operation,
				data,
				duration,
				success,
				error,
				metadata,
			});
		}
	}

	/**
	 * Track a simple interaction without timing
	 */
	async trackSimpleInteraction(
		operation: ComponentInteraction['operation'],
		sourceComponent: ComponentInteraction['sourceComponent'],
		sourceId: string,
		targetComponent: ComponentInteraction['targetComponent'],
		targetId: string,
		success: boolean,
		data?: any,
		error?: string,
		metadata?: Record<string, any>
	): Promise<void> {
		await this.trackInteraction({
			sourceComponent,
			sourceId,
			targetComponent,
			targetId,
			operation,
			data,
			success,
			error,
			metadata,
		});
	}

	private getDebugTracker() {
		const id = this.env.DURABLE_DEBUG_TRACKER.idFromName('global-debug-tracker');
		return this.env.DURABLE_DEBUG_TRACKER.get(id);
	}
}
