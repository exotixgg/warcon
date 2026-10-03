import { sql } from 'drizzle-orm';
import { getEnv } from '$lib/server/env';
import { ApiError, apiJson, param, readJson, route } from '$lib/server/http';
import { requireListsRole, requireOrgRole, requireServerCap } from '$lib/server/access';
import { policyOf, savePolicy } from '$lib/server/exotix/ban-policy';
import { writeAudit } from '$lib/server/audit';
export const GET = route(async (event) => {
	const env = getEnv();
	const orgId = param(event, 'id');
	const serverId = event.url.searchParams.get('serverId');
	if (serverId) {
		const { server } = await requireServerCap(env, event.locals, serverId, 'bans.manage');
		if (server.orgId !== orgId) throw new ApiError(404, 'Organisation not found.');
	} else await requireListsRole(env, event.locals, orgId, 'ban');
	return apiJson({ ok: true, policy: await policyOf(env.db, orgId) });
});
export const PATCH = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	const body = await readJson(event.request);
	const policy = await env.db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${org.id}, 179088))`);
		const current = await policyOf(tx, org.id);
		if (body.version !== current.version)
			throw new ApiError(409, 'The policy changed. Reload before saving.');
		return savePolicy(tx, org.id, body);
	});
	await writeAudit(env, event.request, {
		actor: user,
		orgId: org.id,
		category: 'org',
		action: 'ban.policy',
		outcome: 'ok',
		message: `Ban policy ${policy.enabled ? 'enabled' : 'disabled'}`,
		detail: {
			categories: policy.categories.map((c) => ({ id: c.id, action: c.action, levels: c.levels }))
		}
	});
	return apiJson({ ok: true, policy });
});
