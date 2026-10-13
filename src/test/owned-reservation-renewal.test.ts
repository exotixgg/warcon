import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { listEntries, lists, serverLists } from '$lib/server/db/schema';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type World } from './world';

// All database tests use the existing isolated TEST_DATABASE_URL harness; never production.
describe.skipIf(!hasTestDb)('owned server reservation renewal', () => {
	let env: Env;
	let patch: typeof import('../routes/api/servers/[id]/lists/reserve/entries/[steamId]/+server').PATCH;
	let remove: typeof import('../routes/api/servers/[id]/lists/reserve/entries/[steamId]/+server').DELETE;
	const steamId = '76561198000000091';
	const future = (minutes: number) => new Date(Date.now() + minutes * 60000).toISOString();
	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		const route = await import(
			join(import.meta.dir, '../routes/api/servers/[id]/lists/reserve/entries/[steamId]/+server.ts')
		);
		patch = route.PATCH;
		remove = route.DELETE;
	});
	async function fixture(
		scope: 'server' | 'org' = 'server',
		creator: 'owner' | 'keyAll' = 'owner'
	) {
		const id = randomUUID(),
			listId = randomUUID(),
			marker = `EXOTIX VIP ${randomUUID()}`;
		const expiresAt = future(5);
		// Fresh server per case: no accidental duplicate lists or identity sharing across tests.
		const world = await seedWorld(env);
		await env.db.insert(lists).values({
			id: listId,
			orgId: world.org.id,
			serverId: scope === 'server' ? world.server.id : null,
			kind: 'reserve',
			name: id
		});
		await env.db.insert(serverLists).values({ serverId: world.server.id, listId });
		await env.db.insert(listEntries).values({
			id,
			listId,
			steamId,
			reason: marker,
			expiresAt: new Date(expiresAt),
			addedBy: world.users[creator]!.id,
			addedByName: 'original operator'
		});
		const read = async () =>
			(await env.db.select().from(listEntries).where(eq(listEntries.id, id)))[0];
		const call = (body: Record<string, unknown>, who: keyof World['users'] = creator) =>
			callApi(patch, world.users[who], {
				method: 'PATCH',
				params: { id: world.server.id, steamId },
				body
			});
		return {
			id,
			serverId: world.server.id,
			owner: world.users.owner,
			marker,
			expiresAt,
			read,
			call,
			body: { expectedMarker: marker, expectedExpiresAt: expiresAt, expiresAt: future(10) }
		};
	}
	test('extends the same row, preserves metadata, and repeats a lost reply without a second mutation', async () => {
		const f = await fixture(),
			before = await f.read();
		const first = await f.call(f.body);
		expect(first.status).toBe(200);
		expect((first.body as { changed: boolean }).changed).toBe(true);
		expect(await f.read()).toEqual({ ...before, expiresAt: new Date(f.body.expiresAt) });
		const repeat = await f.call(f.body);
		expect(repeat.status).toBe(200);
		expect((repeat.body as { changed: boolean }).changed).toBe(false);
	});
	test('competing extensions from the same old expiry have exactly one winner', async () => {
		const f = await fixture();
		const results = await Promise.all([
			f.call(f.body),
			f.call({ ...f.body, expiresAt: future(15) })
		]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
	});
	test('the creating API key may renew, while copied marker and expiry do not transfer ownership', async () => {
		const f = await fixture('server', 'keyAll');
		expect((await f.call(f.body)).status).toBe(200);
		const renewed = await f.read();
		await env.db.update(listEntries).set({ addedBy: randomUUID() }).where(eq(listEntries.id, f.id));
		const replacement = await f.read();
		expect(
			(
				await f.call({
					...f.body,
					expectedExpiresAt: renewed.expiresAt!.toISOString(),
					expiresAt: future(20)
				})
			).status
		).toBe(409);
		expect(
			(
				await f.call({
					expectedMarker: f.marker,
					expectedExpiresAt: renewed.expiresAt!.toISOString(),
					remove: true
				})
			).status
		).toBe(409);
		expect(await f.read()).toEqual(replacement);
	});
	test('manual takeover while renewal waits for the row lock is refused', async () => {
		const f = await fixture();
		let pending!: ReturnType<typeof f.call>;
		await env.db.transaction(async (tx) => {
			await tx.select().from(listEntries).where(eq(listEntries.id, f.id)).for('update');
			pending = f.call(f.body);
			await tx
				.update(listEntries)
				.set({ reason: 'manual replacement', expiresAt: null })
				.where(eq(listEntries.id, f.id));
		});
		expect((await pending).status).toBe(409);
		expect((await f.read()).reason).toBe('manual replacement');
		expect((await f.read()).expiresAt).toBeNull();
	});
	test('wrong marker/expiry, removed row and permanent reservation remain untouched', async () => {
		for (const mutation of ['marker', 'expiry', 'removed', 'permanent'] as const) {
			const f = await fixture();
			if (mutation === 'removed')
				await env.db
					.update(listEntries)
					.set({ removedAt: new Date() })
					.where(eq(listEntries.id, f.id));
			if (mutation === 'permanent')
				await env.db.update(listEntries).set({ expiresAt: null }).where(eq(listEntries.id, f.id));
			const before = await f.read();
			const body = {
				...f.body,
				...(mutation === 'marker' ? { expectedMarker: `EXOTIX VIP ${randomUUID()}` } : {}),
				...(mutation === 'expiry' ? { expectedExpiresAt: future(4) } : {})
			};
			expect((await f.call(body)).status).toBe(409);
			expect(await f.read()).toEqual(before);
		}
	});
	test('organisation coverage cannot authorize creating or extending a server reservation', async () => {
		const f = await fixture('org'),
			before = await f.read();
		expect((await f.call(f.body)).status).toBe(409);
		expect(await f.read()).toEqual(before);
	});
	test('finite validation rejects permanent, past, excessive, shorter and generic edits', async () => {
		const f = await fixture(),
			before = await f.read();
		for (const expiresAt of [
			null,
			'',
			'invalid',
			future(-1),
			future(11 * 366 * 24 * 60),
			future(4)
		])
			expect((await f.call({ ...f.body, expiresAt })).status).toBe(400);
		expect((await f.call({ ...f.body, reason: 'overwrite' })).status).toBe(400);
		expect(await f.read()).toEqual(before);
	});
	test('view-only and other-server credentials cannot renew', async () => {
		const f = await fixture(),
			before = await f.read();
		for (const who of ['viewer', 'keyView', 'keyElsewhere', 'anon'] as const)
			expect([401, 403, 404]).toContain((await f.call(f.body, who)).status);
		expect(await f.read()).toEqual(before);
	});
	test('owned removal preserves history and repeats a lost reply without another withdrawal', async () => {
		const f = await fixture(),
			before = await f.read();
		const body = { expectedMarker: f.marker, expectedExpiresAt: f.expiresAt, remove: true };
		const first = await f.call(body);
		expect(first.status).toBe(200);
		expect((first.body as { removed: boolean; changed: boolean }).removed).toBe(true);
		expect((first.body as { changed: boolean }).changed).toBe(true);
		const removed = await f.read();
		expect(removed.removedAt).not.toBeNull();
		expect(removed.reason).toBe(before.reason);
		expect(removed.expiresAt).toEqual(before.expiresAt);
		expect(removed.addedAt).toEqual(before.addedAt);
		expect(removed.addedBy).toBe(before.addedBy);
		const repeated = await f.call(body); // Original result may have been lost to the caller.
		expect(repeated.status).toBe(200);
		expect((repeated.body as { changed: boolean }).changed).toBe(false);
		expect(await f.read()).toEqual(removed);
		await env.db.insert(listEntries).values({
			id: randomUUID(),
			listId: before.listId,
			steamId,
			reason: 'manual replacement after withdrawal',
			expiresAt: null
		});
		expect((await f.call(body)).status).toBe(409);
	});
	test('another creator’s reservation removed by this actor is not an owned-removal retry', async () => {
		const f = await fixture('server', 'keyAll');
		const original = await f.read();
		expect(original.addedBy).not.toBe(f.owner!.id);
		const deleted = await callApi(remove, f.owner, {
			method: 'DELETE',
			params: { id: f.serverId, steamId }
		});
		expect(deleted.status).toBe(200);
		const tombstone = await f.read();
		expect(tombstone.addedBy).toBe(original.addedBy);
		expect(tombstone.removedBy).toBe(f.owner!.id);
		expect(tombstone.removedAt).not.toBeNull();
		expect(
			(
				await f.call(
					{ expectedMarker: f.marker, expectedExpiresAt: f.expiresAt, remove: true },
					'owner'
				)
			).status
		).toBe(409);
		expect(await f.read()).toEqual(tombstone);
	});
	test('manual takeover during the last-read/write window prevents owned removal atomically', async () => {
		const f = await fixture();
		const body = { expectedMarker: f.marker, expectedExpiresAt: f.expiresAt, remove: true };
		let pending!: ReturnType<typeof f.call>;
		await env.db.transaction(async (tx) => {
			await tx.select().from(listEntries).where(eq(listEntries.id, f.id)).for('update');
			pending = f.call(body);
			await tx
				.update(listEntries)
				.set({ reason: 'manual takeover', expiresAt: null })
				.where(eq(listEntries.id, f.id));
		});
		expect((await pending).status).toBe(409);
		expect((await f.read()).removedAt).toBeNull();
		expect((await f.read()).reason).toBe('manual takeover');
	});
	test('org, permanent and expiry replacement cannot inherit owned removal authority', async () => {
		for (const kind of ['org', 'permanent', 'expiry'] as const) {
			const f = await fixture(kind === 'org' ? 'org' : 'server');
			if (kind !== 'org')
				await env.db
					.update(listEntries)
					.set({ expiresAt: kind === 'permanent' ? null : new Date(future(15)) })
					.where(eq(listEntries.id, f.id));
			const before = await f.read();
			expect(
				(await f.call({ expectedMarker: f.marker, expectedExpiresAt: f.expiresAt, remove: true }))
					.status
			).toBe(409);
			expect(await f.read()).toEqual(before);
		}
	});
});
