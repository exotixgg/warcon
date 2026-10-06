/** Native Warcon statistics. Add counts/sums across disjoint windows; combine streaks with max. */
export interface PlayerStatsQuery {
	steamIds: string[];
	serverIds: string[];
	from: string;
	to: string;
	/** Optional ownership/membership intervals; each requested player must be covered. */
	playerWindows?: PlayerStatsWindow[];
}

export interface PlayerStatsWindow {
	steamId: string;
	from: string;
	to: string;
}

export interface PlayerStats {
	steamId: string;
	hasObservedData: boolean;
	playtimeSeconds: number;
	/** Session seed_seconds cannot be split exactly at arbitrary window boundaries. */
	seedtimeSeconds: null;
	matches: number;
	wins: number;
	losses: number;
	draws: number;
	kills: number;
	deaths: number;
	cashDelta: number;
	headshots: number;
	teamKills: number;
	suicides: number;
	vehicleKills: number;
	killStreak: number;
	deathStreak: number;
	firstSeen: string | null;
	lastSeen: string | null;
	lastMatchEndedAt: string | null;
	coverage: { sessions: number; matches: number };
}

export interface PlayerStatsResponse {
	ok: true;
	version: 1;
	generatedAt: string;
	from: string;
	to: string;
	serverIds: string[];
	/** Canonical disjoint windows actually queried, including defaults when none were supplied. */
	playerWindows: PlayerStatsWindow[];
	players: PlayerStats[];
	coverage: {
		semantics: 'observed-history';
		matchAttribution: 'ended_at';
		playtimeAttribution: 'observed-session-overlap';
		/** Observation timestamps report current worker state, not completeness of past history. */
		servers: {
			serverId: string;
			ok: boolean;
			observedAt: string | null;
			playersAt: string | null;
			statusAt: string | null;
			feedAt: string | null;
		}[];
	};
	provenance: {
		playtimeSeconds: 'player_sessions';
		scoreboard: 'completed_match_players';
		results: 'completed_matches';
		feedDerivatives: 'completed_match_players_feed_derivatives';
		streaks: 'maximum_completed_match_players';
		seedtimeSeconds: 'unavailable_for_arbitrary_windows';
	};
}
