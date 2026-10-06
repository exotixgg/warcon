// Bounded native history query for server-authorized API integrations.
import { getEnv } from '$lib/server/env';
import { requireServerCap, requireUser } from '$lib/server/access';
import { ApiError, apiJson, route } from '$lib/server/http';
import { takeRate } from '$lib/server/ratelimit';
import { loadPlayerStats, readPlayerStatsQuery } from '$lib/server/player-stats';

export const POST = route(async (event) => {
	const user = requireUser(event.locals);
	if (!user.apiKey)
		throw new ApiError(403, 'An organisation API key is required.', 'api_key_required');
	const retryIn = takeRate(`native-stats:${user.id}`, 1, 12, 60_000);
	if (retryIn)
		return apiJson(
			{ ok: false, error: { code: 'rate_limited', message: 'Too many statistics queries.' } },
			429,
			{ 'retry-after': String(retryIn) }
		);
	const query = await readPlayerStatsQuery(event.request);
	const env = getEnv();
	for (const serverId of query.serverIds)
		await requireServerCap(env, event.locals, serverId, 'server.view');
	return apiJson(await loadPlayerStats(env.db, query));
});
