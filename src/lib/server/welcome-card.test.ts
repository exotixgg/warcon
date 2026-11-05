import { describe, expect, test } from 'bun:test';
import { buildWelcomeCard, shortWelcomeName, type WelcomeCardVars } from './welcome-card';

const zero: WelcomeCardVars = {
	season_name: 'SEASON 02',
	season_rank: '-',
	season_kills: 0,
	season_deaths: 0,
	season_kd: '0.00',
	season_playtime: '0m',
	season_seeded: '0m',
	season_cash: '0',
	season_rival: '-',
	leader_kills_name: '-',
	leader_kills_value: '0',
	leader_cash_name: '-',
	leader_cash_value: '0',
	leader_playtime_name: '-',
	leader_playtime_value: '0m',
	leader_seeded_name: '-',
	leader_seeded_value: '0m',
	server_label: 'EXOTIX EU-05'
};

describe('welcome card', () => {
	test('renders a useful zero-history card', () => {
		expect(buildWelcomeCard(zero)).toContain('SEASON 02 | Rank #-');
		expect(buildWelcomeCard(zero)).toContain('0K/0D | 0.00 K/D | 0m/0m');
	});

	test('budgets grapheme names and never exceeds the RCON limit', () => {
		const long = '👩🏽‍🚀'.repeat(50);
		const card = buildWelcomeCard({
			...zero,
			season_rival: long,
			leader_kills_name: long,
			leader_cash_name: long,
			leader_playtime_name: long,
			leader_seeded_name: long,
			season_name: long,
			server_label: long,
			season_rank: long,
			season_kills: long,
			season_deaths: long,
			season_kd: long,
			season_playtime: long,
			season_seeded: long,
			leader_kills_value: long,
			leader_cash_value: long,
			leader_playtime_value: long,
			leader_seeded_value: long
		});
		expect(card.length).toBeLessThanOrEqual(256);
		expect(card.endsWith('seeded')).toBe(true);
		expect(shortWelcomeName('👩🏽‍🚀x', 1)).toBe('…');
	});
});
