import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import type { DbOrTx } from '../db';
import { kills, outbox, playerSessions, servers, type ListRow, type ServerRow } from '../db/schema';
import { ApiError } from '../http';
import { MAX_CHAT } from '$lib/chat';
import { VEHICLE_TAGS } from '$lib/kills';
import {
	chooseMessageIndexes,
	eligibleMessageIndexes,
	effectivePools,
	DEFAULT_MESSAGE_POOLS,
	renderPoolMessage,
	validateMessagePools,
	type BanSource,
	type MessagePool,
	type MessagePoolConfig,
	type WeaponThreshold
} from '$lib/message-pools';
import { matchVars, type MatchEnd, type MatchLineVars } from '../trigger-rules';
import { PANEL_BAN } from '../rule-ban';
import { policyOf } from './ban-policy';
import type { KillView, Player, Status } from '$lib/types';

export interface PoolConfigView extends MessagePoolConfig {
	version: string;
}

export async function poolConfigOf(db: DbOrTx, orgId: string): Promise<PoolConfigView> {
	const [row] = await db.execute<{ config: unknown; version: string }>(sql`
		SELECT config, updated_at::text AS version FROM exotix.message_pool_configs WHERE org_id = ${orgId}`);
	return row
		? { ...validateMessagePools(row.config), version: row.version }
		: { ...DEFAULT_MESSAGE_POOLS, version: 'default' };
}

