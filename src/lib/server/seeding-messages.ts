import { ApiError, int } from './http';
import { normalizeAutomationMessage } from '$lib/automation-message';
import { MAX_CHAT } from '$lib/chat';
import { SEED_NOTICE_MESSAGES, SEED_COMPLETE_MESSAGE } from '$lib/seeding-messages';

export interface SeedNoticeConfig {
	noticeEnabled?: boolean;
	noticeDelaySeconds?: number;
	noticeEveryMinutes?: number;
	noticeStartPlayers?: number;
	noticeMessages?: string[];
	noticeCompleteMessage?: string;
}

export function validateSeedNotices(c: Record<string, unknown>): Required<SeedNoticeConfig> {
	const message = (raw: unknown) => {
		const text = normalizeAutomationMessage(typeof raw === 'string' ? raw : '');
		if (text.length > MAX_CHAT)
			throw new ApiError(400, 'Seeding messages must fit in 256 characters.');
		return text;
	};
	const raw = c.noticeMessages === undefined ? SEED_NOTICE_MESSAGES : c.noticeMessages;
	if (!Array.isArray(raw) || raw.length > 20 || raw.some((x) => typeof x !== 'string'))
		throw new ApiError(400, 'Use up to 20 seeding messages.');
	const noticeMessages = raw.map(message).filter(Boolean);
	if (c.noticeEnabled && !noticeMessages.length) throw new ApiError(400, 'Add a seeding message.');
	return {
		noticeEnabled: !!c.noticeEnabled,
		noticeDelaySeconds: int(c.noticeDelaySeconds, 60, 10, 600),
		noticeEveryMinutes: int(c.noticeEveryMinutes, 5, 1, 120),
		noticeStartPlayers: int(c.noticeStartPlayers, 20, 1, 1000),
		noticeMessages,
		noticeCompleteMessage: message(c.noticeCompleteMessage ?? SEED_COMPLETE_MESSAGE)
	};
}

export interface SeedSession {
	id: number;
	steamId: string;
	joinedAt: number;
	hasFaction: boolean;
	seedMs: number;
	pendingSeedMs: number;
	creditedNowMs: number;
}
export interface SeedNoticeTrack {
	sessionId: number;
	readyAt: number;
	lastAt: number;
	index: number;
	creditMs: number;
	observedSeedMs: number;
}
export type SeedNoticeState = Record<string, SeedNoticeTrack>;
export type SeedNoticeStage = 'intro' | 'update' | 'complete';
export interface SeedNoticePick {
	session: SeedSession;
	stage: SeedNoticeStage;
	text: string;
}

export const waitingForPlayers = (phase: string) =>
	phase === 'MatchState.PreMatch.WaitingForPlayers' ||
	phase.startsWith('MatchState.PreMatch.WaitingForPlayers.');
export const playing = (phase: string) =>
	phase === 'MatchState.Playing' || phase.startsWith('MatchState.Playing.');

/** Plans only. The caller advances a message's clock after the delivery guard allows it. */
export function planSeedNotices(
	cfg: Required<SeedNoticeConfig>,
	before: SeedNoticeState,
	sessions: SeedSession[],
	at: { now: number; phase: string; players: number; lowAt: number; fullAt: number }
): { state: SeedNoticeState; picks: SeedNoticePick[] } {
	const state: SeedNoticeState = {};
	const picks: SeedNoticePick[] = [];
	const low = at.players <= at.lowAt && at.players < at.fullAt;
	for (const session of sessions) {
		const old = before[session.steamId];
		let track = old?.sessionId === session.id ? { ...old } : null;
		if (!track && session.hasFaction && (low || session.creditedNowMs > 0))
			track = {
				sessionId: session.id,
				readyAt: at.now + cfg.noticeDelaySeconds * 1000,
				lastAt: 0,
				index: 0,
				creditMs: 0,
				observedSeedMs: session.seedMs - session.creditedNowMs
			};
		if (!track) continue;
		track.creditMs += Math.max(0, session.seedMs - track.observedSeedMs);
		track.observedSeedMs = session.seedMs;
		state[session.steamId] = track;
		if (
			!session.hasFaction ||
			at.now < track.readyAt ||
			(!waitingForPlayers(at.phase) && !playing(at.phase))
		)
			continue;
		if (track.creditMs > 0 && cfg.noticeCompleteMessage) {
			picks.push({ session, stage: 'complete', text: cfg.noticeCompleteMessage });
			continue;
		}
		if (!low || !cfg.noticeMessages.length) continue;
		if (!track.lastAt) picks.push({ session, stage: 'intro', text: cfg.noticeMessages[0] });
		else if (
			waitingForPlayers(at.phase) &&
			at.players < cfg.noticeStartPlayers &&
			at.now - track.lastAt >= cfg.noticeEveryMinutes * 60_000
		)
			picks.push({
				session,
				stage: 'update',
				text: cfg.noticeMessages[track.index % cfg.noticeMessages.length]
			});
	}
	return { state, picks };
}

export function seedTime(ms: number): string {
	const mins = Math.max(0, Math.floor(ms / 60_000));
	return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60}m`;
}

/** A queued card is invalid after its message settings or reward thresholds change. */
export function seedNoticeSettingsKey(raw: unknown): string {
	const c = (raw ?? {}) as SeedNoticeConfig & {
		lowAt?: number;
		fullAt?: number;
		untilFull?: boolean;
	};
	return JSON.stringify([
		c.lowAt,
		c.fullAt,
		c.untilFull,
		c.noticeEnabled,
		c.noticeDelaySeconds,
		c.noticeEveryMinutes,
		c.noticeStartPlayers,
		c.noticeMessages,
		c.noticeCompleteMessage
	]);
}
