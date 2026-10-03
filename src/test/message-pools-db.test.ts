import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { kills, outbox, playerSessions, servers } from '$lib/server/db/schema';
import {
	poolConfigOf,
	poolStillHolds,
	queueBanAnnouncements,
	queueDirectBanAnnouncement,
	queueObservationPools,
	queueWeaponPools,
	savePoolConfig
} from '$lib/server/exotix/message-pools';
import { grantEntry, listOf } from '$lib/server/lists';
import { PANEL_BAN } from '$lib/server/rule-ban';
import { ingestBatch } from '$lib/server/feed';
import type { MessagePool } from '$lib/message-pools';
import type { KillView, Player, Status } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { seedWorld } from './world';

const STEAM = '76561198000000777';
const pool = (
	id: string,
	action: MessagePool['action'],
	extra: Partial<MessagePool> = {}
): MessagePool => ({
	id,
	name: id,
	action,
	enabled: true,
	mode: 'ordered',
	messages: ['Hello {player_name}'],
	sendCount: 1,
	initialDelaySeconds: 0,
	spacingSeconds: 10,
	allServers: true,
	serverIds: [],
	onlyFirstVisit: false,
	categoryId: action === 'ban' ? 'general' : '',
	banSources: ['policy', 'legacy', 'automatic'],
	weaponTags: [],
	teamKillsOnly: false,
	thresholds: [],
	everyMinutes: 10,
	minPlayers: 1,
	maxPlayers: null,
	...extra
});

