import { WhoopClient } from './whoop-client.js';
import { WhoopDatabase } from './database.js';

interface SyncStats {
	cycles: number;
	recoveries: number;
	sleeps: number;
	workouts: number;
	profile: boolean;
	body_measurement: boolean;
}

interface SmartSyncResult {
	type: 'full' | 'quick' | 'skip';
	stats?: SyncStats;
}

export class WhoopSync {
	private readonly client: WhoopClient;
	private readonly db: WhoopDatabase;

	constructor(client: WhoopClient, db: WhoopDatabase) {
		this.client = client;
		this.db = db;
	}

	async syncDays(days = 90): Promise<SyncStats> {
		const endDate = new Date();
		const startDate = new Date();
		startDate.setDate(startDate.getDate() - days);
		const start = startDate.toISOString();
		const end = endDate.toISOString();

		const [cycles, recoveries, sleeps, workouts, profileResult, measurementResult] = await Promise.allSettled([
			this.client.getAllCycles({ start, end }),
			this.client.getAllRecoveries({ start, end }),
			this.client.getAllSleeps({ start, end }),
			this.client.getAllWorkouts({ start, end }),
			this.client.getProfile(),
			this.client.getBodyMeasurement(),
		]);

		const cyclesData = cycles.status === 'fulfilled' ? cycles.value : [];
		const recoveriesData = recoveries.status === 'fulfilled' ? recoveries.value : [];
		const sleepsData = sleeps.status === 'fulfilled' ? sleeps.value : [];
		const workoutsData = workouts.status === 'fulfilled' ? workouts.value : [];

		if (cyclesData.length > 0) this.db.upsertCycles(cyclesData);
		if (recoveriesData.length > 0) this.db.upsertRecoveries(recoveriesData);
		if (sleepsData.length > 0) this.db.upsertSleeps(sleepsData);
		if (workoutsData.length > 0) this.db.upsertWorkouts(workoutsData);

		let profileSynced = false;
		if (profileResult.status === 'fulfilled') {
			this.db.upsertProfile(profileResult.value);
			profileSynced = true;
		}

		let measurementSynced = false;
		if (measurementResult.status === 'fulfilled') {
			this.db.upsertBodyMeasurement(measurementResult.value);
			measurementSynced = true;
		}

		this.db.updateSyncState(
			startDate.toISOString().split('T')[0],
			endDate.toISOString().split('T')[0]
		);

		return {
			cycles: cyclesData.length,
			recoveries: recoveriesData.length,
			sleeps: sleepsData.length,
			workouts: workoutsData.length,
			profile: profileSynced,
			body_measurement: measurementSynced,
		};
	}

	async quickSync(): Promise<SyncStats> {
		return this.syncDays(7);
	}

	needsFullSync(): boolean {
		const state = this.db.getSyncState();
		if (!state.lastSyncAt) return true;
		const lastSync = new Date(state.lastSyncAt);
		const hoursSinceSync = (Date.now() - lastSync.getTime()) / (1000 * 60 * 60);
		return hoursSinceSync > 24;
	}

	async smartSync(): Promise<SmartSyncResult> {
		const state = this.db.getSyncState();
		if (!state.lastSyncAt) {
			const stats = await this.syncDays(90);
			return { type: 'full', stats };
		}
		const lastSync = new Date(state.lastSyncAt);
		const hoursSinceSync = (Date.now() - lastSync.getTime()) / (1000 * 60 * 60);
		if (hoursSinceSync < 1) {
			return { type: 'skip' };
		}
		const stats = await this.quickSync();
		return { type: 'quick', stats };
	}
}
