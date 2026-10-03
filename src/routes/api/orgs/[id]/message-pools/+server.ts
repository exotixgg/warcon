import { asc, eq } from 'drizzle-orm';
import { getEnv } from '$lib/server/env';
import { getOrg, requireOwner } from '$lib/server/access';
import { ApiError, apiJson, param, readJson, route } from '$lib/server/http';
import { servers } from '$lib/server/db/schema';
import { policyOf } from '$lib/server/exotix/ban-policy';
import { poolConfigOf, savePoolConfig } from '$lib/server/exotix/message-pools';
import { writeAudit } from '$lib/server/audit';

export const GET = route(async (event) => {
	const env = getEnv();
	requireOwner(event.locals);
	const orgId = param(event, 'id');
	if (!(await getOrg(env, orgId))) throw new ApiError(404, 'Organisation not found.');
	const [config, policy, serverRows] = await Promise.all([
		poolConfigOf(env.db, orgId),
		policyOf(env.db, orgId),
		env.db
			.select({ id: servers.id, name: servers.name })
			.from(servers)
			.where(eq(servers.orgId, orgId))
			.orderBy(asc(servers.name))
	]);
	return apiJson({
		ok: true,
		config,
		servers: serverRows,
		categories: policy.categories.map((category) => ({ id: category.id, label: category.label }))
	});
});

export const PUT = route(async (event) => {
	const env = getEnv();
	const user = requireOwner(event.locals);
	const orgId = param(event, 'id');
	if (!(await getOrg(env, orgId))) throw new ApiError(404, 'Organisation not found.');
	const body = await readJson<{ pools?: unknown; version?: unknown }>(event.request);
	const config = await env.db.transaction((tx) =>
		savePoolConfig(tx, orgId, { pools: body.pools }, body.version)
	);
	await writeAudit(env, event.request, {
		actor: user,
		orgId,
		category: 'org',
		action: 'message-pools.update',
		outcome: 'ok',
		message: 'Message pools updated',
		detail: {
			pools: config.pools.map((pool) => ({
				id: pool.id,
				name: pool.name,
				action: pool.action,
				enabled: pool.enabled,
				allServers: pool.allServers,
				serverIds: pool.serverIds
			}))
		}
	});
	return apiJson({ ok: true, config });
});
