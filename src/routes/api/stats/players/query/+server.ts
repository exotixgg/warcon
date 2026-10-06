// Bounded native history query for server-authorized API integrations.
import { getEnv } from '$lib/server/env';
import { env as processEnv } from '$env/dynamic/private';
import { requireServerCap, requireUser } from '$lib/server/access';
import { ApiError, apiJson, route } from '$lib/server/http';
import { takeRate } from '$lib/server/ratelimit';
import {
	acquirePlayerStatsSlot,
	loadPlayerStats,
	playerStatsRequestBudget,
	readPlayerStatsQuery
} from '$lib/server/player-stats';

const limited = (retryIn: number) =>
	apiJson(
		{ ok: false, error: { code: 'rate_limited', message: 'Too many statistics queries.' } },
		429,
		{ 'retry-after': String(retryIn) }
	);

export const POST = route(async (event) => {
	const user = requireUser(event.locals);
	if (!user.apiKey)
		throw new ApiError(403, 'An organisation API key is required.', 'api_key_required');
	const release = acquirePlayerStatsSlot(user.id);
	if (!release) return limited(1);
	try {
		const budget = playerStatsRequestBudget(processEnv.WARCON_NATIVE_STATS_REQUESTS_PER_MINUTE);
		const retryIn = takeRate(`native-stats:${user.id}`, 1, budget, 60_000);
		if (retryIn) return limited(retryIn);
		const query = await readPlayerStatsQuery(event.request);
		const env = getEnv();
		for (const serverId of query.serverIds)
			await requireServerCap(env, event.locals, serverId, 'server.view');
		return apiJson(await loadPlayerStats(env.db, query));
	} finally {
		release();
	}
});
