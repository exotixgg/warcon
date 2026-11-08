import { describe, expect, test } from 'bun:test';
import type { Rotation } from '$lib/types';
import { placeholdersFor, unfilled } from '$lib/placeholders';
import { serverVars, messageVars, dryRunVars } from './message-vars';
import { renderTemplate } from './trigger-rules';
import {
	MESSAGE_ROTATION_TTL_MS,
	messageRotationSnapshot,
	messageRotationDue,
	nextMessageEntry,
	usesMessageRotation
} from './message-rotation';

const now = 100_000;
const status = { map: 'Bakurani', lighting: 'DayLateRain', rotationNow: 0, rotationNext: 2 };
const rotation: Rotation = {
	enabled: true,
	mode: 'ordered',
	nowIndex: 0,
	nextIndex: 2,
	entries: [
		{
			map: 'Kavkazi',
			lighting: 'DayClear',
			status: 'now',
			experiences: [],
			zoneAlternator: '',
			denied: false
		},
		{
			map: 'Europe',
			lighting: 'DayClear',
			status: '',
			experiences: [],
			zoneAlternator: '',
			denied: false
		},
		{
			map: 'Europe',
			lighting: 'DayEarlyFog',
			status: 'next',
			experiences: [],
			zoneAlternator: '',
			denied: false
		}
	]
};
const snapshot = (r = rotation) => messageRotationSnapshot(status, r, now);

describe('rotation message values', () => {
	test('current weather is live, next weather belongs to the explicit next entry even with repeated maps', () => {
		const vars = messageVars(
			serverVars({ name: 'Server', status, startedAt: 0, now, rotation: snapshot() }),
			null
		);
		expect(
			renderTemplate('{weather} / {CURRENT_WEATHER} / {next_map} / {next_weather}', vars, 256)
		).toBe('Day Late Rain / Day Late Rain / Ozeti / Day Early Fog');
	});
	test('random rotations use an explicit next entry, never an inferred neighbour', () => {
		expect(nextMessageEntry(status, snapshot({ ...rotation, mode: 'random' }), now)?.lighting).toBe(
			'DayEarlyFog'
		);
		expect(nextMessageEntry(status, snapshot({ ...rotation, nextIndex: -1 }), now)).toBeNull();
	});
	test('expired, failed and mismatched observations do not announce a previous next map', () => {
		expect(nextMessageEntry(status, snapshot(), now + MESSAGE_ROTATION_TTL_MS)).toBeNull();
		expect(nextMessageEntry(status, snapshot(), now - 1)).toBeNull();
		expect(nextMessageEntry(status, messageRotationSnapshot(status, null, now), now)).toBeNull();
		expect(nextMessageEntry({ ...status, rotationNext: 1 }, snapshot(), now)).toBeNull();
		expect(nextMessageEntry({ ...status, map: 'NorthAmerica' }, snapshot(), now)).toBeNull();
		expect(nextMessageEntry(status, snapshot({ ...rotation, nowIndex: 1 }), now)).toBeNull();
	});
	test('disabled rotations, invalid pointers, denied entries and ambiguous markers are unknown', () => {
		for (const r of [
			{ ...rotation, enabled: false },
			{ ...rotation, nextIndex: 99 },
			{ ...rotation, nextIndex: 0.5 },
			{ ...rotation, entries: rotation.entries.map((e, i) => ({ ...e, denied: i === 2 })) },
			{
				...rotation,
				entries: rotation.entries.map((e, i) => ({ ...e, status: i === 1 ? 'next' : e.status }))
			},
			{
				...rotation,
				entries: rotation.entries.map((e, i) => ({ ...e, map: i === 0 ? 'Europe' : e.map }))
			}
		])
			expect(nextMessageEntry(status, snapshot(r), now)).toBeNull();
	});
	test('a startup map outside the rotation may have an explicitly known next entry', () => {
		const s = { ...status, rotationNow: -1 };
		const r = {
			...rotation,
			nowIndex: -1,
			entries: rotation.entries.map((e) => ({ ...e, status: e.status === 'now' ? '' : e.status }))
		};
		expect(nextMessageEntry(s, messageRotationSnapshot(s, r, now), now)?.map).toBe('Europe');
	});
	test('missing weather and unavailable historical rotation stay unknown while a known map remains usable', () => {
		const r = { ...rotation, entries: rotation.entries.map((e) => ({ ...e, lighting: '' })) };
		expect(
			serverVars({
				name: 'S',
				status: { ...status, lighting: '' },
				startedAt: 0,
				now,
				rotation: snapshot(r)
			})
		).toMatchObject({ weather: '…', next_map: 'Ozeti', next_weather: '…' });
		expect(dryRunVars('S', null)).toMatchObject({
			weather: '…',
			current_weather: '…',
			next_map: '…',
			next_weather: '…'
		});
	});
	test('reads are cached only while map and both pointers remain the same', () => {
		expect(messageRotationDue(snapshot(), status, now + 1000)).toBe(false);
		expect(messageRotationDue(snapshot(), { ...status, rotationNow: 1 }, now + 1000)).toBe(true);
		expect(messageRotationDue(snapshot(), status, now + MESSAGE_ROTATION_TTL_MS)).toBe(true);
	});
	test('the shared catalogue offers the fields and only next placeholders request a rotation read', () => {
		for (const kind of [
			'welcome',
			'death_whisper',
			'broadcast',
			'match_broadcast',
			'seed_reward'
		] as const) {
			expect(unfilled(['{weather} {current_weather} {next_map} {NEXT_WEATHER}'], kind)).toEqual([]);
			expect(placeholdersFor(kind).find((g) => g.key === 'server')?.names).toContain(
				'next_weather'
			);
		}
		expect(
			usesMessageRotation([{ kind: 'welcome', config: { message: '{current_weather}' } }])
		).toBe(false);
		expect(
			usesMessageRotation([
				{ kind: 'death_whisper', config: { messages: ['"Next: {NEXT_MAP}\\n{next_weather}"'] } }
			])
		).toBe(true);
		expect(
			usesMessageRotation([{ kind: 'seed_reward', config: { noticeMessages: ['{next_weather}'] } }])
		).toBe(true);
		expect(usesMessageRotation([{ kind: 'broadcast', config: { ignored: '{next_map}' } }])).toBe(
			false
		);
	});
});
