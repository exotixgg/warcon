import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld } from './world';
import { ensureOrgLists, ensureServerLists } from '$lib/server/lists';
import { lists, listEntries, servers } from '$lib/server/db/schema';
import type { Env } from '$lib/server/env';

describe.skipIf(!hasTestDb)('owned organisation priority', () => {
	let env: Env;
	let routes: typeof import('../routes/api/orgs/[id]/lists/reserve/entries/[steamId]/owned/+server');
	const steamId = '76561198000000092',
		future = (m: number) => new Date(Date.now() + m * 60000).toISOString();
	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		routes = await import(
			join(
				import.meta.dir,
				'../routes/api/orgs/[id]/lists/reserve/entries/[steamId]/owned/+server.ts'
			)
		);
	});
	async function fixture() {
		const world = await seedWorld(env);
		await ensureOrgLists(env.db, world.org.id);
		const marker = `EXOTIX VIP ${randomUUID()}`,
			expiresAt = future(10);
		const call = (
			method: 'GET' | 'POST' | 'PATCH',
			body: Record<string, unknown> = {},
			who: keyof typeof world.users = 'keyAll'
		) =>
			callApi(routes[method], world.users[who], {
				method,
				params: { id: world.org.id, steamId },
				body
			});
		const read = async () => {
			const ls = await env.db.select().from(lists).where(eq(lists.orgId, world.org.id));
			return env.db
				.select()
				.from(listEntries)
				.where(eq(listEntries.listId, ls.find((l) => l.kind === 'reserve' && l.isDefault)!.id));
		};
		return {
			world,
			marker,
			expiresAt,
			call,
			read,
			create: () => call('POST', { expectedMarker: marker, expiresAt })
		};
	}
	test('one default organisation row covers all servers and create retries preserve metadata', async () => {
		const f = await fixture();
		expect((await f.create()).status).toBe(200);
		const before = await f.read();
		expect(before.length).toBe(1);
		const repeat = await f.create();
		expect(repeat.status).toBe(200);
		expect((repeat.body as any).changed).toBe(false);
		expect(await f.read()).toEqual(before);
		const view = await f.call('GET');
		expect(view.status).toBe(200);
		expect((view.body as any).entry.owned).toBe(true);
		expect((view.body as any).entry.servers.length).toBe(2);
		const [existing] = await env.db.select().from(servers).where(eq(servers.id, f.world.server.id));
		const newId = randomUUID();
		await env.db.insert(servers).values({ ...existing, id: newId, name: 'Future server' });
		await ensureServerLists(env.db, newId, f.world.org.id);
		expect((await f.call('GET')).body as any).toMatchObject({
			entry: { servers: expect.arrayContaining([expect.objectContaining({ id: newId })]) }
		});
		expect((await f.call('GET', {}, 'owner')).body as any).toMatchObject({
			entry: { owned: false }
		});
	});
	test('renewal has one winner, lost replies repeat, and withdrawal retains its history', async () => {
		const f = await fixture();
		await f.create();
		const body = {
			expectedMarker: f.marker,
			expectedExpiresAt: f.expiresAt,
			expiresAt: future(20)
		};
		expect((await f.call('PATCH', body)).status).toBe(200);
		expect((await f.call('PATCH', body)).body as any).toMatchObject({ changed: false });
		const results = await Promise.all([
			f.call('PATCH', { ...body, expectedExpiresAt: body.expiresAt, expiresAt: future(30) }),
			f.call('PATCH', { ...body, expectedExpiresAt: body.expiresAt, expiresAt: future(40) })
		]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
		const [row] = await f.read();
		const removal = {
			expectedMarker: f.marker,
			expectedExpiresAt: row.expiresAt!.toISOString(),
			remove: true
		};
		expect((await f.call('PATCH', removal)).status).toBe(200);
		expect((await f.call('PATCH', removal)).body as any).toMatchObject({
			changed: false,
			removed: true
		});
		const [removed] = await f.read();
		expect(removed.removedAt).not.toBeNull();
		expect(removed.addedBy).toBe(row.addedBy);
		expect(removed.reason).toBe(row.reason);
	});
	test('copied markers, permanent/operator rows, changed expiries and wrong credentials are preserved', async () => {
		const f = await fixture();
		await f.create();
		const body = {
			expectedMarker: f.marker,
			expectedExpiresAt: f.expiresAt,
			expiresAt: future(20)
		};
		expect((await f.call('PATCH', body, 'owner')).status).toBe(409);
		for (const who of ['anon', 'viewer', 'keyView', 'keyElsewhere', 'outsider'] as const)
			expect([401, 403, 404]).toContain((await f.call('GET', {}, who)).status);
		const [row] = await f.read();
		await env.db
			.update(listEntries)
			.set({ reason: 'manual', expiresAt: null })
			.where(eq(listEntries.id, row.id));
		const before = await f.read();
		expect((await f.call('PATCH', body)).status).toBe(409);
		expect((await f.create()).status).toBe(409);
		expect(
			(
				await f.call('PATCH', {
					expectedMarker: f.marker,
					expectedExpiresAt: f.expiresAt,
					remove: true
				})
			).status
		).toBe(409);
		expect(await f.read()).toEqual(before);
	});
	test('canonical finite validation and removed-row replacement cannot transfer ownership', async () => {
		const f = await fixture();
		for (const expiresAt of [null, '', future(-1), future(11 * 366 * 24 * 60), 'invalid'])
			expect((await f.call('POST', { expectedMarker: f.marker, expiresAt })).status).toBe(400);
		await f.create();
		const remove = { expectedMarker: f.marker, expectedExpiresAt: f.expiresAt, remove: true };
		await f.call('PATCH', remove);
		const [row] = await f.read();
		await env.db.insert(listEntries).values({
			id: randomUUID(),
			listId: row.listId,
			steamId,
			reason: 'manual replacement',
			expiresAt: null
		});
		expect((await f.call('PATCH', remove)).status).toBe(409);
	});
	test('manual takeover while org renewal waits for its row lock is refused', async () => {
		const f = await fixture();
		await f.create();
		const [row] = await f.read();
		let pending!: ReturnType<typeof f.call>;
		await env.db.transaction(async (tx) => {
			await tx.select().from(listEntries).where(eq(listEntries.id, row.id)).for('update');
			pending = f.call('PATCH', {
				expectedMarker: f.marker,
				expectedExpiresAt: f.expiresAt,
				expiresAt: future(20)
			});
			await tx
				.update(listEntries)
				.set({ reason: 'operator takeover', expiresAt: null })
				.where(eq(listEntries.id, row.id));
		});
		expect((await pending).status).toBe(409);
		expect((await f.read())[0].reason).toBe('operator takeover');
		expect((await f.read())[0].expiresAt).toBeNull();
	});
	test('scope-specific legacy read finds server row even while org coverage masks it', async () => {
		const f = await fixture();
		await f.create();
		const listId = randomUUID();
		await env.db.insert(lists).values({
			id: listId,
			orgId: f.world.org.id,
			serverId: f.world.server.id,
			kind: 'reserve',
			name: 'Server'
		});
		await env.db.insert(listEntries).values({
			id: randomUUID(),
			listId,
			steamId,
			reason: 'legacy marker',
			expiresAt: new Date(f.expiresAt),
			addedBy: f.world.users.keyAll!.id
		});
		const route = await import(
			join(import.meta.dir, '../routes/api/servers/[id]/lists/reserve/entries/[steamId]/+server.ts')
		);
		const result = await callApi(route.GET, f.world.users.keyAll, {
			params: { id: f.world.server.id, steamId }
		});
		expect(result.status).toBe(200);
		expect(result.body as any).toMatchObject({
			entry: { scope: 'server', reason: 'legacy marker', owned: true }
		});
	});

	test('custom groups cannot inherit the default-list automation', async () => {
		const f = await fixture(),
			groupId = randomUUID();
		await env.db
			.insert(lists)
			.values({ id: groupId, orgId: f.world.org.id, kind: 'reserve', name: 'Manual group' });
		await env.db.insert(listEntries).values({
			id: randomUUID(),
			listId: groupId,
			steamId,
			reason: 'manual group',
			expiresAt: null
		});
		expect((await f.create()).status).toBe(200);
		const [manual] = await env.db.select().from(listEntries).where(eq(listEntries.listId, groupId));
		expect(manual.reason).toBe('manual group');
		expect(manual.expiresAt).toBeNull();
		await env.db.update(lists).set({ archivedAt: new Date() }).where(eq(lists.id, groupId));
		expect((await f.call('GET')).body as any).toMatchObject({
			entry: { reason: f.marker, owned: true }
		});
		expect((await f.read())[0].removedAt).toBeNull();
	});
});
