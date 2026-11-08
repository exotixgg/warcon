import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { organizations, outbox, servers, triggers } from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, observeServer } from '$lib/server/observe';
import { WardogsClient } from '$lib/server/rcon';
import { invalidateTriggers, validateConfig } from '$lib/server/triggers';
import { MESSAGE_ROTATION_TTL_MS } from '$lib/server/message-rotation';
import { newId } from '$lib/server/http';
import { hasTestDb, testEnv } from './db';
import { seedWorld } from './world';
import { stubGateway } from './call';

describe.skipIf(!hasTestDb)('rotation placeholders in worker observations', () => {
	let env: Env;
	let spy: ReturnType<typeof spyOn>;
	let id = '';
	let reads = 0;
	let refuse = false;
	let index = 0;
	const entries = [
		{ map: 'Kavkazi', lighting: 'DayClear', experiences: [], denied: false },
		{ map: 'Europe', lighting: 'DayEarlyFog', experiences: [], denied: false },
		{ map: 'NorthAmerica', lighting: 'DayLateGray', experiences: [], denied: false }
	];
	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		stubGateway();
		expect(await acquireOrRenew(env, 'message rotation test')).toBe(true);
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`message-rotation-${server.id}`
			);
			const raw = client.raw.bind(client);
			const answer = (body: unknown, status = 200) => ({
				status,
				statusText: status === 200 ? 'OK' : 'Unavailable',
				headers: { 'content-type': 'application/json' },
				text: JSON.stringify(body)
			});
			client.raw = async (method, path, body, headers) => {
				if (method === 'GET' && path === '/v1/status')
					return answer({
						map: entries[index].map,
						lighting: 'DayLateRain',
						players: { current: 10, max: 100 },
						factionScores: [],
						rotation: { nowIndex: index, nextIndex: index + 1 }
					});
				if (method === 'GET' && path === '/v1/rotation') {
					reads++;
					return refuse
						? answer({ error: { code: 'unavailable', message: 'Try later' } }, 503)
						: answer({
								enabled: true,
								mode: 'ordered',
								entries: entries.map((e, i) => ({
									...e,
									index: i,
									status: i === index ? 'now' : i === index + 1 ? 'next' : null
								}))
							});
				}
				return raw(method, path, body, headers);
			};
			return client;
		});
	});
	afterAll(async () => {
		spy?.mockRestore();
		if (id) forgetMemory(id);
		await releaseOwnership(env);
	});
	test('loads only on demand, shares a snapshot, invalidates on movement and treats failed reads as unknown', async () => {
		const w = await seedWorld(env);
		id = w.server.id;
		const [server] = await env.db.select().from(servers).where(eq(servers.id, id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		const memory = memoryFor(server, org);
		const ruleId = newId();
		await env.db.insert(triggers).values({
			id: ruleId,
			serverId: id,
			orgId: w.org.id,
			kind: 'broadcast',
			name: 'Map information',
			enabled: true,
			config: validateConfig('broadcast', {
				messages: ['{weather}'],
				everyMinutes: 5,
				minPlayers: 0
			})
		});
		const look = async (message: string) => {
			await acquireOrRenew(env, 'message rotation test');
			await env.db
				.update(triggers)
				.set({
					config: validateConfig('broadcast', {
						messages: [message],
						everyMinutes: 5,
						minPlayers: 0
					}),
					lastFiredAt: null
				})
				.where(eq(triggers.id, ruleId));
			invalidateTriggers(id);
			await observeServer(env, memory, { status: true, players: true });
			const rows = await env.db
				.select()
				.from(outbox)
				.where(eq(outbox.triggerId, ruleId))
				.orderBy(outbox.id);
			return (rows.at(-1)!.params as { message: string }).message;
		};
		expect(await look('{weather}')).toBe('Day Late Rain');
		expect(reads).toBe(0);
		const text = '{current_weather} | {next_map} | {next_weather}';
		expect(await look(text)).toBe('Day Late Rain | Ozeti | Day Early Fog');
		expect(reads).toBe(1);
		expect(await look(text)).toBe('Day Late Rain | Ozeti | Day Early Fog');
		expect(reads).toBe(1);
		index = 1;
		expect(await look(text)).toBe('Day Late Rain | Zestafona | Day Late Gray');
		expect(reads).toBe(2);
		refuse = true;
		memory.messageRotation!.at -= MESSAGE_ROTATION_TTL_MS;
		expect(await look(text)).toBe('Day Late Rain | … | …');
		expect(memory.ok).toBe(true);
		expect(reads).toBe(3);
		expect(await look(text)).toBe('Day Late Rain | … | …');
		expect(reads).toBe(3);
		expect(await look('{weather}')).toBe('Day Late Rain');
		expect(memory.messageRotation).toBeNull();
		expect(reads).toBe(3);
	});
});
