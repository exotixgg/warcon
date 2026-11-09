import { describe, expect, test } from 'bun:test';
import type { Player, Rotation, Status, MatchStateView } from '$lib/types';
import { usesMessageRotation, messageRotationSnapshot } from './message-rotation';
import {
	buildMatchCard,
	captureMatchCard,
	matchCardStillHolds,
	matchCardVars,
	type MatchCardEnd,
	type MatchCardKill
} from './match-card';
import { validateConfig } from './trigger-rules';
import type { ParsedEnd } from './feed-core';
import type { TallyRow } from './match-players';
import { buildWelcomeCard } from './welcome-card';

const at = 100_000;
const status = { map: 'Bakurani', rotationNow: 0, rotationNext: 2 } as Status;
const rotation: Rotation = {
	enabled: true,
	mode: 'ordered',
	nowIndex: 0,
	nextIndex: 2,
	entries: [
		{
			map: 'Bakurani',
			lighting: 'DayClear',
			status: 'now',
			experiences: [],
			zoneAlternator: '',
			denied: false
		},
		{
			map: 'Europe',
			lighting: 'NightClear',
			status: '',
			experiences: [],
			zoneAlternator: '',
			denied: false
		},
		{
			map: 'Bakurani',
			lighting: 'DayLateRain',
			status: 'next',
			experiences: [],
			zoneAlternator: '',
			denied: false
		}
	]
};
const end: MatchCardEnd = {
	eventId: 'end',
	at,
	map: status.map,
	rotationNow: 0,
	rotationNext: 2,
	startedAt: 1,
	recipients: ['a'],
	nextMap: 'Bakurani',
	nextWeather: 'Day Late Rain'
};
const state: MatchStateView = {
	state: 'MatchState.PostMatch',
	map: status.map,
	at: new Date(at).toISOString()
};
const row = (
	steamId: string,
	name: string,
	kills: number,
	deaths: number,
	cashDelta = 125_000
): TallyRow => ({ steamId, name, kills, deaths, cashDelta, faction: 'Red', seconds: 2040 });
const kill = (
	killerSteamId: string,
	victimSteamId: string,
	over: Partial<MatchCardKill> = {}
): MatchCardKill => ({
	killerSteamId,
	victimSteamId,
	killerName: killerSteamId,
	victimName: victimSteamId,
	headshot: false,
	teamKill: false,
	suicide: false,
	distanceM: null,
	cause: null,
	...over
});

