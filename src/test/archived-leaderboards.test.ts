import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { DEFAULT_BOARD_QUERY } from '$lib/leaderboard';
import { getOrg } from '$lib/server/access';
import { archivedServers, playerSessions, servers } from '$lib/server/db/schema';
import { orgLeaderboardServers, publicLeaderboardServers } from '$lib/server/leaderboard-servers';
import { loadBoard } from '$lib/server/leaderboards';
import { hasTestDb, testEnv } from './db';
import { seedWorld } from './world';

describe.skipIf(!hasTestDb)('archived leaderboards', () => {
	test('only permitted org boards include an archive and its stored seeding time', async () => {
		const env = await testEnv();
		const w = await seedWorld(env);
		const publishedId = `${w.server.id}_retired`;
		const privateId = `${w.server.id}_private`;
		const steamId = '76561198000000042';
		await env.db
			.update(servers)
			.set({ publicLeaderboards: true })
			.where(eq(servers.id, w.server.id));
		await env.db.insert(archivedServers).values([
			{
				id: publishedId,
				orgId: w.org.id,
				name: 'Server One',
				retiredOn: '2026-01-02',
				publicLeaderboards: true
			},
			{ id: privateId, orgId: w.org.id, name: 'Private', retiredOn: '2026-01-02' },
			{
				id: w.otherOrgServer.id + '_retired',
				orgId: w.otherOrg.id,
				name: 'Other tenant',
				retiredOn: '2026-01-02',
				publicLeaderboards: true
			},
			{
				id: w.server.id,
				orgId: w.org.id,
				name: 'Duplicate live ID',
				retiredOn: '2026-01-02',
				publicLeaderboards: true
			}
		]);
		const joinedAt = new Date('2026-01-01T09:00:00Z');
		const leftAt = new Date('2026-01-01T11:00:00Z');
		await env.db.insert(playerSessions).values(
			[
				[w.server.id, 600],
				[publishedId, 1800],
				[privateId, 3000]
			].map(([serverId, seedSeconds]) => ({
				serverId: String(serverId),
				steamId,
				name: 'Seeder',
				joinedAt,
				leftAt,
				lastSeen: leftAt,
				seedSeconds: Number(seedSeconds)
			}))
		);

		const org = (await getOrg(env, w.org.id))!;
		const publicServers = await publicLeaderboardServers(env, org);
		expect(publicServers.map((s) => s.id)).toEqual([w.server.id, publishedId]);
		expect(publicServers[1].name).toBe('Server One (retired 2026-01-02)');
		expect(await publicLeaderboardServers(env, { ...org, allowPublicLeaderboards: false })).toEqual(
			[]
		);
		expect(await publicLeaderboardServers(env, { ...org, suspendedAt: new Date() })).toEqual([]);
		const ownerServers = await orgLeaderboardServers(env, w.users.owner!, w.org.id);
		expect(ownerServers.filter((s) => s.archived).map((s) => s.id)).toEqual([
			privateId,
			publishedId
		]);
		for (const principal of ['viewer', 'keyAll'] as const) {
			expect(
				(await orgLeaderboardServers(env, w.users[principal]!, w.org.id)).some((s) => s.archived)
			).toBe(false);
		}
		const query = { ...DEFAULT_BOARD_QUERY, scope: 'org', range: 'all', sort: 'seeded' } as const;
		const orgBoard = await loadBoard(
			env,
			publicServers.map((s) => s.id),
			query,
			org.id
		);
		const serverBoard = await loadBoard(env, [w.server.id], { ...query, scope: 'server' }, org.id);
		expect(orgBoard.rows[0]).toMatchObject({ steamId, seedMinutes: 40 });
		expect(serverBoard.rows[0]).toMatchObject({ steamId, seedMinutes: 10 });
	});
});
