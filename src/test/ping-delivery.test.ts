import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { organizations, outbox, servers, triggers, type TriggerRow } from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, memoryOf } from '$lib/server/observe';
import { enqueueIntents, startDelivery, stopDelivery } from '$lib/server/outbox';
import { WardogsClient } from '$lib/server/rcon';
import { pingSettingsKey, validateConfig } from '$lib/server/trigger-rules';
import { hasTestDb, testEnv } from './db';
import { stubGateway } from './call';
import { seedWorld, type World } from './world';

const PLAYER = '76561198000008711';
const config = validateConfig('ping_kick', {
	maxPingMs: 150,
	durationSeconds: 60,
	minPlayers: 2,
	spareReserved: true,
	warningSeconds: [15, 30, 45],
	warnMessage: 'High ping.'
});

describe.skipIf(!hasTestDb)('ping decisions at delivery', () => {
	let env: Env, w: World, ruleId: string;
	let spy: ReturnType<typeof spyOn>, renewing: ReturnType<typeof setInterval>;
	const requests: string[] = [];
	let seq = 0;
	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		stubGateway();
		expect(await acquireOrRenew(env, 'ping-delivery')).toBe(true);
		renewing = setInterval(() => void acquireOrRenew(env, 'ping-delivery'), 5000);
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		memoryFor(server, org);
		ruleId = `ping-delivery-${w.server.id}`;
		await env.db.insert(triggers).values({
			id: ruleId,
			serverId: server.id,
			orgId: org.id,
			kind: 'ping_kick',
			name: 'High ping',
			enabled: true,
			config
		});
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(
			async () =>
				({
					json: async (method: string, path: string) => {
						requests.push(`${method} ${path}`);
						return { ok: true };
					}
				}) as unknown as WardogsClient
		);
	});
	afterEach(async () => {
		await stopDelivery();
		requests.length = 0;
	});
	afterAll(async () => {
		clearInterval(renewing);
		await stopDelivery();
		spy?.mockRestore();
		forgetMemory(w.server.id);
		await releaseOwnership(env);
	});
	async function queue(action: 'whisper' | 'kick') {
		const now = Date.now(),
			since = now - (action === 'kick' ? 60_000 : 15_000);
		const m = memoryOf(w.server.id)!;
		m.players = [PLAYER, '76561198000008712'].map((steamId) => ({
			steamId,
			name: 'Tester',
			faction: null,
			kills: 0,
			deaths: 0,
			cash: 0,
			ping: 200
		}));
		m.playersAt = now;
		m.reservedAt = now;
		m.reserved.clear();
		await env.db
			.update(triggers)
			.set({
				enabled: true,
				config,
				state: {
					lastAt: now,
					players: { [PLAYER]: { since, fired: action === 'kick', warned: 15 } }
				}
			})
			.where(eq(triggers.id, ruleId));
		const dedupeKey = `ping-delivery:${w.server.id}:${seq++}`;
		await enqueueIntents(env.db, w.server.id, [
			{
				trigger: { id: ruleId, name: 'High ping', kind: 'ping_kick' } as TriggerRow,
				action,
				params: {
					steamId: PLAYER,
					message: 'High ping.',
					reason: 'High ping.',
					since,
					warningSeconds: 15,
					rule: pingSettingsKey(config),
					pingGuard: { minPlayers: 2, maxPingMs: 150, spareReserved: true, maxGapMs: 60_000 }
				},
				target: PLAYER,
				steamId: PLAYER,
				okMessage: 'Sent.',
				detail: {},
				dedupeKey
			}
		]);
		return (await env.db.select().from(outbox).where(eq(outbox.dedupeKey, dedupeKey)))[0].id;
	}
	async function deliver(id: number) {
		startDelivery(env);
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			const [row] = await env.db.select().from(outbox).where(eq(outbox.id, id));
			if (row.doneAt) return row;
			await Bun.sleep(25);
		}
		throw new Error('Ping delivery timed out');
	}
	test('sends current warnings and kicks through their native endpoints', async () => {
		for (const action of ['whisper', 'kick'] as const) {
			expect((await deliver(await queue(action))).state).toBe('delivered');
			await stopDelivery();
		}
		expect(requests).toEqual([
			`POST /v1/players/${PLAYER}/message`,
			`POST /v1/players/${PLAYER}/kick`
		]);
	}, 30_000);
	test('rechecks population, recovered ping, exemptions and sampling before sending either action', async () => {
		for (const scenario of [
			'population',
			'recovery',
			'reserved',
			'unknown-slots',
			'stale-roster'
		]) {
			for (const action of ['whisper', 'kick'] as const) {
				const id = await queue(action),
					m = memoryOf(w.server.id)!;
				if (scenario === 'population') m.players.pop();
				if (scenario === 'recovery') m.players[0].ping = 150;
				if (scenario === 'reserved') m.reserved.add(PLAYER);
				if (scenario === 'unknown-slots') m.reservedAt = 0;
				if (scenario === 'stale-roster') m.playersAt = Date.now() - 61_000;
				expect([scenario, action, (await deliver(id)).state]).toEqual([
					scenario,
					action,
					'skipped'
				]);
				await stopDelivery();
			}
		}
		expect(requests).toEqual([]);
	}, 60_000);
	test('drops expired warnings and decisions whose rule or streak changed', async () => {
		for (const scenario of ['expired', 'disabled', 'new-streak', 'changed-config']) {
			const id = await queue('whisper');
			if (scenario === 'expired')
				await env.db
					.update(outbox)
					.set({ createdAt: new Date(Date.now() - 6000) })
					.where(eq(outbox.id, id));
			if (scenario === 'disabled')
				await env.db.update(triggers).set({ enabled: false }).where(eq(triggers.id, ruleId));
			if (scenario === 'new-streak')
				await env.db
					.update(triggers)
					.set({ state: { lastAt: Date.now(), players: {} } })
					.where(eq(triggers.id, ruleId));
			if (scenario === 'changed-config')
				await env.db
					.update(triggers)
					.set({ config: { ...config, minPlayers: 80 } })
					.where(eq(triggers.id, ruleId));
			expect([scenario, (await deliver(id)).state]).toEqual([scenario, 'skipped']);
			await stopDelivery();
		}
		expect(requests).toEqual([]);
	}, 60_000);
});
