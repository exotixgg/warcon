import { sql } from 'drizzle-orm';
import type { Tx } from './db';
import type { OutboxRow } from './db/schema';

/** Reserve delivery across the org's servers. The caller owns the outbox lease and transaction. */
export async function reserveSeedComplete(
	tx: Tx,
	orgId: string,
	row: Pick<OutboxRow, 'id' | 'steamId'>
): Promise<boolean> {
	const key = `seed-complete:${orgId}:${row.steamId}`;
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
	const rows = await tx.execute(sql`
		UPDATE outbox AS candidate
		SET params = candidate.params || '{"seedCompleteReserved":true}'::jsonb
		WHERE candidate.id = ${row.id} AND candidate.state = 'sending'
		AND NOT EXISTS (
			SELECT 1
			FROM servers s JOIN outbox prior ON prior.server_id = s.id
			WHERE s.org_id = ${orgId} AND prior.steam_id = ${row.steamId}
			AND prior.id <> candidate.id AND prior.action = 'whisper'
			AND prior.trigger_kind = 'seed_reward'
			AND prior.params->'seedNotice'->>'stage' = 'complete'
			-- Complete notices expire after 30 seconds. Two hours covers the one-hour
			-- receipt window and lets the query use the existing server/time index.
			AND prior.created_at >= now() - interval '2 hours'
			AND (
				(prior.state IN ('delivered', 'unknown') AND prior.done_at > now() - interval '1 hour')
				OR (prior.state = 'sending' AND prior.params ? 'seedCompleteReserved')
			)
		)
		RETURNING candidate.id`);
	return rows.length > 0;
}
