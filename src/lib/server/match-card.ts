// A private snapshot of one completed match. No writes to matches, players or totals.
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { mapName, prettify } from '$lib/format';
import { kdRatio } from '$lib/leaderboard';
import type { Player, Status, MatchStateView } from '$lib/types';
import {
	cardLeaderLine,
	cardServerLabel,
	compactMinutes,
	compactNumber,
	shortCardName
} from './card-format';
import { matches, matchPlayers, kills } from './db/schema';
import type { Env } from './env';
import type { ParsedEnd } from './feed-core';
import { feedRecord, type FeedKill, type TallyRow } from './match-players';
import { nextMessageEntry, type MessageRotation } from './message-rotation';

export interface MatchCardConfig {
	message: string;
	delaySeconds: number;
}
export const matchCardSettingsKey = (c: MatchCardConfig) =>
	JSON.stringify([c.message, c.delaySeconds]);
export const MATCH_CARD_MAX_AGE_MS = 120_000;
export interface MatchCardEnd {
	eventId: string;
	at: number;
	map: string;
	rotationNow: number;
	rotationNext: number;
	startedAt: number;
	matchSeconds?: number | null;
	recipients: string[];
	nextMap: string;
	nextWeather: string;
}
type CardMemory = {
	observedAt: number;
	status: Status | null;
	startedAt: number;
	players: Player[];
	lastMatch: unknown;
	messageRotation?: MessageRotation | null;
	matchCardEnd?: MatchCardEnd | null;
};
const sameMap = (a: string, b: string) => mapName(a).toLowerCase() === mapName(b).toLowerCase();

/** Capture while still on the finished map. Repeated events cannot restart the delay. */
export function captureMatchCard(m: CardMemory, end: ParsedEnd, now: number): void {
	if (
		!m.observedAt ||
		!m.lastMatch ||
		!m.status ||
		!end.eventId ||
		!end.map ||
		!sameMap(end.map, m.status.map)
	)
		return;
	const held = m.matchCardEnd;
	if (
		held &&
		held.startedAt === m.startedAt &&
		sameMap(held.map, m.status.map) &&
		held.rotationNow === m.status.rotationNow &&
		held.rotationNext === m.status.rotationNext &&
		now >= held.at &&
		now - held.at <= MATCH_CARD_MAX_AGE_MS
	)
		return;
	const next = nextMessageEntry(m.status, m.messageRotation, now);
	m.matchCardEnd = {
		eventId: end.eventId,
		at: now,
		map: m.status.map,
		rotationNow: m.status.rotationNow,
		rotationNext: m.status.rotationNext,
		startedAt: m.startedAt,
		matchSeconds: m.status.matchSeconds ?? null,
		recipients: m.players.map((p) => p.steamId).filter(Boolean),
		nextMap: next ? mapName(next.map) : '…',
		nextWeather:
			next?.lighting && next.lighting.toLowerCase() !== 'none' ? prettify(next.lighting) : '…'
	};
}

/** Strictly post-match, on the captured rotation slot and process, including repeated maps. */
export function matchCardStillHolds(
	end:
		| Pick<
				MatchCardEnd,
				'at' | 'startedAt' | 'map' | 'rotationNow' | 'rotationNext' | 'matchSeconds'
		  >
		| null
		| undefined,
	status: Status | null,
	state: MatchStateView | null,
	startedAt: number,
	now: number
): boolean {
	return (
		!!end &&
		!!status &&
		now >= end.at &&
		now - end.at <= MATCH_CARD_MAX_AGE_MS &&
		end.startedAt === startedAt &&
		sameMap(end.map, status.map) &&
		status.rotationNow === end.rotationNow &&
		status.rotationNext === end.rotationNext &&
		(end.matchSeconds == null ||
			status.matchSeconds == null ||
			status.matchSeconds + 5 >= end.matchSeconds) &&
		!!state &&
		sameMap(state.map, end.map) &&
		Date.parse(state.at) >= end.at - 30_000 &&
		(state.state === 'MatchState.PostMatch' || state.state.startsWith('MatchState.PostMatch.'))
	);
}

