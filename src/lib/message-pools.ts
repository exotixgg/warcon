import { MAX_CHAT } from './chat';

export const POOL_ACTIONS = ['join', 'round_start', 'round_end', 'ban', 'weapon', 'timer'] as const;
export type PoolAction = (typeof POOL_ACTIONS)[number];
export type PoolMode = 'ordered' | 'random';
export type BanSource = 'policy' | 'legacy' | 'automatic';
export type WeaponAction = 'whisper' | 'kick' | 'ban';

export interface WeaponThreshold {
	count: number;
	action: WeaponAction;
	days: number;
	scope: 'server' | 'org';
	/** Text for this step; older rules fall back to the pool's shared messages. */
	message?: string;
	/** Public messages chosen only after this step successfully adds a ban. */
	announcementMessages?: string[];
}

export interface MessagePool {
	id: string;
	name: string;
	action: PoolAction;
	enabled: boolean;
	mode: PoolMode;
	messages: string[];
	/** How many distinct messages to take for one event. */
	sendCount: number;
	initialDelaySeconds: number;
	spacingSeconds: number;
	allServers: boolean;
	serverIds: string[];
	/** Join pools only. */
	onlyFirstVisit: boolean;
	/** Ban pools only: a policy category id, or general for bans without a case. */
	categoryId: string;
	banSources: BanSource[];
	/** Weapon pools only: exact, case-insensitive kill-feed cause tags. */
	weaponTags: string[];
	teamKillsOnly: boolean;
	/** Count qualifying kills across the selected servers and all matches. */
	persistentCounts?: boolean;
	/** First receipt time counted by a persistent weapon rule; set by the server. */
	trackingSince?: string;
	thresholds: WeaponThreshold[];
	/** Timer pools only. */
	everyMinutes: number;
	minPlayers: number;
	maxPlayers: number | null;
}

export interface MessagePoolConfig {
	pools: MessagePool[];
}

/** The General pool covers ban categories without a specific pool, except pending reviews. */
export const DEFAULT_MESSAGE_POOLS: MessagePoolConfig = {
	pools: [
		{
			id: 'default-general-ban',
			name: 'General ban announcement',
			action: 'ban',
			enabled: true,
			mode: 'ordered',
			messages: ['{player_name} was banned from {server_name} ({ban_duration}).'],
			sendCount: 1,
			initialDelaySeconds: 0,
			spacingSeconds: 0,
			allServers: true,
			serverIds: [],
			onlyFirstVisit: false,
			categoryId: 'general',
			banSources: ['policy', 'legacy', 'automatic'],
			weaponTags: [],
			teamKillsOnly: false,
			thresholds: [],
			everyMinutes: 10,
			minPlayers: 1,
			maxPlayers: null
		}
	]
};

const BASE = ['server_name', 'map', 'players', 'max_players'];
export const POOL_VARIABLES: Record<PoolAction, readonly string[]> = {
	join: [
		...BASE,
		'player_name',
		'faction',
		'welcome_phrase',
		'server_visit_count',
		'exotix_visit_count',
		'server_connected_time',
		'exotix_connected_time'
	],
	round_start: [...BASE, 'winner', 'scores', 'previous_map', 'mvp', 'top'],
	round_end: [
		...BASE,
		'winner',
		'scores',
		'previous_map',
		'mvp',
		'top',
		'top_kills_name',
		'top_kills_count',
		'top_cash_name',
		'top_cash_gain',
		'best_kd_name',
		'best_kd_value'
	],
	ban: [...BASE, 'player_name', 'ban_category', 'ban_reason', 'ban_duration', 'ban_reference'],
	weapon: [...BASE, 'player_name', 'victim_name', 'weapon', 'weapon_type', 'count'],
	timer: BASE
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown, field: string, max: number): string => {
	if (typeof v !== 'string' || !v.trim() || v.trim().length > max)
		throw new Error(`${field} is required (1–${max} characters).`);
	return v.trim();
};
const whole = (v: unknown, field: string, min: number, max: number): number => {
	if (!Number.isInteger(v) || Number(v) < min || Number(v) > max)
		throw new Error(`${field} must be a whole number from ${min} to ${max}.`);
	return Number(v);
};
const bool = (v: unknown, field: string): boolean => {
	if (typeof v !== 'boolean') throw new Error(`${field} must be on or off.`);
	return v;
};
const distinct = (raw: unknown, field: string, maxItems: number, maxLength: number): string[] => {
	if (!Array.isArray(raw) || raw.length > maxItems)
		throw new Error(`${field} must contain at most ${maxItems} entries.`);
	const out = raw.map((v) => string(v, field, maxLength));
	if (new Set(out.map((v) => v.toLowerCase())).size !== out.length)
		throw new Error(`${field} contains duplicates.`);
	return out;
};

