import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { DEFAULT_BAN_POLICY, type BanCase, type BanPolicy } from '$lib/ban-policy';
import { enqueueBanAnnouncements, banAnnouncementStillHolds } from '$lib/server/ban-announcements';
import { banCases, listEntries, orgBanPolicies, outbox } from '$lib/server/db/schema';
import { listOf } from '$lib/server/lists';
import type { Env } from '$lib/server/env';
import { hasTestDb, testEnv } from './db';
import { seedWorld } from './world';

describe.skipIf(!hasTestDb)('durable category announcements', () => {
	let env: Env;
	beforeAll(async () => {
		env = await testEnv();
	});

	async function fixture(categoryId: BanCase['categoryId'] = 'cheating') {
		const world = await seedWorld(env);
		const policy: BanPolicy = { ...structuredClone(DEFAULT_BAN_POLICY), enabled: true };
		await env.db.insert(orgBanPolicies).values({ orgId: world.org.id, config: policy });
		const list = await listOf(env, world.org.id, 'ban');
		const [entry] = await env.db
			.insert(listEntries)
			.values({
				id: crypto.randomUUID(),
				listId: list.id,
				steamId: '76561198000000991',
				reason: 'Confirmed rule breach'
			})
			.returning();
		const banCase: BanCase = {
			categoryId,
			category: categoryId === 'cheating' ? 'Cheating' : 'Player Review',
			days: 0,
			reason: 'Confirmed rule breach',
			ticketId: '00123',
			notes: 'PRIVATE EVIDENCE',
			originServerId: world.server.id,
			playerMessage: 'Review the case'
		};
		await env.db.insert(banCases).values({ entryId: entry.id, record: banCase });
		const event = {
			orgId: world.org.id,
			entryId: entry.id,
			steamId: entry.steamId,
			expiresAt: null,
			policy,
			banCase,
			source: { id: world.server.id, name: 'EXOTIX EU-01' },
			name: 'Example player'
		};
		const enqueue = () => env.db.transaction((tx) => enqueueBanAnnouncements(tx, event));
		const rows = () =>
			env.db
				.select()
				.from(outbox)
				.where(eq(outbox.dedupeKey, `ban-announcement:${entry.id}:${world.server.id}`));
		return { world, policy, entry, banCase, event, enqueue, rows };
	}

	test('fans out only inside the org, chooses one line, deduplicates retries and keeps notes private', async () => {
		const f = await fixture();
		await f.enqueue();
		await f.enqueue();
		const rows = (await env.db.select().from(outbox)).filter(
			(r) => (r.params as { entryId?: string })?.entryId === f.entry.id
		);
		expect(rows.map((r) => r.serverId).sort()).toEqual(
			[f.world.server.id, f.world.otherServer.id].sort()
		);
		expect(new Set(rows.map((r) => (r.params as { message: string }).message)).size).toBe(1);
		expect(JSON.stringify(rows)).not.toContain('PRIVATE EVIDENCE');
		expect(await banAnnouncementStillHolds(env.db, rows[0])).toBeTrue();
	});

	test('Player Review announces only at its origin, even for an org-wide ban', async () => {
		const f = await fixture('player-review');
		await f.enqueue();
		const all = (await env.db.select().from(outbox)).filter(
			(r) => (r.params as { entryId?: string })?.entryId === f.entry.id
		);
		expect(all.map((r) => r.serverId)).toEqual([f.world.server.id]);
	});

	test('cancelled, expired or publicly edited cases and changed settings cannot announce stale facts', async () => {
		const f = await fixture();
		await f.enqueue();
		const [row] = await f.rows();
		await env.db
			.update(banCases)
			.set({ record: { ...f.banCase, notes: 'New private note' } })
			.where(eq(banCases.entryId, f.entry.id));
		expect(await banAnnouncementStillHolds(env.db, row)).toBeTrue();
		await env.db
			.update(banCases)
			.set({ record: { ...f.banCase, reason: 'Corrected reason' } })
			.where(eq(banCases.entryId, f.entry.id));
		expect(await banAnnouncementStillHolds(env.db, row)).toBeFalse();
		await env.db
			.update(banCases)
			.set({ record: f.banCase })
			.where(eq(banCases.entryId, f.entry.id));
		await env.db
			.update(orgBanPolicies)
			.set({ config: { ...f.policy, enabled: false } })
			.where(eq(orgBanPolicies.orgId, f.world.org.id));
		expect(await banAnnouncementStillHolds(env.db, row)).toBeFalse();
		await env.db
			.update(orgBanPolicies)
			.set({ config: f.policy })
			.where(eq(orgBanPolicies.orgId, f.world.org.id));
		await env.db
			.update(listEntries)
			.set({ expiresAt: new Date(0) })
			.where(eq(listEntries.id, f.entry.id));
		expect(await banAnnouncementStillHolds(env.db, row)).toBeFalse();
		await env.db
			.update(listEntries)
			.set({ expiresAt: null, removedAt: new Date() })
			.where(eq(listEntries.id, f.entry.id));
		expect(await banAnnouncementStillHolds(env.db, row)).toBeFalse();
	});

	test('missing origin does not turn a local announcement into an org broadcast', async () => {
		const f = await fixture('player-review');
		await env.db.transaction((tx) => enqueueBanAnnouncements(tx, { ...f.event, source: null }));
		expect(await f.rows()).toEqual([]);
	});

	test('an overlong expanded announcement is recorded as skipped without rolling back a ban', async () => {
		const f = await fixture();
		f.event.name = 'x'.repeat(300);
		await f.enqueue();
		expect((await f.rows())[0].state).toBe('skipped');
		expect(
			(await env.db.select().from(listEntries).where(eq(listEntries.id, f.entry.id))).length
		).toBe(1);
	});
});
