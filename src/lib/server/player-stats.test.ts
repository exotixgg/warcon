import { describe, expect, test } from 'bun:test';
import {
	acquirePlayerStatsSlot,
	loadPlayerStats,
	parsePlayerStatsQuery,
	playerStatsRequestBudget,
	readPlayerStatsQuery
} from './player-stats';
import type { Db } from './db';

const PLAYER = '76561198000000001';
const OTHER = '76561198000000002';
const query = () => ({
	steamIds: [PLAYER],
	serverIds: ['server-a'],
	from: '2026-01-01T00:00:00Z',
	to: '2026-01-02T00:00:00Z'
});
const now = new Date('2026-01-03T00:00:00Z');

describe('bounded native player stats query', () => {
	test('practical request budget is configurable without allowing unlimited or invalid overrides', () => {
		expect(playerStatsRequestBudget(undefined)).toBe(120);
		expect(playerStatsRequestBudget('')).toBe(120);
		expect(playerStatsRequestBudget('60')).toBe(60);
		expect(playerStatsRequestBudget('240')).toBe(240);
		for (const value of ['0', '241', 'Infinity', 'NaN', '3.5', '-1', 120, null])
			expect(playerStatsRequestBudget(value)).toBe(12);
	});
	test('concurrency admission bounds each key and all keys; releases are idempotent', () => {
		const releases: (() => void)[] = [];
		try {
			const first = acquirePlayerStatsSlot('a')!;
			releases.push(first);
			const second = acquirePlayerStatsSlot('a')!;
			releases.push(second);
			expect(acquirePlayerStatsSlot('a')).toBeNull();
			releases.push(acquirePlayerStatsSlot('b')!, acquirePlayerStatsSlot('c')!);
			expect(acquirePlayerStatsSlot('d')).toBeNull();
			first();
			first();
			const resumed = acquirePlayerStatsSlot('a');
			expect(resumed).not.toBeNull();
			releases.push(resumed!);
			expect(acquirePlayerStatsSlot('d')).toBeNull();
		} finally {
			for (const release of releases) release();
		}
		const final = acquirePlayerStatsSlot('d');
		expect(final).not.toBeNull();
		final!();
	});
	test('source/query failure rejects the whole batch instead of returning unknown zero rows', async () => {
		const db = {
			transaction: async () => {
				throw new Error('source unavailable');
			}
		} as unknown as Db;
		expect(loadPlayerStats(db, query())).rejects.toThrow('source unavailable');
	});
	test('canonicalizes IDs, timestamps and default windows without a floor', () => {
		const parsed = parsePlayerStatsQuery(
			{
				...query(),
				steamIds: [OTHER, PLAYER, PLAYER],
				serverIds: ['server-b', 'server-a', 'server-a']
			},
			now
		);
		expect(parsed.steamIds).toEqual([PLAYER, OTHER]);
		expect(parsed.serverIds).toEqual(['server-a', 'server-b']);
		expect(parsed.from).toBe('2026-01-01T00:00:00.000000Z');
		expect(parsed.playerWindows).toHaveLength(2);
	});
	test('keeps epoch..now available', () => {
		expect(
			parsePlayerStatsQuery(
				{ ...query(), from: '1970-01-01T00:00:00Z', to: now.toISOString() },
				now
			).from
		).toBe('1970-01-01T00:00:00.000000Z');
	});
	test('preserves microsecond membership boundaries exactly', () => {
		const parsed = parsePlayerStatsQuery(
			{ ...query(), from: '2026-01-01T00:00:00.123456Z', to: '2026-01-01T00:00:00.123457Z' },
			now
		);
		expect(parsed.from).toBe('2026-01-01T00:00:00.123456Z');
		expect(parsed.to).toBe('2026-01-01T00:00:00.123457Z');
		expect(() =>
			parsePlayerStatsQuery({ ...query(), to: '2026-01-03T00:00:00.000001Z' }, now)
		).toThrow();
	});
	test('rejects empty, numeric, whitespace, excessive and implicit scopes', () => {
		for (const change of [
			{ steamIds: [] },
			{ steamIds: [Number(PLAYER)] },
			{ steamIds: [' ' + PLAYER] },
			{ steamIds: Array(101).fill(PLAYER) },
			{ serverIds: [] },
			{ serverIds: null },
			{ serverIds: ['server-a '] },
			{ serverIds: Array(33).fill('a') },
			{ scope: 'all' }
		])
			expect(() => parsePlayerStatsQuery({ ...query(), ...change }, now)).toThrow();
	});
	test('rejects invalid, non-UTC, reversed and future windows', () => {
		for (const change of [
			{ from: '2026-02-30T00:00:00Z' },
			{ from: '2026-01-01' },
			{ from: '2026-01-01T00:00:00+00:00' },
			{ from: '1969-01-01T00:00:00Z' },
			{ from: query().to },
			{ to: '2026-01-04T00:00:00Z' }
		])
			expect(() => parsePlayerStatsQuery({ ...query(), ...change }, now)).toThrow();
	});
	test('merges overlap and adjacency per player, retains genuine gaps, does not mutate input', () => {
		const windows = [
			{ steamId: PLAYER, from: '2026-01-01T10:00:00Z', to: '2026-01-01T12:00:00Z' },
			{ steamId: PLAYER, from: '2026-01-01T01:00:00Z', to: '2026-01-01T04:00:00Z' },
			{ steamId: PLAYER, from: '2026-01-01T00:00:00Z', to: '2026-01-01T02:00:00Z' },
			{ steamId: PLAYER, from: '2026-01-01T04:00:00Z', to: '2026-01-01T05:00:00Z' }
		];
		const original = structuredClone(windows);
		const parsed = parsePlayerStatsQuery({ ...query(), playerWindows: windows }, now);
		expect(parsed.playerWindows).toEqual([
			{ steamId: PLAYER, from: '2026-01-01T00:00:00.000000Z', to: '2026-01-01T05:00:00.000000Z' },
			{ steamId: PLAYER, from: '2026-01-01T10:00:00.000000Z', to: '2026-01-01T12:00:00.000000Z' }
		]);
		expect(windows).toEqual(original);
	});
	test('refuses excessive, uncovered, foreign, unknown-field and outside-envelope player windows', () => {
		const valid = { steamId: PLAYER, from: query().from, to: query().to };
		for (const windows of [
			[],
			Array(201).fill(valid),
			[{ ...valid, steamId: OTHER }],
			[{ ...valid, from: '2025-12-31T00:00:00Z' }],
			[{ ...valid, to: '2026-01-03T00:00:00Z' }],
			[{ ...valid, extra: true }],
			[null]
		])
			expect(() => parsePlayerStatsQuery({ ...query(), playerWindows: windows }, now)).toThrow();
		expect(() =>
			parsePlayerStatsQuery({ ...query(), steamIds: [PLAYER, OTHER], playerWindows: [valid] }, now)
		).toThrow();
	});
	test('bounds streamed bytes without trusting Content-Length', async () => {
		const request = new Request('http://localhost', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: ' '.repeat(32769)
		});
		expect(readPlayerStatsQuery(request, now)).rejects.toMatchObject({ status: 413 });
	});
	test('refuses malformed JSON and accepts a bounded body', async () => {
		const request = (body: string) =>
			new Request('http://localhost', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body
			});
		expect(readPlayerStatsQuery(request('{'), now)).rejects.toMatchObject({ status: 400 });
		expect(await readPlayerStatsQuery(request(JSON.stringify(query())), now)).toEqual(
			parsePlayerStatsQuery(query(), now)
		);
	});
});