describe.skipIf(!hasTestDb)('message pools on a real database', () => {
	let env: Env;
	beforeAll(async () => {
		env = await testEnv();
	});
	const serverOf = async (id: string) =>
		(await env.db.select().from(servers).where(eq(servers.id, id)))[0];

	test('a join can queue two delayed messages and edited pools stop queued delivery', async () => {
		const world = await seedWorld(env);
		const server = await serverOf(world.server.id);
		const old = await poolConfigOf(env.db, world.org.id);
		const join = pool('join-all', 'join', {
			messages: ['Hello {player_name}', 'Welcome to {server_name}'],
			sendCount: 2,
			initialDelaySeconds: 5,
			spacingSeconds: 12
		});
		const saved = await env.db.transaction((tx) =>
			savePoolConfig(tx, world.org.id, { pools: [join] }, old.version)
		);
		const now = new Date();
		const status = {
			serverName: server.name,
			map: 'Kavkazi',
			playerCount: 12,
			maxPlayers: 100
		} as Status;
		const player = { steamId: STEAM, name: 'Test Player', faction: 'A' } as Player;
		const queued = await env.db.transaction((tx) =>
			queueObservationPools(tx, server, status, [player], new Set(), null, [], now)
		);
		expect(queued).toBe(2);
		const rows = await env.db
			.select()
			.from(outbox)
			.where(and(eq(outbox.serverId, world.server.id), eq(outbox.triggerKind, 'message_pool')));
		expect(rows.map((row) => row.params)).toMatchObject([
			{ steamId: STEAM, message: 'Hello Test Player' },
			{ steamId: STEAM, message: `Welcome to ${server.name}` }
		]);
		expect(rows[0].notBefore.getTime() - now.getTime()).toBe(5000);
		expect(rows[1].notBefore.getTime() - rows[0].notBefore.getTime()).toBe(12000);
		expect(await poolStillHolds(env.db, world.server.id, rows[0].params)).toBe(true);
		await env.db.transaction((tx) =>
			savePoolConfig(
				tx,
				world.org.id,
				{
					pools: [{ ...join, enabled: false }]
				},
				saved.version
			)
		);
		expect(await poolStillHolds(env.db, world.server.id, rows[0].params)).toBe(false);
	});

	test('round start and end both fire at a detected boundary without a winning faction', async () => {
		const world = await seedWorld(env);
		const server = await serverOf(world.server.id);
		const before = await poolConfigOf(env.db, world.org.id);
		await env.db.transaction((tx) =>
			savePoolConfig(
				tx,
				world.org.id,
				{
					pools: [
						pool('round-start', 'round_start', { messages: ['Start {map}'] }),
						pool('round-end', 'round_end', { messages: ['Ended {previous_map}'] })
					]
				},
				before.version
			)
		);
		const status = {
			serverName: server.name,
			map: 'New Map',
			playerCount: 12,
			maxPlayers: 100
		} as Status;
		const queued = await env.db.transaction((tx) =>
			queueObservationPools(
				tx,
				server,
				status,
				[],
				new Set(),
				{ map: 'Old Map', scores: [], winner: null, leaders: [] },
				[],
				new Date()
			)
		);
		expect(queued).toBe(2);
		const rows = await env.db
			.select({ params: outbox.params })
			.from(outbox)
			.where(and(eq(outbox.serverId, world.server.id), eq(outbox.triggerKind, 'message_pool')));
		expect(rows.map((row) => row.params)).toMatchObject([
			{ message: 'Start New Map' },
			{ message: 'Ended Old Map' }
		]);
	});

	test('join history counts only organisation sessions and fills round awards', async () => {
		const world = await seedWorld(env);
		const server = await serverOf(world.server.id);
		const before = await poolConfigOf(env.db, world.org.id);
		await env.db.transaction((tx) =>
			savePoolConfig(
				tx,
				world.org.id,
				{
					pools: [
						pool('history', 'join', {
							messages: [
								'{welcome_phrase} {player_name}: visit {server_visit_count}/{exotix_visit_count}, time {server_connected_time}/{exotix_connected_time}'
							]
						}),
						pool('awards', 'round_end', {
							messages: [
								'Kills {top_kills_name} {top_kills_count}',
								'Cash {top_cash_name} {top_cash_gain}',
								'GG on {previous_map}'
							],
							sendCount: 2
						})
					]
				},
				before.version
			)
		);
		const now = new Date('2026-10-03T12:00:00Z');
		const player = { steamId: STEAM, name: 'Test Player', faction: 'A' } as Player;
		await env.db.insert(playerSessions).values([
			{
				serverId: world.server.id,
				steamId: STEAM,
				name: player.name,
				joinedAt: new Date(now.getTime() - 3_600_000),
				lastSeen: new Date(now.getTime() - 1_800_000),
				leftAt: new Date(now.getTime() - 1_800_000)
			},
			{
				serverId: world.otherServer.id,
				steamId: STEAM,
				name: player.name,
				joinedAt: new Date(now.getTime() - 7_200_000),
				lastSeen: new Date(now.getTime() - 5_400_000),
				leftAt: new Date(now.getTime() - 5_400_000)
			},
			{
				serverId: world.otherOrgServer.id,
				steamId: STEAM,
				name: player.name,
				joinedAt: new Date(now.getTime() - 10_800_000),
				lastSeen: new Date(now.getTime() - 9_000_000),
				leftAt: new Date(now.getTime() - 9_000_000)
			},
			{ serverId: world.server.id, steamId: STEAM, name: player.name, joinedAt: now, lastSeen: now }
		]);
		const status = {
			serverName: server.name,
			map: 'New Map',
			playerCount: 12,
			maxPlayers: 100
		} as Status;
		const queued = await env.db.transaction((tx) =>
			queueObservationPools(
				tx,
				server,
				status,
				[player],
				new Set(),
				{ map: 'Old Map', scores: [], winner: null, leaders: [] },
				[
					{ name: 'Ace', kills: 14, deaths: 2, cashDelta: 500 },
					{ name: 'Banker', kills: 0, deaths: 0, cashDelta: 800 }
				],
				now
			)
		);
		expect(queued).toBe(3);
		const rows = await env.db
			.select({ params: outbox.params })
			.from(outbox)
			.where(and(eq(outbox.serverId, world.server.id), eq(outbox.triggerKind, 'message_pool')));
		expect(rows.map((row) => row.params)).toMatchObject([
			{ message: 'Welcome back Test Player: visit 2/3, time 30m/1h 0m' },
			{ message: 'Kills Ace 14' },
			{ message: 'Cash Banker 800' }
		]);
	});

	test('an organisation ban announces only where the player played in the last hour', async () => {
		const world = await seedWorld(env);
		const before = await poolConfigOf(env.db, world.org.id);
		expect(before.pools).toMatchObject([
			{
				action: 'ban',
				categoryId: 'general',
				allServers: true,
				enabled: true,
				banSources: ['policy', 'legacy', 'automatic']
			}
		]);
		await env.db.transaction((tx) =>
			savePoolConfig(
				tx,
				world.org.id,
				{
					pools: [
						pool('general-ban', 'ban', {
							messages: ['{player_name} banned for {ban_reason} ({ban_duration}).']
						})
					]
				},
				before.version
			)
		);
		const now = new Date();
		const recent = new Date(now.getTime() - 25 * 60_000);
		const old = new Date(now.getTime() - 61 * 60_000);
		await env.db.insert(playerSessions).values([
			{
				serverId: world.server.id,
				steamId: STEAM,
				name: 'Recent Player',
				joinedAt: new Date(recent.getTime() - 5 * 60_000),
				lastSeen: recent,
				leftAt: recent
			},
			{
				serverId: world.otherServer.id,
				steamId: STEAM,
				name: 'Stale Player',
				joinedAt: new Date(old.getTime() - 5 * 60_000),
				lastSeen: old,
				leftAt: old
			},
			{
				serverId: world.otherOrgServer.id,
				steamId: STEAM,
				name: 'Recent Elsewhere',
				joinedAt: new Date(recent.getTime() - 5 * 60_000),
				lastSeen: recent,
				leftAt: recent
			}
		]);
		const list = await listOf(env, world.org.id, 'ban');
		const result = await grantEntry(env, list, {
			steamId: STEAM,
			reason: 'Rule violation',
			expiresAt: null,
			addedByName: 'automatic rule'
		});
		expect(result.added).toBe(true);
		const announcements = await env.db
			.select()
			.from(outbox)
			.where(and(eq(outbox.triggerKind, 'message_pool'), eq(outbox.triggerName, 'general-ban')));
		const inOrg = announcements.filter((row) => row.dedupeKey.includes(`ban:${result.id}`));
		expect(inOrg).toHaveLength(1);
		expect(inOrg[0].serverId).toBe(world.server.id);
		expect(inOrg[0].params).toMatchObject({
			message: 'Recent Player banned for Rule violation (Permanent).'
		});
		expect(inOrg.every((row) => row.action === 'broadcast')).toBe(true);
		const caseRecord = {
			categoryId: 'cheating',
			category: 'Cheating',
			reference: 't-12345',
			source: 'manual',
			description: 'PRIVATE EVIDENCE NEVER TO ANNOUNCE'
		};
		await env.db.transaction((tx) =>
			queueBanAnnouncements(
				tx,
				list,
				{
					id: 'private-case-test',
					steamId: STEAM,
					reason: 'Cheating',
					expiresAt: null,
					automatic: false
				},
				caseRecord
			)
		);
		const privateCaseRows = await env.db
			.select()
			.from(outbox)
			.where(eq(outbox.triggerName, 'general-ban'));
		expect(JSON.stringify(privateCaseRows)).not.toContain(caseRecord.description);
	});

	test('a pending player review uses only its own neutral announcement pool', async () => {
		const world = await seedWorld(env);
		const before = await poolConfigOf(env.db, world.org.id);
		const general = pool('general-ban', 'ban', {
			messages: ['{player_name} was banned for a rule violation.']
		});
		const review = pool('player-review', 'ban', {
			categoryId: 'player-review',
			banSources: ['policy'],
			messages: ['{player_name} is restricted pending staff review; no decision has been made.']
		});
		const saved = await env.db.transaction((tx) =>
			savePoolConfig(tx, world.org.id, { pools: [general, review] }, before.version)
		);
		const lastSeen = new Date(Date.now() - 3 * 60_000);
		await env.db.insert(playerSessions).values({
			serverId: world.server.id,
			steamId: STEAM,
			name: 'Player Under Review',
			joinedAt: new Date(lastSeen.getTime() - 20 * 60_000),
			lastSeen,
			leftAt: lastSeen
		});
		const list = await listOf(env, world.org.id, 'ban');
		const caseRecord = {
			categoryId: 'player-review',
			category: 'Player review',
			reference: 't-12345',
			source: 'manual',
			reviewStatus: 'pending',
			description: 'PRIVATE CASE NOTES'
		};
		const entry = {
			id: 'pending-review-1',
			steamId: STEAM,
			reason: 'Player review',
			expiresAt: null,
			automatic: false
		};
		expect(
			await env.db.transaction((tx) => queueBanAnnouncements(tx, list, entry, caseRecord))
		).toBe(1);
		const announcements = await env.db
			.select()
			.from(outbox)
			.where(eq(outbox.triggerName, 'player-review'));
		expect(announcements).toHaveLength(1);
		expect(announcements[0]).toMatchObject({
			serverId: world.server.id,
			triggerName: 'player-review',
			action: 'broadcast',
			params: {
				message:
					'Player Under Review is restricted pending staff review; no decision has been made.'
			}
		});
		expect(JSON.stringify(announcements)).not.toContain(caseRecord.description);
		await env.db.transaction((tx) =>
			savePoolConfig(tx, world.org.id, { pools: [general] }, saved.version)
		);
		expect(
			await env.db.transaction((tx) =>
				queueBanAnnouncements(tx, list, { ...entry, id: 'pending-review-2' }, caseRecord)
			)
		).toBe(0);
	});

	test('a direct game ban requires a recent session on that server', async () => {
		const world = await seedWorld(env);
		const server = await serverOf(world.server.id);
		const recent = new Date(Date.now() - 25 * 60_000);
		await env.db.insert(playerSessions).values({
			serverId: server.id,
			steamId: STEAM,
			name: 'Recent Player',
			joinedAt: new Date(recent.getTime() - 5 * 60_000),
			lastSeen: recent,
			leftAt: recent
		});
		expect(
			await queueDirectBanAnnouncement(env.db, server, '76561198000000888', 'Rule violation')
		).toBe(0);
		expect(await queueDirectBanAnnouncement(env.db, server, STEAM, 'Rule violation')).toBe(1);
		const rows = await env.db
			.select()
			.from(outbox)
			.where(and(eq(outbox.serverId, server.id), eq(outbox.triggerKind, 'message_pool')));
		expect(rows).toHaveLength(1);
		expect(rows[0].params).toMatchObject({
			message: `Recent Player was banned from ${server.name} (Permanent).`
		});
	});

	test('mounted-gun kills advance thresholds, but roadkills and vehicle explosions do not', async () => {
		const world = await seedWorld(env);
		const server = await serverOf(world.server.id);
		const before = await poolConfigOf(env.db, world.org.id);
		const weaponTag = 'Id.Vehicle.WeaponExtension.WHL_05.RingMinigun';
		await env.db.transaction((tx) =>
			savePoolConfig(
				tx,
				world.org.id,
				{
					pools: [
						pool('mounted-gun-rule', 'weapon', {
							messages: ['{player_name}: {weapon} kill #{count}'],
							weaponTags: [weaponTag],
							thresholds: [
								{
									count: 1,
									action: 'whisper',
									days: 0,
									scope: 'server',
									message: 'Warning: {weapon} is banned.'
								},
								{
									count: 2,
									action: 'kick',
									days: 0,
									scope: 'server',
									message: 'Kicked for using {weapon}.'
								},
								{
									count: 3,
									action: 'ban',
									days: 7,
									scope: 'server',
									message: 'Banned for using {weapon} again.'
								}
							]
						})
					]
				},
				before.version
			)
		);
		for (const [n, tag] of ['RoadKill', 'VehicleExplosion'].entries()) {
			const now = new Date();
			const eventId = `pool-vehicle-${world.server.id}-${n}`;
			const event: KillView = {
				eventId,
				ts: now.toISOString(),
				map: 'Kavkazi',
				eventTime: n,
				killer: { steamId: STEAM, name: 'Test Player', faction: 'A' },
				victim: { steamId: `7656119800000077${n}`, name: `Vehicle victim ${n}`, faction: 'B' },
				cause: weaponTag,
				distanceM: null,
				headshot: false,
				suicide: false,
				teamKill: false,
				tags: [tag]
			};
			await env.db.insert(kills).values({
				ts: now,
				serverId: world.server.id,
				eventId,
				instanceId: 'pool-test',
				matchId: 'one',
				eventTime: n,
				map: event.map,
				killerSteamId: STEAM,
				killerName: 'Test Player',
				killerFaction: 'A',
				victimSteamId: event.victim.steamId,
				victimName: event.victim.name,
				victimFaction: 'B',
				cause: event.cause,
				distanceM: null,
				tags: event.tags
			});
			expect(await env.db.transaction((tx) => queueWeaponPools(tx, server, [event]))).toBe(0);
		}
		for (let n = 1; n <= 3; n++) {
			const now = new Date();
			const eventId = `pool-test-${world.server.id}-${n}`;
			const event: KillView = {
				eventId,
				ts: now.toISOString(),
				map: 'Kavkazi',
				eventTime: n,
				killer: { steamId: STEAM, name: 'Test Player', faction: 'A' },
				victim: { steamId: `7656119800000078${n}`, name: `Victim ${n}`, faction: 'B' },
				cause: weaponTag,
				distanceM: 20,
				headshot: false,
				suicide: false,
				teamKill: false,
				tags: []
			};
			await env.db.insert(kills).values({
				ts: now,
				serverId: world.server.id,
				eventId,
				instanceId: 'pool-test',
				matchId: 'one',
				eventTime: n,
				map: event.map,
				killerSteamId: STEAM,
				killerName: 'Test Player',
				killerFaction: 'A',
				victimSteamId: event.victim.steamId,
				victimName: event.victim.name,
				victimFaction: 'B',
				cause: event.cause,
				distanceM: 20,
				tags: []
			});
			expect(await env.db.transaction((tx) => queueWeaponPools(tx, server, [event]))).toBe(1);
		}
		const rows = await env.db
			.select()
			.from(outbox)
			.where(and(eq(outbox.serverId, world.server.id), eq(outbox.triggerName, 'mounted-gun-rule')))
			.orderBy(asc(outbox.id));
		expect(rows.map((row) => row.action)).toEqual(['whisper', 'kick', PANEL_BAN]);
		expect(
			rows.map(
				(row) =>
					(row.params as { message?: string; reason?: string }).message ??
					(row.params as { reason?: string }).reason
			)
		).toEqual([
			'Warning: Id.Vehicle.WeaponExtension.WHL_05.RingMinigun is banned.',
			'Kicked for using Id.Vehicle.WeaponExtension.WHL_05.RingMinigun.',
			'Banned for using Id.Vehicle.WeaponExtension.WHL_05.RingMinigun again.'
		]);
		expect(rows[2].params).toMatchObject({ days: 7, scope: 'server', steamId: STEAM });
	});

	test('persistent weapon counts carry a private warning into later matches and repeat the ban', async () => {
		const world = await seedWorld(env);
		const server = await serverOf(world.server.id);
		const secondServer = await serverOf(world.otherServer.id);
		const old = await poolConfigOf(env.db, world.org.id);
		const rule = pool('persistent-mmgl', 'weapon', {
			allServers: false,
			serverIds: [server.id, secondServer.id],
			weaponTags: ['Id.Item.MMGL'],
			persistentCounts: true,
			thresholds: [
				{ count: 1, action: 'whisper', days: 0, scope: 'org', message: 'Private warning.' },
				{ count: 2, action: 'ban', days: 7, scope: 'org', message: 'Seven-day ban.' }
			]
		});
		const saved = await env.db.transaction((tx) =>
			savePoolConfig(tx, world.org.id, { pools: [rule] }, old.version)
		);
		expect(saved.pools[0].trackingSince).toBeTruthy();
		const edited = await env.db.transaction((tx) =>
			savePoolConfig(
				tx,
				world.org.id,
				{ pools: [{ ...saved.pools[0], name: 'Edited rule text' }] },
				saved.version
			)
		);
		expect(edited.pools[0].trackingSince).toBe(saved.pools[0].trackingSince);
		const receive = async (n: number, on: typeof server, tags: string[] = []) => {
			const now = new Date();
			const eventId = `persistent-${on.id}-${n}`;
			const event: KillView = {
				eventId,
				ts: now.toISOString(),
				map: 'Kavkazi',
				eventTime: n,
				killer: { steamId: STEAM, name: 'Test Player', faction: 'A' },
				victim: { steamId: `7656119800000060${n}`, name: `Victim ${n}`, faction: 'B' },
				cause: 'Id.Item.MMGL',
				distanceM: 25,
				headshot: false,
				suicide: false,
				teamKill: false,
				tags
			};
			await env.db.insert(kills).values({
				ts: now,
				serverId: on.id,
				eventId,
				instanceId: 'persistent-test',
				matchId: `match-${n}`,
				eventTime: n,
				map: event.map,
				killerSteamId: STEAM,
				killerName: 'Test Player',
				killerFaction: 'A',
				victimSteamId: event.victim.steamId,
				victimName: event.victim.name,
				victimFaction: 'B',
				cause: event.cause,
				distanceM: event.distanceM,
				tags
			});
			return env.db.transaction((tx) => queueWeaponPools(tx, on, [event]));
		};
		expect(await receive(1, server)).toBe(1);
		expect(await receive(2, secondServer, ['RoadKill'])).toBe(0);
		expect(await receive(3, secondServer)).toBe(1);
		expect(await receive(4, secondServer)).toBe(1);
		const rows = await env.db
			.select()
			.from(outbox)
			.where(eq(outbox.triggerName, 'Edited rule text'))
			.orderBy(asc(outbox.id));
		expect(rows.map((row) => row.action)).toEqual(['whisper', PANEL_BAN, PANEL_BAN]);
		expect(rows.map((row) => row.params)).toMatchObject([
			{ message: 'Private warning.', steamId: STEAM },
			{ reason: 'Seven-day ban.', days: 7, scope: 'org', steamId: STEAM },
			{ reason: 'Seven-day ban.', days: 7, scope: 'org', steamId: STEAM }
		]);
	});

	test('ingesting MMGL kills atomically queues one warning and one ban despite feed retries', async () => {
		const world = await seedWorld(env);
		const old = await poolConfigOf(env.db, world.org.id);
		const rule = pool('atomic-mmgl', 'weapon', {
			allServers: false,
			serverIds: [world.server.id],
			weaponTags: ['Id.Item.MMGL'],
			persistentCounts: true,
			thresholds: [
				{ count: 1, action: 'whisper', days: 0, scope: 'org', message: 'Private warning.' },
				{ count: 2, action: 'ban', days: 7, scope: 'org', message: 'Seven-day ban.' }
			]
		});
		await env.db.transaction((tx) =>
			savePoolConfig(tx, world.org.id, { pools: [rule] }, old.version)
		);
		const ids = [randomUUID(), randomUUID()];
		const body = {
			serverId: world.server.id,
			serverName: 'Test',
			events: ids.map((eventId, i) => ({
				eventId,
				type: 'killed',
				eventTime: 100 + i,
				matchId: randomUUID(),
				mapName: 'Kavkazi',
				killerName: 'Test Player',
				killerSteamId: STEAM,
				victimName: `Victim ${i}`,
				victimSteamId: `7656119800000060${i}`,
				cause: 'Id.Item.MMGL',
				distance: 30,
				contextTags: []
			}))
		};
		expect((await ingestBatch(env, world.server.id, body)).accepted).toBe(2);
		expect((await ingestBatch(env, world.server.id, body)).duplicates).toBe(2);
		const roadKill = {
			...body,
			events: [
				{
					...body.events[0],
					eventId: randomUUID(),
					victimSteamId: '76561198000000609',
					contextTags: ['RoadKill']
				}
			]
		};
		expect((await ingestBatch(env, world.server.id, roadKill)).accepted).toBe(1);
		const rows = await env.db
			.select()
			.from(outbox)
			.where(and(eq(outbox.serverId, world.server.id), eq(outbox.triggerName, 'atomic-mmgl')))
			.orderBy(asc(outbox.id));
		expect(rows.map((row) => row.action)).toEqual(['whisper', PANEL_BAN]);
		expect(rows.map((row) => row.params)).toMatchObject([
			{ steamId: STEAM, message: 'Private warning.' },
			{ steamId: STEAM, reason: 'Seven-day ban.', days: 7, scope: 'org' }
		]);
	});
});
