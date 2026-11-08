import { sql } from 'drizzle-orm';
import type { Env } from './env';
import { statsFor, statsReader, statsOf, type TickContext, type Evaluation } from './triggers';
import { messageVars, serverVars } from './message-vars';
import type { TriggerRow } from './db/schema';
import { renderTemplate, type SeedRewardConfig } from './trigger-rules';
import {
	seedNoticeSettingsKey,
	planSeedNotices,
	seedTime,
	validateSeedNotices,
	type SeedNoticeState
} from './seeding-messages';
import { seedingStats } from './seeding-stats';
import { MAX_CHAT } from '$lib/chat';

/** Optional messages belong to the reward rule, so they share its eligibility thresholds. */
export async function evalSeedNotices(
	env: Env,
	ctx: TickContext,
	row: TriggerRow,
	cfg: SeedRewardConfig,
	out: Evaluation
) {
	if (!cfg.noticeEnabled || !ctx.playersObserved || !ctx.seedSessions) return;
	const options = validateSeedNotices(cfg as unknown as Record<string, unknown>);
	const before = (row.state as { notices?: SeedNoticeState } | null)?.notices ?? {};
	const fullAt = cfg.fullAt ?? ctx.status.maxPlayers;
	if (!fullAt) return;
	const now = ctx.ts.getTime();
	const { state, picks } = planSeedNotices(options, before, ctx.seedSessions, {
		now,
		phase: ctx.matchPhase ?? '',
		players: ctx.players.length,
		lowAt: cfg.lowAt,
		fullAt
	});
	if (picks.length) {
		// Wait for queued faction/welcome messages and measure the delay from actual delivery.
		// Also give any other private card 30 seconds of breathing room.
		const receipts = await env.db.execute<{
			steamId: string;
			welcome: string | null;
			recent: string | null;
			waiting: boolean;
		}>(sql`
			SELECT o.steam_id AS "steamId",
			 MAX(o.done_at) FILTER (WHERE o.trigger_kind IN ('welcome','faction_change') AND o.state='delivered') AS welcome,
			 MAX(o.done_at) FILTER (WHERE o.state='delivered') AS recent,
			 bool_or(o.trigger_kind IN ('welcome','faction_change') AND o.state IN ('pending','sending')) AS waiting
			 FROM outbox o JOIN player_sessions s ON s.server_id=o.server_id AND s.steam_id=o.steam_id
			 WHERE o.server_id=${ctx.server.id} AND s.id IN ${picks.map((p) => p.session.id)}
			 AND o.steam_id IN ${picks.map((p) => p.session.steamId)} AND o.action='whisper'
			 AND o.created_at >= s.joined_at AND o.created_at >= ${new Date(now - 15 * 60_000)}
			 GROUP BY o.steam_id`);
		const receipt = new Map(receipts.map((r) => [r.steamId, r]));
		const ready = picks.filter(({ session }) => {
			const r = receipt.get(session.steamId);
			if (!r) return true;
			const until = Math.max(
				r.welcome ? new Date(r.welcome).getTime() + options.noticeDelaySeconds * 1000 : 0,
				r.recent ? new Date(r.recent).getTime() + 30_000 : 0
			);
			if (r.waiting || now < until) {
				state[session.steamId].readyAt = r.waiting ? now + 10_000 : until;
				return false;
			}
			return true;
		});
		const stats = await seedingStats(
			env,
			ctx.server.id,
			ready.map((p) => p.session)
		);
		const common = await statsFor(
			statsReader(env, ctx.server.id),
			ready.map((p) => ({ steamId: p.session.steamId, text: p.text }))
		);
		const server = serverVars({
			name: ctx.server.name,
			status: ctx.status,
			rotation: ctx.messageRotation,
			startedAt: ctx.startedAt,
			now
		});
		for (const { session, stage, text } of ready) {
			const player = ctx.players.find((p) => p.steamId === session.steamId);
			if (!player) continue;
			const track = state[session.steamId];
			const message = renderTemplate(
				text,
				messageVars(server, player, statsOf(common, session.steamId), {
					name: player.name,
					steamid: player.steamId,
					faction: player.faction ?? '',
					server: ctx.server.name,
					players: ctx.players.length,
					round_start_players: options.noticeStartPlayers,
					seed_target: fullAt,
					seed_session: seedTime(session.seedMs + session.pendingSeedMs),
					seed_pending: seedTime(session.pendingSeedMs),
					seed_credited_now: seedTime(track.creditMs),
					...(stats.get(session.steamId) ?? { seed_all: '…', seed_season: '…' })
				}),
				MAX_CHAT
			);
			out.intents.push({
				trigger: row,
				action: 'whisper',
				params: {
					steamId: session.steamId,
					message,
					seedNotice: {
						settings: seedNoticeSettingsKey(cfg),
						stage,
						sessionId: session.id,
						lowAt: cfg.lowAt,
						fullAt,
						startPlayers: options.noticeStartPlayers
					}
				},
				target: session.steamId,
				steamId: session.steamId,
				okMessage: `Whispered ${player.name} (seeding ${stage}).`,
				detail: { stage, sessionId: session.id },
				dedupeKey: `${row.id}:seed:${session.id}:${stage}:${now}`
			});
			track.lastAt = now;
			if (stage === 'complete') track.creditMs = 0;
			else track.index++;
		}
		if (ready.length)
			out.updates.push({
				id: row.id,
				lastFiredAt: ctx.ts,
				lastResult: `Sending seeding messages to ${ready.length} players`
			});
	}
	if (JSON.stringify(before) !== JSON.stringify(state)) {
		const next = { ...((row.state ?? {}) as object), notices: state };
		out.updates.push({ id: row.id, state: next });
		(out.afterCommit ??= []).push(() => {
			row.state = next;
		});
	}
}
