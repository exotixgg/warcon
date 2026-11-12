// The Weather cycle rule: its settings, which lighting comes next (nextLighting), what the worker
// queues at a look (evaluateTriggers), and the change itself, against a stand-in game and the mock.
// Sabatulo takes four of the lightings: the rule passes over the rest while the server is on it.
import { describe, expect, test } from 'bun:test';
import type { Env } from './env';
import { ApiError } from './http';
import { WardogsClient } from './rcon';
import {
	changeWeather,
	lightingName,
	nextLighting,
	validateWeatherCycle,
	WEATHER_CYCLE,
	weatherCycleIndex,
	weatherCycleSettingsKey
} from './weather-cycle';
import { evaluateTriggers, SETTINGS_KEYS, validateConfig, type TickContext } from './triggers';
import type { TriggerRow } from './db/schema';
import { takesLighting } from '../format';
import type { Rotation, Status } from '../types';
import { messageRotationSnapshot } from './message-rotation';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 25, 18, 0, 0);
const THREE = ['DayClear', 'DayLateRain', 'DayLateGray'];
const RAIN = 'DayLateRain';
const DRY = ['DayEarlyClear', 'DayClear', 'DayLateClear', 'DayEndClear'];
const rotationFor = (lighting: string, map = 'Kavkazi'): Rotation => ({
	enabled: true,
	mode: 'ordered',
	nowIndex: 0,
	nextIndex: -1,
	entries: [
		{ map, lighting, experiences: [], zoneAlternator: '', denied: false, status: 'now' }
	]
});

const refused = (raw: Record<string, unknown>): string => {
	try {
		validateWeatherCycle(raw);
	} catch (err) {
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(400);
		return (err as ApiError).message;
	}
	throw new Error('accepted');
};

describe('settings', () => {
	test('two lightings or more, every 30 min, in order, with someone on, by default', () => {
		expect(validateWeatherCycle({ lightings: THREE })).toEqual({
			lightings: THREE,
			everyMinutes: 30,
			random: false,
			minPlayers: 1
		});
		expect(validateConfig('weather_cycle', { lightings: THREE })).toEqual(
			validateWeatherCycle({ lightings: THREE })
		);
	});

	test('the same lighting twice is kept once, the first way it was written', () => {
		expect(
			validateWeatherCycle({ lightings: ['DayClear', ' dayclear ', 'DayLateRain'] }).lightings
		).toEqual(['DayClear', 'DayLateRain']);
	});

	test('refused: fewer than two, more than twenty, a name that is no id, a time out of range', () => {
		expect(refused({})).toBe('Pick at least two lightings to change between.');
		expect(refused({ lightings: ['DayClear', 'dayClear'] })).toBe(
			'Pick at least two lightings to change between.'
		);
		expect(refused({ lightings: Array.from({ length: 21 }, (_, i) => `Light${i}`) })).toBe(
			'At most 20 lightings.'
		);
		expect(refused({ lightings: ['DayClear', 'Day Late Rain'] })).toBe(
			'"Day Late Rain" is not a lighting: use the ids the server lists, such as DayLateRain.'
		);
		expect(refused({ lightings: ['DayClear', ''] })).toContain('is not a lighting');
		expect(refused({ lightings: ['DayClear', 'x'.repeat(101)] })).toContain('is not a lighting');
		for (const everyMinutes of [0, 4, 1441, -30])
			expect(refused({ lightings: THREE, everyMinutes })).toBe(
				'Change the weather every 5 to 1440 minutes.'
			);
	});

	test('random only when asked; the player count held to 0-1000', () => {
		const c = (more: Record<string, unknown>) =>
			validateWeatherCycle({ lightings: THREE, ...more });
		expect(c({ random: 'yes' }).random).toBe(false);
		expect(c({ random: true }).random).toBe(true);
		expect(c({ minPlayers: 0 }).minPlayers).toBe(0);
		expect(c({ minPlayers: 5000 }).minPlayers).toBe(1000);
		expect(c({ everyMinutes: 5 }).everyMinutes).toBe(5);
		expect(c({ everyMinutes: '15' }).everyMinutes).toBe(15);
	});

	test('validates excluded presets without changing older rule settings', () => {
		const raw = { lightings: DRY };
		const cfg = validateWeatherCycle(raw);
		expect(validateWeatherCycle({ ...raw, skipStartingLightings: [] })).toEqual(cfg);
		const protectedCfg = validateWeatherCycle({
			...raw,
			skipStartingLightings: [RAIN, 'daylaterain']
		});
		expect(protectedCfg.skipStartingLightings).toEqual([RAIN]);
		expect(weatherCycleSettingsKey(protectedCfg)).not.toBe(weatherCycleSettingsKey(cfg));
		expect(refused({ lightings: THREE, skipStartingLightings: [RAIN] })).toContain(
			'excluded presets'
		);
	});

	test('a queued change carries the settings it was decided under', () => {
		const a = validateWeatherCycle({ lightings: THREE });
		expect(SETTINGS_KEYS.weather_cycle?.(a)).toBe(weatherCycleSettingsKey(a));
		expect(weatherCycleSettingsKey({ ...a })).toBe(weatherCycleSettingsKey(a));
		expect(weatherCycleSettingsKey({ ...a, lightings: [...THREE].reverse() })).not.toBe(
			weatherCycleSettingsKey(a)
		);
	});
});

