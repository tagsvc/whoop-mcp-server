import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { WhoopClient } from './whoop-client.js';
import { WhoopDatabase } from './database.js';
import { WhoopSync } from './sync.js';

interface ToolArguments {
	days?: number;
	full?: boolean;
	id?: string | number;
	limit?: number;
}

const config = {
	clientId: process.env.WHOOP_CLIENT_ID ?? '',
	clientSecret: process.env.WHOOP_CLIENT_SECRET ?? '',
	redirectUri: process.env.WHOOP_REDIRECT_URI ?? 'http://localhost:3000/callback',
	dbPath: process.env.DB_PATH ?? './whoop.db',
	port: Number.parseInt(process.env.PORT ?? '3000', 10),
	mode: process.env.MCP_MODE ?? 'http',
};

const db = new WhoopDatabase(config.dbPath);
const client = new WhoopClient({
	clientId: config.clientId,
	clientSecret: config.clientSecret,
	redirectUri: config.redirectUri,
	onTokenRefresh: tokens => db.saveTokens(tokens),
});

const existingTokens = db.getTokens();
if (existingTokens) {
	client.setTokens(existingTokens);
}

const sync = new WhoopSync(client, db);

const SESSION_TTL_MS = 30 * 60 * 1000;
const transports = new Map<string, { transport: StreamableHTTPServerTransport; lastAccess: number }>();

function cleanupStaleSessions(): void {
	const now = Date.now();
	for (const [sessionId, session] of transports) {
		if (now - session.lastAccess > SESSION_TTL_MS) {
			session.transport.close().catch(() => {});
			transports.delete(sessionId);
		}
	}
}

setInterval(cleanupStaleSessions, 5 * 60 * 1000);

// Sport ID to name mapping. Whoop does not publish a complete list.
// Source: community-maintained from patloeber.com and observed workouts.
const SPORT_NAMES: Record<number, string> = {
	[-1]: 'Activity',
	0: 'Running',
	1: 'Cycling',
	16: 'Baseball',
	17: 'Basketball',
	18: 'Rowing',
	19: 'Fencing',
	20: 'Field Hockey',
	21: 'Football',
	22: 'Golf',
	24: 'Ice Hockey',
	25: 'Lacrosse',
	27: 'Rugby',
	28: 'Sailing',
	29: 'Skiing',
	30: 'Soccer',
	31: 'Softball',
	32: 'Squash',
	33: 'Swimming',
	34: 'Tennis',
	35: 'Track and Field',
	36: 'Volleyball',
	37: 'Water Polo',
	38: 'Wrestling',
	39: 'Boxing',
	42: 'Dance',
	43: 'Pilates',
	44: 'Yoga',
	45: 'Weightlifting',
	47: 'Cross Country Skiing',
	48: 'Functional Fitness',
	49: 'Duathlon',
	51: 'Gymnastics',
	52: 'Hiking',
	53: 'Horseback Riding',
	55: 'Kayaking',
	56: 'Martial Arts',
	57: 'Mountain Biking',
	59: 'Powerlifting',
	60: 'Rock Climbing',
	61: 'Paddleboarding',
	62: 'Triathlon',
	63: 'Walking',
	64: 'Surfing',
	65: 'Elliptical',
	66: 'Stairmaster',
	70: 'Meditation',
	71: 'Other',
	73: 'Diving',
	74: 'Operations - Tactical',
	75: 'Operations - Medical',
	76: 'Operations - Flying',
	77: 'Operations - Water',
	82: 'Ultimate',
	83: 'Climber',
	84: 'Jumping Rope',
	85: 'Australian Football',
	86: 'Skateboarding',
	87: 'Coaching',
	88: 'Ice Bath',
	89: 'Commuting',
	90: 'Gaming',
	91: 'Snowboarding',
	92: 'Motocross',
	93: 'Caddying',
	94: 'Obstacle Course Racing',
	95: 'Box Fitness',
	96: 'HIIT',
	97: 'Spin',
	98: 'Jiu Jitsu',
	99: 'Manual Labor',
	100: 'Cricket',
	101: 'Pickleball',
	102: 'Inline Skating',
	103: 'Box Lacrosse',
	104: 'Spikeball',
	105: 'Wheelchair Pushing',
	106: 'Paddle Tennis',
	107: 'Barre',
	108: 'Stage Performance',
	109: 'High Stress Work',
	110: 'Parkour',
	111: 'Gaelic Football',
	112: 'Hurling/Camogie',
	113: 'Circus Arts',
	121: 'Massage Therapy',
	123: 'Strength Trainer',
	125: 'Watching Sports',
	126: 'Assault Bike',
	127: 'Kickboxing',
	128: 'Stretching',
	230: 'Table Tennis',
	231: 'Badminton',
	232: 'Netball',
	233: 'Sauna',
	234: 'Disc Golf',
	235: 'Yard Work',
	236: 'Air Compression',
	237: 'Percussive Massage',
	238: 'Paintball',
	239: 'Ice Skating',
	240: 'Handball',
};