export interface MatchCardKill extends FeedKill {
	killerName?: string | null;
	victimName?: string | null;
}
export interface MatchCardData {
	players: TallyRow[];
	kills: MatchCardKill[];
}
export type MatchCardVars = Record<string, string | number>;
const amount = (n: number) => `${n < 0 ? '-' : ''}${compactNumber(Math.abs(n))}`;

/** Competition rank (1, 1, 3); deterministic leaders and rival ties. Includes leavers. */
export function matchCardVars(
	serverName: string,
	steamId: string,
	data: MatchCardData,
	next: Pick<MatchCardEnd, 'nextMap' | 'nextWeather'>
): MatchCardVars | null {
	const mine = data.players.find((p) => p.steamId === steamId);
	if (!mine) return null;
	const records = feedRecord(data.kills);
	// Partial or absent feeds cannot establish a best streak or a most frequent opponent.
	const feedKills = new Map<string, number>(),
		feedDeaths = new Map<string, number>();
	for (const k of data.kills) {
		if (k.killerSteamId && !k.suicide && !k.teamKill)
			feedKills.set(k.killerSteamId, (feedKills.get(k.killerSteamId) ?? 0) + 1);
		feedDeaths.set(k.victimSteamId, (feedDeaths.get(k.victimSteamId) ?? 0) + 1);
	}
	const covered = (p: TallyRow) =>
		records.has(p.steamId) &&
		(feedKills.get(p.steamId) ?? 0) >= p.kills &&
		(feedDeaths.get(p.steamId) ?? 0) >= p.deaths;
	const leader = (value: (p: TallyRow) => number) =>
		[...data.players].sort((a, b) => value(b) - value(a) || a.steamId.localeCompare(b.steamId))[0];
	const killLeader = leader((p) => p.kills),
		cashLeader = leader((p) => p.cashDelta);
	const streakPlayers = data.players.every((p) => (p.kills === 0 && p.deaths === 0) || covered(p))
		? data.players.filter(covered)
		: [];
	const streakLeader = [...streakPlayers].sort(
		(a, b) =>
			records.get(b.steamId)!.killStreak - records.get(a.steamId)!.killStreak ||
			a.steamId.localeCompare(b.steamId)
	)[0];
	const opponents = new Map<string, { name: string; kills: number; deaths: number }>();
	for (const k of data.kills) {
		if (k.suicide || k.teamKill || !k.killerSteamId || k.killerSteamId === k.victimSteamId)
			continue;
		if (k.victimSteamId !== steamId && k.killerSteamId !== steamId) continue;
		const id = k.victimSteamId === steamId ? k.killerSteamId : k.victimSteamId;
		const observedName = k.victimSteamId === steamId ? k.killerName : k.victimName;
		const rival = opponents.get(id) ?? { name: id, kills: 0, deaths: 0 };
		rival.name = data.players.find((p) => p.steamId === id)?.name || observedName || rival.name;
		if (k.victimSteamId === steamId) rival.deaths++;
		else rival.kills++;
		opponents.set(id, rival);
	}
	const rival = covered(mine)
		? [...opponents]
				.filter(([, r]) => r.deaths > 0)
				.sort((a, b) => b[1].deaths - a[1].deaths || a[0].localeCompare(b[0]))[0]?.[1]
		: null;
	const vars: MatchCardVars = {
		server_label: cardServerLabel(serverName),
		match_rank: 1 + data.players.filter((p) => p.kills > mine.kills).length,
		match_kills: Math.max(0, Math.round(mine.kills)),
		match_deaths: Math.max(0, Math.round(mine.deaths)),
		match_kd: (kdRatio(mine.kills, mine.deaths) ?? 0).toFixed(2),
		match_cash: amount(mine.cashDelta),
		match_playtime: compactMinutes(mine.seconds / 60),
		match_streak: covered(mine) ? records.get(steamId)!.killStreak : '',
		match_rival: rival?.name ?? '',
		match_rival_kills: rival?.kills ?? '',
		match_rival_deaths: rival?.deaths ?? '',
		leader_kills_name: killLeader.name,
		leader_kills_value: compactNumber(killLeader.kills),
		leader_cash_name: cashLeader.name,
		leader_cash_value: amount(cashLeader.cashDelta),
		leader_streak_name: streakLeader?.name ?? '',
		leader_streak_value: streakLeader ? records.get(streakLeader.steamId)!.killStreak : '',
		next_map: next.nextMap,
		next_weather: next.nextWeather
	};
	vars.match_card = buildMatchCard(vars);
	return vars;
}