function validateTemplate(name: string, action: PoolAction, message: string): void {
	if (/[\r\n]/.test(message)) throw new Error(`${name}: each message must be one line.`);
	const tokens = [...message.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1].toLowerCase());
	if (
		/[{}]/.test(message.replace(/\{([^{}]+)\}/g, '')) ||
		tokens.some((key) => !POOL_VARIABLES[action].includes(key))
	)
		throw new Error(`${name}: use only the placeholders listed for ${action.replace('_', ' ')}.`);
}

export function validateMessagePools(raw: unknown): MessagePoolConfig {
	if (!isRecord(raw) || !Array.isArray(raw.pools) || raw.pools.length > 100)
		throw new Error('Provide at most 100 message pools.');
	const ids = new Set<string>();
	const pools: MessagePool[] = raw.pools.map((item): MessagePool => {
		if (!isRecord(item)) throw new Error('Invalid message pool.');
		const id = string(item.id, 'Pool ID', 60);
		if (!/^[a-zA-Z0-9-]+$/.test(id) || ids.has(id))
			throw new Error('Pool IDs must be unique letters, numbers or hyphens.');
		ids.add(id);
		const name = string(item.name, 'Pool name', 80);
		const action = item.action;
		if (!(POOL_ACTIONS as readonly unknown[]).includes(action))
			throw new Error('Unknown pool action.');
		const a = action as PoolAction;
		const mode = item.mode;
		if (mode !== 'ordered' && mode !== 'random') throw new Error('Choose ordered or random.');
		const maxMessage = a === 'weapon' ? 200 : MAX_CHAT;
		const messages = distinct(item.messages, 'Messages', 50, maxMessage);
		if (!messages.length) throw new Error(`${name}: add at least one message.`);
		for (const message of messages) validateTemplate(name, a, message);
		const sendCount = whole(item.sendCount, 'Messages per event', 1, 5);
		if (sendCount > messages.length)
			throw new Error(`${name}: messages per event exceeds pool size.`);
		const initialDelaySeconds = whole(item.initialDelaySeconds, 'Initial delay', 0, 300);
		const spacingSeconds = whole(item.spacingSeconds, 'Message spacing', 0, 300);
		const allServers = bool(item.allServers, 'All servers');
		const serverIds = distinct(item.serverIds, 'Server IDs', 100, 100);
		if (!allServers && !serverIds.length) throw new Error(`${name}: select at least one server.`);
		if (allServers && serverIds.length)
			throw new Error(`${name}: select all servers or named servers.`);
		const categoryId = typeof item.categoryId === 'string' ? item.categoryId.trim() : '';
		if (a === 'ban' && !/^[a-z][a-z0-9-]{0,39}$/.test(categoryId) && categoryId !== 'general')
			throw new Error(`${name}: choose a ban category or General.`);
		const banSources = distinct(
			item.banSources ?? ['policy', 'legacy', 'automatic'],
			'Ban sources',
			3,
			20
		) as BanSource[];
		if (a === 'ban' && !banSources.length)
			throw new Error(`${name}: choose at least one ban source.`);
		if (banSources.some((source) => !['policy', 'legacy', 'automatic'].includes(source)))
			throw new Error(`${name}: invalid ban source.`);
		const weaponTags = distinct(item.weaponTags ?? [], 'Weapon tags', 40, 200);
		if (a === 'weapon' && !weaponTags.length)
			throw new Error(`${name}: add at least one kill-feed weapon tag.`);
		if (weaponTags.some((tag) => !/^[A-Za-z0-9_.-]+$/.test(tag)))
			throw new Error(`${name}: weapon tags must match the kill feed exactly.`);
		const persistentCounts = bool(item.persistentCounts ?? false, 'Persistent weapon counts');
		const trackingSince = item.trackingSince;
		if (
			trackingSince !== undefined &&
			(typeof trackingSince !== 'string' ||
				!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(trackingSince) ||
				!Number.isFinite(Date.parse(trackingSince)))
		)
			throw new Error(`${name}: invalid persistent count start.`);
		const rawThresholds = item.thresholds ?? [];
		if (!Array.isArray(rawThresholds) || rawThresholds.length > 5)
			throw new Error(`${name}: use at most five thresholds.`);
		const thresholds: WeaponThreshold[] = rawThresholds.map((v) => {
			if (!isRecord(v) || !['whisper', 'kick', 'ban'].includes(String(v.action)))
				throw new Error(`${name}: choose whisper, kick or ban for each threshold.`);
			if (v.scope !== 'server' && v.scope !== 'org') throw new Error(`${name}: invalid ban scope.`);
			const message =
				v.message === undefined ? undefined : string(v.message, 'Threshold message', 200);
			if (message !== undefined) validateTemplate(name, 'weapon', message);
			const announcementMessages = distinct(
				v.announcementMessages ?? [],
				'Public ban announcements',
				50,
				MAX_CHAT
			);
			if (announcementMessages.length && v.action !== 'ban')
				throw new Error(`${name}: public ban announcements require a ban step.`);
			for (const announcement of announcementMessages)
				validateTemplate(name, 'weapon', announcement);
			return {
				count: whole(v.count, 'Kill threshold', 1, 100),
				action: v.action as WeaponAction,
				days: whole(v.days, 'Ban days', 0, 3650),
				scope: v.scope,
				...(message === undefined ? {} : { message }),
				...(announcementMessages.length ? { announcementMessages } : {})
			};
		});
		if (a === 'weapon' && !thresholds.length) throw new Error(`${name}: add a threshold.`);
		if (new Set(thresholds.map((t) => t.count)).size !== thresholds.length)
			throw new Error(`${name}: thresholds must have different kill counts.`);
		thresholds.sort((x, y) => x.count - y.count);
		const everyMinutes = whole(item.everyMinutes ?? 10, 'Timer interval', 1, 1440);
		const minPlayers = whole(item.minPlayers ?? 1, 'Minimum players', 0, 1000);
		const maxPlayers =
			item.maxPlayers == null ? null : whole(item.maxPlayers, 'Maximum players', 0, 1000);
		if (maxPlayers !== null && maxPlayers < minPlayers)
			throw new Error(`${name}: maximum players is below minimum.`);
		return {
			id,
			name,
			action: a,
			enabled: bool(item.enabled, 'Enabled'),
			mode,
			messages,
			sendCount,
			initialDelaySeconds,
			spacingSeconds,
			allServers,
			serverIds,
			onlyFirstVisit: bool(item.onlyFirstVisit ?? false, 'First visits only'),
			categoryId: a === 'ban' ? categoryId : '',
			banSources,
			weaponTags,
			teamKillsOnly: bool(item.teamKillsOnly ?? false, 'Team kills only'),
			...(a === 'weapon' && persistentCounts ? { persistentCounts: true } : {}),
			...(a === 'weapon' && persistentCounts && trackingSince ? { trackingSince } : {}),
			thresholds,
			everyMinutes,
			minPlayers,
			maxPlayers
		};
	});
	const all = new Set<string>();
	const specific = new Set<string>();
	for (const pool of pools) {
		if (!pool.enabled) continue;
		const key = `${pool.action}:${pool.action === 'ban' ? pool.categoryId : ''}`;
		if (pool.allServers) {
			if (all.has(key)) throw new Error(`Only one all-server pool may cover ${key}.`);
			all.add(key);
		} else
			for (const serverId of pool.serverIds) {
				const assignment = `${serverId}:${key}`;
				if (specific.has(assignment))
					throw new Error(`Only one pool may cover ${key} on one server.`);
				specific.add(assignment);
			}
	}
	return { pools };
}

