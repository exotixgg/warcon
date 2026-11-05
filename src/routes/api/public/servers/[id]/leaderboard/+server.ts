// Public leaderboard JSON: the same board as /s/<id>/leaderboard, same query parameters as the
// panel's route. 404 unless leaderboards are on; rate limited per address.
import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { limitPublicReads, publicHeaders, requirePublicServer } from '$lib/server/public';
import { publicLeaderboardServers } from '$lib/server/leaderboard-servers';
import { loadBoard } from '$lib/server/leaderboards';
import { parseBoardQuery, PUBLIC_MAX_PAGE } from '$lib/leaderboard';

export const GET = route(async (event) => {
	const env = getEnv();
	limitPublicReads(event.request);
	const ps = await requirePublicServer(env, param(event, 'id'), 'leaderboards');
	const q = parseBoardQuery(event.url.searchParams, PUBLIC_MAX_PAGE);
	const orgServers = q.scope === 'org' ? await publicLeaderboardServers(env, ps.org) : [];
	const ids = q.scope === 'org' ? orgServers.map((s) => s.id) : [ps.server.id];
	return apiJson(
		{
			ok: true,
			...(await loadBoard(env, ids, q, ps.org.id)),
			maxPage: PUBLIC_MAX_PAGE,
			archivedServerNames: orgServers.filter((s) => s.archived).map((s) => s.name)
		},
		200,
		publicHeaders(30)
	);
});
