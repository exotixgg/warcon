import { beforeAll, describe, expect, test } from 'bun:test';
import { and, asc, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { kills, outbox, servers } from '$lib/server/db/schema';
import {
	poolConfigOf,
	poolStillHolds,
	queueBanAnnouncements,
	queueObservationPools,
	queueWeaponPools,
	savePoolConfig
} from '$lib/server/exotix/message-pools';
import { grantEntry, listOf } from '$lib/server/lists';
import { PANEL_BAN } from '$lib/server/rule-ban';
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

	test('an automatic ban announces on all organisation servers without private notes', async () => {
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
		expect(inOrg.length).toBeGreaterThanOrEqual(2);
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

	test('exact weapon tags advance whisper, kick, and timed ban thresholds', async () => {
		const world = await seedWorld(env);
		const server = await serverOf(world.server.id);
		const before = await poolConfigOf(env.db, world.org.id);
		await env.db.transaction((tx) =>
			savePoolConfig(
				tx,
				world.org.id,
				{
					pools: [
						pool('grenade-rule', 'weapon', {
							messages: ['{player_name}: {weapon} kill #{count}'],
							weaponTags: ['Id.Item.GrenadeLauncher'],
							thresholds: [
								{ count: 1, action: 'whisper', days: 0, scope: 'server' },
								{ count: 2, action: 'kick', days: 0, scope: 'server' },
								{ count: 3, action: 'ban', days: 7, scope: 'server' }
							]
						})
					]
				},
				before.version
			)
		);
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
				cause: 'Id.Item.GrenadeLauncher',
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
			.where(and(eq(outbox.serverId, world.server.id), eq(outbox.triggerName, 'grenade-rule')))
			.orderBy(asc(outbox.id));
		expect(rows.map((row) => row.action)).toEqual(['whisper', 'kick', PANEL_BAN]);
		expect(rows[2].params).toMatchObject({ days: 7, scope: 'server', steamId: STEAM });
	});
});