/** Specific server choices replace an all-server pool of the same action/category. */
export function effectivePools(config: MessagePoolConfig, serverId: string): MessagePool[] {
	const on = config.pools.filter(
		(p) => p.enabled && (p.allServers || p.serverIds.includes(serverId))
	);
	const key = (p: MessagePool) => `${p.action}:${p.action === 'ban' ? p.categoryId : ''}`;
	const chosen = new Map<string, MessagePool>();
	for (const pool of on.filter((p) => p.allServers)) chosen.set(key(pool), pool);
	for (const pool of on.filter((p) => !p.allServers)) chosen.set(key(pool), pool);
	return [...chosen.values()];
}

export function chooseMessageIndexes(
	pool: Pick<MessagePool, 'messages' | 'mode' | 'sendCount'>,
	cursor: number,
	lastIndex: number,
	random = Math.random
): number[] {
	const length = pool.messages.length;
	if (!length) return [];
	if (pool.mode === 'ordered')
		return Array.from({ length: pool.sendCount }, (_, i) => (cursor + i) % length);
	const choices = Array.from({ length }, (_, i) => i);
	const result: number[] = [];
	for (let i = 0; i < pool.sendCount; i++) {
		const eligible = choices.filter((index) => i !== 0 || length === 1 || index !== lastIndex);
		const index = eligible[Math.floor(random() * eligible.length)];
		result.push(index);
		choices.splice(choices.indexOf(index), 1);
	}
	return result;
}

/** Never send a join or round template whose required value is unavailable. */
export function eligibleMessageIndexes(
	pool: Pick<MessagePool, 'action' | 'messages'>,
	values: Record<string, string | number>
): number[] {
	if (!['join', 'round_start', 'round_end'].includes(pool.action))
		return pool.messages.map((_, index) => index);
	return pool.messages.flatMap((message, index) => {
		const tokens = [...message.matchAll(/\{([a-z_]+)\}/gi)].map((match) => match[1].toLowerCase());
		return tokens.every((key) => values[key] !== undefined && String(values[key]).trim() !== '')
			? [index]
			: [];
	});
}

/** One-pass substitution: values containing braces are inserted literally. */
export function renderPoolMessage(
	template: string,
	values: Record<string, string | number>
): string {
	const lower = Object.fromEntries(
		Object.entries(values).map(([key, value]) => [
			key.toLowerCase(),
			String(value).replace(/[\x00-\x1f\x7f]/g, ' ')
		])
	);
	return template.replace(
		/\{([a-z_]+)\}/gi,
		(token, key: string) => lower[key.toLowerCase()] ?? token
	);
}
