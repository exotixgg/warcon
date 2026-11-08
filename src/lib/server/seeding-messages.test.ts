import { describe, expect, test } from 'bun:test';
import {
	planSeedNotices,
	seedTime,
	validateSeedNotices,
	type SeedSession,
	type SeedNoticeState
} from './seeding-messages';
import { renderTemplate, validateConfig } from './trigger-rules';
import { SEED_NOTICE_MESSAGES, SEED_COMPLETE_MESSAGE } from '$lib/seeding-messages';

const cfg = validateSeedNotices({ noticeEnabled: true });
const session: SeedSession = {
	id: 1,
	steamId: '76561198000000001',
	joinedAt: 0,
	hasFaction: true,
	seedMs: 0,
	pendingSeedMs: 60_000,
	creditedNowMs: 0
};
const waiting = 'MatchState.PreMatch.WaitingForPlayers.PlayerCount';
const play = 'MatchState.Playing.KOTH';
const step = (state: SeedNoticeState, now: number, phase = waiting, players = 10, s = session) =>
	planSeedNotices(cfg, state, [s], { now, phase, players, lowAt: 49, fullAt: 50 });

describe('seeding cards', () => {
	test('waits for faction pick and the configured delay; loading and post-match stay quiet', () => {
		expect(step({}, 1000, waiting, 10, { ...session, hasFaction: false }).picks).toEqual([]);
		const first = step({}, 1000);
		expect(first.picks).toEqual([]);
		expect(step(first.state, 60_999).picks).toEqual([]);
		expect(step(first.state, 61_000).picks[0].stage).toBe('intro');
		for (const phase of ['', 'MatchState.PreMatch.WaitingForWorldLoad', 'MatchState.PostMatch'])
			expect(step(first.state, 61_000, phase).picks).toEqual([]);
	});
	test('repeats only while waiting below the start target, never on population alone', () => {
		const state = step({}, 1000).state;
		state[session.steamId].lastAt = 61_000;
		state[session.steamId].index = 1;
		expect(step(state, 360_999).picks).toEqual([]);
		expect(step(state, 361_000).picks[0].text).toBe(cfg.noticeMessages[1]);
		expect(step(state, 361_000, waiting, 20).picks).toEqual([]);
		expect(step(state, 361_000, play, 30).picks).toEqual([]);
		expect(step(state, 361_000, play, 9).picks).toEqual([]);
	});
	test('late arrivals receive one explanation during play, then no repeated cards', () => {
		const first = step({}, 1000, play, 40);
		expect(step(first.state, 61_000, play, 40).picks[0].stage).toBe('intro');
		expect(step(first.state, 61_000, play, 50).picks).toEqual([]);
	});
	test('credits at 50; delays confirmation instead of colliding with welcome', () => {
		const credited = { ...session, seedMs: 600_000, pendingSeedMs: 0, creditedNowMs: 600_000 };
		const first = step({}, 1000, play, 50, credited);
		expect(first.picks).toEqual([]);
		const later = step(JSON.parse(JSON.stringify(first.state)), 61_000, play, 50, {
			...credited,
			creditedNowMs: 0
		});
		expect(later.picks[0].stage).toBe('complete');
		expect(later.state[session.steamId].creditMs).toBe(600_000);
		later.state[session.steamId].creditMs = 0;
		later.state[session.steamId].lastAt = 61_000;
		expect(step(later.state, 62_000, play, 50, { ...credited, creditedNowMs: 0 }).picks).toEqual(
			[]
		);
	});
	test('a new session cannot inherit an old confirmation or cooldown', () => {
		const before = step({}, 1000).state;
		before[session.steamId].creditMs = 300_000;
		const next = step(before, 100_000, waiting, 10, { ...session, id: 2 });
		expect(next.state[session.steamId].creditMs).toBe(0);
		expect(next.picks).toEqual([]);
	});
	test('a brief missing roster retains progress without delivering to an absent player', () => {
		const before = step({}, 1000).state;
		const absent = step(before, 61_000, waiting, 10, { ...session, hasFaction: false });
		expect(absent.picks).toEqual([]);
		expect(absent.state[session.steamId].readyAt).toBe(61_000);
	});
	test('templates fit; JSON strings work; notices remain opt-in', () => {
		const base = { lowAt: 49, fullAt: 50, minutes: 1440, windowDays: 1 };
		expect((validateConfig('seed_reward', base) as any).noticeEnabled).toBeUndefined();
		const c = validateConfig('seed_reward', {
			...base,
			noticeEnabled: true,
			noticeMessages: [JSON.stringify('A\nB')]
		}) as any;
		expect(c.noticeMessages).toEqual(['A\nB']);
		for (const template of [...SEED_NOTICE_MESSAGES, SEED_COMPLETE_MESSAGE]) {
			expect(template.length).toBeLessThanOrEqual(256);
			const rendered = renderTemplate(
				template,
				{
					seed_session: '123h59m',
					seed_pending: '123h59m',
					seed_all: '99999h59m',
					seed_season: '9999h59m',
					seed_credited_now: '123h59m',
					seed_target: 50,
					round_start_players: 20,
					players: 19
				},
				10_000
			);
			expect(rendered.length).toBeLessThanOrEqual(256);
			expect(rendered).not.toContain('{');
		}
		expect(seedTime(3_599_999)).toBe('59m');
		expect(seedTime(3_600_000)).toBe('1h0m');
	});
});
