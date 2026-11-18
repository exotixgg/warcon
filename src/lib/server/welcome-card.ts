// Current-official-season data for the Welcome Whisper card.  This deliberately
// reads the same range CTE as the leaderboards, so a player's card and the board
// agree about what belongs to the season.
import { sql } from 'drizzle-orm';
import { DEFAULT_FLOOR_MINUTES, kdRatio } from '$lib/leaderboard';
import { currentSeason } from '$lib/seasons';
import type { Env } from './env';
import { latestHiddenNames } from './sessions';
import { rangeBase } from './leaderboards';
import { orgSeasons } from './seasons';
import { cardLeaderLine } from './card-format';

export type WelcomeCardValue = string | number;
export type WelcomeCardVars = Record<string, WelcomeCardValue>;

type Scope = { orgId: string; serverName: string; ids: string[] };
type LeaderKey = 'kills' | 'cash' | 'playtime' | 'seeded';
type Leader = { steamId?: string; name: string; value: string };

const TTL_MS = 60_000;
const CACHE_MAX = 500;
const leadersCache = new Map<
	string,
	{ until: number; value: Promise<Record<LeaderKey, Leader>> }
>();

const number = (value: unknown): number =>
	value === null || value === undefined ? 0 : Number(value);

import {
	compactNumber,
	compactMinutes,
	shortCardName as shortWelcomeName,
	cardServerLabel as welcomeServerLabel
} from './card-format';
export {
	compactNumber,
	compactMinutes,
	shortCardName as shortWelcomeName,
	cardServerLabel as welcomeServerLabel
} from './card-format';

export function welcomeSeasonLabel(name: string): string {
	const simple = name.match(/^season\s+(\d+)$/i);
	return (
		shortWelcomeName(simple ? `SEASON ${simple[1].padStart(2, '0')}` : name.toUpperCase(), 24) ||
		'-'
	);
}

function emptyVars(serverLabel = '-'): WelcomeCardVars {
	return {
		season_name: '-',
		season_rank: '-',
		season_kills: 0,
		season_deaths: 0,
		season_kd: '0.00',
		season_playtime: '0m',
		season_seeded: '0m',
		season_cash: '0',
		season_rival: '-',
		season_rival_kills: 0,
		season_rival_deaths: 0,
		leader_kills_name: '-',
		leader_kills_value: '0',
		leader_cash_name: '-',
		leader_cash_value: '0',
		leader_playtime_name: '-',
		leader_playtime_value: '0m',
		leader_seeded_name: '-',
		leader_seeded_value: '0m',
		server_label: serverLabel
	};
}

export async function scopeFor(env: Env, serverId: string): Promise<Scope | null> {
	const rows = await env.db.execute<{ orgId: string; serverName: string; id: string }>(sql`
		WITH me AS (SELECT id, org_id, name FROM servers WHERE id = ${serverId})
		SELECT me.org_id AS "orgId", me.name AS "serverName", s.id
		  FROM me JOIN servers s ON s.org_id = me.org_id
		UNION ALL
		SELECT me.org_id AS "orgId", me.name AS "serverName", a.id
		  FROM me JOIN archived_servers a ON a.org_id = me.org_id
		 WHERE NOT EXISTS (SELECT 1 FROM servers live WHERE live.id = a.id)`);
	if (!rows.length) return null;
	return { orgId: rows[0].orgId, serverName: rows[0].serverName, ids: rows.map((r) => r.id) };
}

async function readLeaders(
	env: Env,
	ids: string[],
	from: Date
): Promise<Record<LeaderKey, Leader>> {
	const fallback: Record<LeaderKey, Leader> = {
		kills: { name: '-', value: '0' },
		cash: { name: '-', value: '0' },
		playtime: { name: '-', value: '0m' },
		seeded: { name: '-', value: '0m' }
	};
	const rows = await env.db.execute<{
		kind: LeaderKey;
		steamId: string;
		raw: string;
		name: string | null;
	}>(sql`
		WITH ${rangeBase(ids, from)},
		picked AS (
			(SELECT 'kills'::text AS kind, steam_id, kills AS raw FROM base WHERE minutes >= ${DEFAULT_FLOOR_MINUTES} ORDER BY kills DESC, steam_id ASC LIMIT 1)
			UNION ALL (SELECT 'cash', steam_id, cash FROM base WHERE minutes >= ${DEFAULT_FLOOR_MINUTES} ORDER BY cash DESC, steam_id ASC LIMIT 1)
			UNION ALL (SELECT 'playtime', steam_id, minutes FROM base WHERE minutes >= ${DEFAULT_FLOOR_MINUTES} ORDER BY minutes DESC, steam_id ASC LIMIT 1)
			UNION ALL (SELECT 'seeded', steam_id, seed_minutes FROM base WHERE minutes >= ${DEFAULT_FLOOR_MINUTES} ORDER BY seed_minutes DESC, steam_id ASC LIMIT 1)
		)
		SELECT p.kind, p.steam_id AS "steamId", p.raw,
		       (SELECT s.name FROM player_sessions s WHERE s.server_id IN ${ids} AND s.steam_id = p.steam_id
		         ORDER BY s.last_seen DESC NULLS LAST LIMIT 1) AS name
		  FROM picked p`);
	for (const row of rows as {
		kind: LeaderKey;
		steamId: string;
		raw: string;
		name: string | null;
	}[]) {
		const raw = number(row.raw);
		fallback[row.kind] = {
			steamId: row.steamId,
			name: shortWelcomeName(row.name || row.steamId),
			value:
				row.kind === 'playtime' || row.kind === 'seeded' ? compactMinutes(raw) : compactNumber(raw)
		};
	}
	return fallback;
}

