import { sql } from 'drizzle-orm';
import type { Db } from './db';
import { ApiError } from './http';
import type {
	PlayerStats,
	PlayerStatsQuery,
	PlayerStatsResponse,
	PlayerStatsWindow
} from '$lib/player-stats';

export const STATS_MAX_PLAYERS = 100;
export const STATS_MAX_SERVERS = 32;
export const STATS_MAX_WINDOWS = 200;
export const STATS_MAX_BODY_BYTES = 32_768;
const activeByKey = new Map<string, number>();
let activeQueries = 0;

/** Per-process admission bounds; release in finally, including body/auth/query failures. */
export function acquirePlayerStatsSlot(key: string): (() => void) | null {
	const activeForKey = activeByKey.get(key) ?? 0;
	if (activeForKey >= 2 || activeQueries >= 4) return null;
	activeByKey.set(key, activeForKey + 1);
	activeQueries++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const remaining = (activeByKey.get(key) ?? 1) - 1;
		if (remaining) activeByKey.set(key, remaining);
		else activeByKey.delete(key);
		activeQueries--;
	};
}
const bad = (message: string): never => {
	throw new ApiError(400, message, 'bad_stats_query');
};

/** Explicit bounded scopes only; no implicit all, truncation, or number-coerced identities. */
export function parsePlayerStatsQuery(raw: unknown, now = new Date()): PlayerStatsQuery {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('Expected a statistics query.');
	const input = raw as Record<string, unknown>;
	if (
		Object.keys(input).some(
			(key) => !['steamIds', 'serverIds', 'from', 'to', 'playerWindows'].includes(key)
		)
	)
		bad('Unknown statistics query field.');
	const ids = (value: unknown, max: number, pattern: RegExp, name: string): string[] => {
		if (!Array.isArray(value) || !value.length || value.length > max)
			bad(`${name} must contain between 1 and ${max} IDs.`);
		const values = value as unknown[];
		if (!values.every((id) => typeof id === 'string' && pattern.test(id)))
			bad(`Invalid ${name}; IDs must be exact strings.`);
		return [...new Set(values as string[])].sort();
	};
	const timestamp = (value: unknown): string => {
		if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value))
			bad('from and to must be UTC ISO timestamps.');
		const text = value as string;
		const date = new Date(text);
		if (!Number.isFinite(date.getTime()) || date.getTime() < 0)
			bad('Invalid statistics time window.');
		// JS Date validates the calendar only. Keep PostgreSQL microseconds in the wire/SQL
		// boundary rather than rounding a membership event down to milliseconds.
		if (date.toISOString().slice(0, 19) !== text.slice(0, 19))
			bad('Invalid statistics time window.');
		return text.replace(
			/(?:\.(\d{1,6}))?Z$/,
			(_, fraction: string | undefined) => `.${(fraction ?? '').padEnd(6, '0')}Z`
		);
	};
	const from = timestamp(input.from);
	const to = timestamp(input.to);
	if (from >= to || to > now.toISOString().replace(/(\d{3})Z$/, '$1000Z'))
		bad('Require epoch <= from < to <= now.');
	const steamIds = ids(input.steamIds, STATS_MAX_PLAYERS, /^\d{17}$/, 'steamIds');
	let playerWindows: PlayerStatsWindow[];
	if (input.playerWindows === undefined)
		playerWindows = steamIds.map((steamId) => ({ steamId, from, to }));
	else {
		if (
			!Array.isArray(input.playerWindows) ||
			!input.playerWindows.length ||
			input.playerWindows.length > STATS_MAX_WINDOWS
		)
			bad(`playerWindows must contain between 1 and ${STATS_MAX_WINDOWS} windows.`);
		const windows = (input.playerWindows as unknown[])
			.map((raw): PlayerStatsWindow => {
				if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('Invalid player window.');
				const window = raw as Record<string, unknown>;
				if (
					Object.keys(window).some((key) => !['steamId', 'from', 'to'].includes(key)) ||
					typeof window.steamId !== 'string' ||
					!steamIds.includes(window.steamId)
				)
					bad('Invalid player window identity.');
				const start = timestamp(window.from),
					end = timestamp(window.to);
				if (start < from || end > to || start >= end)
					bad('Player windows must lie within the outer time window.');
				return { steamId: window.steamId as string, from: start, to: end };
			})
			.sort(
				(a, b) =>
					a.steamId.localeCompare(b.steamId) ||
					a.from.localeCompare(b.from) ||
					a.to.localeCompare(b.to)
			);
		if (steamIds.some((id) => !windows.some((window) => window.steamId === id)))
			bad('Every requested player needs a window.');
		playerWindows = [];
		for (const window of windows) {
			const previous = playerWindows.at(-1);
			if (previous?.steamId === window.steamId && window.from <= previous.to)
				previous.to = previous.to > window.to ? previous.to : window.to;
			else playerWindows.push({ ...window });
		}
	}
	return {
		steamIds,
		serverIds: ids(input.serverIds, STATS_MAX_SERVERS, /^[A-Za-z0-9_-]{1,64}$/, 'serverIds'),
		from,
		to,
		playerWindows
	};
}