/** Budget names, then omit rival. Fields are never sliced by the transport's final cap. */
export function buildMatchCard(v: MatchCardVars): string {
	// Keep every field bounded, even when a future catalogue or a caller supplies unexpected text.
	const stat = (key: string, max = 8) => {
		const text = String(v[key] ?? '');
		const pattern = [
			'match_kills',
			'match_deaths',
			'match_rival_kills',
			'match_rival_deaths'
		].includes(key)
			? /^\d+$/
			: /^-?\d+(?:\.\d+)?[KMhm]?$/;
		return pattern.test(text) && text.length <= max ? text : '…';
	};
	const card = (width: number, rival: boolean, labelWidth = 32) => {
		const name = (key: string) => shortCardName(String(v[key] ?? ''), width);
		return [
			shortCardName(String(v.server_label), 24),
			`MATCH STATS | Rank #${stat('match_rank', 4)}`,
			`${stat('match_kills')}K/${stat('match_deaths')}D | ${stat('match_kd')} K/D | $${stat('match_cash')}`,
			`${stat('match_playtime')} played${v.match_streak !== '' ? ` | Best streak: ${stat('match_streak')}` : ''}`,
			...(rival && v.match_rival
				? [
						`Rival: ${name('match_rival')} ${stat('match_rival_kills')}K/${stat('match_rival_deaths')}D`
					]
				: []),
			'',
			'LEADERS',
			cardLeaderLine(name('leader_kills_name'), stat('leader_kills_value'), 'kills'),
			cardLeaderLine(name('leader_cash_name'), `$${stat('leader_cash_value')}`, 'cash'),
			...(v.leader_streak_name
				? [cardLeaderLine(name('leader_streak_name'), stat('leader_streak_value'), 'kill streak')]
				: []),
			'',
			`NEXT: ${shortCardName(String(v.next_map), labelWidth)}`,
			`Weather: ${shortCardName(String(v.next_weather), labelWidth)}`
		].join('\n');
	};
	for (const rival of [true, false])
		for (const width of [20, 16, 12, 8]) {
			const rendered = card(width, rival);
			if (rendered.length <= 256) return rendered;
		}
	for (const labelWidth of [32, 24, 16, 8, 1])
		for (const width of [4, 1]) {
			const rendered = card(width, false, labelWidth);
			if (rendered.length <= 256) return rendered;
		}
	return card(1, false, 1);
}

/** Read existing leaver rows and overlay the final observed tallies, without settling totals early. */
export async function readMatchCard(
	env: Env,
	serverId: string,
	map: string,
	lines: TallyRow[]
): Promise<{ id: number; data: MatchCardData } | null> {
	const [match] = await env.db
		.select({ id: matches.id, map: matches.map, startedAt: matches.startedAt })
		.from(matches)
		.where(and(eq(matches.serverId, serverId), isNull(matches.endedAt)))
		.orderBy(desc(matches.id))
		.limit(1);
	if (!match || !sameMap(match.map ?? '', map)) return null;
	const [persisted, feed] = await Promise.all([
		env.db
			.select()
			.from(matchPlayers)
			.where(and(eq(matchPlayers.serverId, serverId), eq(matchPlayers.matchId, match.id))),
		env.db
			.select()
			.from(kills)
			.where(
				and(
					eq(kills.serverId, serverId),
					eq(kills.matchRow, match.id),
					gte(kills.ts, new Date(match.startedAt.getTime() - 120_000))
				)
			)
			.orderBy(kills.eventTime, kills.ts, kills.eventId)
	]);
	const players = new Map<string, TallyRow>(persisted.map((p) => [p.steamId, p]));
	for (const line of lines) players.set(line.steamId, line);
	return { id: match.id, data: { players: [...players.values()], kills: feed } };
}
