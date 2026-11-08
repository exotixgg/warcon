import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';
import type { Env } from '$lib/server/env';
import {
	archivedServers,
	outbox,
	playerSessions,
	triggers,
	type TriggerRow
} from '$lib/server/db/schema';
import { evalSeedNotices } from '$lib/server/seeding-notices';
import { seedingStats } from '$lib/server/seeding-stats';
import { loadPresence, newPresence, persistPresence } from '$lib/server/sessions';
import { validateConfig, type SeedRewardConfig } from '$lib/server/trigger-rules';
import type { TickContext, Evaluation } from '$lib/server/triggers';
import type { SeedSession } from '$lib/server/seeding-messages';

describe.skipIf(!hasTestDb)('seeding messages with stored sessions and deliveries', () => {
	let env: Env;
	let world: World;
	beforeAll(async () => {
		env = await testEnv();
		world = await seedWorld(env);
	});

	test('pending time survives reload, remains outside totals and is discarded on leave', async () => {
		const steamId = '76561198000088101';
		const joinedAt = new Date(Date.now() - 600_000);
		const [row] = await env.db
			.insert(playerSessions)
			.values({
				serverId: world.server.id,
				steamId,
				name: 'Seeder',
				joinedAt,
				lastSeen: new Date(),
				faction: 'TeamA',
				seedSeconds: 60,
				pendingSeedSeconds: 600
			})
			.returning();
		const presence = newPresence();
		await loadPresence(env.db, world.server.id, presence, ['TeamA']);
		const s = presence.open.get(steamId)!;
		expect(s.pendingSeedMs).toBe(600_000);
		expect(s.seedMs).toBe(60_000);
		await persistPresence(
			env.db,
			world.server.id,
			presence,
			{ joined: [], left: [s], stayed: [], renamed: [], returned: [], factioned: [] },
			new Date(),
			true
		);
		const [closed] = await env.db
			.select()
			.from(playerSessions)
			.where(eq(playerSessions.id, row.id));
		expect(closed.seedSeconds).toBe(60);
		expect(closed.pendingSeedSeconds).toBe(0);
	});

	test('season/all totals include other and archived servers, exclude another org and add new live credit once', async () => {
		const steamId = '76561198000088102';
		const retired = randomUUID();
		await env.db
			.insert(archivedServers)
			.values({ id: retired, orgId: world.org.id, name: 'Retired', retiredOn: '2026-11-01' });
		const joinedAt = new Date(Date.now() - 3_600_000);
		const [own] = await env.db
			.insert(playerSessions)
			.values({
				serverId: world.server.id,
				steamId,
				name: 'Seeder',
				joinedAt,
				lastSeen: new Date(),
				seedSeconds: 60,
				pendingSeedSeconds: 600
			})
			.returning();
		await env.db.insert(playerSessions).values([
			{
				serverId: world.otherServer.id,
				steamId,
				name: 'Seeder',
				joinedAt,
				lastSeen: new Date(),
				seedSeconds: 120
			},
			{
				serverId: retired,
				steamId,
				name: 'Seeder',
				joinedAt,
				lastSeen: new Date(),
				seedSeconds: 180
			},
			{
				serverId: world.otherOrgServer.id,
				steamId,
				name: 'Seeder',
				joinedAt,
				lastSeen: new Date(),
				seedSeconds: 9999
			}
		]);
		const session: SeedSession = {
			id: own.id,
			steamId,
			joinedAt: +joinedAt,
			hasFaction: true,
			seedMs: 120_000,
			pendingSeedMs: 600_000,
			creditedNowMs: 60_000
		};
		const stats = (await seedingStats(env, world.server.id, [session])).get(steamId)!;
		expect(stats).toEqual({ seed_all: '7m', seed_season: '7m' });
	});

	test('queued welcome delays intro, then actual delivery starts the delay; state survives a worker reload', async () => {
		const steamId = '76561198000088103';
		const start = Date.now();
		const [s] = await env.db
			.insert(playerSessions)
			.values({
				serverId: world.server.id,
				steamId,
				name: 'Seeder',
				joinedAt: new Date(start),
				lastSeen: new Date(start),
				faction: 'TeamA'
			})
			.returning();
		const cfg = validateConfig('seed_reward', {
			lowAt: 49,
			fullAt: 50,
			minutes: 1440,
			windowDays: 1,
			noticeEnabled: true
		}) as SeedRewardConfig;
		const [row] = await env.db
			.insert(triggers)
			.values({
				id: randomUUID(),
				serverId: world.server.id,
				orgId: world.org.id,
				kind: 'seed_reward',
				name: 'Seed',
				config: cfg,
				enabled: true
			})
			.returning();
		const [welcome] = await env.db
			.insert(outbox)
			.values({
				serverId: world.server.id,
				triggerKind: 'welcome',
				action: 'whisper',
				steamId,
				createdAt: new Date(start),
				dedupeKey: randomUUID(),
				state: 'pending'
			})
			.returning();
		const session: SeedSession = {
			id: s.id,
			steamId,
			joinedAt: start,
			hasFaction: true,
			seedMs: 0,
			pendingSeedMs: 60_000,
			creditedNowMs: 0
		};
		const run = async (now: number, trigger: TriggerRow = row) => {
			const ctx = {
				server: { id: world.server.id, name: 'Test', orgId: world.org.id },
				status: { playerCount: 1, maxPlayers: 100 },
				players: [{ steamId, name: 'Seeder', faction: 'TeamA', ping: 50 }],
				playersObserved: true,
				seedSessions: [session],
				matchPhase: 'MatchState.PreMatch.WaitingForPlayers.PlayerCount',
				startedAt: start - 1000,
				ts: new Date(now)
			} as unknown as TickContext;
			const out: Evaluation = { intents: [], updates: [] };
			await evalSeedNotices(env, ctx, trigger, cfg, out);
			for (const f of out.afterCommit ?? []) f();
			return out;
		};
		expect((await run(start)).intents).toHaveLength(0);
		expect((await run(start + 60_000)).intents).toHaveLength(0);
		await env.db
			.update(outbox)
			.set({ state: 'delivered', doneAt: new Date(start + 70_000) })
			.where(eq(outbox.id, welcome.id));
		expect((await run(start + 75_000)).intents).toHaveLength(0);
		const restored = { ...row, state: JSON.parse(JSON.stringify(row.state)) };
		expect((await run(start + 129_999, restored)).intents).toHaveLength(0);
		const sent = await run(start + 130_000, restored);
		expect(sent.intents).toHaveLength(1);
		expect(sent.intents[0].params.message).toContain('Stay until 50+');
		expect((await run(start + 131_000, restored)).intents).toHaveLength(0);
	});
});