/** Bound bytes even for streamed bodies without Content-Length. Never read an unlimited body. */
export async function readPlayerStatsQuery(
	request: Request,
	now = new Date()
): Promise<PlayerStatsQuery> {
	if (!(request.headers.get('content-type') ?? '').includes('application/json'))
		throw new ApiError(415, 'Expected application/json body.');
	const reader = request.body?.getReader();
	if (!reader) bad('Expected a statistics query.');
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader!.read();
			if (done) break;
			size += value.byteLength;
			if (size > STATS_MAX_BODY_BYTES) {
				await reader!.cancel();
				throw new ApiError(413, 'Statistics query body is too large.', 'stats_query_too_large');
			}
			chunks.push(value);
		}
	} finally {
		reader!.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		bad('Malformed JSON body.');
	}
	return parsePlayerStatsQuery(raw, now);
}

const iso = (value: unknown): string | null =>
	value == null ? null : new Date(value as string | Date).toISOString();
const count = (value: unknown): number => Number(value ?? 0);
const blank = (steamId: string): PlayerStats => ({
	steamId,
	hasObservedData: false,
	playtimeSeconds: 0,
	seedtimeSeconds: null,
	matches: 0,
	wins: 0,
	losses: 0,
	draws: 0,
	kills: 0,
	deaths: 0,
	cashDelta: 0,
	headshots: 0,
	teamKills: 0,
	suicides: 0,
	vehicleKills: 0,
	killStreak: 0,
	deathStreak: 0,
	firstSeen: null,
	lastSeen: null,
	lastMatchEndedAt: null,
	coverage: { sessions: 0, matches: 0 }
});