function leadersFor(env: Env, scope: Scope, seasonKey: string, from: Date) {
	const key = `${scope.orgId}:${seasonKey}:${from.toISOString()}`;
	const now = Date.now();
	const hit = leadersCache.get(key);
	if (hit && hit.until > now) return hit.value;
	const value = readLeaders(env, scope.ids, from);
	leadersCache.set(key, { until: now + TTL_MS, value });
	value.catch(() => {
		if (leadersCache.get(key)?.value === value) leadersCache.delete(key);
	});
	if (leadersCache.size > CACHE_MAX)
		for (const [cacheKey, entry] of leadersCache)
			if (entry.until <= now || leadersCache.size > CACHE_MAX) leadersCache.delete(cacheKey);
	return value;
}

/**
 * Current official-season card variables for the given players. Missing history is a valid
 * state: callers always get a complete, zeroed record rather than a failed welcome whisper.
 */
export async function welcomeCardVars(
	env: Env,
	serverId: string,
	steamIds: string[]
): Promise<Map<string, WelcomeCardVars>> {
	const unique = [...new Set(steamIds.filter(Boolean))];
	const scope = await scopeFor(env, serverId);
	const result = new Map<string, WelcomeCardVars>();
	const label = scope ? welcomeServerLabel(scope.serverName) : '-';
	for (const steamId of unique) {
		const vars = emptyVars(label);
		vars.welcome_card = buildWelcomeCard(vars);
		result.set(steamId, vars);
	}
	if (!scope || !unique.length) return result;

	const season = currentSeason((await orgSeasons(env, scope.orgId)).seasons, 'official');
	if (!season) return result;
	const from = new Date(season.startsAt);
	const [leaders, stats, rivals] = await Promise.all([
		leadersFor(env, scope, season.key, from),
		env.db.execute<{
			steamId: string;
			minutes: string;
			seedMinutes: string;
			cash: string;
			kills: string;
			deaths: string;
			above: string;
		}>(sql`
			WITH ${rangeBase(scope.ids, from)}, mine AS (SELECT * FROM base WHERE steam_id IN ${unique})
			SELECT m.steam_id AS "steamId", m.minutes, m.seed_minutes AS "seedMinutes", m.cash, m.kills, m.deaths,
			       (SELECT COUNT(*) FROM base b WHERE b.minutes >= ${DEFAULT_FLOOR_MINUTES} AND b.kills > m.kills) AS above
			  FROM mine m`),
		env.db.execute<{
			steamId: string;
			rivalId: string;
			name: string;
			kills: string;
			deaths: string;
		}>(sql`
			WITH grouped AS (
				SELECT victim_steam_id, killer_steam_id, COUNT(*) AS deaths, MAX(ts) AS latest,
				       (array_agg(COALESCE(killer_name, killer_steam_id) ORDER BY ts DESC))[1] AS name
				  FROM kills
				 WHERE server_id IN ${scope.ids} AND victim_steam_id IN ${unique}
				   AND killer_steam_id IS NOT NULL AND killer_steam_id <> victim_steam_id
				   AND NOT suicide AND NOT team_kill AND ts >= ${from}
				 GROUP BY victim_steam_id, killer_steam_id
			), ranked AS (
				SELECT *, row_number() OVER (PARTITION BY victim_steam_id ORDER BY deaths DESC, latest DESC, killer_steam_id ASC) AS place FROM grouped
			) SELECT r.victim_steam_id AS "steamId", r.killer_steam_id AS "rivalId", r.name, r.deaths,
			         (SELECT COUNT(*) FROM kills k
			           WHERE k.server_id IN ${scope.ids} AND k.killer_steam_id = r.victim_steam_id
			             AND k.victim_steam_id = r.killer_steam_id
			             AND NOT k.suicide AND NOT k.team_kill AND k.ts >= ${from}) AS kills
			    FROM ranked r WHERE r.place = 1`)
	]);

	const hidden = await latestHiddenNames(env.db, scope.ids, [
		...Object.values(leaders).flatMap((leader) => (leader.steamId ? [leader.steamId] : [])),
		...rivals.map((rival) => rival.rivalId)
	]);
	const leaderName = (leader: Leader) =>
		shortWelcomeName((leader.steamId && hidden.get(leader.steamId)) || leader.name);
	const rivalsBySteam = new Map(rivals.map((r) => [r.steamId, r]));
	const statsBySteam = new Map(stats.map((s) => [s.steamId, s]));
	for (const steamId of unique) {
		const row = statsBySteam.get(steamId);
		const vars = emptyVars(label);
		vars.season_name = welcomeSeasonLabel(season.name);
		const rival = rivalsBySteam.get(steamId);
		vars.season_rival = rival ? shortWelcomeName(hidden.get(rival.rivalId) ?? rival.name) : '-';
		vars.season_rival_kills = number(rival?.kills);
		vars.season_rival_deaths = number(rival?.deaths);
		vars.leader_kills_name = leaderName(leaders.kills);
		vars.leader_kills_value = leaders.kills.value;
		vars.leader_cash_name = leaderName(leaders.cash);
		vars.leader_cash_value = leaders.cash.value;
		vars.leader_playtime_name = leaderName(leaders.playtime);
		vars.leader_playtime_value = leaders.playtime.value;
		vars.leader_seeded_name = leaderName(leaders.seeded);
		vars.leader_seeded_value = leaders.seeded.value;
		if (row) {
			const kills = number(row.kills),
				deaths = number(row.deaths),
				minutes = number(row.minutes);
			vars.season_kills = Math.round(kills);
			vars.season_deaths = Math.round(deaths);
			vars.season_kd = (kdRatio(kills, deaths) ?? 0).toFixed(2);
			vars.season_playtime = compactMinutes(minutes);
			vars.season_seeded = compactMinutes(number(row.seedMinutes));
			vars.season_cash = compactNumber(number(row.cash));
			vars.season_rank = minutes >= DEFAULT_FLOOR_MINUTES ? number(row.above) + 1 : '-';
		}
		vars.welcome_card = buildWelcomeCard(vars);
		result.set(steamId, vars);
	}
	return result;
}