describe('nextLighting', () => {
	const inTurn = { lightings: THREE, random: false };

	test('in order from the top, passing over the one the server shows', () => {
		expect(nextLighting(inTurn, -1, 'DayEndClear')).toEqual({ index: 0, lighting: 'DayClear' });
		expect(nextLighting(inTurn, -1, 'DayClear')).toEqual({ index: 1, lighting: 'DayLateRain' });
		expect(nextLighting(inTurn, 0, 'DayClear')).toEqual({ index: 1, lighting: 'DayLateRain' });
		expect(nextLighting(inTurn, 1, 'DayLateRain')).toEqual({ index: 2, lighting: 'DayLateGray' });
		// round to the top again
		expect(nextLighting(inTurn, 2, 'DayLateGray')).toEqual({ index: 0, lighting: 'DayClear' });
		// a new map came up on the next one in the list: the one after it
		expect(nextLighting(inTurn, 0, 'daylaterain')).toEqual({ index: 2, lighting: 'DayLateGray' });
		// a place past the end of a list that has since got shorter
		expect(nextLighting(inTurn, 7, '')).toEqual({ index: 2, lighting: 'DayLateGray' });
	});

	test('at random, any but the one the server shows', () => {
		const random = { lightings: THREE, random: true };
		expect(nextLighting(random, 0, 'DayClear', () => 0)).toEqual({
			index: 1,
			lighting: 'DayLateRain'
		});
		expect(nextLighting(random, 0, 'DayClear', () => 0.9999)).toEqual({
			index: 2,
			lighting: 'DayLateGray'
		});
		expect(nextLighting(random, 0, 'DayEarlyFog', () => 0)).toEqual({
			index: 0,
			lighting: 'DayClear'
		});
		const picks = new Set<string>();
		for (let i = 0; i < 200; i++) picks.add(nextLighting(random, 1, 'DayLateRain')!.lighting);
		expect([...picks].sort()).toEqual(['DayClear', 'DayLateGray']);
	});

	test('nothing when the list holds only the one on', () => {
		for (const random of [false, true])
			expect(nextLighting({ lightings: ['DayClear'], random }, -1, 'DayClear')).toBeNull();
	});

	test('on a map that takes only some lightings, the rest are passed over', () => {
		const four = ['DayClear', 'DayEarlyFog', 'DayLateGray', 'DayLateRain'];
		const inOrder = { lightings: four, random: false };
		// Sabatulo takes no fog, by its id or the name players know: the turn goes to the next it takes
		for (const map of ['Russia', 'Sabatulo'])
			expect(nextLighting(inOrder, 0, 'DayClear', undefined, map)).toEqual({
				index: 2,
				lighting: 'DayLateGray'
			});
		// the same turn on another map is fog's
		expect(nextLighting(inOrder, 0, 'DayClear', undefined, 'Kavkazi')).toEqual({
			index: 1,
			lighting: 'DayEarlyFog'
		});
		// at random: never fog there, and never the one on
		const picks = new Set<string>();
		for (let i = 0; i < 200; i++)
			picks.add(
				nextLighting({ lightings: four, random: true }, 0, 'DayClear', undefined, 'Russia')!
					.lighting
			);
		expect([...picks].sort()).toEqual(['DayLateGray', 'DayLateRain']);
		// nothing while the map takes none of the others
		for (const random of [false, true]) {
			const fog = { lightings: ['DayEarlyFog', 'DayStartClear'], random };
			expect(nextLighting(fog, -1, 'DayClear', undefined, 'Russia')).toBeNull();
			expect(nextLighting(fog, -1, 'DayClear', undefined, 'Europe')).not.toBeNull();
			const one = { lightings: ['DayEarlyFog', 'DayClear'], random };
			expect(nextLighting(one, -1, 'DayClear', undefined, 'Russia')).toBeNull();
		}
	});

	test('reads back only a place it wrote', () => {
		expect(weatherCycleIndex(null)).toBe(-1);
		expect(weatherCycleIndex({ index: 'x' })).toBe(-1);
		expect(weatherCycleIndex({ index: -3 })).toBe(-1);
		expect(weatherCycleIndex({ index: 1.5 })).toBe(-1);
		expect(weatherCycleIndex({ index: 2 })).toBe(2);
	});

	test('names come from the id', () => {
		expect(lightingName('DayLateRain')).toBe('Day Late Rain');
		expect(lightingName('DayLateGrayFog')).toBe('Day Late Gray Fog');
	});
});