export async function savePoolConfig(
	db: DbOrTx,
	orgId: string,
	raw: unknown,
	version: unknown
): Promise<PoolConfigView> {
	await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${orgId}, 179089))`);
	const current = await poolConfigOf(db, orgId);
	if (current.version !== version)
		throw new ApiError(409, 'Message pools changed. Reload before saving.');
	let config: MessagePoolConfig;
	try {
		config = validateMessagePools(raw);
	} catch (err) {
		throw new ApiError(400, (err as Error).message);
	}
	const rows = await db.execute<{ id: string }>(
		sql`SELECT id FROM public.servers WHERE org_id = ${orgId}`
	);
	const allowed = new Set(rows.map((row) => row.id));
	for (const pool of config.pools)
		if (pool.serverIds.some((id) => !allowed.has(id)))
			throw new ApiError(400, `${pool.name}: a selected server is not in this organisation.`);
	const policy = await policyOf(db, orgId);
	const categoryIds = new Set(policy.categories.map((category) => category.id));
	for (const pool of config.pools)
		if (pool.action === 'ban' && pool.categoryId !== 'general' && !categoryIds.has(pool.categoryId))
			throw new ApiError(400, `${pool.name}: the ban category no longer exists.`);
	await db.execute(sql`
		INSERT INTO exotix.message_pool_configs (org_id, config)
		VALUES (${orgId}, ${JSON.stringify(config)}::text::jsonb)
		ON CONFLICT (org_id) DO UPDATE SET config = excluded.config, updated_at = clock_timestamp()`);
	return poolConfigOf(db, orgId);
}

const fingerprint = (pool: MessagePool): string =>
	createHash('sha256').update(JSON.stringify(pool)).digest('hex');
const valuesFor = (server: { name: string }, status?: Status | null) => ({
	server_name: status?.serverName || server.name,
	map: status?.map || '',
	players: status?.playerCount ?? 0,
	max_players: status?.maxPlayers ?? 0
});

type PoolDelivery = {
	eventKey: string;
	values: Record<string, string | number>;
	steamId?: string;
	action?: 'whisper' | 'kick' | 'ban';
	threshold?: WeaponThreshold;
	/** The event occurred at this time; timer sends use the worker's current time. */
	at?: Date;
};

/** Select and queue in one transaction so retries cannot advance a pool twice. */
export async function queuePoolEvent(
	db: DbOrTx,
	orgId: string,
	serverId: string,
	pool: MessagePool,
	event: PoolDelivery
): Promise<number> {
	const lock = `message-pool:${orgId}:${serverId}:${pool.id}`;
	await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lock}))`);
	const firstKey = `pool:${serverId}:${pool.id}:${event.eventKey}:0`;
	const existing = await db.execute<{ id: number }>(sql`
		SELECT id FROM public.outbox WHERE dedupe_key = ${firstKey} LIMIT 1`);
	if (existing.length) return 0;
	const [state] = await db.execute<{
		cursor: number;
		last_index: number;
		last_at: Date | null;
	}>(sql`
		SELECT cursor, last_index, last_at FROM exotix.message_pool_state
		 WHERE org_id = ${orgId} AND server_id = ${serverId} AND pool_id = ${pool.id}`);
	const cursor = Number(state?.cursor ?? 0);
	const lastIndex = Number(state?.last_index ?? -1);
	const messageSource =
		pool.action === 'weapon' && event.threshold?.message
			? { ...pool, messages: [event.threshold.message], sendCount: 1 }
			: pool;
	const eligible = eligibleMessageIndexes(messageSource, event.values);
	if (!eligible.length) return 0;
	const eligiblePool = {
		...messageSource,
		messages: eligible.map((index) => messageSource.messages[index]),
		sendCount: Math.min(
			pool.action === 'weapon' && event.action !== 'whisper' ? 1 : messageSource.sendCount,
			eligible.length
		)
	};
	const indexes = chooseMessageIndexes(eligiblePool, cursor, eligible.indexOf(lastIndex)).map(
		(index) => eligible[index]
	);
	const now = event.at ?? new Date();
	const rows = indexes.map((index, position) => {
		const action =
			event.action === 'ban'
				? PANEL_BAN
				: (event.action ?? (pool.action === 'join' ? 'whisper' : 'broadcast'));
		const cap = action === PANEL_BAN || action === 'kick' ? 200 : MAX_CHAT;
		const message = renderPoolMessage(messageSource.messages[index], event.values).slice(0, cap);
		const due = new Date(
			now.getTime() + (pool.initialDelaySeconds + position * pool.spacingSeconds) * 1000
		);
		const params: Record<string, unknown> =
			action === PANEL_BAN
				? {
						steamId: event.steamId,
						reason: message,
						days: event.threshold?.days ?? 0,
						scope: event.threshold?.scope ?? 'server'
					}
				: action === 'kick'
					? { steamId: event.steamId, reason: message }
					: action === 'whisper'
						? { steamId: event.steamId, message }
						: { message };
		params.poolId = pool.id;
		params.poolKey = fingerprint(pool);
		return {
			serverId,
			triggerId: null,
			triggerName: pool.name,
			triggerKind: 'message_pool',
			action,
			params,
			target: event.steamId ?? message.slice(0, 300),
			detail: { poolId: pool.id, poolAction: pool.action, eventKey: event.eventKey, index },
			steamId: action === 'whisper' || action === 'kick' ? (event.steamId ?? null) : null,
			okMessage: `${pool.name}: ${action} delivered.`,
			dedupeKey: `pool:${serverId}:${pool.id}:${event.eventKey}:${position}`,
			notBefore: due
		};
	});
	const inserted = await db
		.insert(outbox)
		.values(rows)
		.onConflictDoNothing({ target: outbox.dedupeKey })
		.returning({ id: outbox.id });
	if (inserted.length) {
		await db.execute(sql`
			INSERT INTO exotix.message_pool_state (org_id, server_id, pool_id, cursor, last_index, last_at)
			VALUES (${orgId}, ${serverId}, ${pool.id}, ${cursor + indexes.length}, ${indexes.at(-1) ?? -1}, ${now})
			ON CONFLICT (org_id, server_id, pool_id) DO UPDATE
			SET cursor = excluded.cursor, last_index = excluded.last_index, last_at = excluded.last_at`);
	}
	return inserted.length;
}

const connectedTime = (seconds: number): string => {
	const minutes = Math.max(0, Math.floor(seconds / 60));
	const hours = Math.floor(minutes / 60);
	return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
};

