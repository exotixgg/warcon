import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { chatTimeline, type LiveChatLine } from '$lib/chat-archive';
import { eq } from 'drizzle-orm';
import {
	chatArchiveSources as sources,
	chatMessages as messages,
	matches,
	orgRoles,
	servers
} from '$lib/server/db/schema';
import type { Env } from '$lib/server/env';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { collectArchive } from '$lib/server/chat-archive-collect';
import { chatHistory } from '$lib/server/chat-history';
import { GameError, type WardogsClient } from '$lib/server/rcon';
import { testEnv, hasTestDb } from './db';
import { seedWorld, type World } from './world';

describe.skipIf(!hasTestDb)('moderation chat archive', () => {
	let env: Env, w: World;
	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
	}, 30_000);
	afterAll(async () => {
		if (env) await releaseOwnership(env);
	});
	const steam = '76561198000000001';
	const line = (seq: number, text: string, at: Date) => ({
		seq,
		text,
		rawText: 'unfiltered private text',
		steamId: steam,
		anonymous: true,
		hiddenName: 'Public alias',
		realName: 'Private alias',
		channel: 'Team',
		sentUtc: at.toISOString()
	});
	test('automatic logging waits for game terms, catches up, and resumes legacy paused sources', async () => {
		const server = { ...w.server, orgId: w.org.id, name: 'EU-01' };
		let accepted = false;
		let game: ReturnType<typeof line>[] = [];
		let reads = 0;
		let throttleRead = 0;
		const client = {
			json: async (_method: string, path: string) => {
				if (path.endsWith('/terms'))
					return {
						requiredVersion: 1,
						acceptedVersion: accepted ? 1 : 0,
						accepted,
						text: 'Example terms'
					};

				reads++;
				if (reads === throttleRead) throw new GameError(429, 'Slow down', 'rate_limited');
				const q = new URL(path, 'http://local').searchParams;
				return {
					latestSeq: game.at(-1)?.seq ?? 0,
					messages: game
						.filter((l) => l.seq > Number(q.get('after')))
						.slice(0, Number(q.get('limit')))
				};
			}
		} as WardogsClient;
		const collect = async () => {
			await acquireOrRenew(env, 'archive-test');
			return collectArchive(env, server, client, 1000000);
		};
		await collect();
		expect(reads).toBe(0);
		const source = async () =>
			(await env.db.select().from(sources).where(eq(sources.serverId, server.id)))[0];
		expect((await source()).state).toBe('terms');
		accepted = true;
		const time = new Date(Date.now() + 1000);
		game = Array.from({ length: 225 }, (_, i) => line(i + 1, 'line ' + i, time));
		throttleRead = reads + 2;
		await expect(collect()).rejects.toThrow('Slow down');
		expect(
			await env.db
				.select({ seq: messages.seq })
				.from(messages)
				.where(eq(messages.serverId, server.id))
		).toHaveLength(200);
		await collect();
		await collect();
		const stored = () => env.db.select().from(messages).where(eq(messages.serverId, server.id));
		expect((await stored()).length).toBe(225);
		expect((await stored())[0].speaker).toBe('Public alias');
		expect(JSON.stringify(await stored())).not.toContain('Private alias');
		expect(JSON.stringify(await stored())).not.toContain('unfiltered private text');
		// A new map has already passed the previous cursor. Its anchor now identifies a different line.
		game = Array.from({ length: 230 }, (_, i) => line(i + 1, 'new ' + i, time));
		await collect();
		expect((await stored()).length).toBe(455);
		game.push(line(233, 'after gap', time));
		await collect();
		expect((await stored()).filter((r) => r.kind === 'gap')).toHaveLength(1);
		const before = await source();
		await env.db
			.update(sources)
			.set({ enabled: false, state: 'off', changedAt: new Date(Date.now() - 60000) })
			.where(eq(sources.serverId, server.id));
		game.push(
			line(234, 'while paused', new Date(Date.now() - 5000)),
			line(235, 'after resume', new Date(Date.now() + 1000))
		);
		await collect();
		await collect();
		const resumed = await source();
		expect(resumed.enabled).toBe(true);
		expect(resumed.createdAt).toEqual(before.createdAt);
		expect(resumed.epoch).toBe(before.epoch);
		expect(resumed.cursor).toBe(235);
		expect((await stored()).map((l) => l.body)).not.toContain('while paused');
		expect((await stored()).length).toBe(458);
		await env.db.delete(servers).where(eq(servers.id, server.id));
		const retired = await stored();
		expect(retired.length).toBe(458);
	});
	test('scoped cross-server search, private player history, round markers and stable pagination', async () => {
		const world = await seedWorld(env);
		const now = new Date(),
			old = new Date(now.getTime() - 60 * 86400000);
		const serverIds = [world.server.id, world.otherServer.id, world.otherOrgServer.id];
		for (const [i, id] of serverIds.entries()) {
			const orgId = i === 2 ? world.otherOrg.id : world.org.id;
			await env.db.insert(sources).values({
				orgId,
				serverId: id,
				name: 'EU-' + i,
				createdAt: old,
				changedAt: old,
				revision: 'test'
			});
			await env.db.insert(messages).values(
				[1, 2].map((seq) => ({
					orgId,
					serverId: id,
					epoch: 0,
					seq,
					steamId: steam,
					speaker: 'Pilot',
					channel: 'Global',
					faction: '',
					body: 'literal 100%_' + seq,
					at: seq === 1 ? old : now
				}))
			);
		}
		await env.db.insert(matches).values({
			serverId: serverIds[0],
			startedAt: new Date(now.getTime() - 30000),
			endedAt: now,
			map: 'Sabatulo',
			winner: 'Green'
		});
		const read = (
			params: Record<string, string> = {},
			who: 'owner' | 'viewer' | 'outsider' | 'keyAll' = 'owner'
		) => chatHistory(env, world.users[who]!, world.org.id, new URLSearchParams(params));
		expect((await read()).lines.map((l) => l.kind).sort()).toEqual([
			'end',
			'message',
			'message',
			'start'
		]);
		expect((await read({ player: steam, range: 'all' })).lines).toHaveLength(4);
		expect((await read({ q: '100%_1', range: 'all' })).lines).toHaveLength(2);
		expect((await read({ q: '100__1', range: 'all' })).lines).toHaveLength(0);

		const found = (await read({ any: '100%_2', channel: 'Global' })).lines;
		expect(found).toHaveLength(2);
		expect((await read({ any: 'pilot', channel: 'Squad' })).lines).toHaveLength(0);
		expect((await read({ any: steam })).lines).toHaveLength(2);
		const saved = found.find((l) => l.serverId === serverIds[0])!;
		const live: LiveChatLine = {
			seq: 2,
			at: saved.at,
			channel: 'Global',
			faction: '',
			steamId: steam,
			name: 'Pilot',
			hiddenName: '',
			anonymous: false,
			text: saved.body,
			typed: null,
			ping: false
		};
		const timeline = (rows: LiveChatLine[], channel = '') =>
			chatTimeline(
				found,
				rows,
				serverIds[0],
				{ range: '1h', player: '', any: '', channel },
				now.getTime(),
				0
			);
		const merged = timeline([live, { ...live, seq: 3 }]);
		expect(merged).toHaveLength(3);
		expect(
			timeline([{ ...live, at: null, observedAt: new Date(now.getTime() + 600000).toISOString() }])
		).toHaveLength(2);
		expect(merged.find((l) => l.id === saved.id)?.live?.seq).toBe(2);
		expect(merged.find((l) => l.serverId === serverIds[1])?.live).toBeUndefined();
		// A process restart reuses seq. Keep the new message even if the player repeats it.
		expect(timeline([{ ...live, at: new Date(now.getTime() + 1000).toISOString() }])).toHaveLength(
			3
		);
		expect(timeline([{ ...live, seq: 3, at: old.toISOString() }])).toHaveLength(2);
		expect(timeline([{ ...live, seq: 3 }], 'Team')).toHaveLength(2);
		const all = (await read({ range: 'all' })).lines;
		const collected = [];
		let next: string | null = null;
		do {
			const r = await read({ range: 'all', limit: '1', before: next ?? '' });
			collected.push(...r.lines);
			next = r.next;
		} while (next && collected.length < 20);
		expect(collected).toEqual(all);
		await expect(read({}, 'keyAll')).rejects.toThrow();
		await expect(read({}, 'outsider')).rejects.toThrow();
		await expect(read({}, 'viewer')).rejects.toThrow();
		await env.db
			.update(orgRoles)
			.set({ capabilities: ['server.view', 'chat.read'] })
			.where(eq(orgRoles.id, world.roles.viewer));
		expect(
			(await read({ range: 'all', player: steam }, 'viewer')).lines.map((l) => l.serverId)
		).toEqual([serverIds[0], serverIds[0]]);
		await expect(read({ server: serverIds[1] }, 'viewer')).rejects.toThrow();
		await env.db
			.update(sources)
			.set({ enabled: false, changedAt: old })
			.where(eq(sources.serverId, serverIds[0]));
		expect(
			(await read({ server: serverIds[0] })).lines.filter((l) => l.kind === 'end')
		).toHaveLength(1);
		expect((await read({})).lines.filter((l) => l.kind === 'end')).toHaveLength(0);
		await env.db.delete(servers).where(eq(servers.id, serverIds[1]));
		expect((await read({ range: 'all', server: serverIds[1], player: steam })).lines).toHaveLength(
			2
		);
		expect((await read()).servers.find((s) => s.id === serverIds[1])?.retired).toBe(true);
	});
});