describe('private match cards', () => {
	test('native configuration, card token requests the rotation lazily', () => {
		expect(validateConfig('match_card', {})).toEqual({ message: '{match_card}', delaySeconds: 5 });
		expect(() => validateConfig('match_card', { message: '' })).toThrow();
		expect(usesMessageRotation([{ kind: 'match_card', config: { message: '{MATCH_CARD}' } }])).toBe(
			true
		);
	});
	test('capture explicit repeated-map next slot and preserve original delay/snapshot on duplicate', () => {
		const m = {
			observedAt: at - 1000,
			lastMatch: {},
			status,
			startedAt: 1,
			players: [{ steamId: 'a' } as Player],
			messageRotation: messageRotationSnapshot(status, rotation, at),
			matchCardEnd: null as MatchCardEnd | null
		};
		const feed = { eventId: 'end', map: 'Bakurani' } as ParsedEnd;
		captureMatchCard(m, feed, at);
		expect(m.matchCardEnd?.nextMap).toBe('Bakurani');
		expect(m.matchCardEnd?.nextWeather).toBe('Day Late Rain');
		m.messageRotation = messageRotationSnapshot(status, { ...rotation, nextIndex: 1 }, at + 1000);
		captureMatchCard(m, feed, at + 1000);
		captureMatchCard(m, { ...feed, eventId: 'same-match-again' }, at + 2000);
		expect(m.matchCardEnd?.at).toBe(at);
		expect(m.matchCardEnd?.nextWeather).toBe('Day Late Rain');
		captureMatchCard({ ...m, observedAt: 0, matchCardEnd: null }, feed, at);
		const startup = { ...m, lastMatch: null, matchCardEnd: null };
		captureMatchCard(startup, feed, at);
		expect(startup.matchCardEnd).toBeNull();
	});
	test('never deliver into a new phase, repeated map slot, restarted process or an old window', () => {
		expect(matchCardStillHolds(end, status, state, 1, at + 5000)).toBe(true);
		for (const phase of ['MatchState.Playing', 'MatchState.PreMatch.WaitingForWorldLoad'])
			expect(matchCardStillHolds(end, status, { ...state, state: phase }, 1, at + 6000)).toBe(
				false
			);
		expect(matchCardStillHolds(end, { ...status, rotationNow: 2 }, state, 1, at + 6000)).toBe(
			false
		);
		expect(matchCardStillHolds(end, status, state, 2, at + 6000)).toBe(false);
		expect(matchCardStillHolds(end, status, state, 1, at + 120001)).toBe(false);
		expect(matchCardStillHolds(null, status, state, 1, at)).toBe(false);
		expect(
			matchCardStillHolds(
				{ ...end, matchSeconds: 1800 },
				{ ...status, matchSeconds: 0 },
				state,
				1,
				at + 6000
			)
		).toBe(false);
	});
	test('competition rank, leaver highlights, signed cash earnings and missing feed omissions', () => {
		const data = {
			players: [
				row('a', 'Player', 42, 18, -1000),
				row('b', 'Leaver', 68, 10),
				row('c', 'Tie', 42, 20)
			],
			kills: []
		};
		const v = matchCardVars('EXOTIX EU-01', 'a', data, end)!;
		expect(v.match_rank).toBe(2);
		expect(matchCardVars('s', 'c', data, end)!.match_rank).toBe(2);
		expect(v.match_cash).toBe('-1.0K');
		expect(v.match_card).toContain('Leaver — 68 kills');
		expect(v.match_card).toContain('42K/18D | 2.33 K/D');
		expect(v.match_card).not.toContain('Best streak');
		expect(v.match_card).not.toContain('Rival:');
		expect(matchCardVars('s', 'absent', data, end)).toBeNull();
		const large = matchCardVars('s', 'x', { players: [row('x', 'X', 1000, 20)], kills: [] }, end)!;
		expect(large.match_card).toContain('1000K/20D');
		expect(large.match_card).not.toContain('1.0KK');
	});
	test('streaks and rival exclude team kills and suicides; opponent outside scoreboard uses victim name', () => {
		const data = {
			players: [row('a', 'Receiver', 2, 4), row('b', 'Ghost', 1, 2)],
			kills: [
				kill('a', 'x', { victimName: 'Outside' }),
				kill('a', 'b'),
				kill('x', 'a', { killerName: 'Outside' }),
				kill('x', 'a', { killerName: 'Outside' }),
				kill('b', 'a'),
				kill('a', 'a', { suicide: true }),
				kill('b', 'b', { suicide: true }),
				kill('b', 'other', { teamKill: true })
			]
		};
		const v = matchCardVars('EXOTIX EU-01', 'a', data, end)!;
		expect(v.match_streak).toBe(2);
		expect(v.match_rival).toBe('Outside');
		expect(v.match_rival_kills).toBe(1);
		expect(v.match_rival_deaths).toBe(2);
		expect(v.match_card).toContain('Rival: Outside 1K/2D');
		expect(v.match_card).toContain('Best streak: 2');
		const extra = matchCardVars(
			's',
			'a',
			{
				...data,
				kills: [...data.kills, kill('b', 'a', { teamKill: true })]
			},
			end
		)!;
		expect(extra.match_streak).toBe(2);
		expect(extra.match_rival).toBe('Outside');
		expect(extra.match_card).toContain('kill streak');
		data.kills.pop();
		data.kills.shift();
		expect(matchCardVars('s', 'a', data, end)!.match_streak).toBe('');
	});
	test('matches the welcome leader wording byte for byte', () => {
		const match = String(
			matchCardVars('s', 'a', { players: [row('a', 'Mercury', 68, 19, 250000)], kills: [] }, end)!
				.match_card
		);
		const welcome = buildWelcomeCard({
			leader_kills_name: 'Mercury',
			leader_kills_value: '68',
			leader_cash_name: 'Mercury',
			leader_cash_value: '250K'
		});
		for (const line of ['Mercury — 68 kills', 'Mercury — $250K cash']) {
			expect(welcome).toContain(line);
			expect(match).toContain(line);
		}
	});
	test('extreme realistic cards and adversarial input stay within 256 without cutting final fields', () => {
		const name = '👩🏽‍🚀'.repeat(30);
		const v = matchCardVars(
			'EXOTIX EU-01 VERY LONG SERVER',
			'a',
			{ players: [row('a', name, 999, 999, 999_999_999), row('b', name, 1000, 1000)], kills: [] },
			end
		)!;
		Object.assign(v, {
			match_streak: 999,
			match_rival: name,
			match_rival_kills: 999,
			match_rival_deaths: 999,
			leader_streak_name: name,
			leader_streak_value: 999
		});
		const rendered = buildMatchCard(v);
		expect(rendered.length).toBeLessThanOrEqual(256);
		expect(rendered).toEndWith('NEXT: Bakurani\nWeather: Day Late Rain');
		expect(rendered).toContain('999K/999D | 1.00 K/D');
		expect(rendered).toContain('LEADERS');
		const bad = Object.fromEntries(Object.keys(v).map((k) => [k, name.repeat(10)]));
		const bounded = buildMatchCard(bad);
		expect(bounded.length).toBeLessThanOrEqual(256);
		expect(bounded).toContain('LEADERS');
		expect(bounded).toContain('Weather:');
		const hugeNumbers = Object.fromEntries(Object.keys(v).map((k) => [k, '99999999']));
		Object.assign(hugeNumbers, {
			server_label: name,
			match_rank: '9999',
			next_map: name,
			next_weather: name
		});
		expect(buildMatchCard(hugeNumbers).length).toBeLessThanOrEqual(256);
	});
});
