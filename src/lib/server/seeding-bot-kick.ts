import { ApiError } from './http';
import { isSteamId, requireSteamId } from './steam';

export const SEEDING_BOT_KICK_MAX_AGE_MS = 15_000;

export interface SeedingBotKickConfig {
	minPlayers: number;
	steamIds: string[];
}

export function validateSeedingBotKick(c: Record<string, unknown>): SeedingBotKickConfig {
	const minPlayers = c.minPlayers ?? 95;
	if (
		typeof minPlayers !== 'number' ||
		!Number.isInteger(minPlayers) ||
		minPlayers < 2 ||
		minPlayers > 1000
	)
		throw new ApiError(400, 'Set a player threshold from 2 to 1000.');
	if (!Array.isArray(c.steamIds) || !c.steamIds.length)
		throw new ApiError(400, 'Add at least one seeding account SteamID64.');
	const steamIds = [...new Set(c.steamIds.map(requireSteamId))];
	if (steamIds.length > 100) throw new ApiError(400, 'Use up to 100 seeding account SteamIDs.');
	return {
		minPlayers,
		steamIds
	};
}

export function seedingBotKickTarget<P extends { steamId: string }>(
	cfg: Pick<SeedingBotKickConfig, 'minPlayers' | 'steamIds'>,
	players: P[],
	targetId?: string
): P | undefined {
	const connected = new Map(players.filter((p) => isSteamId(p.steamId)).map((p) => [p.steamId, p]));
	if (connected.size < cfg.minPlayers) return;
	if (targetId !== undefined)
		return cfg.steamIds.includes(targetId) ? connected.get(targetId) : undefined;
	for (const id of cfg.steamIds) {
		const player = connected.get(id);
		if (player) return player;
	}
}

export function seedingBotKickReady(
	cfg: SeedingBotKickConfig,
	last: { state: string; steamId: string | null } | undefined,
	players: { steamId: string }[],
	previousPlayers: { steamId: string }[] | undefined
): boolean {
	if (!last || last.state === 'skipped') return true;
	if (last.state === 'pending' || last.state === 'sending') return false;

	// Confirm that a successful or uncertain send actually freed the slot before the next kick.
	if (
		(last.state === 'delivered' || last.state === 'unknown') &&
		last.steamId &&
		cfg.steamIds.includes(last.steamId) &&
		players.some((p) => p.steamId === last.steamId)
	)
		return false;
	if (!previousPlayers) return false;
	const previousIds = new Set(previousPlayers.map((p) => p.steamId).filter(isSteamId));
	// A join can fill the slot between polls, so the count might never be seen below the threshold.
	return (
		previousIds.size < cfg.minPlayers ||
		players.some(
			(p) =>
				isSteamId(p.steamId) && !previousIds.has(p.steamId) && !cfg.steamIds.includes(p.steamId)
		)
	);
}
