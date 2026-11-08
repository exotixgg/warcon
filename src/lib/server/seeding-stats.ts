import { sql } from 'drizzle-orm';
import type { Env } from './env';
import { scopeFor } from './welcome-card';
import { rangeBase, totalsBase } from './leaderboards';
import { currentSeason } from '$lib/seasons';
import { orgSeasons } from './seasons';
import { seedTime, type SeedSession } from './seeding-messages';

/** The same credited totals as the boards, including archived EXOTIX servers.
 * Replace the current session's persisted counter with its live counter: evaluation
 * happens before the observation transaction banks the newly credited seconds. */
export async function seedingStats(env: Env, serverId: string, sessions: SeedSession[]) {
	const result = new Map<string, { seed_all: string; seed_season: string }>();
	if (!sessions.length) return result;
	const scope = await scopeFor(env, serverId);
	if (!scope) return result;
	const ids = sessions.map((s) => s.steamId);
	const season = currentSeason((await orgSeasons(env, scope.orgId)).seasons, 'official');
	const [all, seasonal, stored] = await Promise.all([
		env.db.execute<{ steamId: string; minutes: string }>(sql`
			WITH ${totalsBase(scope.ids, ids)} SELECT steam_id AS "steamId", seed_minutes AS minutes FROM base`),
		season
			? env.db.execute<{ steamId: string; minutes: string }>(sql`
			WITH ${rangeBase(scope.ids, new Date(season.startsAt))}
			SELECT steam_id AS "steamId", seed_minutes AS minutes FROM base WHERE steam_id IN ${ids}`)
			: [],
		env.db.execute<{ id: number; seconds: number }>(sql`
			SELECT id, seed_seconds AS seconds FROM player_sessions WHERE id IN ${sessions.map((s) => s.id)}`)
	]);
	const a = new Map(all.map((s) => [s.steamId, Number(s.minutes) * 60_000]));
	const b = new Map(seasonal.map((s) => [s.steamId, Number(s.minutes) * 60_000]));
	const db = new Map(stored.map((s) => [Number(s.id), Number(s.seconds) * 1000]));
	for (const session of sessions) {
		const delta = session.seedMs - (db.get(session.id) ?? 0);
		result.set(session.steamId, {
			seed_all: seedTime((a.get(session.steamId) ?? 0) + delta),
			seed_season: season ? seedTime((b.get(session.steamId) ?? 0) + delta) : '—'
		});
	}
	return result;
}
