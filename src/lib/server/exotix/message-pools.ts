import { and, desc, eq, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import type { DbOrTx } from '../db';
import {
	kills,
	outbox,
	playerSessions,
	servers,
	steamProfiles,
	type ListRow,
	type ServerRow
} from '../db/schema';
import { ApiError } from '../http';
import { MAX_CHAT } from '$lib/chat';
import {
	chooseMessageIndexes,
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
	const indexes = chooseMessageIndexes(
		pool.action === 'weapon' && event.action !== 'whisper' ? { ...pool, sendCount: 1 } : pool,
		cursor,
		lastIndex
	);
	const now = event.at ?? new Date();
	const rows = indexes.map((index, position) => {
		const action =
			event.action === 'ban'
				? PANEL_BAN
				: (event.action ?? (pool.action === 'join' ? 'whisper' : 'broadcast'));
		const cap = action === PANEL_BAN || action === 'kick' ? 200 : MAX_CHAT;
		const message = renderPoolMessage(pool.messages[index], event.values).slice(0, cap);
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
	for (const pool of pools) {
		if (pool.action === 'join') {
			for (const player of joined) {
				if (pool.onlyFirstVisit && !firstVisit.has(player.steamId)) continue;
				queued += await queuePoolEvent(db, server.orgId, server.id, pool, {
					eventKey: `join:${player.steamId}:${at.getTime()}`,
					values: { ...base, player_name: player.name, faction: player.faction ?? '' },
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

/** A new list entry gets its public announcement on every affected server, once per entry. */
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
	const [session] = await db
		.select({ name: playerSessions.name })
		.from(playerSessions)
		.where(eq(playerSessions.steamId, entry.steamId))
		.orderBy(desc(playerSessions.joinedAt))
		.limit(1);
	const [profile] = await db
		.select({ persona: steamProfiles.persona })
		.from(steamProfiles)
		.where(eq(steamProfiles.steamId, entry.steamId))
		.limit(1);
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
		const pools = effectivePools(config, server.id).filter((p) => p.action === 'ban');
		const pool =
			pools.find((p) => p.categoryId === category && p.banSources.includes(source)) ??
			pools.find((p) => p.categoryId === 'general' && p.banSources.includes(source));
		if (!pool) continue;
		queued += await queuePoolEvent(db, list.orgId, server.id, pool, {
			eventKey: `ban:${entry.id}`,
			values: {
				...valuesFor(server),
				player_name: session?.name || profile?.persona || entry.steamId,
				ban_category: caseRecord?.category || 'Ban',
				ban_reason: entry.reason,
				ban_duration: duration,
				ban_reference: caseRecord?.reference || ''
			}
		});
	}
	return queued;
}

/** A successful direct game ban has no policy case or list entry; use General and legacy source. */
export async function queueDirectBanAnnouncement(
	db: DbOrTx,
	server: ServerRow,
	steamId: string,
	reason: string
): Promise<number> {
	const pool = effectivePools(await poolConfigOf(db, server.orgId), server.id).find(
		(candidate) =>
			candidate.action === 'ban' &&
			candidate.categoryId === 'general' &&
			candidate.banSources.includes('legacy')
	);
	if (!pool) return 0;
	const [session] = await db
		.select({ name: playerSessions.name })
		.from(playerSessions)
		.where(eq(playerSessions.steamId, steamId))
		.orderBy(desc(playerSessions.joinedAt))
		.limit(1);
	const [profile] = await db
		.select({ persona: steamProfiles.persona })
		.from(steamProfiles)
		.where(eq(steamProfiles.steamId, steamId))
		.limit(1);
	return queuePoolEvent(db, server.orgId, server.id, pool, {
		eventKey: `direct-ban:${randomUUID()}`,
		values: {
			...valuesFor(server),
			player_name: session?.name || profile?.persona || steamId,
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
		const hits = [...batch]
			.filter(
				(k) =>
					k.killer &&
					!k.suicide &&
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
