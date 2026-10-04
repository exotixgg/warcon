import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { SQL } from 'bun';
import { randomBytes } from 'node:crypto';
import { migrate } from 'drizzle-orm/bun-sql/migrator';
import { connect } from '$lib/server/db';
import { eq, sql } from 'drizzle-orm';
import {
	DEFAULT_BAN_POLICY,
	EXPIRY_POLICY_MESSAGE,
	type BanPolicyView
} from '$lib/exotix/ban-policy';
import { formatBanExpiry } from '$lib/ban-message';
import { policyOf, savePolicy, caseOf } from '$lib/server/exotix/ban-policy';
import { runExotixMigrations, pendingExotixMigrations } from '$lib/server/exotix/migrations';
import { auditLog, listEntries, organizations, servers } from '$lib/server/db/schema';
import { grantEntry, listOf, entriesView, serverListOf } from '$lib/server/lists';
import { kickBanned } from '$lib/server/lists-sync';
import type { PanelBan } from '$lib/server/lists-plan';
import type { WardogsClient } from '$lib/server/rcon';
import type { Env } from '$lib/server/env';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';
import { callApi, stubGateway } from './call';

const ROUTES = join(import.meta.dir, '..', 'routes', 'api');
const PLAYER = '76561198000000881';
const PRIVATE = 'PRIVATE-CASE-EVIDENCE-DO-NOT-SEND';
const form = (p: BanPolicyView, extra = {}) => ({
	policyVersion: p.version,
	categoryId: 'griefing',
	levelId: 'standard',
	ticketId: '00123',
	description: PRIVATE,
	...extra
});
const call = async (
	w: World,
	route: string,
	method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
	body = {},
	principal: keyof World['users'] = 'owner',
	params = {},
	query = ''
) => {
	const mod = await import(join(ROUTES, route, '+server.ts'));
	return callApi(mod[method], w.users[principal], {
		method,
		body,
		params: { id: w.org.id, kind: 'ban', steamId: PLAYER, ...params },
		query
	});
};

