import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { organizations, outbox, servers, triggers } from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, observeServer } from '$lib/server/observe';
import { startDelivery, stopDelivery } from '$lib/server/outbox';
import { WardogsClient } from '$lib/server/rcon';
import { validateConfig } from '$lib/server/trigger-rules';
import { seedingBotKickReady, type SeedingBotKickConfig } from '$lib/server/seeding-bot-kick';
import { hasTestDb, testEnv } from './db';
import { seedWorld } from './world';

const id = (i: number) => String(76561198000000000n + BigInt(i));
const [firstBot, secondBot, incomingPlayer] = [id(1), id(2), id(96)];
const config = validateConfig('seeding_bot_kick', {
	steamIds: [firstBot, secondBot]
}) as SeedingBotKickConfig;
const full = Array.from({ length: 95 }, (_, i) => id(i + 1));

test('seeding bot kick defaults to 95 players and accepts unique string SteamID64s in order', () => {
	expect(
		validateConfig('seeding_bot_kick', { steamIds: [secondBot, firstBot, secondBot] })
	).toEqual({ minPlayers: 95, steamIds: [secondBot, firstBot] });
	for (const bad of [
		{ steamIds: [] },
		{ steamIds: [Number(firstBot)] },
		{ steamIds: ['human name'] },
		{ minPlayers: 0 }
	])
		expect(() => validateConfig('seeding_bot_kick', { ...config, ...bad })).toThrow();
});

test('a kick waits for a refill even when the count stays at or above the goal', () => {
	const last = { state: 'delivered', steamId: firstBot };
	const players = (ids: string[]) => ids.map((steamId) => ({ steamId }));
	const previous = players([...full, incomingPlayer]);
	expect(seedingBotKickReady(config, last, previous.slice(1), previous)).toBe(false);
	const postKick = players(full.slice(1));
	expect(
		seedingBotKickReady(config, last, [...postKick, { steamId: incomingPlayer }], players(full))
	).toBe(true);
});

describe.skipIf(!hasTestDb)('seeding bot kick observation and delivery', () => {
	let env: Env;
	let serverId: string;
	let ruleId: string;
	let look: () => Promise<void>;
	let restore: () => void;
	let roster: string[] = [];
	const kicks: string[] = [];
	const rowsOf = () =>
		env.db.select().from(outbox).where(eq(outbox.triggerId, ruleId)).orderBy(outbox.id);

	beforeAll(async () => {
		env = await testEnv();
		const w = await seedWorld(env);
		serverId = w.server.id;
		ruleId = crypto.randomUUID();
		await env.db.insert(triggers).values({
			id: ruleId,
			serverId,
			orgId: w.org.id,
			kind: 'seeding_bot_kick',
			name: 'Seeding bot kick',
			enabled: true,
			config
		});
		const [server] = await env.db.select().from(servers).where(eq(servers.id, serverId));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		const m = memoryFor(server, org);
		m.playersIntervalMs = 1000;
		look = () => observeServer(env, m, { status: true, players: true });
		expect(await acquireOrRenew(env, 'test-seeding-bot-kick')).toBe(true);
		const forServer = WardogsClient.forServer.bind(WardogsClient);
		const spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (e, s) => {
			if (s.id !== serverId) return forServer(e, s);
			const client = new WardogsClient(
				env,
				{ id: serverId, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				'seeding-bot-kick'
			);
			const raw = client.raw.bind(client);
			const json = (data: unknown) => ({
				status: 200,
				statusText: 'OK',
				headers: { 'content-type': 'application/json' },
				text: JSON.stringify(data)
			});
			client.raw = async (method, path, body, headers) => {
				if (method === 'GET' && path === '/v1/players')
					return json({ players: roster.map((steamId) => ({ steamId, name: steamId })) });
				if (method === 'GET' && path === '/v1/status')
					return json({ players: { current: roster.length, max: 100 }, rotation: {} });
				if (method === 'POST' && path.endsWith('/kick')) {
					kicks.push(path);
					return json({ ok: true });
				}
				return raw(method, path, body, headers);
			};
			return client;
		});
		restore = () => spy.mockRestore();
	});

	afterAll(async () => {
		await stopDelivery();
		restore?.();
		if (serverId) forgetMemory(serverId);
		if (env) await releaseOwnership(env);
	});

	const deliver = async () => {
		startDelivery(env);
		try {
			const until = Date.now() + 10_000;
			while (Date.now() < until) {
				const last = (await rowsOf()).at(-1);
				if (last?.doneAt) return last;
				await Bun.sleep(25);
			}
			throw new Error('Timed out waiting for the seeding bot kick.');
		} finally {
			await stopDelivery();
		}
	};

	test('queues one at 95, checks the live count, then waits for a refill', async () => {
		roster = full.slice(0, -1);
		await look();
		expect(await rowsOf()).toHaveLength(0);

		roster = full;
		await look();
		await look();
		expect((await rowsOf()).map((row) => row.steamId)).toEqual([firstBot]);

		roster = full.slice(0, -1);
		const skipped = await deliver();
		expect(skipped.state).toBe('skipped');
		expect(kicks).toEqual([]);

		roster = full;
		await look();
		const sent = await deliver();
		expect(sent.state).toBe('delivered');
		expect(kicks).toEqual([`/v1/players/${firstBot}/kick`]);

		await look();
		expect(await rowsOf()).toHaveLength(2);

		roster = full.slice(1);
		await look();
		expect(await rowsOf()).toHaveLength(2);

		roster = [...full.slice(1), incomingPlayer];
		await look();
		expect((await rowsOf()).map((row) => row.steamId)).toEqual([firstBot, firstBot, secondBot]);
		await env.db.update(triggers).set({ enabled: false }).where(eq(triggers.id, ruleId));
		expect((await deliver()).state).toBe('skipped');
		expect(kicks).toHaveLength(1);
	}, 25_000);
});
