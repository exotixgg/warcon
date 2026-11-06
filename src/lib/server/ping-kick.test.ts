// The High ping kick on one look: a rule that spares reserved slots leaves their holders out, and
// until the worker has read the reserved list it holds every kick that falls due, so the first
// look after a start cannot kick a reserved regular. Rules that do not spare them, and rules saved
// before the setting, kick everyone over the limit as before.
import { describe, expect, test } from 'bun:test';
import { evaluateTriggers, validateConfig, type Evaluation, type TickContext } from './triggers';
import { pingKickStep, type PingKickState, type PingKickConfig } from './trigger-rules';
import type { TriggerRow } from './db/schema';
import type { Env } from './env';
import type { Player } from '$lib/types';

const NOW = Date.parse('2026-10-16T18:00:00Z');
const player = (name: string, steamId: string, ping: number): Player => ({
	name,
	steamId,
	faction: 'Valkyra',
	kills: 0,
	deaths: 0,
	cash: 0,
	ping
});
const REGULAR = player('Regular', '76561198000000801', 310);
const VISITOR = player('Visitor', '76561198000000802', 290);

/** Both over the limit for two minutes, as of the look before this one. */
const streaks = (): PingKickState => ({
	lastAt: NOW - 2000,
	players: {
		[REGULAR.steamId]: { since: NOW - 120_000, fired: false },
		[VISITOR.steamId]: { since: NOW - 120_000, fired: false }
	}
});

const rule = (config: unknown) =>
	({
		id: 'rule-ping',
		name: 'High ping kick',
		kind: 'ping_kick',
		config,
		state: streaks(),
		lastFiredAt: null
	}) as unknown as TriggerRow;

const warningRule = (over: Record<string, unknown> = {}, state: PingKickState | null = null) =>
	({
		id: 'rule-ping-warning',
		name: 'High ping kick',
		kind: 'ping_kick',
		config: validateConfig('ping_kick', {
			maxPingMs: 200,
			durationSeconds: 60,
			spareReserved: true,
			warningSeconds: [15, 30, 45],
			warnMessage: 'Ping {ping} / {limit}; {remaining}s left ({warning}/{warnings})',
			...over
		}),
		state: state ?? {
			lastAt: NOW,
			players: {
				[REGULAR.steamId]: { since: NOW, fired: false },
				[VISITOR.steamId]: { since: NOW, fired: false }
			}
		},
		lastFiredAt: null
	}) as unknown as TriggerRow;

/** A look with both players on and REGULAR on the reserved list the worker has read. */
const look = (over: Partial<TickContext> = {}, at = NOW) =>
	({
		server: { id: 'srv', name: 'Panel name' },
		status: {
			serverName: 'Example Clan #1',
			map: 'NorthAmerica',
			playerCount: 2,
			maxPlayers: 100,
			scores: [],
			scoreCap: null
		},
		players: [REGULAR, VISITOR],
		playersObserved: true,
		playersIntervalMs: 2000,
		joined: [],
		renamed: [],
		returned: [],
		riskCheck: [],
		factioned: [],
		firstVisit: new Set(),
		reserved: new Set([REGULAR.steamId]),
		reservedLoaded: true,
		seedMs: new Map(),
		signals: new Map(),
		profiles: new Map(),
		performance: new Map(),
		startedAt: NOW - 3_600_000,
		matchEnd: null,
		matchLines: [],
		ts: new Date(at),
		...over
	}) as unknown as TickContext;
const unread = { reserved: new Set<string>(), reservedLoaded: false };

const evaluate = (row: TriggerRow, ctx: TickContext) => evaluateTriggers({} as Env, ctx, [row]);
const kicked = (ev: Evaluation) =>
	ev.intents
		.filter((i) => i.action === 'kick')
		.map((i) => i.params.steamId as string)
		.sort();
const warned = (ev: Evaluation) =>
	ev.intents
		.filter((i) => i.action === 'whisper')
		.map((i) => i.params.steamId as string)
		.sort();
const streakOf = (row: TriggerRow, p: Player) => (row.state as PingKickState).players[p.steamId];
const BOTH = [REGULAR.steamId, VISITOR.steamId].sort();

