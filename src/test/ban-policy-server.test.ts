import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { DEFAULT_BAN_POLICY } from '$lib/ban-policy';
import { getOrg } from '$lib/server/access';
import { setBanPolicy } from '$lib/server/ban-policy';
import { banCases, listEntries } from '$lib/server/db/schema';
import { serverListOf } from '$lib/server/lists';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway, type CallInput } from './call';
import { seedWorld, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes', 'api');
const PLAYER = '76561198000123456';

describe.skipIf(!hasTestDb)('structured ban policy writes', () => {
	let env: Env;
	let world: World;
	let org: NonNullable<Awaited<ReturnType<typeof getOrg>>>;
	const call = async (method: 'POST' | 'PATCH' | 'GET', path: string, input: CallInput = {}) => {
		const route = await import(join(ROUTES, path, '+server.ts'));
		return callApi(route[method], world.users.owner, {
			method,
			...input,
			params: { id: world.server.id, steamId: PLAYER, ...input.params }
		});
	};
	const entry = async () => {
		const list = await serverListOf(env, { id: world.server.id, orgId: world.org.id }, 'ban');
		const [row] = await env.db
			.select()
			.from(listEntries)
			.where(
				and(
					eq(listEntries.listId, list.id),
					eq(listEntries.steamId, PLAYER),
					isNull(listEntries.removedAt)
				)
			);
		return row!;
	};

	beforeAll(async () => {
		env = await testEnv();
		world = await seedWorld(env);
		org = (await getOrg(env, world.org.id))!;
		stubGateway();
		await setBanPolicy(
			env,
			new Request('http://test/policy', { method: 'PATCH' }),
			world.users.owner!,
			org,
			{
				...DEFAULT_BAN_POLICY,
				enabled: true
			}
		);
	});

	test('requires a category when policy is on and snapshots only private case metadata', async () => {
		const missing = await call('POST', 'servers/[id]/lists/ban/entries', {
			body: { steamId: PLAYER, reason: 'griefing' }
		});
		expect(missing.status).toBe(400);
		const added = await call('POST', 'servers/[id]/lists/ban/entries', {
			body: {
				steamId: PLAYER,
				moderation: { categoryId: 'griefing', days: 3, ticketId: '00123', notes: 'staff evidence' }
			}
		});
		expect(added.status).toBe(201);
		const row = await entry();
		expect(row.reason).toBe('Griefing');
		const [caseRow] = await env.db.select().from(banCases).where(eq(banCases.entryId, row.id));
		expect(caseRow.record).toMatchObject({
			categoryId: 'griefing',
			days: 3,
			notes: 'staff evidence'
		});
		const viewer = await callApi(
			(await import(join(ROUTES, 'servers/[id]/lists/state/+server.ts'))).GET,
			world.users.viewer,
			{
				params: { id: world.server.id }
			}
		);
		expect(JSON.stringify(viewer.body)).not.toContain('staff evidence');
	});

	test('Player Review cannot be placed on a server-only list', async () => {
		const answer = await call('POST', 'servers/[id]/lists/ban/entries', {
			params: { steamId: '76561198000123457' },
			body: {
				steamId: '76561198000123457',
				reason: 'Review',
				moderation: { categoryId: 'player-review', days: 0 }
			}
		});
		expect(answer.status).toBe(400);
	});

	test('a categorized wording edit preserves its existing fixed-term expiry', async () => {
		const before = await entry();
		const edited = await call('PATCH', 'servers/[id]/lists/ban/entries/[steamId]', {
			body: {
				reason: 'Intentional team killing (confirmed)',
				moderation: {
					categoryId: 'griefing',
					days: 3,
					ticketId: '00123',
					notes: 'updated evidence'
				}
			}
		});
		expect(edited.status).toBe(200);
		const after = await entry();
		expect(after.expiresAt?.toISOString()).toBe(before.expiresAt?.toISOString());
		expect(after.reason).toBe('Intentional team killing (confirmed)');
	});

	test('policy-off organisations retain the native unclassified ban path', async () => {
		await setBanPolicy(
			env,
			new Request('http://test/policy', { method: 'PATCH' }),
			world.users.owner!,
			org,
			{
				...DEFAULT_BAN_POLICY,
				enabled: false
			}
		);
		const steamId = '76561198000123458';
		const answer = await call('POST', 'servers/[id]/lists/ban/entries', {
			params: { steamId },
			body: { steamId, reason: 'native legacy reason' }
		});
		expect(answer.status).toBe(201);
		const list = await serverListOf(env, { id: world.server.id, orgId: world.org.id }, 'ban');
		const [row] = await env.db
			.select({ id: listEntries.id })
			.from(listEntries)
			.where(
				and(
					eq(listEntries.listId, list.id),
					eq(listEntries.steamId, steamId),
					isNull(listEntries.removedAt)
				)
			);
		expect(row).toBeTruthy();
		const [caseRow] = await env.db.select().from(banCases).where(eq(banCases.entryId, row!.id));
		expect(caseRow).toBeUndefined();
	});
});