function sportName(id: number): string {
	return SPORT_NAMES[id] ?? `Sport ID ${id}`;
}

function formatDuration(millis: number | null): string {
	if (!millis) return 'N/A';
	const hours = Math.floor(millis / 3_600_000);
	const minutes = Math.floor((millis % 3_600_000) / 60_000);
	return `${hours}h ${minutes}m`;
}

function formatDate(isoString: string): string {
	return new Date(isoString).toLocaleDateString('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
	});
}

function formatDateTime(isoString: string): string {
	return new Date(isoString).toLocaleString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});
}

function metersToFeetInches(meters: number): string {
	const totalInches = meters * 39.3701;
	const feet = Math.floor(totalInches / 12);
	const inches = Math.round(totalInches % 12);
	return `${feet}' ${inches}"`;
}

function kilogramsToPounds(kg: number): number {
	return Math.round(kg * 2.20462 * 10) / 10;
}

function getRecoveryZone(score: number): string {
	if (score >= 67) return 'Green (Well Recovered)';
	if (score >= 34) return 'Yellow (Moderate)';
	return 'Red (Needs Rest)';
}

function getStrainZone(strain: number): string {
	if (strain >= 18) return 'All Out (18-21)';
	if (strain >= 14) return 'High (14-17)';
	if (strain >= 10) return 'Moderate (10-13)';
	return 'Light (0-9)';
}

function validateDays(value: unknown, defaultDays = 14): number {
	if (value === undefined || value === null) return defaultDays;
	const num = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
	if (Number.isNaN(num) || num < 1) return defaultDays;
	return Math.min(num, 90);
}

function validateBoolean(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	if (value === 'true') return true;
	return false;
}

function validateLimit(value: unknown, defaultLimit = 25): number {
	if (value === undefined || value === null) return defaultLimit;
	const num = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
	if (Number.isNaN(num) || num < 1) return defaultLimit;
	return Math.min(num, 100);
}

function workoutDurationMs(startTime: string, endTime: string): number {
	return new Date(endTime).getTime() - new Date(startTime).getTime();
}