describe('the High ping kick and reserved slots', () => {
	test('a rule that spares them kicks the others and ends the reserved player’s streak', async () => {
		const row = rule(validateConfig('ping_kick', { spareReserved: true }));
		const ev = await evaluate(row, look());
		expect(kicked(ev)).toEqual([VISITOR.steamId]);
		expect(ev.intents[0].params.reason).toBe('Ping too high for too long.');
		expect(streakOf(row, REGULAR)).toBeUndefined();
		expect(streakOf(row, VISITOR)).toEqual({ since: NOW - 120_000, fired: true });
		expect(ev.updates.at(-1)?.lastResult).toBe('Kicking Visitor: high ping');
	});

	test('a rule that does not spare them kicks a reserved player too, as does one saved before the setting', async () => {
		const before = { maxPingMs: 200, durationSeconds: 60, reason: 'Ping too high for too long.' };
		for (const config of [validateConfig('ping_kick', {}), before]) {
			expect(kicked(await evaluate(rule(config), look()))).toEqual(BOTH);
			// and it never waits for the reserved list
			expect(kicked(await evaluate(rule(config), look(unread)))).toEqual(BOTH);
		}
	});

	test('before the reserved list is read it kicks nobody and says so; the read lets the kick go', async () => {
		const row = rule(validateConfig('ping_kick', { spareReserved: true }));
		const waiting = await evaluate(row, look(unread));
		expect(waiting.intents).toEqual([]);
		expect(waiting.updates).toEqual([
			{ id: row.id, state: row.state, lastResult: 'Waiting for the reserved slots to be read' }
		]);
		// both streaks go on, neither spent
		expect(streakOf(row, REGULAR)).toEqual({ since: NOW - 120_000, fired: false });
		expect(streakOf(row, VISITOR)).toEqual({ since: NOW - 120_000, fired: false });

		// read at the next look: the reserved player is spared, the other kicked on the same streak
		const read = await evaluate(row, look({}, NOW + 2000));
		expect(kicked(read)).toEqual([VISITOR.steamId]);
		const direct = await evaluate(
			rule(validateConfig('ping_kick', { spareReserved: true })),
			look()
		);
		expect(read.intents[0].dedupeKey).toBe(direct.intents[0].dedupeKey);
		expect(streakOf(row, REGULAR)).toBeUndefined();
		// spent: not again while the ping stays high
		expect(kicked(await evaluate(row, look({}, NOW + 4000)))).toEqual([]);
	});

	test('a streak that has not run its time yet says nothing while the list is unread', async () => {
		const row = rule(validateConfig('ping_kick', { spareReserved: true, durationSeconds: 600 }));
		const ev = await evaluate(row, look(unread));
		expect(ev.intents).toEqual([]);
		expect(ev.updates.map((u) => u.lastResult)).toEqual([undefined]);
	});
});

describe('High ping warning stages', () => {
	test('emits only the latest crossed warning, then lets the kick take precedence', () => {
		const cfg = validateConfig('ping_kick', {
			maxPingMs: 200,
			durationSeconds: 60,
			warningSeconds: [15, 30, 45],
			warnMessage: 'Ping {ping}'
		}) as PingKickConfig;
		let state: PingKickState | null = {
			lastAt: NOW,
			players: { [VISITOR.steamId]: { since: NOW, fired: false } }
		};
		let step = pingKickStep(cfg, state, [VISITOR], NOW + 20_000, 30_000);
		expect(step.warnings).toEqual([{ steamId: VISITOR.steamId, seconds: 15 }]);
		expect(step.kicks).toEqual([]);
		state = step.state;
		step = pingKickStep(cfg, state, [VISITOR], NOW + 50_000, 40_000);
		expect(step.warnings).toEqual([{ steamId: VISITOR.steamId, seconds: 45 }]);
		state = step.state;
		step = pingKickStep(cfg, state, [VISITOR], NOW + 60_000, 20_000);
		expect(step.warnings).toEqual([]);
		expect(step.kicks).toEqual([VISITOR.steamId]);
	});

	test('warns the non-VIP once, renders ping placeholders, and never warns the reserved VIP', async () => {
		const row = warningRule(
			{},
			{
				lastAt: NOW + 18_000,
				players: {
					[REGULAR.steamId]: { since: NOW, fired: false },
					[VISITOR.steamId]: { since: NOW, fired: false }
				}
			}
		);
		const ev = await evaluate(row, look({}, NOW + 20_000));
		expect(kicked(ev)).toEqual([]);
		expect(warned(ev)).toEqual([VISITOR.steamId]);
		expect(ev.intents[0].params.message).toBe('Ping 290 / 200; 40s left (1/3)');
		expect(streakOf(row, REGULAR)).toBeUndefined();
		expect(streakOf(row, VISITOR)).toMatchObject({ since: NOW, fired: false, warned: 15 });

		// A fresh look before the next threshold does not duplicate the first warning.
		expect(warned(await evaluate(row, look({}, NOW + 25_000)))).toEqual([]);
	});

	test('drops below the player floor reset warning progress, while reserved players still count', async () => {
		const row = warningRule({ minPlayers: 2 });
		const low = await evaluate(row, look({ players: [VISITOR] }, NOW + 20_000));
		expect(warned(low)).toEqual([]);
		expect((row.state as PingKickState).players).toEqual({});

		const atFloor = await evaluate(row, look({}, NOW + 40_000));
		expect(warned(atFloor)).toEqual([]); // new streak begins at this look, not at the old 0s one
		expect(streakOf(row, VISITOR)).toMatchObject({ since: NOW + 40_000 });
		expect(streakOf(row, VISITOR)?.warned).toBeUndefined();
		expect(streakOf(row, REGULAR)).toBeUndefined();
	});

	test('does not spend a warning before the reserved list has loaded', async () => {
		const row = warningRule(
			{},
			{
				lastAt: NOW + 18_000,
				players: {
					[REGULAR.steamId]: { since: NOW, fired: false },
					[VISITOR.steamId]: { since: NOW, fired: false }
				}
			}
		);
		const waiting = await evaluate(row, look(unread, NOW + 20_000));
		expect(warned(waiting)).toEqual([]);
		expect(streakOf(row, VISITOR)).toMatchObject({ since: NOW });
		expect(streakOf(row, VISITOR)?.warned).toBeUndefined();

		const loaded = await evaluate(row, look({}, NOW + 22_000));
		expect(warned(loaded)).toEqual([VISITOR.steamId]);
		expect(streakOf(row, VISITOR)).toMatchObject({ warned: 15 });
	});
});