async function joinHistory(
	db: DbOrTx,
	orgId: string,
	serverId: string,
	joined: Player[],
	at: Date
): Promise<Map<string, Record<string, string | number>>> {
	if (!joined.length) return new Map();
	const ids = [...new Set(joined.map((player) => player.steamId))];
	const rows = await db.execute<{
		steam_id: string;
		server_visits: string;
		exotix_visits: string;
		server_seconds: string;
		exotix_seconds: string;
	}>(sql`
		SELECT ps.steam_id,
		       COUNT(*) FILTER (WHERE ps.server_id = ${serverId})::text AS server_visits,
		       COUNT(*)::text AS exotix_visits,
		       COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM
		         (LEAST(COALESCE(ps.left_at, ps.last_seen), ${at}) - ps.joined_at))))
		         FILTER (WHERE ps.server_id = ${serverId}), 0)::text AS server_seconds,
		       COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM
		         (LEAST(COALESCE(ps.left_at, ps.last_seen), ${at}) - ps.joined_at)))), 0)::text AS exotix_seconds
		  FROM public.player_sessions ps
		  JOIN public.servers s ON s.id = ps.server_id
		 WHERE s.org_id = ${orgId} AND ps.steam_id IN (${sql.join(
				ids.map((id) => sql`${id}`),
				sql`, `
			)})
		   AND ps.joined_at <= ${at}
		 GROUP BY ps.steam_id`);
	return new Map(
		rows.map((row) => [
			row.steam_id,
			{
				welcome_phrase: Number(row.exotix_visits) > 1 ? 'Welcome back' : 'Welcome',
				server_visit_count: Number(row.server_visits),
				exotix_visit_count: Number(row.exotix_visits),
				server_connected_time: connectedTime(Number(row.server_seconds)),
				exotix_connected_time: connectedTime(Number(row.exotix_seconds))
			}
		])
	);
}

function roundAwards(lines: MatchLineVars[]): Record<string, string | number> {
	const byKills = [...lines]
		.filter((line) => line.kills > 0)
		.sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name))[0];
	const byCash = [...lines]
		.filter((line) => (line.cashDelta ?? 0) > 0)
		.sort((a, b) => (b.cashDelta ?? 0) - (a.cashDelta ?? 0) || a.name.localeCompare(b.name))[0];
	const byKd = [...lines]
		.filter((line) => line.kills >= 10 && line.deaths !== undefined)
		.sort(
			(a, b) =>
				b.kills / Math.max(1, b.deaths ?? 0) - a.kills / Math.max(1, a.deaths ?? 0) ||
				a.name.localeCompare(b.name)
		)[0];
	return {
		top_kills_name: byKills?.name ?? '',
		top_kills_count: byKills?.kills ?? '',
		top_cash_name: byCash?.name ?? '',
		top_cash_gain: byCash?.cashDelta ?? '',
		best_kd_name: byKd?.name ?? '',
		best_kd_value: byKd ? (byKd.kills / Math.max(1, byKd.deaths ?? 0)).toFixed(2) : ''
	};
}

export async function poolStillHolds(db: DbOrTx, serverId: string, raw: unknown): Promise<boolean> {
	const params = raw as { poolId?: unknown; poolKey?: unknown } | null;
	if (typeof params?.poolId !== 'string' || typeof params.poolKey !== 'string') return false;
	const [server] = await db
		.select({ orgId: servers.orgId })
		.from(servers)
		.where(eq(servers.id, serverId));
	if (!server) return false;
	const pool = effectivePools(await poolConfigOf(db, server.orgId), serverId).find(
		(p) => p.id === params.poolId
	);
	return !!pool && fingerprint(pool) === params.poolKey;
}

