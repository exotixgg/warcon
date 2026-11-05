// One page of the leaderboard: this server, or every server of its organisation the caller can
// see, from the match lines and the sessions (all time from each player's settled totals), a
// page kept for a minute. A season's range is one of the organisation's seasons; `current` (the
// default) is what its boards open on.
// ?scope=server|org&range=current|s:<season>|7d|30d|90d|all&sort=<metric>&dir=asc|desc&page=1&minMinutes=60
import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireServerCap } from '$lib/server/access';
import { orgLeaderboardServers } from '$lib/server/leaderboard-servers';
import { loadBoard } from '$lib/server/leaderboards';
import { parseBoardQuery } from '$lib/leaderboard';

export const GET = route(async (event) => {
	const env = getEnv();
	const { server, user } = await requireServerCap(
		env,
		event.locals,
		param(event, 'id'),
		'server.view'
	);
	const q = parseBoardQuery(event.url.searchParams);
	const orgServers = q.scope === 'org' ? await orgLeaderboardServers(env, user, server.orgId) : [];
	const ids = q.scope === 'org' ? orgServers.map((s) => s.id) : [server.id];
	return apiJson({
		ok: true,
		...(await loadBoard(env, ids, q, server.orgId)),
		archivedServerNames: orgServers.filter((s) => s.archived).map((s) => s.name)
	});
});
