import { eq, desc, sql, and } from 'drizzle-orm';
import { getEnv } from '$lib/server/env';
import { getOrg, requireOwner } from '$lib/server/access';
import { ApiError, apiJson, param, readJson, route } from '$lib/server/http';
import { playerSessions, servers } from '$lib/server/db/schema';
import { requireSteamId } from '$lib/server/steam';
import { causeKind, causeLabel } from '$lib/causes';
import { effectivePools } from '$lib/message-pools';
import {
	poolConfigOf,
	queuePoolEvent,
	weaponRuleTestKey,
	weaponThresholdFor
} from '$lib/server/exotix/message-pools';
import { writeAudit } from '$lib/server/audit';

/** One admin click represents one qualifying kill for this test counter only. */
export const POST = route(async (event) => {
	const env = getEnv();
	const user = requireOwner(event.locals);
	const orgId = param(event, 'id');
	if (!(await getOrg(env, orgId))) throw new ApiError(404, 'Organisation not found.');
	const body = await readJson<Record<string, unknown>>(event.request);
	const steamId = requireSteamId(body.steamId);
	if (
		typeof body.poolId !== 'string' ||
		typeof body.serverId !== 'string' ||
		typeof body.weaponTag !== 'string'
	)
		throw new ApiError(400, 'Choose a weapon rule, server, and kill-feed tag.');
	const result = await env.db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${orgId}, 179089))`);
		const [server] = await tx
			.select()
			.from(servers)
			.where(and(eq(servers.id, body.serverId as string), eq(servers.orgId, orgId)))
			.limit(1);
		if (!server) throw new ApiError(404, 'Server not found in this organisation.');
		const pool = effectivePools(await poolConfigOf(tx, orgId), server.id).find(
			(candidate) => candidate.id === body.poolId && candidate.action === 'weapon'
		);
		if (!pool) throw new ApiError(400, 'Choose an enabled weapon rule for this server.');
		const weaponTag = pool.weaponTags.find(
			(tag) => tag.toLowerCase() === (body.weaponTag as string).toLowerCase()
		);
		if (!weaponTag || causeKind(weaponTag) === 'vehicle')
			throw new ApiError(400, 'Choose one of the rule’s exact weapon tags, not a roadkill tag.');
		const key = weaponRuleTestKey(pool);
		const [counter] = await tx.execute<{ count: number }>(sql`
			INSERT INTO exotix.weapon_rule_tests (org_id, pool_id, steam_id, config_key, "count")
			VALUES (${orgId}, ${pool.id}, ${steamId}, ${key}, 1)
			ON CONFLICT (org_id, pool_id, steam_id) DO UPDATE SET
				"count" = CASE WHEN exotix.weapon_rule_tests.config_key = excluded.config_key
					THEN exotix.weapon_rule_tests."count" + 1 ELSE 1 END,
				config_key = excluded.config_key,
				updated_at = now()
			RETURNING "count"`);
		const count = Number(counter.count);
		const threshold = weaponThresholdFor(pool, count);
		const [session] = await tx
			.select({ name: playerSessions.name })
			.from(playerSessions)
			.where(and(eq(playerSessions.serverId, server.id), eq(playerSessions.steamId, steamId)))
			.orderBy(desc(playerSessions.lastSeen))
			.limit(1);
		const playerName = session?.name || steamId;
		const queued = threshold
			? await queuePoolEvent(tx, orgId, server.id, pool, {
					eventKey: `test-weapon:${steamId}:${key}:${count}`,
					values: {
						server_name: server.name,
						map: '',
						players: 0,
						max_players: 0,
						player_name: playerName,
						victim_name: 'Test player',
						weapon: weaponTag,
						weapon_type: causeLabel(weaponTag),
						count
					},
					steamId,
					action: threshold.action,
					threshold
				})
			: 0;
		return {
			count,
			action: threshold?.action ?? 'none',
			queued,
			playerName,
			weaponType: causeLabel(weaponTag)
		};
	});
	await writeAudit(env, event.request, {
		actor: user,
		orgId,
		category: 'org',
		action: 'message-pools.test-weapon',
		outcome: 'ok',
		message: `Simulated weapon rule kill #${result.count}: ${result.action}`,
		target: steamId,
		detail: { poolId: body.poolId, serverId: body.serverId, weaponTag: body.weaponTag, ...result }
	});
	return apiJson({ ok: true, ...result });
});
