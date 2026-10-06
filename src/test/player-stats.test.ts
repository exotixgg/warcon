import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import type { PlayerStatsResponse } from '$lib/player-stats';
import { matches, matchPlayers, playerSessions, serverLive } from '$lib/server/db/schema';
import { acquirePlayerStatsSlot, loadPlayerStats } from '$lib/server/player-stats';
import { POST } from '../routes/api/stats/players/query/+server';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';
import { callApi } from './call';
import { resetRates, takeRate } from '$lib/server/ratelimit';
import type { RequestEvent } from '@sveltejs/kit';

const PLAYER = '76561198000000881',
	UNKNOWN = '76561198000000882';
const time = (hour: number) => new Date(Date.UTC(2026, 0, 1, hour));
describe.skipIf(!hasTestDb)('native player statistics on an isolated database', () => {
	let env: Env, w: World;
	const query = () => ({
		steamIds: [PLAYER, UNKNOWN],
		serverIds: [w.server.id],
		from: time(1).toISOString(),
		to: time(5).toISOString()
	});
	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		await env.db.insert(playerSessions).values([
			{
				serverId: w.server.id,
				steamId: PLAYER,
				name: 'P',
				joinedAt: time(0),
				lastSeen: time(3),
				leftAt: time(3)
			},
			// Open but no observation after hour 4: never invent duration up to hour 5/now.
			{ serverId: w.server.id, steamId: PLAYER, name: 'P', joinedAt: time(3), lastSeen: time(4) },
			{
				serverId: w.otherServer.id,
				steamId: PLAYER,
				name: 'P',
				joinedAt: time(0),
				lastSeen: time(5),
				leftAt: time(5)
			}
		]);
		for (const [hour, winner, score, faction] of [
			[1, 'A', 10, 'A'],
			[2, 'B', 10, 'A'],
			[3, null, 10, 'A'],
			[4, null, 0, 'A'],
			[5, 'A', 10, 'A'],
			[2, 'A', 10, 'absent']
		] as const) {
			const [match] = await env.db
				.insert(matches)
				.values({
					serverId: w.server.id,
					startedAt: time(0),
					endedAt: time(hour),
					winner,
					finalScores: [
						{ name: 'A', score },
						{ name: 'B', score: 0 }
					]
				})
				.returning();
			await env.db.insert(matchPlayers).values({
				matchId: match.id,
				serverId: w.server.id,
				steamId: PLAYER,
				name: 'P',
				faction,
				kills: 2,
				deaths: 1,
				cashDelta: 3,
				headshots: 1,
				teamKills: 1,
				suicides: 1,
				vehicleKills: 1,
				killStreak: 2,
				deathStreak: 1
			});
		}
		const [ongoing] = await env.db
			.insert(matches)
			.values({ serverId: w.server.id, startedAt: time(0) })
			.returning();
		await env.db.insert(matchPlayers).values({
			matchId: ongoing.id,
			serverId: w.server.id,
			steamId: PLAYER,
			name: 'P',
			kills: 999
		});
		const [other] = await env.db
			.insert(matches)
			.values({ serverId: w.otherServer.id, startedAt: time(0), endedAt: time(2) })
			.returning();
		await env.db.insert(matchPlayers).values({
			matchId: other.id,
			serverId: w.otherServer.id,
			steamId: PLAYER,
			name: 'P',
			kills: 1000
		});
		await env.db.insert(serverLive).values({
			serverId: w.server.id,
			ok: true,
			observedAt: time(4),
			playersAt: time(4),
			statusAt: time(3)
		});
	});
	test('counts half-open completed matches, native outcomes, observed playtime and unknown coverage', async () => {
		const result = await loadPlayerStats(env.db, query());
		expect(result.coverage.feedDerivatives).toBe('partial');
		expect(result.players).toHaveLength(2);
		expect(result.players[0]).toMatchObject({
			steamId: PLAYER,
			hasObservedData: true,
			playtimeSeconds: 10800,
			matches: 5,
			wins: 1,
			losses: 1,
			draws: 1,
			kills: 10,
			deaths: 5,
			cashDelta: 15,
			headshots: 5,
			killStreak: 2,
			seedtimeSeconds: null,
			coverage: { sessions: 2, matches: 5 }
		});
		expect(result.players[1]).toMatchObject({
			steamId: UNKNOWN,
			hasObservedData: false,
			kills: 0,
			playtimeSeconds: 0,
			coverage: { sessions: 0, matches: 0 }
		});
		expect(result.coverage.servers[0]).toMatchObject({
			serverId: w.server.id,
			ok: true,
			playersAt: time(4).toISOString()
		});
	});
	test('session coverage stays inside the requested window, preserving six-digit boundaries', async () => {
		const from = '2026-01-01T01:00:00.123456Z',
			to = '2026-01-01T02:00:00.654321Z';
		const result = await loadPlayerStats(env.db, { ...query(), steamIds: [PLAYER], from, to });
		expect(result.players[0]).toMatchObject({
			firstSeen: from,
			lastSeen: to,
			coverage: { sessions: 1, matches: 2 }
		});
	});
	test('membership windows merge and leave gaps; playtime clips and match end at new membership belongs once', async () => {
		const result = await loadPlayerStats(env.db, {
			...query(),
			steamIds: [PLAYER],
			playerWindows: [
				{ steamId: PLAYER, from: time(1).toISOString(), to: time(2).toISOString() },
				{ steamId: PLAYER, from: time(1).toISOString(), to: time(2).toISOString() },
				{ steamId: PLAYER, from: time(3).toISOString(), to: time(5).toISOString() }
			]
		});
		expect(result.playerWindows).toHaveLength(2);
		expect(result.players[0]).toMatchObject({
			playtimeSeconds: 7200,
			matches: 3,
			kills: 6,
			coverage: { sessions: 2, matches: 3 }
		});
	});
	test('partitioned windows add up exactly for sums; streaks combine with maximum', async () => {
		const whole = (await loadPlayerStats(env.db, query())).players[0];
		const a = (await loadPlayerStats(env.db, { ...query(), to: time(3).toISOString() })).players[0];
		const b = (await loadPlayerStats(env.db, { ...query(), from: time(3).toISOString() }))
			.players[0];
		for (const key of [
			'playtimeSeconds',
			'matches',
			'kills',
			'deaths',
			'cashDelta',
			'wins',
			'losses',
			'draws',
			'headshots'
		] as const)
			expect(a[key] + b[key]).toBe(whole[key]);
		expect(Math.max(a.killStreak, b.killStreak)).toBe(whole.killStreak);
	});
	test('zero-match session-only player has observed evidence, and match-only player also has evidence', async () => {
		const sessionOnly = (
			await loadPlayerStats(env.db, {
				...query(),
				serverIds: [w.otherServer.id],
				from: time(3).toISOString()
			})
		).players[0];
		expect(sessionOnly).toMatchObject({ hasObservedData: true, matches: 0, playtimeSeconds: 7200 });
		const matchOnly = (await loadPlayerStats(env.db, { ...query(), from: time(4).toISOString() }))
			.players[0];
		expect(matchOnly).toMatchObject({ hasObservedData: true, matches: 1, playtimeSeconds: 0 });
	});
	test('a single observed sighting carries evidence even with zero measured duration', async () => {
		const single = '76561198000000883';
		await env.db.insert(playerSessions).values({
			serverId: w.server.id,
			steamId: single,
			name: 'One sighting',
			joinedAt: time(2),
			lastSeen: time(2)
		});
		const result = (await loadPlayerStats(env.db, { ...query(), steamIds: [single] })).players[0];
		expect(result).toMatchObject({
			hasObservedData: true,
			playtimeSeconds: 0,
			matches: 0,
			coverage: { sessions: 1, matches: 0 }
		});
	});
	test('existing server.view API key authorization checks every server; no session/public access', async () => {
		for (const principal of ['anon', 'owner', 'viewer', 'keyElsewhere'] as const) {
			const result = await callApi(POST, w.users[principal], { method: 'POST', body: query() });
			expect(result.status).toBe(
				principal === 'anon' ? 401 : principal === 'keyElsewhere' ? 404 : 403
			);
		}
		const allowed = await callApi(POST, w.users.keyView, { method: 'POST', body: query() });
		expect(allowed.status).toBe(200);
		expect((allowed.body as PlayerStatsResponse).players).toHaveLength(2);
		for (const forbidden of [w.otherOrgServer.id, 'missing']) {
			const result = await callApi(POST, w.users.keyView, {
				method: 'POST',
				body: { ...query(), serverIds: [w.server.id, forbidden] }
			});
			expect(result.status).toBe(404);
			expect((result.body as { players?: unknown }).players).toBeUndefined();
		}
		const partial = await callApi(POST, w.users.keyElsewhere, {
			method: 'POST',
			body: { ...query(), serverIds: [w.server.id, w.otherServer.id] }
		});
		expect(partial.status).toBe(404);
		expect((partial.body as { players?: unknown }).players).toBeUndefined();
	});
	test('caller limit returns Retry-After with the existing limiter', async () => {
		resetRates();
		const user = w.users.keyView!;
		takeRate(`native-stats:${user.id}`, 12, 12, 60_000);
		try {
			const response = await POST({ locals: { user } } as unknown as RequestEvent);
			expect(response.status).toBe(429);
			expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
			expect((await response.json()).error.code).toBe('rate_limited');
		} finally {
			resetRates();
		}
	});
	test('concurrency refusal returns 429 Retry-After and malformed-body errors release admission', async () => {
		resetRates();
		const user = w.users.keyView!;
		const first = acquirePlayerStatsSlot(user.id)!,
			second = acquirePlayerStatsSlot(user.id)!;
		try {
			const busy = await POST({ locals: { user } } as unknown as RequestEvent);
			expect(busy.status).toBe(429);
			expect(busy.headers.get('retry-after')).toBe('1');
			second();
			const malformed = await POST({
				locals: { user },
				request: new Request('http://localhost', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: '{'
				})
			} as unknown as RequestEvent);
			expect(malformed.status).toBe(400);
			const available = acquirePlayerStatsSlot(user.id);
			expect(available).not.toBeNull();
			available!();
		} finally {
			first();
			second();
			resetRates();
		}
	});
	test('query exceptions release route admission before returning a source error', async () => {
		const db = env.db as unknown as { transaction: () => Promise<unknown> };
		const original = db.transaction;
		const held = acquirePlayerStatsSlot(w.users.keyView!.id)!;
		try {
			db.transaction = async () => {
				throw new Error('test statement timeout');
			};
			const result = await callApi(POST, w.users.keyView, { method: 'POST', body: query() });
			expect(result.status).toBe(500);
			expect((result.body as { players?: unknown }).players).toBeUndefined();
			const available = acquirePlayerStatsSlot(w.users.keyView!.id);
			expect(available).not.toBeNull();
			available!();
		} finally {
			db.transaction = original;
			held();
			resetRates();
		}
	});
	test('PostgreSQL keeps microsecond half-open match attribution', async () => {
		const precise = '2026-01-01T02:00:00.123456Z';
		const [row] = await env.db.execute<{ id: number }>(
			sql`INSERT INTO matches (server_id,started_at,ended_at) VALUES (${w.server.id}, ${time(0).toISOString()}::timestamptz, ${precise}::timestamptz) RETURNING id`
		);
		await env.db.insert(matchPlayers).values({
			matchId: row.id,
			serverId: w.server.id,
			steamId: UNKNOWN,
			name: 'Micro',
			kills: 7
		});
		const before = (await loadPlayerStats(env.db, { ...query(), steamIds: [UNKNOWN], to: precise }))
			.players[0];
		const after = (
			await loadPlayerStats(env.db, { ...query(), steamIds: [UNKNOWN], from: precise })
		).players[0];
		expect(before).toMatchObject({ matches: 0, kills: 0, hasObservedData: false });
		expect(after).toMatchObject({ matches: 1, kills: 7, hasObservedData: true });
	});
});