function createMcpServer(): Server {
	const server = new Server(
		{ name: 'whoop-mcp-server', version: '2.0.0' },
		{ capabilities: { tools: {} } }
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: 'get_today',
				description: "Get today's Whoop data including recovery score, last night's sleep, and current strain.",
				inputSchema: { type: 'object', properties: {}, required: [] },
			},
			{
				name: 'get_recovery_trends',
				description: 'Get recovery score trends over time, including HRV and resting heart rate patterns.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_sleep_analysis',
				description: 'Get detailed sleep analysis including duration, stages, efficiency, and sleep debt.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_strain_history',
				description: 'Get training strain history and workout data.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_workouts',
				description: 'List workouts in a date range with sport, duration, strain, heart rate, calories, and zone breakdown.',
				inputSchema: {
					type: 'object',
					properties: {
						days: { type: 'number', description: 'Number of days to look back (default: 14, max: 90)' },
						limit: { type: 'number', description: 'Maximum number of workouts to return (default: 25, max: 100)' },
					},
					required: [],
				},
			},
			{
				name: 'get_workout_detail',
				description: 'Get a single workout by ID with full zone time, percent recorded, and full metric breakdown.',
				inputSchema: {
					type: 'object',
					properties: { id: { type: 'string', description: 'Workout UUID' } },
					required: ['id'],
				},
			},
			{
				name: 'get_cycle_detail',
				description: 'Get a single physiological cycle by ID with start, end, strain, heart rate, and calories.',
				inputSchema: {
					type: 'object',
					properties: { id: { type: 'number', description: 'Cycle ID' } },
					required: ['id'],
				},
			},
			{
				name: 'get_sleep_detail',
				description: 'Get a single sleep record by ID with onset, wake time, stage breakdown, disturbances, debt, and consistency.',
				inputSchema: {
					type: 'object',
					properties: { id: { type: 'string', description: 'Sleep UUID' } },
					required: ['id'],
				},
			},
			{
				name: 'get_profile',
				description: 'Get the authenticated user profile: name, email, and user ID.',
				inputSchema: { type: 'object', properties: {}, required: [] },
			},
			{
				name: 'get_body_measurement',
				description: 'Get body measurements: height, weight, and max heart rate baseline.',
				inputSchema: { type: 'object', properties: {}, required: [] },
			},
			{
				name: 'sync_data',
				description: 'Manually trigger a data sync from Whoop.',
				inputSchema: {
					type: 'object',
					properties: { full: { type: 'boolean', description: 'Force a full 90-day sync (default: false)' } },
					required: [],
				},
			},
			{
				name: 'get_auth_url',
				description: 'Get the Whoop authorization URL to connect your account.',
				inputSchema: { type: 'object', properties: {}, required: [] },
			},
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async request => {
		const { name, arguments: args } = request.params;
		const typedArgs = (args ?? {}) as ToolArguments;

		try {
			const dataTools = [
				'get_today', 'get_recovery_trends', 'get_sleep_analysis', 'get_strain_history',
				'get_workouts', 'get_workout_detail', 'get_cycle_detail', 'get_sleep_detail',
				'get_profile', 'get_body_measurement',
			];
			if (dataTools.includes(name)) {
				const tokens = db.getTokens();
				if (!tokens) {
					return { content: [{ type: 'text', text: 'Not authenticated with Whoop. Use get_auth_url to authorize first.' }] };
				}
				client.setTokens(tokens);
				try {
					await sync.smartSync();
				} catch {
					// Continue with cached data
				}
			}

			switch (name) {
				case 'get_today': {
					const recovery = db.getLatestRecovery();
					const sleep = db.getLatestSleep();
					const cycle = db.getLatestCycle();

					if (!recovery && !sleep && !cycle) {
						return { content: [{ type: 'text', text: 'No data available. Try running sync_data first.' }] };
					}

					let response = "# Today's Whoop Summary\n\n";

					if (recovery) {
						response += `## Recovery: ${recovery.recovery_score ?? 'N/A'}% ${recovery.recovery_score ? getRecoveryZone(recovery.recovery_score) : ''}\n`;
						response += `- **HRV**: ${recovery.hrv_rmssd?.toFixed(1) ?? 'N/A'} ms\n`;
						response += `- **Resting HR**: ${recovery.resting_hr ?? 'N/A'} bpm\n`;
						if (recovery.spo2) response += `- **SpO2**: ${recovery.spo2.toFixed(1)}%\n`;
						if (recovery.skin_temp) response += `- **Skin Temp**: ${recovery.skin_temp.toFixed(1)}°C\n`;
						if (recovery.user_calibrating === 1) response += `- **Status**: User calibrating (baseline not yet established)\n`;
						response += '\n';
					}

					if (sleep) {
						const totalSleep = (sleep.total_in_bed_milli ?? 0) - (sleep.total_awake_milli ?? 0);
						response += `## Last Night's Sleep\n`;
						response += `- **Total Sleep**: ${formatDuration(totalSleep)}\n`;
						response += `- **Performance**: ${sleep.sleep_performance?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Efficiency**: ${sleep.sleep_efficiency?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Stages**: Light ${formatDuration(sleep.total_light_milli)}, Deep ${formatDuration(sleep.total_deep_milli)}, REM ${formatDuration(sleep.total_rem_milli)}\n`;
						if (sleep.disturbance_count !== null) response += `- **Disturbances**: ${sleep.disturbance_count}\n`;
						if (sleep.sleep_cycle_count !== null) response += `- **Sleep Cycles**: ${sleep.sleep_cycle_count}\n`;
						if (sleep.respiratory_rate) response += `- **Respiratory Rate**: ${sleep.respiratory_rate.toFixed(1)} breaths/min\n`;
						response += '\n';
					}

					if (cycle) {
						response += `## Current Strain\n`;
						response += `- **Day Strain**: ${cycle.strain?.toFixed(1) ?? 'N/A'} ${cycle.strain ? getStrainZone(cycle.strain) : ''}\n`;
						if (cycle.kilojoule) response += `- **Calories**: ${Math.round(cycle.kilojoule / 4.184).toLocaleString()} kcal\n`;
						if (cycle.avg_hr) response += `- **Avg HR**: ${cycle.avg_hr} bpm\n`;
						if (cycle.max_hr) response += `- **Max HR**: ${cycle.max_hr} bpm\n`;
					}

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_recovery_trends': {
					const days = validateDays(typedArgs.days);
					const trends = db.getRecoveryTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No recovery data available for the requested period.' }] };
					}

					let response = `# Recovery Trends (Last ${days} Days)\n\n`;
					response += '| Date | Recovery | HRV | RHR |\n|------|----------|-----|-----|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.recovery_score}% | ${day.hrv?.toFixed(1) ?? 'N/A'} ms | ${day.rhr ?? 'N/A'} bpm |\n`;
					}

					const avgRecovery = trends.reduce((sum, d) => sum + (d.recovery_score || 0), 0) / trends.length;
					const avgHrv = trends.reduce((sum, d) => sum + (d.hrv || 0), 0) / trends.length;
					const avgRhr = trends.reduce((sum, d) => sum + (d.rhr || 0), 0) / trends.length;

					response += `\n## Averages\n- **Recovery**: ${avgRecovery.toFixed(0)}%\n- **HRV**: ${avgHrv.toFixed(1)} ms\n- **RHR**: ${avgRhr.toFixed(0)} bpm\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_sleep_analysis': {
					const days = validateDays(typedArgs.days);
					const trends = db.getSleepTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No sleep data available for the requested period.' }] };
					}

					let response = `# Sleep Analysis (Last ${days} Days)\n\n`;
					response += '| Date | Duration | Performance | Efficiency |\n|------|----------|-------------|------------|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.total_sleep_hours?.toFixed(1) ?? 'N/A'}h | ${day.performance?.toFixed(0) ?? 'N/A'}% | ${day.efficiency?.toFixed(0) ?? 'N/A'}% |\n`;
					}

					const avgDuration = trends.reduce((sum, d) => sum + (d.total_sleep_hours || 0), 0) / trends.length;
					const avgPerf = trends.reduce((sum, d) => sum + (d.performance || 0), 0) / trends.length;
					const avgEff = trends.reduce((sum, d) => sum + (d.efficiency || 0), 0) / trends.length;

					response += `\n## Averages\n- **Duration**: ${avgDuration.toFixed(1)} hours\n- **Performance**: ${avgPerf.toFixed(0)}%\n- **Efficiency**: ${avgEff.toFixed(0)}%\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_strain_history': {
					const days = validateDays(typedArgs.days);
					const trends = db.getStrainTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No strain data available for the requested period.' }] };
					}

					let response = `# Strain History (Last ${days} Days)\n\n`;
					response += '| Date | Strain | Calories |\n|------|--------|----------|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.strain?.toFixed(1) ?? 'N/A'} | ${day.calories?.toLocaleString() ?? 'N/A'} kcal |\n`;
					}

					const avgStrain = trends.reduce((sum, d) => sum + (d.strain || 0), 0) / trends.length;
					const avgCalories = trends.reduce((sum, d) => sum + (d.calories || 0), 0) / trends.length;

					response += `\n## Averages\n- **Daily Strain**: ${avgStrain.toFixed(1)}\n- **Daily Calories**: ${Math.round(avgCalories).toLocaleString()} kcal\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_workouts': {
					const days = validateDays(typedArgs.days);
					const limit = validateLimit(typedArgs.limit);
					const workouts = db.getRecentWorkouts(days, limit);

					if (workouts.length === 0) {
						return { content: [{ type: 'text', text: `No workouts in the last ${days} days.` }] };
					}

					let response = `# Workouts (Last ${days} Days, showing ${workouts.length})\n\n`;
					response += '| Date | Sport | Duration | Strain | Avg HR | Max HR | Calories |\n|------|-------|----------|--------|--------|--------|----------|\n';

					for (const w of workouts) {
						const duration = formatDuration(workoutDurationMs(w.start_time, w.end_time));
						const calories = w.kilojoule ? Math.round(w.kilojoule / 4.184).toLocaleString() : 'N/A';
						response += `| ${formatDate(w.start_time)} | ${sportName(w.sport_id)} | ${duration} | ${w.strain?.toFixed(1) ?? 'N/A'} | ${w.avg_hr ?? 'N/A'} | ${w.max_hr ?? 'N/A'} | ${calories} kcal |\n`;
					}

					const sportCounts: Record<string, number> = {};
					for (const w of workouts) {
						const sport = sportName(w.sport_id);
						sportCounts[sport] = (sportCounts[sport] ?? 0) + 1;
					}
					const topSports = Object.entries(sportCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

					response += `\n## Top Activities\n`;
					for (const [sport, count] of topSports) {
						response += `- ${sport}: ${count}\n`;
					}

					const totalStrain = workouts.reduce((sum, w) => sum + (w.strain || 0), 0);
					const totalCalories = workouts.reduce((sum, w) => sum + (w.kilojoule ? w.kilojoule / 4.184 : 0), 0);
					const totalDurationMs = workouts.reduce((sum, w) => sum + workoutDurationMs(w.start_time, w.end_time), 0);

					response += `\n## Totals\n`;
					response += `- **Workouts**: ${workouts.length}\n`;
					response += `- **Total Duration**: ${formatDuration(totalDurationMs)}\n`;
					response += `- **Total Strain**: ${totalStrain.toFixed(1)}\n`;
					response += `- **Total Calories**: ${Math.round(totalCalories).toLocaleString()} kcal\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_workout_detail': {
					const id = String(typedArgs.id ?? '');
					if (!id) {
						return { content: [{ type: 'text', text: 'Workout ID is required.' }] };
					}
					const w = db.getWorkoutById(id);
					if (!w) {
						return { content: [{ type: 'text', text: `Workout ${id} not found in local database. Try running sync_data.` }] };
					}

					const duration = workoutDurationMs(w.start_time, w.end_time);
					const calories = w.kilojoule ? Math.round(w.kilojoule / 4.184) : null;

					let response = `# Workout Detail: ${sportName(w.sport_id)}\n\n`;
					response += `- **Start**: ${formatDateTime(w.start_time)}\n`;
					response += `- **End**: ${formatDateTime(w.end_time)}\n`;
					response += `- **Duration**: ${formatDuration(duration)}\n`;
					response += `- **Strain**: ${w.strain?.toFixed(1) ?? 'N/A'} ${w.strain ? getStrainZone(w.strain) : ''}\n`;
					response += `- **Avg HR**: ${w.avg_hr ?? 'N/A'} bpm\n`;
					response += `- **Max HR**: ${w.max_hr ?? 'N/A'} bpm\n`;
					if (calories) response += `- **Calories**: ${calories.toLocaleString()} kcal\n`;
					if (w.percent_recorded !== null) response += `- **Data Coverage**: ${w.percent_recorded.toFixed(0)}%\n`;
					response += `- **Score State**: ${w.score_state}\n\n`;

					response += `## Heart Rate Zones\n`;
					response += `| Zone | Range | Time |\n|------|-------|------|\n`;
					response += `| 0 | Recovery (<50%) | ${formatDuration(w.zone_zero_milli)} |\n`;
					response += `| 1 | Easy (50-60%) | ${formatDuration(w.zone_one_milli)} |\n`;
					response += `| 2 | Moderate (60-70%) | ${formatDuration(w.zone_two_milli)} |\n`;
					response += `| 3 | Hard (70-80%) | ${formatDuration(w.zone_three_milli)} |\n`;
					response += `| 4 | Very Hard (80-90%) | ${formatDuration(w.zone_four_milli)} |\n`;
					response += `| 5 | Max (>90%) | ${formatDuration(w.zone_five_milli)} |\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_cycle_detail': {
					const id = Number(typedArgs.id);
					if (!id || Number.isNaN(id)) {
						return { content: [{ type: 'text', text: 'Cycle ID (number) is required.' }] };
					}
					const c = db.getCycleById(id);
					if (!c) {
						return { content: [{ type: 'text', text: `Cycle ${id} not found in local database. Try running sync_data.` }] };
					}

					let response = `# Cycle Detail: ${id}\n\n`;
					response += `- **Start**: ${formatDateTime(c.start_time)}\n`;
					response += `- **End**: ${c.end_time ? formatDateTime(c.end_time) : 'In Progress'}\n`;
					response += `- **Day Strain**: ${c.strain?.toFixed(1) ?? 'N/A'} ${c.strain ? getStrainZone(c.strain) : ''}\n`;
					if (c.kilojoule) response += `- **Calories**: ${Math.round(c.kilojoule / 4.184).toLocaleString()} kcal\n`;
					response += `- **Avg HR**: ${c.avg_hr ?? 'N/A'} bpm\n`;
					response += `- **Max HR**: ${c.max_hr ?? 'N/A'} bpm\n`;
					response += `- **Score State**: ${c.score_state}\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_sleep_detail': {
					const id = String(typedArgs.id ?? '');
					if (!id) {
						return { content: [{ type: 'text', text: 'Sleep ID is required.' }] };
					}
					const s = db.getSleepById(id);
					if (!s) {
						return { content: [{ type: 'text', text: `Sleep ${id} not found in local database. Try running sync_data.` }] };
					}

					const totalSleep = (s.total_in_bed_milli ?? 0) - (s.total_awake_milli ?? 0);

					let response = `# Sleep Detail${s.is_nap ? ' (Nap)' : ''}\n\n`;
					response += `## Timing\n`;
					response += `- **Sleep Onset**: ${formatDateTime(s.start_time)}\n`;
					response += `- **Wake Time**: ${formatDateTime(s.end_time)}\n`;
					response += `- **Time in Bed**: ${formatDuration(s.total_in_bed_milli)}\n`;
					response += `- **Time Asleep**: ${formatDuration(totalSleep)}\n`;
					response += `- **Time Awake**: ${formatDuration(s.total_awake_milli)}\n`;
					if (s.total_no_data_milli) response += `- **No Data**: ${formatDuration(s.total_no_data_milli)}\n`;
					response += `\n`;

					response += `## Stages\n`;
					response += `- **Light**: ${formatDuration(s.total_light_milli)}\n`;
					response += `- **Deep (Slow Wave)**: ${formatDuration(s.total_deep_milli)}\n`;
					response += `- **REM**: ${formatDuration(s.total_rem_milli)}\n`;
					if (s.sleep_cycle_count !== null) response += `- **Sleep Cycles**: ${s.sleep_cycle_count}\n`;
					if (s.disturbance_count !== null) response += `- **Disturbances**: ${s.disturbance_count}\n`;
					response += `\n`;

					response += `## Scores\n`;
					response += `- **Performance**: ${s.sleep_performance?.toFixed(0) ?? 'N/A'}%\n`;
					response += `- **Efficiency**: ${s.sleep_efficiency?.toFixed(0) ?? 'N/A'}%\n`;
					response += `- **Consistency**: ${s.sleep_consistency?.toFixed(0) ?? 'N/A'}%\n`;
					if (s.respiratory_rate) response += `- **Respiratory Rate**: ${s.respiratory_rate.toFixed(1)} breaths/min\n`;
					response += `\n`;

					if (s.sleep_needed_baseline_milli !== null) {
						const baseline = s.sleep_needed_baseline_milli ?? 0;
						const debt = s.sleep_needed_debt_milli ?? 0;
						const strain = s.sleep_needed_strain_milli ?? 0;
						const nap = s.sleep_needed_nap_milli ?? 0;
						const totalNeeded = baseline + debt + strain - nap;

						response += `## Sleep Need\n`;
						response += `- **Baseline**: ${formatDuration(baseline)}\n`;
						response += `- **Debt**: ${formatDuration(debt)}\n`;
						response += `- **Strain-driven**: ${formatDuration(strain)}\n`;
						if (nap) response += `- **Nap credit**: -${formatDuration(nap)}\n`;
						response += `- **Total Needed**: ${formatDuration(totalNeeded)}\n`;
					}

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_profile': {
					const profile = db.getProfile();
					if (!profile) {
						return { content: [{ type: 'text', text: 'Profile not available. Try running sync_data.' }] };
					}

					let response = `# Profile\n\n`;
					response += `- **Name**: ${profile.first_name} ${profile.last_name}\n`;
					response += `- **Email**: ${profile.email}\n`;
					response += `- **User ID**: ${profile.user_id}\n`;
					response += `- **Last Synced**: ${profile.synced_at}\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_body_measurement': {
					const measurement = db.getBodyMeasurement();
					if (!measurement) {
						return { content: [{ type: 'text', text: 'Body measurement not available. Try running sync_data.' }] };
					}

					let response = `# Body Measurement\n\n`;
					response += `- **Height**: ${metersToFeetInches(measurement.height_meter)} (${measurement.height_meter.toFixed(2)} m)\n`;
					response += `- **Weight**: ${kilogramsToPounds(measurement.weight_kilogram).toFixed(1)} lb (${measurement.weight_kilogram.toFixed(1)} kg)\n`;
					response += `- **Max Heart Rate**: ${measurement.max_heart_rate} bpm\n`;
					response += `- **Last Synced**: ${measurement.synced_at}\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'sync_data': {
					const tokens = db.getTokens();
					if (!tokens) {
						return { content: [{ type: 'text', text: 'Not authenticated with Whoop. Use get_auth_url to authorize first.' }] };
					}
					client.setTokens(tokens);

					const full = validateBoolean(typedArgs.full);
					let stats;

					if (full) {
						stats = await sync.syncDays(90);
					} else {
						const result = await sync.smartSync();
						if (result.type === 'skip') {
							return { content: [{ type: 'text', text: 'Data is already up to date (synced within the last hour).' }] };
						}
						stats = result.stats;
					}

					return {
						content: [{
							type: 'text',
							text: `Sync complete!\n- Cycles: ${stats?.cycles ?? 0}\n- Recoveries: ${stats?.recoveries ?? 0}\n- Sleeps: ${stats?.sleeps ?? 0}\n- Workouts: ${stats?.workouts ?? 0}\n- Profile: ${stats?.profile ? 'synced' : 'failed'}\n- Body Measurement: ${stats?.body_measurement ? 'synced' : 'failed'}`,
						}],
					};
				}

				case 'get_auth_url': {
					const scopes = ['read:profile', 'read:body_measurement', 'read:cycles', 'read:recovery', 'read:sleep', 'read:workout', 'offline'];
					const url = client.getAuthorizationUrl(scopes);
					return {
						content: [{
							type: 'text',
							text: `To authorize with Whoop:\n\n1. Visit: ${url}\n2. Log in and authorize\n3. You'll be redirected back automatically\n\nRedirect URI: ${config.redirectUri}`,
						}],
					};
				}

				default:
					throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
		}
	});

	return server;
}

