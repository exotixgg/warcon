import { beforeAll, describe, expect, test } from 'bun:test';
import type { Env } from '$lib/server/env';
import {
	archivedServers,
	kills,
	matches,
	matchPlayers,
	playerSessions
} from '$lib/server/db/schema';
import { welcomeCardVars } from '$lib/server/welcome-card';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

const A = '76561198000009101';
const B = '76561198000009102';
const C = '76561198000009103';
const OUTSIDER = '76561198000009104';
const HOUR = 3_600_000;

describe.skipIf(!hasTestDb)('welcome-card season data', () => {
	let env: Env;
	let world: World;
	let retired: string;
	const at = new Date('2026-10-20T12:00:00Z');

	const addMatch = async (
		serverId: string,
		endedAt: Date,
		lines: { steamId: string; name: string; kills: number; deaths: number }[]
	) => {
		const [match] = await env.db
			.insert(matches)
			.values({
				serverId,
				startedAt: new Date(+endedAt - HOUR),
				endedAt,
				map: 'Welcome test',
				finalScores: [],
				winner: null
			})
			.returning({ id: matches.id });
		await env.db.insert(matchPlayers).values(
			lines.map((line, i) => ({
				matchId: match.id,
				serverId,
				steamId: line.steamId,
				name: line.name,
				faction: i % 2 ? 'B' : 'A',
				seconds: 3600,
				kills: line.kills,
				deaths: line.deaths
			}))
		);
	};

	beforeAll(async () => {
		env = await testEnv();
		world = await seedWorld(env);
		retired = `${world.server.id}-retired-welcome`;
		await env.db.insert(archivedServers).values([
			{ id: retired, orgId: world.org.id, name: 'EXOTIX Old', retiredOn: '2026-10-19' },
			{
				id: `${world.otherOrgServer.id}-retired-welcome`,
				orgId: world.otherOrg.id,
				name: 'Not EXOTIX',
				retiredOn: '2026-10-19'
			}
		]);
		// Open sessions are deliberately read by rangeBase without relying on the daily-rollup worker.
		const joined = new Date(Date.now() - 2 * HOUR);
		await env.db.insert(playerSessions).values([
			{ serverId: world.server.id, steamId: A, name: 'Alpha', joinedAt: joined, lastSeen: joined },
			{ serverId: world.server.id, steamId: B, name: 'Bravo', joinedAt: joined, lastSeen: joined },
			{
				serverId: retired,
				steamId: C,
				name: 'Charlie',
				joinedAt: joined,
				lastSeen: joined,
				seedSeconds: 1800
			}
		]);
		// The retired match is in the official Season 2 and must count; the older match must not.
		await addMatch(retired, at, [
			{ steamId: A, name: 'Alpha', kills: 10, deaths: 4 },
			{ steamId: B, name: 'Bravo', kills: 10, deaths: 6 },
			{ steamId: C, name: 'Charlie', kills: 20, deaths: 1 }
		]);
		await addMatch(world.server.id, new Date('2026-10-14T12:00:00Z'), [
			{ steamId: A, name: 'Alpha', kills: 999, deaths: 1 }
		]);
		await addMatch(`${world.otherOrgServer.id}-retired-welcome`, at, [
			{ steamId: OUTSIDER, name: 'Outsider', kills: 9999, deaths: 1 }
		]);
		await env.db.insert(kills).values([
			{
				ts: new Date(+at + 1000),
				serverId: retired,
				eventId: 'rival-b-1',
				instanceId: 'i',
				matchId: 'm',
				eventTime: 1,
				map: 'Test',
				killerSteamId: B,
				killerName: 'Bravo',
				victimSteamId: A,
				victimName: 'Alpha',
				tags: []
			},
			{
				ts: new Date(+at + 2000),
				serverId: retired,
				eventId: 'rival-c',
				instanceId: 'i',
				matchId: 'm',
				eventTime: 2,
				map: 'Test',
				killerSteamId: C,
				killerName: 'Charlie',
				victimSteamId: A,
				victimName: 'Alpha',
				tags: []
			},
			{
				ts: new Date(+at + 3000),
				serverId: retired,
				eventId: 'rival-b-2',
				instanceId: 'i',
				matchId: 'm',
				eventTime: 3,
				map: 'Test',
				killerSteamId: B,
				killerName: 'Bravo',
				victimSteamId: A,
				victimName: 'Alpha',
				tags: []
			},
			{
				ts: new Date(+at + 4000),
				serverId: retired,
				eventId: 'rival-team',
				instanceId: 'i',
				matchId: 'm',
				eventTime: 4,
				map: 'Test',
				killerSteamId: C,
				killerName: 'Charlie',
				victimSteamId: A,
				victimName: 'Alpha',
				teamKill: true,
				tags: []
			},
			{
				ts: new Date(+at + 5000),
				serverId: retired,
				eventId: 'rival-suicide',
				instanceId: 'i',
				matchId: 'm',
				eventTime: 5,
				map: 'Test',
				killerSteamId: A,
				killerName: 'Alpha',
				victimSteamId: A,
				victimName: 'Alpha',
				suicide: true,
				tags: []
			},
			{
				ts: new Date('2026-10-14T12:00:00Z'),
				serverId: retired,
				eventId: 'rival-old',
				instanceId: 'i',
				matchId: 'm',
				eventTime: 6,
				map: 'Test',
				killerSteamId: C,
				killerName: 'Charlie',
				victimSteamId: A,
				victimName: 'Alpha',
				tags: []
			}
		]);
	});

	test('uses only this org and current official season, including archived history', async () => {
		const vars = await welcomeCardVars(env, world.server.id, [A, B, C, OUTSIDER]);
		const alpha = vars.get(A)!;
		expect(alpha.season_name).toBe('SEASON 02');
		expect(alpha.season_kills).toBe(10); // 999 pre-season kills are cut off.
		expect(alpha.season_rank).toBe(2); // Charlie is above; Bravo's equal score shares rank 2.
		expect(alpha.season_rival).toBe('Bravo'); // team kill, suicide and old kill do not affect it.
		expect(vars.get(C)!.season_kills).toBe(20); // retired-server match counts.
		expect(alpha.leader_kills_name).toBe('Charlie');
		const outsider = vars.get(OUTSIDER)!;
		expect(outsider.season_kills).toBe(0); // other organisation is out of scope.
		expect(outsider.season_rank).toBe('-');
		expect(outsider.welcome_card).toContain('0K/0D | 0.00 K/D | 0m/0m');
		expect(alpha.welcome_card).toContain('LEADERS');
	});
});