export async function queueObservationPools(
	db: DbOrTx,
	server: ServerRow,
	status: Status,
	joined: Player[],
	firstVisit: Set<string>,
	matchEnd: MatchEnd | null,
	matchLines: MatchLineVars[],
	at: Date
): Promise<number> {
	const config = await poolConfigOf(db, server.orgId);
	const pools = effectivePools(config, server.id);
	let queued = 0;
	const base = valuesFor(server, status);
	const history = pools.some((pool) => pool.action === 'join')
		? await joinHistory(db, server.orgId, server.id, joined, at)
		: new Map();
	for (const pool of pools) {
		if (pool.action === 'join') {
			for (const player of joined) {
				if (pool.onlyFirstVisit && !firstVisit.has(player.steamId)) continue;
				queued += await queuePoolEvent(db, server.orgId, server.id, pool, {
					eventKey: `join:${player.steamId}:${at.getTime()}`,
					values: {
						...base,
						player_name: player.name,
						faction: player.faction ?? '',
						...(history.get(player.steamId) ?? {
							welcome_phrase: 'Welcome',
							server_visit_count: 1,
							exotix_visit_count: 1,
							server_connected_time: '0m',
							exotix_connected_time: '0m'
						})
					},
					steamId: player.steamId,
					at
				});
			}
		} else if ((pool.action === 'round_end' || pool.action === 'round_start') && matchEnd) {
			queued += await queuePoolEvent(db, server.orgId, server.id, pool, {
				eventKey: `${pool.action}:${at.getTime()}`,
				values: {
					...base,
					...matchVars(matchEnd, matchLines),
					...(pool.action === 'round_end' ? roundAwards(matchLines) : {}),
					winner: matchEnd.winner || matchEnd.leaders.join(' and '),
					previous_map: matchEnd.map
				},
				at
			});
		} else if (pool.action === 'timer') {
			if (
				status.playerCount < pool.minPlayers ||
				(pool.maxPlayers !== null && status.playerCount > pool.maxPlayers)
			)
				continue;
			const [state] = await db.execute<{ last_at: Date | null }>(sql`
				SELECT last_at FROM exotix.message_pool_state
				 WHERE org_id = ${server.orgId} AND server_id = ${server.id} AND pool_id = ${pool.id}`);
			if (
				state?.last_at &&
				at.getTime() - new Date(state.last_at).getTime() < pool.everyMinutes * 60_000
			)
				continue;
			queued += await queuePoolEvent(db, server.orgId, server.id, pool, {
				eventKey: `timer:${Math.floor(at.getTime() / (pool.everyMinutes * 60_000))}`,
				values: base,
				at
			});
		}
	}
	return queued;
}

/** Recent play identifies the server(s) relevant to a ban, including a player who just left. */
const BAN_ANNOUNCEMENT_WINDOW_MS = 60 * 60_000;

async function recentBanPlayers(
	db: DbOrTx,
	steamId: string,
	serverIds: string[]
): Promise<Map<string, string>> {
	if (!serverIds.length) return new Map();
	const rows = await db
		.select({
			serverId: playerSessions.serverId,
			name: playerSessions.name
		})
		.from(playerSessions)
		.where(
			and(
				eq(playerSessions.steamId, steamId),
				inArray(playerSessions.serverId, serverIds),
				gte(playerSessions.lastSeen, new Date(Date.now() - BAN_ANNOUNCEMENT_WINDOW_MS))
			)
		)
		.orderBy(desc(playerSessions.lastSeen));
	const names = new Map<string, string>();
	for (const row of rows)
		if (!names.has(row.serverId)) names.set(row.serverId, row.name.trim() || steamId);
	return names;
}

/** A new list entry announces only on affected servers where the player played recently. */
export async function queueBanAnnouncements(
	db: DbOrTx,
	list: ListRow,
	entry: {
		id: string;
		steamId: string;
		reason: string;
		expiresAt: Date | null;
		automatic: boolean;
	},
	caseRecord: {
		categoryId: string;
		category: string;
		reference: string;
		source: string;
		reviewStatus?: string;
	} | null
): Promise<number> {
	if (list.kind !== 'ban' || caseRecord?.reviewStatus === 'pending') return 0;
	const config = await poolConfigOf(db, list.orgId);
	const targets = await db
		.select({ id: servers.id, name: servers.name })
		.from(servers)
		.where(list.serverId ? eq(servers.id, list.serverId) : eq(servers.orgId, list.orgId));
	const recent = await recentBanPlayers(
		db,
		entry.steamId,
		targets.map((server) => server.id)
	);
	const source: BanSource =
		entry.automatic || caseRecord?.source === 'automated'
			? 'automatic'
			: caseRecord
				? 'policy'
				: 'legacy';
	const category = caseRecord?.categoryId ?? 'general';
	const duration = entry.expiresAt
		? `${Math.max(1, Math.ceil((entry.expiresAt.getTime() - Date.now()) / 86400_000))}d`
		: 'Permanent';
	let queued = 0;
	for (const server of targets) {
		const playerName = recent.get(server.id);
		if (!playerName) continue;
		const pools = effectivePools(config, server.id).filter((p) => p.action === 'ban');
		const pool =
			pools.find((p) => p.categoryId === category && p.banSources.includes(source)) ??
			pools.find((p) => p.categoryId === 'general' && p.banSources.includes(source));
		if (!pool) continue;
		queued += await queuePoolEvent(db, list.orgId, server.id, pool, {
			eventKey: `ban:${entry.id}`,
			values: {
				...valuesFor(server),
				player_name: playerName,
				ban_category: caseRecord?.category || 'Ban',
				ban_reason: entry.reason,
				ban_duration: duration,
				ban_reference: caseRecord?.reference || ''
			}
		});
	}
	return queued;
}