async function main(): Promise<void> {
	if (config.mode === 'stdio') {
		const server = createMcpServer();
		const transport = new StdioServerTransport();
		await server.connect(transport);
		process.stderr.write('Whoop MCP server running on stdio\n');
	} else {
		const app = express();
		app.use((req, res, next) => {
			if (req.path === '/mcp') return next();
			express.json()(req, res, next);
		});

		app.get('/callback', async (req: Request, res: Response) => {
			const code = req.query.code as string | undefined;
			if (!code) {
				res.status(400).send('Missing authorization code');
				return;
			}

			try {
				const tokens = await client.exchangeCodeForTokens(code);
				db.saveTokens(tokens);
				sync.syncDays(90).catch(() => {});
				res.send('Authorization successful! You can close this window.');
			} catch {
				res.status(500).send('Authorization failed. Please try again.');
			}
		});

		app.get('/health', (_req: Request, res: Response) => {
			res.json({ status: 'ok', authenticated: Boolean(db.getTokens()) });
		});

		app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
			res.status(200).json({});
		});

		app.get('/.well-known/oauth-protected-resource/mcp', (_req: Request, res: Response) => {
			res.status(200).json({});
		});

		app.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
			res.status(200).json({});
		});

		app.post('/register', (_req: Request, res: Response) => {
			res.status(200).json({});
		});

		app.all('/mcp', async (req: Request, res: Response) => {
			const sessionId = req.headers['mcp-session-id'] as string | undefined;

			if (req.method === 'DELETE' && sessionId && transports.has(sessionId)) {
				const session = transports.get(sessionId)!;
				await session.transport.close();
				transports.delete(sessionId);
				res.status(200).send('Session closed');
				return;
			}

			if (req.method === 'GET') {
				res.status(200).json({ name: 'whoop-mcp-server', version: '2.0.0' });
				return;
			}

			if (req.method === 'POST') {
				let transport: StreamableHTTPServerTransport;

				if (sessionId && transports.has(sessionId)) {
					const session = transports.get(sessionId)!;
					session.lastAccess = Date.now();
					transport = session.transport;
				} else {
					const newSessionId = randomUUID();
					transport = new StreamableHTTPServerTransport({
						sessionIdGenerator: () => newSessionId,
						onsessioninitialized: (id) => {
							transports.set(id, { transport, lastAccess: Date.now() });
						},
					});

					const server = createMcpServer();
					await server.connect(transport);
					transports.set(newSessionId, { transport, lastAccess: Date.now() });
				}

				await transport.handleRequest(req, res);
				return;
			}

			res.status(405).send('Method not allowed');
		});

		app.get('/sse', (_req: Request, res: Response) => {
			res.status(410).send('SSE endpoint deprecated. Use /mcp with Streamable HTTP transport.');
		});

		const server = app.listen(config.port, '0.0.0.0', () => {
			process.stdout.write(`Whoop MCP server running on http://0.0.0.0:${config.port}\n`);
		});

		const shutdown = (): void => {
			process.stdout.write('\nShutting down...\n');
			for (const [, session] of transports) {
				session.transport.close().catch(() => {});
			}
			transports.clear();
			db.close();
			server.close(() => process.exit(0));
		};

		process.on('SIGTERM', shutdown);
		process.on('SIGINT', shutdown);
	}
}

main().catch(error => {
	process.stderr.write(`Fatal error: ${error}\n`);
	process.exit(1);
});