/** Scope must first be authorized on EVERY server. No live calls, writes, ranks or raw-feed scans. */
export async function loadPlayerStats(db: Db, raw: PlayerStatsQuery): Promise<PlayerStatsResponse> {
	const generatedAt = new Date();
	const query = parsePlayerStatsQuery(raw, generatedAt);
	const { steamIds, serverIds, from, to } = query;
	const playerWindows = query.playerWindows!;
	const values = new Map(steamIds.map((id) => [id, blank(id)]));
	const snapshots = await db.transaction(async (tx) => {
		// Both reads see one snapshot. Timeout is local to this transaction/pool checkout.
		await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
		await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
		const rows = await tx.execute<Record<string, unknown>>(sql`
			WITH windows AS (
			 SELECT * FROM (VALUES ${sql.join(
					playerWindows.map(
						(w) => sql`(${w.steamId}::text, ${w.from}::timestamptz, ${w.to}::timestamptz)`
					),
					sql`, `
				)})
			 AS w(steam_id, window_from, window_to)
			), sess AS (
				SELECT s.steam_id, COUNT(DISTINCT s.id) AS sessions,
				 SUM(EXTRACT(EPOCH FROM (LEAST(COALESCE(s.left_at, s.last_seen), s.last_seen, w.window_to)
				   - GREATEST(s.joined_at, w.window_from)))) AS seconds,
				 TO_CHAR(MIN(GREATEST(s.joined_at, w.window_from)) AT TIME ZONE 'UTC',
				  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS first_seen,
				 TO_CHAR(MAX(LEAST(s.last_seen, w.window_to)) AT TIME ZONE 'UTC',
				  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_seen
				FROM player_sessions s JOIN windows w ON w.steam_id = s.steam_id
				WHERE s.server_id IN ${serverIds} AND s.steam_id IN ${steamIds}
				 AND s.joined_at < w.window_to
				 AND (LEAST(COALESCE(s.left_at, s.last_seen), s.last_seen) > GREATEST(s.joined_at, w.window_from)
				  OR (s.joined_at = s.last_seen AND s.joined_at >= w.window_from AND s.joined_at < w.window_to))
				GROUP BY s.steam_id
			), lines AS (
				SELECT p.*, m.ended_at,
				 CASE WHEN p.faction IS NULL THEN NULL
				 WHEN jsonb_typeof(m.final_scores) = 'array' AND jsonb_array_length(m.final_scores) > 0
				  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.final_scores) e WHERE e->>'name' = p.faction) THEN NULL
				 WHEN m.winner IS NOT NULL THEN CASE WHEN m.winner = p.faction THEN 'win' ELSE 'loss' END
				 WHEN jsonb_typeof(m.final_scores) = 'array'
				  AND (SELECT MAX(CASE WHEN jsonb_typeof(e->'score') = 'number' THEN (e->>'score')::numeric END)
				   FROM jsonb_array_elements(m.final_scores) e) > 0 THEN 'draw'
				 ELSE NULL END AS result
				FROM match_players p JOIN matches m ON m.id = p.match_id AND m.server_id = p.server_id
				WHERE p.server_id IN ${serverIds} AND p.steam_id IN ${steamIds}
				 AND m.ended_at >= ${from}::timestamptz AND m.ended_at < ${to}::timestamptz
				 AND EXISTS (SELECT 1 FROM windows w WHERE w.steam_id = p.steam_id
				  AND m.ended_at >= w.window_from AND m.ended_at < w.window_to)
			), mt AS (
				SELECT steam_id, COUNT(*) AS matches, SUM(kills) AS kills, SUM(deaths) AS deaths,
				 SUM(cash_delta) AS cash_delta, SUM(headshots) AS headshots, SUM(team_kills) AS team_kills,
				 SUM(suicides) AS suicides, SUM(vehicle_kills) AS vehicle_kills,
				 MAX(kill_streak) AS kill_streak, MAX(death_streak) AS death_streak,
				 TO_CHAR(MAX(ended_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_match_ended_at,
				 COUNT(*) FILTER (WHERE result = 'win') AS wins,
				 COUNT(*) FILTER (WHERE result = 'loss') AS losses,
				 COUNT(*) FILTER (WHERE result = 'draw') AS draws
				FROM lines GROUP BY steam_id
			)
			SELECT * FROM sess FULL JOIN mt USING (steam_id)`);
		for (const row of rows) {
			const player = values.get(String(row.steam_id))!;
			player.hasObservedData = true;
			player.playtimeSeconds = count(row.seconds);
			for (const field of [
				'matches',
				'wins',
				'losses',
				'draws',
				'kills',
				'deaths',
				'headshots',
				'suicides'
			] as const)
				player[field] = count(row[field]);
			player.cashDelta = count(row.cash_delta);
			player.teamKills = count(row.team_kills);
			player.vehicleKills = count(row.vehicle_kills);
			player.killStreak = count(row.kill_streak);
			player.deathStreak = count(row.death_streak);
			player.firstSeen = row.first_seen == null ? null : String(row.first_seen);
			player.lastSeen = row.last_seen == null ? null : String(row.last_seen);
			player.lastMatchEndedAt =
				row.last_match_ended_at == null ? null : String(row.last_match_ended_at);
			player.coverage = { sessions: count(row.sessions), matches: count(row.matches) };
		}
		return tx.execute<Record<string, unknown>>(sql`
			SELECT server_id, ok, observed_at, players_at, status_at, feed_at
			FROM server_live WHERE server_id IN ${serverIds}`);
	});
	const byServer = new Map(snapshots.map((row) => [String(row.server_id), row]));
	return {
		ok: true,
		version: 1,
		generatedAt: generatedAt.toISOString(),
		from,
		to,
		serverIds,
		playerWindows,
		players: [...values.values()],
		coverage: {
			semantics: 'observed-history',
			matchAttribution: 'ended_at',
			playtimeAttribution: 'observed-session-overlap',
			feedDerivatives: 'partial',
			servers: serverIds.map((serverId) => {
				const row = byServer.get(serverId);
				return {
					serverId,
					ok: row?.ok === true,
					observedAt: iso(row?.observed_at),
					playersAt: iso(row?.players_at),
					statusAt: iso(row?.status_at),
					feedAt: iso(row?.feed_at)
				};
			})
		},
		provenance: {
			playtimeSeconds: 'player_sessions',
			scoreboard: 'completed_match_players',
			results: 'completed_matches',
			feedDerivatives: 'completed_match_players_feed_derivatives',
			streaks: 'maximum_completed_match_players',
			seedtimeSeconds: 'unavailable_for_arbitrary_windows'
		}
	};
}
