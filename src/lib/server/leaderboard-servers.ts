import { and, asc, eq, notExists } from 'drizzle-orm';
import { accessibleServers, orgRoleFor, type OrgRow, type SessionUser } from './access';
import { archivedServers, servers } from './db/schema';
import type { Env } from './env';
import { publicOrgServers } from './public';

interface LeaderboardServer {
	id: string;
	name: string;
	archived?: true;
}

async function archives(env: Env, orgId: string, publicOnly = false): Promise<LeaderboardServer[]> {
	const rows = await env.db
		.select({
			id: archivedServers.id,
			name: archivedServers.name,
			retiredOn: archivedServers.retiredOn
		})
		.from(archivedServers)
		.where(
			and(
				eq(archivedServers.orgId, orgId),
				publicOnly ? eq(archivedServers.publicLeaderboards, true) : undefined,
				notExists(
					env.db.select({ id: servers.id }).from(servers).where(eq(servers.id, archivedServers.id))
				)
			)
		)
		.orderBy(asc(archivedServers.name), asc(archivedServers.retiredOn), asc(archivedServers.id));
	return rows.map(({ id, name, retiredOn }) => ({
		id,
		name: `${name} (retired ${retiredOn})`,
		archived: true
	}));
}

/** Server-scoped grants and API keys retain their existing access. */
export async function orgLeaderboardServers(
	env: Env,
	user: SessionUser,
	orgId: string
): Promise<LeaderboardServer[]> {
	const [live, role] = await Promise.all([
		accessibleServers(env, user, orgId),
		orgRoleFor(env, user, orgId)
	]);
	return role === 'owner' ? [...live, ...(await archives(env, orgId))] : live;
}

export async function publicLeaderboardServers(
	env: Env,
	org: OrgRow
): Promise<LeaderboardServer[]> {
	if (org.suspendedAt || !org.allowPublicLeaderboards) return [];
	const [live, retired] = await Promise.all([
		publicOrgServers(env, org, 'leaderboards'),
		archives(env, org.id, true)
	]);
	return [...live, ...retired];
}
