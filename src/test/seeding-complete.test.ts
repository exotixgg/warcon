import { expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { outbox } from '$lib/server/db/schema';
import { reserveSeedComplete } from '$lib/server/seeding-complete';
import { hasTestDb, testEnv } from './db';
import { seedWorld } from './world';

test.skipIf(!hasTestDb)('shares the delivery cooldown across an org', async () => {
	const env = await testEnv();
	const world = await seedWorld(env);
	const steamId = '76561198000001891';
	let sequence = 0;
	const add = async (serverId: string, stage = 'complete') => {
		const [row] = await env.db
			.insert(outbox)
			.values({
				serverId,
				action: 'whisper',
				triggerKind: 'seed_reward',
				dedupeKey: `${world.org.id}:complete:${++sequence}`,
				steamId,
				params: { seedNotice: { stage } },
				state: 'sending'
			})
			.returning({ id: outbox.id, steamId: outbox.steamId });
		return row;
	};
	const settle = (id: number, state: string, minutesAgo = 0) =>
		env.db
			.update(outbox)
			.set({ state, doneAt: new Date(Date.now() - minutesAgo * 60_000) })
			.where(eq(outbox.id, id));
	const reserve = (row: Awaited<ReturnType<typeof add>>, orgId = world.org.id) =>
		env.db.transaction((tx) => reserveSeedComplete(tx, orgId, row));

	const intro = await add(world.server.id, 'intro');
	await settle(intro.id, 'delivered');
	const rows = await Promise.all([add(world.server.id), add(world.otherServer.id)]);
	const attempts = await Promise.all(rows.map((row) => reserve(row)));
	expect(attempts.filter(Boolean)).toHaveLength(1);
	const sent = rows[attempts.indexOf(true)];
	const duplicate = rows[attempts.indexOf(false)];

	await settle(sent.id, 'unknown', 59);
	expect(await reserve(duplicate)).toBe(false);
	expect(await reserve(await add(world.otherOrgServer.id), world.otherOrg.id)).toBe(true);
	await settle(sent.id, 'delivered', 61);
	expect(await reserve(duplicate)).toBe(true);
	await settle(duplicate.id, 'failed');
	expect(await reserve(await add(world.server.id))).toBe(true);
});