/** Rendered by the `{welcome_card}` token. It degrades by shortening names, never mid-field. */
export function buildWelcomeCard(vars: WelcomeCardVars): string {
	const card = (maxName: number, includeRival: boolean) => {
		const name = (key: string) => shortWelcomeName(String(vars[key] ?? '-'), maxName);
		const value = (key: string, max: number, fallback: string) =>
			shortWelcomeName(String(vars[key] ?? fallback), max);
		const rivalRecord =
			vars.season_rival && vars.season_rival !== '-'
				? ` ${value('season_rival_kills', 9, '0')}K/${value('season_rival_deaths', 9, '0')}D`
				: '';
		const lines = [
			value('server_label', 24, '-'),
			`${value('season_name', 24, '-').toUpperCase()} | Rank #${value('season_rank', 8, '-')}`,
			`${value('season_kills', 9, '0')}K/${value('season_deaths', 9, '0')}D | ${value('season_kd', 8, '0.00')} K/D | ${value('season_playtime', 8, '0m')}/${value('season_seeded', 8, '0m')}`,
			...(includeRival ? [`Rival: ${name('season_rival')}${rivalRecord}`] : []),
			'',
			'LEADERS',
			cardLeaderLine(name('leader_kills_name'), value('leader_kills_value', 9, '0'), 'kills'),
			cardLeaderLine(name('leader_cash_name'), `$${value('leader_cash_value', 9, '0')}`, 'cash'),
			cardLeaderLine(
				name('leader_playtime_name'),
				value('leader_playtime_value', 8, '0m'),
				'played'
			),
			cardLeaderLine(name('leader_seeded_name'), value('leader_seeded_value', 8, '0m'), 'seeded')
		];
		return lines.join('\n');
	};
	for (const maxName of [20, 16, 12, 8]) {
		const rendered = card(maxName, true);
		if (rendered.length <= 256) return rendered;
	}
	return card(8, false);
}