describe('at the look', () => {
	const rule = (config: Record<string, unknown> = { lightings: THREE }) =>
		({
			id: 'rule-1',
			serverId: 'server-1',
			orgId: 'org-1',
			kind: 'weather_cycle',
			name: 'Weather',
			enabled: true,
			config: validateWeatherCycle(config),
			state: null,
			lastFiredAt: null,
			lastResult: ''
		}) as unknown as TriggerRow;
	const look = (
		row: TriggerRow,
		at: number,
		status: Partial<Status> = {},
		rotation: Rotation | null = null
	) =>
		evaluateTriggers(
			{} as Env,
			{
				server: { id: 'server-1', name: 'Test' },
				status: {
					map: 'Kavkazi',
					rotationNow: 0,
					experiences: ['Bakurani_KOTH_02'],
					lighting: 'DayClear',
					alternator: '',
					playerCount: 12,
					scores: [],
					...status
				},
				messageRotation: messageRotationSnapshot(
					{ map: status.map ?? 'Kavkazi', rotationNow: 0, rotationNext: -1 },
					rotation,
					at
				),
				players: [],
				ts: new Date(at)
			} as unknown as TickContext,
			[row]
		);

	test('at once, then every so many minutes, the next lighting each time', async () => {
		const row = rule();
		const key = weatherCycleSettingsKey(row.config as never);
		let out = await look(row, NOW);
		expect(out.intents).toHaveLength(1);
		expect(out.intents[0]).toMatchObject({
			action: WEATHER_CYCLE,
			params: { rule: key, lighting: 'DayLateRain' },
			target: 'Day Late Rain',
			okMessage: 'Changed the weather to Day Late Rain.',
			detail: { lighting: 'DayLateRain', from: 'DayClear' },
			steamId: null,
			dedupeKey: `rule-1:${NOW}`
		});
		expect(out.updates).toEqual([
			{
				id: 'rule-1',
				lastFiredAt: new Date(NOW),
				lastResult: 'Changing to Day Late Rain',
				state: { index: 1 }
			}
		]);
		// the row moved on with the decision: the looks before the half hour queue nothing
		expect(row.lastFiredAt).toEqual(new Date(NOW));
		for (const at of [NOW + 5_000, NOW + 29 * MIN])
			expect(await look(row, at, { lighting: 'DayLateRain' })).toEqual({
				intents: [],
				updates: []
			});
		out = await look(row, NOW + 30 * MIN, { lighting: 'DayLateRain' });
		expect(out.intents.map((i) => i.params.lighting)).toEqual(['DayLateGray']);
		out = await look(row, NOW + 60 * MIN, { lighting: 'DayLateGray' });
		expect(out.intents.map((i) => i.params.lighting)).toEqual(['DayClear']);
		expect(row.state).toEqual({ index: 0 });
	});

	test('nothing below its player count; a rule for 0 changes an empty server too', async () => {
		const row = rule({ lightings: THREE, minPlayers: 10 });
		expect(await look(row, NOW, { playerCount: 9 })).toEqual({ intents: [], updates: [] });
		expect((await look(row, NOW, { playerCount: 10 })).intents).toHaveLength(1);
		const anyone = rule({ lightings: THREE, minPlayers: 0 });
		expect((await look(anyone, NOW, { playerCount: 0 })).intents).toHaveLength(1);
	});

	test('a new map on a lighting of the list: the change passes over it', async () => {
		const row = rule();
		await look(row, NOW, { lighting: 'DayEndClear' });
		expect(row.state).toEqual({ index: 0 });
		// the next map came up on rain, the next in the list
		const out = await look(row, NOW + 30 * MIN, { lighting: 'DayLateRain' });
		expect(out.intents.map((i) => i.params.lighting)).toEqual(['DayLateGray']);
	});

	test('an excluded round leaves the timer and sequence alone', async () => {
		const row = rule({ lightings: DRY, skipStartingLightings: [RAIN], minPlayers: 20 });
		const status = { playerCount: 20 };
		const protectedRound = await look(row, NOW, status, rotationFor(RAIN));
		expect(protectedRound.intents).toHaveLength(0);
		expect(protectedRound.updates).toHaveLength(0);
		expect(row.lastFiredAt).toBeNull();
		expect(
			(await look(row, NOW, { ...status, lighting: RAIN }, rotationFor(DRY[0]))).intents
		).toHaveLength(0);
		expect((await look(row, NOW, status)).intents).toHaveLength(0);
		expect((await look(row, NOW, status, rotationFor(DRY[0]))).intents[0]?.params).toMatchObject({
			lighting: DRY[0],
			skipStartingLightings: [RAIN],
			minPlayers: 20
		});
	});

	test('the clear cycle skips rainy Sabatulo rounds and uses only compatible presets', async () => {
		const row = rule({ lightings: DRY, skipStartingLightings: [RAIN], minPlayers: 20 });
		const status = { map: 'Sabatulo', playerCount: 20 };
		const rainy = await look(row, NOW, status, rotationFor(RAIN, 'Russia'));
		expect(rainy).toEqual({ intents: [], updates: [] });
		expect(row.lastFiredAt).toBeNull();
		expect(weatherCycleIndex(row.state)).toBe(-1);

		const clear = await look(row, NOW + MIN, status, rotationFor('DayClear', 'Russia'));
		expect(clear.intents[0]?.params).toMatchObject({
			lighting: 'DayLateClear',
			skipStartingLightings: [RAIN]
		});
		expect(row.state).toEqual({ index: 2 });
	});

	test('on Sabatulo: only the lightings it takes, and nothing while the rule has none of them', async () => {
		const fog = ['DayClear', 'DayEarlyFog', 'DayLateRain'];
		// the status names the map by its id or by the name players know
		for (const map of ['Russia', 'Sabatulo']) {
			const row = rule({ lightings: fog });
			const out = await look(row, NOW, { map, lighting: 'DayClear' });
			expect(out.intents.map((i) => i.params.lighting)).toEqual(['DayLateRain']);
			expect(row.state).toEqual({ index: 2 });
		}
		// on another map the same turn is fog's
		const elsewhere = rule({ lightings: fog });
		const there = await look(elsewhere, NOW, { map: 'Europe', lighting: 'DayClear' });
		expect(there.intents.map((i) => i.params.lighting)).toEqual(['DayEarlyFog']);
		// a rule Sabatulo takes nothing of waits the map out, its cadence not moved on, and changes
		// at the first look on the next map
		const row = rule({ lightings: ['DayEarlyFog', 'DayStartClear'] });
		expect(await look(row, NOW, { map: 'Russia', lighting: 'DayClear' })).toEqual({
			intents: [],
			updates: []
		});
		expect(row.lastFiredAt).toBeNull();
		const next = await look(row, NOW + MIN, { map: 'Kavkazi', lighting: 'DayClear' });
		expect(next.intents.map((i) => i.params.lighting)).toEqual(['DayEarlyFog']);
	});

	test('at random: never the lighting on', async () => {
		const row = rule({ lightings: THREE, random: true });
		for (let i = 0; i < 20; i++) {
			row.lastFiredAt = null;
			const out = await look(row, NOW + i * MIN, { lighting: 'DayLateGray' });
			expect(['DayClear', 'DayLateRain']).toContain(out.intents[0].params.lighting as string);
		}
	});
});

