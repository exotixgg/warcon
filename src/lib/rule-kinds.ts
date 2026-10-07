// The kinds of Automation rule as the panel shows them, grouped by what they act on: the Automation
// tab's Add menu and a Discord webhook's Automation box list them the same way. The server's own
// list is TRIGGER_KINDS (trigger-rules.ts); rule-kinds.test.ts holds the two together.
import type { TriggerKind } from './types';

export type RuleGroup = 'Messages' | 'Players' | 'Server';
export const RULE_GROUPS: RuleGroup[] = ['Messages', 'Players', 'Server'];

export const RULE_KINDS: { kind: TriggerKind; group: RuleGroup; label: string; blurb: string }[] = [
	{
		kind: 'welcome',
		group: 'Messages',
		label: 'Welcome whisper',
		blurb: 'Whisper players as they join, or once they pick a faction.'
	},
	{
		kind: 'faction_change',
		group: 'Messages',
		label: 'Faction change whisper',
		blurb: 'Whisper players who switch sides.'
	},
	{
		kind: 'broadcast',
		group: 'Messages',
		label: 'Scheduled broadcast',
		blurb: 'Rotate through messages every few minutes while people are on.'
	},
	{
		kind: 'restart_notice',
		group: 'Messages',
		label: 'Restart notice',
		blurb: 'Warn players before the 24-hour restart and tell them when it lands.'
	},
	{
		kind: 'match_broadcast',
		group: 'Messages',
		label: 'Match broadcast',
		blurb: 'Announce who won when a match ends, and the map as the next one starts.'
	},
	{
		kind: 'risk_kick',
		group: 'Players',
		label: 'Kick on connect risk',
		blurb: 'Kick joiners the panel already distrusts, before they get a slot.'
	},
	{
		kind: 'name_filter',
		group: 'Players',
		label: 'Name filter',
		blurb: 'Kick or flag joiners whose name uses characters or words this server does not allow.'
	},
	{
		kind: 'name_change',
		group: 'Players',
		label: 'Name change watch',
		blurb: "Flag or kick players who change their name mid-game, or take another player's."
	},
	{
		kind: 'ping_kick',
		group: 'Players',
		label: 'High ping kick',
		blurb: 'Kick players whose ping stays too high for a configured time.'
	},
	{
		kind: 'team_kill',
		group: 'Players',
		label: 'Team kill limit',
		blurb: 'Whisper a player about team kills and kick them past a limit.'
	},
	{
		kind: 'kill_rate',
		group: 'Players',
		label: 'Kill rate watch',
		blurb: 'Flag players who get kills too fast, or too many headshots, for staff to check.'
	},
	{
		kind: 'kill_distance',
		group: 'Players',
		label: 'Kill distance watch',
		blurb:
			'Flag, warn, kill, kick or ban players for kills with chosen weapons or vehicles, at any distance or from too far.'
	},
	{
		kind: 'two_teams',
		group: 'Players',
		label: 'Team balance',
		blurb: 'Keep the sides even, and close a faction to play two teams.'
	},
	{
		kind: 'seed_reward',
		group: 'Players',
		label: 'Seeding reward',
		blurb: 'Give players who stay while the server is quiet a reserved slot.'
	},
	{
		kind: 'afk_protection',
		group: 'Players',
		label: 'AFK protection',
		blurb: 'Kill everyone every few minutes while the server seeds, so the idle kick spares them.'
	},
	{
		kind: 'empty_reset',
		group: 'Server',
		label: 'Empty-server map reset',
		blurb: 'Put an empty server back on a chosen map after a while.'
	}
];

/**
 * Rules whose actions come by the hundred as a matter of course (a Team balance sort at every match
 * start, an AFK protection round every few minutes while a server seeds): Discord hears only of
 * those that fail (webhook-delivery.ts).
 */
export const FAILURES_ONLY: TriggerKind[] = ['two_teams', 'afk_protection'];