/** A successful direct game ban uses General and legacy source when played here recently. */
export async function queueDirectBanAnnouncement(
	db: DbOrTx,
	server: ServerRow,
	steamId: string,
	reason: string
): Promise<number> {
	const playerName = (await recentBanPlayers(db, steamId, [server.id])).get(server.id);
	if (!playerName) return 0;
	const pool = effectivePools(await poolConfigOf(db, server.orgId), server.id).find(
		(candidate) =>
			candidate.action === 'ban' &&
			candidate.categoryId === 'general' &&
			candidate.banSources.includes('legacy')
	);
	if (!pool) return 0;
	return queuePoolEvent(db, server.orgId, server.id, pool, {
		eventKey: `direct-ban:${randomUUID()}`,
		values: {
			...valuesFor(server),
			player_name: playerName,
			ban_category: 'Ban',
			ban_reason: reason || 'Server rules',
			ban_duration: 'Permanent',
			ban_reference: ''
		}
	});
}

/** Exact weapon tags and per-match counts drive configurable whisper/kick/ban steps. */
export async function queueWeaponPools(
	db: DbOrTx,
	server: ServerRow,
	batch: KillView[]
): Promise<number> {
	if (!batch.length) return 0;
	const config = await poolConfigOf(db, server.orgId);
	const pools = effectivePools(config, server.id).filter((p) => p.action === 'weapon');
	if (!pools.length) return 0;
	const [stamp] = await db
		.select({ matchRow: kills.matchRow })
		.from(kills)
		.where(and(eq(kills.serverId, server.id), eq(kills.eventId, batch[0].eventId)))
		.limit(1);
	const matchRow = stamp?.matchRow ?? null;
	let queued = 0;
	for (const pool of pools) {
		const tags = new Set(pool.weaponTags.map((v) => v.toLowerCase()));
		const vehicleTagSql = sql.join(
			VEHICLE_TAGS.map((tag) => sql`${tag}`),
			sql`, `
		);
		const hits = [...batch]
			.filter(
				(k) =>
					k.killer &&
					!k.suicide &&
					!k.tags.some((tag) => VEHICLE_TAGS.includes(tag)) &&
					k.cause &&
					tags.has(k.cause.toLowerCase()) &&
					(!pool.teamKillsOnly || k.teamKill)
			)
			.sort((a, b) => a.eventTime - b.eventTime);
		if (!hits.length) continue;
		const byKiller = new Map<string, KillView[]>();
		for (const hit of hits) {
			const id = hit.killer!.steamId;
			(byKiller.get(id) ?? byKiller.set(id, []).get(id)!).push(hit);
		}
		for (const [steamId, events] of byKiller) {
			const tagSql = sql.join(
				pool.weaponTags.map((tag) => sql`${tag.toLowerCase()}`),
				sql`, `
			);
			const [row] = await db.execute<{ n: string }>(sql`
				SELECT COUNT(*)::text AS n FROM public.kills
				 WHERE server_id = ${server.id} AND killer_steam_id = ${steamId}
				 AND ${matchRow === null ? sql`match_row IS NULL AND ts >= ${new Date(Date.parse(batch[0].ts) - 3600_000)}` : sql`match_row = ${matchRow}`}
				 AND lower(cause) IN (${tagSql})
				 AND NOT (tags ?| ARRAY[${vehicleTagSql}]::text[])
				 ${pool.teamKillsOnly ? sql`AND team_kill = true` : sql``}`);
			let count = Math.max(0, Number(row?.n ?? 0) - events.length);
			for (const event of events) {
				count++;
				const threshold = pool.thresholds.find((step) => step.count === count);
				if (!threshold) continue;
				queued += await queuePoolEvent(db, server.orgId, server.id, pool, {
					eventKey: `weapon:${event.eventId}:${threshold.count}`,
					values: {
						...valuesFor(server),
						map: event.map,
						player_name: event.killer!.name,
						victim_name: event.victim.name,
						weapon: event.cause || '',
						count
					},
					steamId,
					action: threshold.action,
					threshold,
					at: new Date(event.ts)
				});
			}
		}
	}
	return queued;
}
