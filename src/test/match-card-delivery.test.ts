import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import {
	matches,
	matchPlayers,
	organizations,
	outbox,
	servers,
	triggers,
	type TriggerRow
} from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, memoryOf } from '$lib/server/observe';
import {
	applyTriggerUpdates,
	enqueueIntents,
	startDelivery,
	stopDelivery,
	deliveryStats
} from '$lib/server/outbox';
import { evaluateTriggers, type Evaluation, type TickContext } from '$lib/server/triggers';
import { validateConfig } from '$lib/server/trigger-rules';
import type { MatchCardEnd } from '$lib/server/match-card';
import { WardogsClient } from '$lib/server/rcon';
import type { Player, Status } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { stubGateway } from './call';
import { seedWorld, type World } from './world';

describe.skipIf(!hasTestDb)('match cards through native delivery', () => {
	let env: Env, w: World, rule: TriggerRow;
	let spy: ReturnType<typeof spyOn>,
		renewing: ReturnType<typeof setInterval>,
		observing: ReturnType<typeof setInterval>;
	const requests: { path: string; message: string }[] = [];
	const config = validateConfig('match_card', {});
	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		stubGateway();
		expect(await acquireOrRenew(env, 'match-card-delivery')).toBe(true);
		renewing = setInterval(() => void acquireOrRenew(env, 'match-card-delivery'), 5000);
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		memoryFor(server, org);
		[rule] = await env.db
			.insert(triggers)
			.values({
				id: `card-${server.id}`,
				serverId: server.id,
				orgId: org.id,
				kind: 'match_card',
				name: 'Match stats',
				enabled: true,
				config
			})
			.returning();
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(
			async () =>
				({
					json: async (_method: string, path: string, body: { message?: string }) => {
						requests.push({ path, message: body.message ?? '' });
						await Bun.sleep(20);
						return { ok: true };
					}
				}) as unknown as WardogsClient
		);
		observing = setInterval(() => {
			const m = memoryOf(w.server.id);
			if (m) m.playersAt = Date.now();
		}, 1000);
	});
	afterEach(async () => {
		await stopDelivery();
		for (let i = 0; i < 200 && deliveryStats().chains; i++) await Bun.sleep(25);
		await env.db
			.update(outbox)
			.set({ state: 'skipped', doneAt: new Date() })
			.where(and(eq(outbox.serverId, w.server.id), inArray(outbox.state, ['pending', 'sending'])));
		requests.length = 0;
	});
	afterAll(async () => {
		clearInterval(renewing);
		clearInterval(observing);
		await stopDelivery();
		spy?.mockRestore();
		forgetMemory(w.server.id);
		await releaseOwnership(env);
	});
	async function fixture(count = 1) {
		const now = Date.now(),
			m = memoryOf(w.server.id)!;
		const people: Player[] = Array.from({ length: count }, (_, i) => ({
			steamId: String(76561198000500000n + BigInt(i)),
			name: `Player ${i}`,
			faction: 'Red',
			kills: 42,
			deaths: 18,
			cash: 900000,
			ping: 30
		}));
		Object.assign(m, {
			ok: true,
			closed: null,
			players: people,
			playersAt: now,
			playersIntervalMs: 2000,
			startedAt: 1,
			status: {
				map: 'Bakurani',
				rotationNow: 0,
				rotationNext: 2,
				scores: [],
				playerCount: count,
				maxPlayers: 100
			} as unknown as Status,
			matchState: {
				map: 'Bakurani',
				state: 'MatchState.PostMatch',
				at: new Date(now - 5000).toISOString()
			}
		});
		// VIPs receive the same card; slots need not have loaded.
		m.reserved = new Set(people.map((p) => p.steamId));
		m.reservedAt = 0;
		const end: MatchCardEnd = {
			eventId: `e-${now}`,
			at: now - 5000,
			map: 'Bakurani',
			rotationNow: 0,
			rotationNext: 2,
			startedAt: 1,
			recipients: people.map((p) => p.steamId),
			nextMap: 'Bakurani',
			nextWeather: 'Day Late Rain'
		};
		await env.db
			.update(matches)
			.set({ endedAt: new Date() })
			.where(and(eq(matches.serverId, w.server.id)));
		const [match] = await env.db
			.insert(matches)
			.values({ serverId: w.server.id, map: 'Bakurani', startedAt: new Date(now - 3600000) })
			.returning();
		await env.db.insert(matchPlayers).values({
			matchId: match.id,
			serverId: w.server.id,
			steamId: '76561198000999999',
			name: 'Leaver',
			kills: 68,
			deaths: 10,
			cashDelta: 250000,
			seconds: 3000
		});
		const lines = people.map((p) => ({
			steamId: p.steamId,
			name: p.name,
			faction: p.faction,
			kills: p.kills,
			deaths: p.deaths,
			seconds: 2040,
			cashDelta: 125000
		}));
		await env.db
			.update(triggers)
			.set({ enabled: true, config, state: null })
			.where(eq(triggers.id, rule.id));
		rule = { ...rule, state: null, enabled: true, config };
		const ctx = {
			server: m.server,
			status: m.status,
			players: people,
			playersObserved: true,
			matchCardEnd: end,
			matchCardState: m.matchState,
			matchCardLines: lines,
			matchEnd: null,
			recovered: false,
			startedAt: 1,
			ts: new Date(now),
			reserved: m.reserved,
			seedMs: new Map(),
			matchLines: []
		} as unknown as TickContext;
		return { ctx, match, people };
	}
	async function commit(ev: Evaluation) {
		const queued = await env.db.transaction(async (tx) => {
			const n = await enqueueIntents(tx, w.server.id, ev.intents);
			await applyTriggerUpdates(tx, ev.updates);
			return n;
		});
		for (const f of ev.afterCommit ?? []) f();
		return queued;
	}
	async function delivered() {
		startDelivery(env);
		const until = Date.now() + 45000;
		while (Date.now() < until) {
			const rows = await env.db.select().from(outbox).where(eq(outbox.triggerId, rule.id));
			if (rows.every((r) => r.doneAt)) return rows;
			await Bun.sleep(30);
		}
		throw new Error('Match card delivery timed out');
	}
	test('fresh final observation, delay, connected recipients and persisted leavers; no early match writes', async () => {
		const { ctx, match } = await fixture(2);
		const evaluate = (over: Partial<TickContext>) =>
			evaluateTriggers(env, { ...ctx, ...over }, [rule]);
		expect((await evaluate({ ts: new Date(+ctx.ts - 1) })).intents).toHaveLength(0);
		expect((await evaluate({ playersObserved: false })).intents).toHaveLength(0);
		expect((await evaluate({ matchCardEnd: null })).intents).toHaveLength(0);
		expect((await evaluate({ recovered: true })).intents).toHaveLength(0);
		expect((await evaluate({ matchEnd: {} as TickContext['matchEnd'] })).intents).toHaveLength(0);
		const ev = await evaluate({ players: ctx.players.slice(0, 1) });
		expect(ev.intents).toHaveLength(1);
		expect(ev.intents[0].params.message).toContain('Leaver — 68 kills');
		expect(ev.intents[0].params.message).toContain('42K/18D | 2.33 K/D | $125K');
		await commit(ev);
		expect(await commit(ev)).toBe(0);
		const [savedRule] = await env.db.select().from(triggers).where(eq(triggers.id, rule.id));
		expect((await evaluateTriggers(env, ctx, [savedRule])).intents).toHaveLength(0);
		// A distinct repeated feed event for this match still dedupes against the match row.
		expect(
			(
				await evaluateTriggers(
					env,
					{ ...ctx, matchCardEnd: { ...ctx.matchCardEnd!, eventId: 'repeat' } },
					[savedRule]
				)
			).intents
		).toHaveLength(0);
		const rows = await delivered();
		expect(rows.filter((r) => r.state === 'delivered')).toHaveLength(1);
		expect(requests).toHaveLength(1);
		expect(requests[0].path).toBe(`/v1/players/${ctx.players[0].steamId}/message`);
		const [saved] = await env.db.select().from(matches).where(eq(matches.id, match.id));
		expect(saved.endedAt).toBeNull();
		expect(
			await env.db.select().from(matchPlayers).where(eq(matchPlayers.matchId, match.id))
		).toHaveLength(1);
	}, 20000);
	test('100 connected participants traverse the normal dispatcher and outbox within post-match', async () => {
		const { ctx } = await fixture(100);
		const ev = await evaluateTriggers(env, ctx, [rule]);
		expect(ev.intents).toHaveLength(100);
		const start = Date.now();
		await commit(ev);
		const rows = await delivered();
		expect(rows.filter((r) => r.state === 'delivered').length).toBeGreaterThanOrEqual(100);
		expect(requests).toHaveLength(100);
		expect(new Set(requests.map((r) => r.path)).size).toBe(100);
		expect(
			requests.every((r) => r.message.length <= 256 && r.message.endsWith('Weather: Day Late Rain'))
		).toBe(true);
		expect(Date.now() - start).toBeLessThan(45000);
	}, 50000);
	test('edit/disable, travel and player disconnect are rechecked at actual delivery', async () => {
		for (const scenario of [
			'edit',
			'disable',
			'phase',
			'slot',
			'clock',
			'boundary',
			'disconnect'
		]) {
			const { ctx } = await fixture();
			await commit(await evaluateTriggers(env, ctx, [rule]));
			if (scenario === 'edit')
				await env.db
					.update(triggers)
					.set({ config: { ...config, message: 'Changed' } })
					.where(eq(triggers.id, rule.id));
			if (scenario === 'disable')
				await env.db.update(triggers).set({ enabled: false }).where(eq(triggers.id, rule.id));
			const m = memoryOf(w.server.id)!;
			if (scenario === 'phase') m.matchState = { ...m.matchState!, state: 'MatchState.Playing' };
			if (scenario === 'slot') m.status = { ...m.status!, rotationNow: 2 };
			if (scenario === 'clock') {
				// A same-map restart can precede its new phase event and retain rotation pointers.
				const [queued] = await env.db
					.select()
					.from(outbox)
					.where(and(eq(outbox.triggerId, rule.id), eq(outbox.state, 'pending')));
				await env.db
					.update(outbox)
					.set({
						params: {
							...(queued.params as Record<string, unknown>),
							matchCard: { ...ctx.matchCardEnd!, matchSeconds: 1800 }
						}
					})
					.where(eq(outbox.id, queued.id));
				m.status = { ...m.status!, matchSeconds: 0 };
			}
			if (scenario === 'boundary') m.closed = { id: 0, at: Date.now(), factions: [], byFeed: true };
			if (scenario === 'disconnect') m.players = [];
			const rows = await delivered();
			expect(rows.filter((r) => r.state === 'pending' || r.state === 'sending')).toHaveLength(0);
			expect(requests).toHaveLength(0);
			await stopDelivery();
		}
	}, 30000);
});
