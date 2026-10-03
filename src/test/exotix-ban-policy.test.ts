import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_BAN_POLICY,
	banCaseMessage,
	manualBanCase,
	validateBanPolicy
} from '$lib/exotix/ban-policy';

const policy = { ...structuredClone(DEFAULT_BAN_POLICY), enabled: true, version: 'v1' };
const body = {
	policyVersion: 'v1',
	categoryId: 'griefing',
	levelId: 'standard',
	ticketId: '00123',
	description: 'Private evidence and warning context.'
};

describe('EXOTIX ban policy', () => {
	test('six clear defaults use 7d, 30d, PERM, with permanent cheating and pending review', () => {
		expect(validateBanPolicy(policy).categories.map((c) => c.label)).toEqual([
			'Rule violation',
			'Griefing',
			'Abusive conduct',
			'Exploiting',
			'Cheating',
			'Player review'
		]);
		expect(policy.categories.slice(0, 4).map((c) => c.levels.map((l) => l.days))).toEqual(
			Array.from({ length: 4 }, () => [7, 30, 0])
		);
		const c = manualBanCase(policy, { ...body, categoryId: 'player-review', levelId: 'pending' });
		expect(c).toMatchObject({ days: 0, reviewStatus: 'pending', severity: 'Pending review' });
		expect(c.message).toBe('Player review | PERM | t-00123 | Appeal on discord.gg/exotix');
	});
	test('leading zeroes survive; private notes do not enter the player message', () => {
		const c = manualBanCase(policy, body);
		expect(c.reference).toBe('t-00123');
		expect(c.message).toBe('Griefing | 7d | t-00123 | Appeal on discord.gg/exotix');
		expect(c.message).not.toContain(body.description);
		expect(c.description).toBe(body.description);
	});
	test('all fields are mandatory, tickets are exactly five digits, stale policy is refused', () => {
		for (const key of Object.keys(body)) {
			const missing = { ...body } as Record<string, unknown>;
			delete missing[key];
			expect(() => manualBanCase(policy, missing)).toThrow();
		}
		for (const ticketId of ['1234', '123456', ' 12345', '12e45', 'm-12345', 12345])
			expect(() => manualBanCase(policy, { ...body, ticketId })).toThrow('five digits');
		expect(() => manualBanCase(policy, { ...body, description: '  ' })).toThrow(
			'Internal description'
		);
		expect(() => manualBanCase(policy, { ...body, policyVersion: 'v0' })).toThrow('changed');
	});
	test('complete 200-character messages pass and 201 fail, including the appeal suffix', () => {
		const fixed = banCaseMessage('X', 30, 'a-0000001', 'Appeal');
		const reason = 'X'.repeat(201 - fixed.length);
		expect(banCaseMessage(reason, 30, 'a-0000001', 'Appeal').length).toBe(200);
		expect(() => banCaseMessage(reason + 'X', 30, 'a-0000001', 'Appeal')).toThrow('200');
		for (const r of ['Harassment / abuse', 'X|Y', 'X\nY'])
			expect(() => banCaseMessage(r, 7, 't-12345', 'Appeal')).toThrow();
		expect(() => banCaseMessage('Griefing', 7, 'm-12345', 'Appeal')).toThrow();
	});
	test('invalid policy cannot introduce ambiguous messages or timed player-review bans', () => {
		for (const label of ['A/B', 'A|B', 'A\nB']) {
			const p = structuredClone(policy);
			p.categories[0].label = label;
			expect(() => validateBanPolicy(p)).toThrow();
		}
		const p = structuredClone(policy);
		p.appealText = 'A'.repeat(150);
		p.categories[0].label = 'B'.repeat(80);
		expect(() => validateBanPolicy(p)).toThrow('200');
		for (const id of ['player-review', 'cheating']) {
			const p = structuredClone(policy);
			p.categories.find((c) => c.id === id)!.levels[0].days = 7;
			expect(() => validateBanPolicy(p)).toThrow('permanent');
			const changed = structuredClone(policy);
			changed.categories.find((c) => c.id === id)!.action =
				id === 'player-review' ? 'ban' : 'review';
			expect(() => validateBanPolicy(changed)).toThrow('Player review');
		}
	});
});