// ---- the change at delivery ----

/** A game that lists these lightings and records what it is asked. */
const standIn = (
	ids: string[],
	asked: string[],
	starting = DRY[0],
	active = starting,
	players = 20,
	map = 'Kavkazi'
) =>
	({
		json: async (method: string, path: string, body?: unknown) => {
			asked.push(`${method} ${path}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`);
			if (path === '/v1/catalog/lightings')
				return { lightings: ids.map((id) => ({ id, displayName: `${id} (game's own words)` })) };
			if (path === '/v1/rotation') return rotationFor(starting, map);
			if (path === '/v1/status')
				return {
					map,
					lighting: active,
					rotation: { nowIndex: 0 },
					players: { current: players }
				};
			if (path === '/v1/world/lighting') return { message: "The game's own words." };
			throw new Error(`unexpected ${method} ${path}`);
		}
	}) as unknown as WardogsClient;

describe('changeWeather', () => {
	test('sent when the server lists it, under the id the server gives it, told in the panel’s words', async () => {
		const asked: string[] = [];
		const got = await changeWeather(standIn(['DayClear', 'DayLateRain'], asked), {
			lighting: 'daylaterain'
		});
		expect(got).toEqual({ message: 'Changed the weather to Day Late Rain.' });
		expect(asked).toEqual([
			'GET /v1/catalog/lightings',
			'PUT /v1/world/lighting {"lighting":"DayLateRain"}'
		]);
	});

	test('a lighting the server does not list is not sent', async () => {
		const asked: string[] = [];
		expect(await changeWeather(standIn(['DayClear'], asked), { lighting: 'DayLateRain' })).toEqual({
			skipped: true,
			message: 'Not sent: Day Late Rain is not among the lightings this server lists.'
		});
		expect(asked).toEqual(['GET /v1/catalog/lightings']);
	});

	test('rechecks the live round before delivery and leaves a rainy entry alone', async () => {
		const change = { lighting: DRY[1], skipStartingLightings: [RAIN], minPlayers: 20 };
		const asked: string[] = [];
		expect(await changeWeather(standIn(DRY, asked, RAIN, DRY[0]), change)).toMatchObject({
			skipped: true
		});
		expect(await changeWeather(standIn(DRY, asked, DRY[0], RAIN), change)).toMatchObject({
			skipped: true
		});
		expect(await changeWeather(standIn(DRY, asked, DRY[0], DRY[0], 19), change)).toMatchObject({
			skipped: true
		});
		expect(asked.filter((call) => call.startsWith('PUT'))).toEqual([]);
		expect(await changeWeather(standIn(DRY, asked), change)).toEqual({
			message: 'Changed the weather to Day Clear.'
		});
		expect(asked.slice(-3)).toEqual([
			'GET /v1/rotation',
			'GET /v1/status',
			'PUT /v1/world/lighting {"lighting":"DayClear"}'
		]);
	});

	test('an excluded-preset rule also checks the map from the live status before delivery', async () => {
		const asked: string[] = [];
		const client = standIn(DRY, asked, 'DayClear', 'DayClear', 20, 'Russia');
		const protection = { skipStartingLightings: [RAIN], minPlayers: 20 };
		expect(await changeWeather(client, { ...protection, lighting: 'DayEndClear' })).toEqual({
			skipped: true,
			message: 'Not sent: Sabatulo does not take Day End Clear.'
		});
		expect(asked.some((call) => call.startsWith('PUT'))).toBe(false);
		expect(await changeWeather(client, { ...protection, lighting: 'DayLateClear' })).toEqual({
			message: 'Changed the weather to Day Late Clear.'
		});
	});

	test('against the mock game: the status shows the new lighting', async () => {
		const client = new WardogsClient(
			{} as Env,
			{ id: 'weather-test', host: 'demo', port: 1, scheme: 'http' },
			'demo',
			`weather-test-${Date.now()}`
		);
		const status = () => client.json('GET', '/v1/status') as Promise<Status>;
		const from = (await status()).lighting;
		const to = from === 'DayLateRain' ? 'DayEarlyFog' : 'DayLateRain';
		expect(await changeWeather(client, { lighting: to })).toEqual({
			message: `Changed the weather to ${lightingName(to)}.`
		});
		expect((await status()).lighting).toBe(to);
		expect((await changeWeather(client, { lighting: 'NightStorm' })).skipped).toBe(true);
		expect((await status()).lighting).toBe(to);
	});

	test('the mock game on Sabatulo refuses the lightings the panel passes over there, and no other', async () => {
		const client = new WardogsClient(
			{} as Env,
			{ id: 'weather-sabatulo', host: 'demo', port: 1, scheme: 'http' },
			'demo',
			`weather-sabatulo-${Date.now()}`
		);
		await client.json('POST', '/v1/match/map', {
			map: 'Russia',
			experiences: ['Moscow_KOTH_01'],
			lighting: 'DayClear'
		});
		const { lightings } = (await client.json('GET', '/v1/catalog/lightings')) as {
			lightings: { id: string }[];
		};
		expect(lightings).toHaveLength(9);
		const taken: string[] = [];
		for (const { id } of lightings) {
			const sent = await client.json('PUT', '/v1/world/lighting', { lighting: id }).then(
				() => true,
				() => false
			);
			expect([id, sent]).toEqual([id, takesLighting('Russia', id)]);
			if (sent) taken.push(id);
		}
		expect(taken).toEqual(['DayClear', 'DayLateClear', 'DayLateGray', 'DayLateRain']);
	});
});