describe.skipIf(!hasTestDb)('EXOTIX structured bans on a real database', () => {
	let env: Env;
	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
	});
	async function enabled() {
		const w = await seedWorld(env);
		const policy = await savePolicy(env.db, w.org.id, {
			...structuredClone(DEFAULT_BAN_POLICY),
			enabled: true
		});
		return { w, policy };
	}
	test('upgrade from upstream-only schema preserves all public table counts and the legacy ban', async () => {
		const name = `warcon_test_upgrade_${randomBytes(6).toString('hex')}`;
		const admin = new SQL(process.env.TEST_DATABASE_URL!, { max: 1 });
		await admin.unsafe(`CREATE DATABASE "${name}"`);
		const target = new URL(process.env.TEST_DATABASE_URL!);
		target.pathname = `/${name}`;
		const isolated = connect(target.href);
		try {
			await migrate(isolated.db, { migrationsFolder: join(process.cwd(), 'drizzle') });
			const rehearsal = { ...env, db: isolated.db, sql: isolated.client };
			const w = await seedWorld(rehearsal);
			const list = await listOf(rehearsal, w.org.id, 'ban');
			await isolated.db.insert(listEntries).values({
				id: 'legacy-before-extension',
				listId: list.id,
				steamId: PLAYER,
				reason: 'original legacy reason',
				addedByName: 'original moderator'
			});
			const tables = await isolated.db.execute<{ name: string }>(
				sql`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
			);
			const counts = async () =>
				Promise.all(
					tables.map(async (t) => {
						const [row] = await isolated.db.execute<{ n: string }>(
							sql`SELECT count(*)::text AS n FROM public.${sql.identifier(t.name)}`
						);
						return [t.name, row.n];
					})
				);
			const before = await counts();
			const legacy = await isolated.db
				.select()
				.from(listEntries)
				.where(eq(listEntries.id, 'legacy-before-extension'));
			const journal = await isolated.db.execute(
				sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`
			);
			expect(await pendingExotixMigrations(isolated.db)).toBe(3);
			await runExotixMigrations(isolated.db);
			expect(await counts()).toEqual(before);
			expect(
				await isolated.db
					.select()
					.from(listEntries)
					.where(eq(listEntries.id, 'legacy-before-extension'))
			).toEqual(legacy);
			expect(
				await isolated.db.execute(sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`)
			).toEqual(journal);
			await isolated.db.execute(sql`UPDATE exotix.schema_migrations SET checksum = 'tampered'`);
			await expect(pendingExotixMigrations(isolated.db)).rejects.toThrow('migration changed');
			await expect(runExotixMigrations(isolated.db)).rejects.toThrow('migration changed');
			expect(await counts()).toEqual(before);
		} finally {
			await isolated.client.close();
			await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
			await admin.close();
		}
	}, 15000);
	test('extension migrations are repeatable and preserve upstream records and its ledger', async () => {
		const w = await seedWorld(env);
		const list = await listOf(env, w.org.id, 'ban');
		await grantEntry(env, list, {
			steamId: PLAYER,
			reason: 'legacy',
			expiresAt: null,
			addedByName: 'original'
		});
		const before = await env.db.select().from(listEntries).where(eq(listEntries.listId, list.id));
		const journal = await env.db.execute(
			sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`
		);
		await runExotixMigrations(env.db);
		await runExotixMigrations(env.db);
		expect(await pendingExotixMigrations(env.db)).toBe(0);
		expect(await env.db.select().from(listEntries).where(eq(listEntries.listId, list.id))).toEqual(
			before
		);
		expect(
			await env.db.execute(sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`)
		).toEqual(journal);
		expect(await caseOf(env.db, before[0].id)).toBeNull();
		expect((await policyOf(env.db, w.org.id)).enabled).toBe(false);
	});
	test('only an owner configures policy and concurrent stale edits are rejected', async () => {
		const w = await seedWorld(env),
			p = await policyOf(env.db, w.org.id);
		const body = { ...p, enabled: true };
		for (const principal of [
			'anon',
			'member',
			'viewer',
			'operator',
			'admin',
			'orgBans',
			'outsider',
			'keyAll',
			'keyBans'
		] as const)
			expect((await call(w, 'orgs/[id]/ban-policy', 'PATCH', body, principal)).status).not.toBe(
				200
			);
		expect((await policyOf(env.db, w.org.id)).version).toBe(p.version);
		const edits = await Promise.all([
			call(w, 'orgs/[id]/ban-policy', 'PATCH', body),
			call(w, 'orgs/[id]/ban-policy', 'PATCH', body)
		]);
		expect(edits.map((r) => r.status).sort()).toEqual([200, 409]);
		expect((await call(w, 'orgs/[id]/ban-policy', 'GET', {}, 'viewer')).status).not.toBe(200);
		expect(
			(await call(w, 'orgs/[id]/ban-policy', 'GET', {}, 'viewer', {}, `serverId=${w.server.id}`))
				.status
		).not.toBe(200);
		expect(
			(await call(w, 'orgs/[id]/ban-policy', 'GET', {}, 'admin', {}, `serverId=${w.server.id}`))
				.status
		).toBe(200);
		expect(
			(
				await call(
					w,
					'orgs/[id]/ban-policy',
					'GET',
					{},
					'owner',
					{},
					`serverId=${w.otherOrgServer.id}`
				)
			).status
		).not.toBe(200);
	});
	test('settings page data is refused independently of layout for non-owners and other tenants', async () => {
		const w = await seedWorld(env);
		const orgSettings = await import('../routes/(app)/orgs/[id]/settings/+page.server');
		const adminSettings = await import('../routes/(app)/admin/settings/+page.server');
		for (const principal of [
			'anon',
			'member',
			'viewer',
			'operator',
			'admin',
			'orgBans',
			'outsider',
			'keyAll'
		] as const) {
			const event = { locals: { user: w.users[principal] }, params: { id: w.org.id } };
			await expect(orgSettings.load(event as never)).rejects.toBeDefined();
			await expect(adminSettings.load(event as never)).rejects.toBeDefined();
		}
		expect(
			await orgSettings.load({ locals: { user: w.users.owner }, params: { id: w.org.id } } as never)
		).toMatchObject({ banOrganization: { id: w.org.id } });
		await expect(
			orgSettings.load({ locals: { user: w.users.owner }, params: { id: w.otherOrg.id } } as never)
		).rejects.toBeDefined();
		await expect(
			adminSettings.load({ locals: { user: w.users.owner } } as never)
		).rejects.toBeDefined();
		const siteData = await adminSettings.load({ locals: { user: w.users.site } } as never);
		expect(siteData).toHaveProperty('banOrganizations');
	});
	test('custom templates are snapshotted for manual cases, automation, and later extensions', async () => {
		const { w, policy } = await enabled();
		const messageTemplate = '{reference}: {reason} | {duration} | {appeal}';
		const p = await savePolicy(env.db, w.org.id, { ...policy, messageTemplate });
		expect(
			(
				await call(w, 'orgs/[id]/lists/[kind]/entries', 'POST', {
					steamId: PLAYER,
					moderation: form(p)
				})
			).status
		).toBe(201);
		const list = await listOf(env, w.org.id, 'ban');
		const entries = await env.db.select().from(listEntries).where(eq(listEntries.listId, list.id));
		expect((await caseOf(env.db, entries[0].id))!.message).toBe(
			't-00123: Griefing | 7d | Appeal on discord.gg/exotix'
		);
		const auto = await grantEntry(env, list, {
			steamId: '76561198000000882',
			reason: PRIVATE,
			expiresAt: null,
			addedByName: 'trigger: test'
		});
		const autoCase = (await caseOf(env.db, auto.id))!;
		expect(autoCase.message).toBe(
			`${autoCase.reference}: Rule violation | PERM | Appeal on discord.gg/exotix`
		);
		expect(autoCase.message).not.toContain(PRIVATE);
		const weaponReason = 'Infantry weapon rule: second prohibited kill';
		const weaponTemplate = '{reason} | {duration} | Unban: {unban_at} | {reference} | {appeal}';
		const weapon = await grantEntry(env, list, {
			steamId: '76561198000000883',
			reason: weaponReason,
			playerReason: weaponReason,
			playerMessageTemplate: weaponTemplate,
			expiresAt: new Date(Date.now() + 7 * 86400_000),
			addedByName: 'trigger: Infantry Weapon Rule'
		});
		const weaponCase = (await caseOf(env.db, weapon.id))!;
		expect(weaponCase.message).toContain(`${weaponReason} | 7d |`);
		expect(weaponCase.message).toContain('Unban: ');
		expect(weaponCase.messageTemplate).toBe(weaponTemplate);
		const oversized = await grantEntry(env, list, {
			steamId: '76561198000000885',
			reason: weaponReason,
			playerReason: weaponReason,
			playerMessageTemplate: `${'X'.repeat(145)} {reason} {duration} {reference} {appeal}`,
			expiresAt: new Date(Date.now() + 7 * 86400_000),
			addedByName: 'trigger: Infantry Weapon Rule'
		});
		const fallbackCase = (await caseOf(env.db, oversized.id))!;
		expect(fallbackCase.message).toContain('Rule violation | 7d |');
		expect(fallbackCase.messageTemplate).toBe(messageTemplate);
		const malformed = await grantEntry(env, list, {
			steamId: '76561198000000884',
			reason: 'Unsafe | source reason',
			playerReason: 'Unsafe | source reason',
			expiresAt: null,
			addedByName: 'trigger: Infantry Weapon Rule'
		});
		expect((await caseOf(env.db, malformed.id))!.message).toContain('Rule violation | PERM |');
		await savePolicy(env.db, w.org.id, { ...policy, appealText: 'Changed appeal' });
		await grantEntry(
			env,
			list,
			{
				steamId: PLAYER,
				reason: PRIVATE,
				expiresAt: new Date(Date.now() + 30 * 86400000),
				addedByName: 'trigger: extend'
			},
			{ lengthen: true }
		);
		await grantEntry(
			env,
			list,
			{
				steamId: '76561198000000883',
				reason: weaponReason,
				expiresAt: new Date(Date.now() + 30 * 86400000),
				addedByName: 'trigger: extend'
			},
			{ lengthen: true }
		);
		const extendedWeapon = (await caseOf(env.db, weapon.id))!;
		expect(extendedWeapon.message).toContain(`${weaponReason} | 30d | Unban: `);
		expect(extendedWeapon.messageTemplate).toBe(weaponTemplate);
		expect((await caseOf(env.db, entries[0].id))!.message).toBe(
			't-00123: Griefing | 30d | Appeal on discord.gg/exotix'
		);
	});
	test('expiry matches list enforcement for org bans, server bans, automation and extensions', async () => {
		const { w, policy } = await enabled();
		const p = await savePolicy(env.db, w.org.id, {
			...policy,
			messageTemplate: EXPIRY_POLICY_MESSAGE
		});
		for (const [route, params, list] of [
			['orgs/[id]/lists/[kind]/entries', {}, await listOf(env, w.org.id, 'ban')],
			[
				'servers/[id]/lists/ban/entries',
				{ id: w.server.id },
				await serverListOf(env, { id: w.server.id, orgId: w.org.id }, 'ban')
			]
		] as const) {
			expect(
				(
					await call(
						w,
						route,
						'POST',
						{ steamId: PLAYER, moderation: form(await policyOf(env.db, w.org.id)) },
						'owner',
						params
					)
				).status
			).toBe(201);
			const [entry] = await env.db
				.select()
				.from(listEntries)
				.where(eq(listEntries.listId, list.id));
			const c = (await caseOf(env.db, entry.id))!;
			expect(c.expiresAt).toBe(entry.expiresAt!.toISOString());
			expect(c.message).toContain(`Unban: ${formatBanExpiry(entry.expiresAt)}`);
			await savePolicy(env.db, w.org.id, {
				...p,
				messageTemplate: policy.messageTemplate,
				appealText: 'Changed appeal'
			});
			const expiry = new Date(Date.now() + 30 * 86400000);
			await grantEntry(
				env,
				list,
				{ steamId: PLAYER, reason: PRIVATE, expiresAt: expiry, addedByName: 'trigger: extend' },
				{ lengthen: true }
			);
			const extended = (await caseOf(env.db, entry.id))!;
			expect(extended.expiresAt).toBe(expiry.toISOString());
			expect(extended.message).toContain(`Unban: ${formatBanExpiry(expiry)}`);
			expect(extended.message).toContain('Appeal on discord.gg/exotix');
			expect(extended.message).not.toContain(PRIVATE);
			await savePolicy(env.db, w.org.id, p);
			const exact = new Date(Date.now() + 7 * 86400000);
			const auto = await grantEntry(env, list, {
				steamId: '76561198000000882',
				reason: PRIVATE,
				expiresAt: exact,
				addedByName: 'trigger: test'
			});
			const automatic = (await caseOf(env.db, auto.id))!;
			expect(automatic.expiresAt).toBe(exact.toISOString());
			expect(automatic.message).toContain(`Unban: ${formatBanExpiry(exact)}`);
			expect(automatic.message).toContain(automatic.reference);
			await grantEntry(
				env,
				list,
				{
					steamId: '76561198000000882',
					reason: PRIVATE,
					expiresAt: null,
					addedByName: 'trigger: permanent'
				},
				{ lengthen: true }
			);
			expect((await caseOf(env.db, auto.id))!.message).toContain('Unban: Permanent');
		}
	});
	test('enabled manual bans validate before writing; record fixed durations and private notes', async () => {
		const { w, policy } = await enabled();
		for (const moderation of [
			{},
			form(policy, { ticketId: '1234' }),
			form(policy, { description: '' }),
			form(policy, { policyVersion: 'stale' })
		]) {
			const r = await call(w, 'orgs/[id]/lists/[kind]/entries', 'POST', {
				steamId: PLAYER,
				reason: 'bypass',
				expiresAt: null,
				moderation
			});
			expect(r.status).toBe(400);
		}
		const org = (
			await env.db.select().from(organizations).where(eq(organizations.id, w.org.id))
		)[0];
		expect(await entriesView(env, org, 'ban')).toHaveLength(0);
		const started = Date.now();
		const r = await call(w, 'orgs/[id]/lists/[kind]/entries', 'POST', {
			steamId: PLAYER,
			reason: 'ignored',
			expiresAt: null,
			moderation: form(policy)
		});
		expect(r.status).toBe(201);
		const entries = await entriesView(env, org, 'ban');
		expect(entries[0]).toMatchObject({
			reason: 'Griefing',
			moderation: { reference: 't-00123', description: PRIVATE, source: 'manual' }
		});
		const days = (new Date(entries[0].expiresAt!).getTime() - started) / 86400000;
		expect(days).toBeGreaterThanOrEqual(7);
		expect(days).toBeLessThan(7.001);
		const audits = await env.db.select().from(auditLog).where(eq(auditLog.orgId, w.org.id));
		expect(JSON.stringify(audits)).not.toContain(PRIVATE);
	});
	test('server bans hide private case records from viewers and other tenants', async () => {
		const { w, policy } = await enabled();
		const r = await call(
			w,
			'servers/[id]/lists/ban/entries',
			'POST',
			{ steamId: PLAYER, moderation: form(policy) },
			'admin',
			{ id: w.server.id }
		);
		expect(r.status).toBe(201);
		const viewer = await call(w, 'servers/[id]/lists/state', 'GET', {}, 'viewer', {
			id: w.server.id
		});
		expect(viewer.status).toBe(200);
		expect(JSON.stringify(viewer.body)).not.toContain(PRIVATE);
		expect(JSON.stringify(viewer.body)).not.toContain('t-00123');
		const staff = await call(w, 'servers/[id]/lists/state', 'GET', {}, 'admin', {
			id: w.server.id
		});
		expect(staff.status).toBe(200);
		expect(JSON.stringify(staff.body)).toContain(PRIVATE);
		const outsider = await call(w, 'servers/[id]/lists/state', 'GET', {}, 'outsider', {
			id: w.server.id
		});
		expect(outsider.status).not.toBe(200);
		const edit = await call(
			w,
			'servers/[id]/lists/ban/entries/[steamId]',
			'PATCH',
			{ description: 'Updated private notes' },
			'admin',
			{ id: w.server.id }
		);
		expect(edit.status).toBe(200);
		expect(edit.body).toMatchObject({ entry: { reason: 'Griefing' } });
		expect(
			(
				await call(
					w,
					'servers/[id]/lists/ban/entries/[steamId]',
					'PATCH',
					{ reason: 'bypass', expiresAt: null },
					'admin',
					{ id: w.server.id }
				)
			).status
		).toBe(400);
		const audits = await env.db.select().from(auditLog).where(eq(auditLog.orgId, w.org.id));
		expect(JSON.stringify(audits)).not.toContain('Updated private notes');
	});
	test('pending review is permanent, can be lifted, and remains in history with resolved status', async () => {
		const { w, policy } = await enabled();
		const r = await call(w, 'orgs/[id]/lists/[kind]/entries', 'POST', {
			steamId: PLAYER,
			moderation: form(policy, { categoryId: 'player-review', levelId: 'pending' })
		});
		expect(r.status).toBe(201);
		const org = (
			await env.db.select().from(organizations).where(eq(organizations.id, w.org.id))
		)[0];
		expect((await entriesView(env, org, 'ban'))[0]).toMatchObject({
			expiresAt: null,
			moderation: { reviewStatus: 'pending' }
		});
		expect((await call(w, 'orgs/[id]/lists/[kind]/entries/[steamId]', 'DELETE')).status).toBe(200);
		expect(await entriesView(env, org, 'ban')).toHaveLength(0);
		expect(
			(await entriesView(env, org, 'ban', { includeRemoved: true }))[0].moderation?.reviewStatus
		).toBe('resolved');
	});
	test('stored player message survives policy changes and disabling; private notes never reach RCON', async () => {
		const { w, policy } = await enabled();
		await call(w, 'orgs/[id]/lists/[kind]/entries', 'POST', {
			steamId: PLAYER,
			moderation: form(policy)
		});
		const org = (
			await env.db.select().from(organizations).where(eq(organizations.id, w.org.id))
		)[0];
		const server = (await env.db.select().from(servers).where(eq(servers.id, w.server.id)))[0];
		const list = await listOf(env, w.org.id, 'ban');
		const bodies: unknown[] = [];
		const client = {
			json: async (_method: string, _path: string, body: unknown) => {
				bodies.push(body);
				return {};
			}
		} as unknown as WardogsClient;
		await savePolicy(env.db, w.org.id, {
			...policy,
			enabled: false,
			appealText: 'Changed appeal text'
		});
		const bans = new Map<string, PanelBan>([[PLAYER, { steamId: PLAYER, listId: list.id }]]);
		await kickBanned(env, server, org, client, [PLAYER], bans);
		expect(bodies).toEqual([{ reason: 'Griefing | 7d | t-00123 | Appeal on discord.gg/exotix' }]);
		expect(JSON.stringify(bodies)).not.toContain(PRIVATE);
		const legacy = await call(w, 'orgs/[id]/lists/[kind]/entries', 'POST', {
			steamId: '76561198000000882',
			reason: 'legacy mode',
			expiresAt: null
		});
		expect(legacy.status).toBe(201);
	});
	test('existing automatic rules get unique references and retain their durations', async () => {
		const { w } = await enabled();
		const list = await serverListOf(env, { id: w.server.id, orgId: w.org.id }, 'ban');
		const entries = await Promise.all(
			[PLAYER, '76561198000000882'].map((steamId) =>
				grantEntry(env, list, {
					steamId,
					reason: 'Original trigger context',
					expiresAt: new Date(Date.now() + 7 * 86400000),
					addedByName: 'trigger: test'
				})
			)
		);
		const cases = await Promise.all(entries.map((e) => caseOf(env.db, e.id)));
		expect(new Set(cases.map((c) => c!.reference)).size).toBe(2);
		for (const c of cases) {
			expect(c).toMatchObject({ source: 'automated', days: 7, category: 'Rule violation' });
			expect(c!.reference).toMatch(/^a-\d{7}$/);
			expect(c!.description).toContain('Original trigger context');
			expect(c!.message).toEndWith('Appeal on discord.gg/exotix');
		}
	});
	test('direct and normalized raw ban writes cannot bypass policy; unbans still work', async () => {
		const { w } = await enabled();
		for (const [action, body] of [
			['ban', { steamId: PLAYER, reason: 'bypass' }],
			['raw', { method: 'POST', path: '/v1/bans', body: { steamId: PLAYER } }],
			['raw', { method: 'POST', path: '/v1/foo/../bans?x=1', body: { steamId: PLAYER } }]
		] as const) {
			expect(
				(
					await call(w, 'servers/[id]/rcon/[action]', 'POST', body, 'owner', {
						id: w.server.id,
						action
					})
				).status
			).toBe(400);
		}
		expect(
			(
				await call(w, 'servers/[id]/rcon/[action]', 'POST', { steamId: PLAYER }, 'owner', {
					id: w.server.id,
					action: 'unban'
				})
			).status
		).toBe(200);
	});
	test('automation extensions preserve the selected preset and record the rule privately', async () => {
		const { w, policy } = await enabled();
		await call(w, 'orgs/[id]/lists/[kind]/entries', 'POST', {
			steamId: PLAYER,
			moderation: form(policy)
		});
		const list = await listOf(env, w.org.id, 'ban');
		const extended = await grantEntry(
			env,
			list,
			{
				steamId: PLAYER,
				reason: 'PRIVATE-AUTOMATION-CONTEXT',
				expiresAt: new Date(Date.now() + 30 * 86400000),
				addedByName: 'trigger: reviewed rule'
			},
			{ lengthen: true }
		);
		expect(extended.lengthened).toBe(true);
		const record = (await caseOf(env.db, extended.id))!;
		expect(record).toMatchObject({
			source: 'manual',
			reference: 't-00123',
			days: 30,
			presetDays: 7,
			severity: 'Standard',
			extensions: [{ rule: 'trigger: reviewed rule', reason: 'PRIVATE-AUTOMATION-CONTEXT' }]
		});
		expect(record.message).toBe('Griefing | 30d | t-00123 | Appeal on discord.gg/exotix');
		expect(record.message).not.toContain('PRIVATE-AUTOMATION-CONTEXT');
	});
	test('disabled policy preserves direct legacy bans', async () => {
		const w = await seedWorld(env);
		for (const [action, body] of [
			['ban', { steamId: PLAYER, reason: 'bypass' }],
			['raw', { method: 'POST', path: '/v1/bans', body: { steamId: PLAYER } }],
			['raw', { method: 'POST', path: '/v1/foo/../bans?x=1', body: { steamId: PLAYER } }]
		] as const) {
			expect(
				(
					await call(w, 'servers/[id]/rcon/[action]', 'POST', body, 'owner', {
						id: w.server.id,
						action
					})
				).status
			).toBe(200);
		}
		expect(
			(
				await call(w, 'servers/[id]/rcon/[action]', 'POST', { steamId: PLAYER }, 'owner', {
					id: w.server.id,
					action: 'unban'
				})
			).status
		).toBe(200);
	});
});
