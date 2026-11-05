import { describe, expect, test } from 'bun:test';
import {
	announcementFor,
	BAN_CATEGORIES,
	banReference,
	DEFAULT_BAN_POLICY,
	finalizeBanCase,
	prepareBanCase,
	playerMessageFor,
	storedBanPolicy,
	validateBanCase,
	validateBanPolicy
} from '$lib/ban-policy';

const values = {
	category: '',
	reason: 'Intentional team killing',
	days: 3,
	expiresAt: new Date('2026-11-08T12:30:00Z'),
	entryId: 'entry-abcdef',
	ticketId: '00123',
	playerName: 'Mercury',
	source: 'EXOTIX EU-01'
};

describe('EXOTIX ban policy', () => {
	test('has the agreed fixed categories and duration ladders', () => {
		expect(BAN_CATEGORIES.map((category) => category.id)).toEqual([
			'rule-violation',
			'griefing',
			'abusive-conduct',
			'cheating',
			'player-review'
		]);
		expect(BAN_CATEGORIES.slice(0, 3).map((category) => category.durations)).toEqual([
			[1, 3, 7, 30, 0],
			[1, 3, 7, 30, 0],
			[1, 3, 7, 30, 0]
		]);
		expect(BAN_CATEGORIES.slice(3).map((category) => category.durations)).toEqual([[0], [0]]);
	});

	test('starts disabled and validates every fixed category', () => {
		expect(DEFAULT_BAN_POLICY.enabled).toBeFalse();
		expect(validateBanPolicy(DEFAULT_BAN_POLICY)).toEqual(DEFAULT_BAN_POLICY);
		expect(storedBanPolicy({ enabled: true, categories: [] })).toEqual(DEFAULT_BAN_POLICY);
	});

	test('refuses missing category configuration and invalid public pools', () => {
		const missing = structuredClone(DEFAULT_BAN_POLICY);
		missing.categories.pop();
		expect(() => validateBanPolicy(missing)).toThrow('every category');
		const noMessage = structuredClone(DEFAULT_BAN_POLICY);
		noMessage.categories[0].announcementMessages = [];
		expect(() => validateBanPolicy(noMessage)).toThrow('add an announcement');
		const unknownToken = structuredClone(DEFAULT_BAN_POLICY);
		unknownToken.categories[0].playerMessage = '{notes}';
		expect(() => validateBanPolicy(unknownToken)).toThrow('placeholder');
		const malformedToken = structuredClone(DEFAULT_BAN_POLICY);
		malformedToken.categories[0].playerMessage = '{reason';
		expect(() => validateBanPolicy(malformedToken)).toThrow('invalid placeholder');
		const overlongTemplate = structuredClone(DEFAULT_BAN_POLICY);
		overlongTemplate.categories[0].playerMessage = 'x'.repeat(201);
		expect(() => validateBanPolicy(overlongTemplate)).toThrow('limited to 200');
	});

	test('uses neutral Player Review defaults without a misconduct allegation', () => {
		const review = DEFAULT_BAN_POLICY.categories.find((item) => item.id === 'player-review')!;
		expect(review.playerMessage).toContain('staff complete a Player Review');
		expect(review.announcementMessages[0]).toContain('staff review');
		expect(review.announcementMessages[0]).not.toContain('banned');
	});

	test('keeps Player Review announcements on their originating server', () => {
		const invalid = structuredClone(DEFAULT_BAN_POLICY);
		invalid.categories.find((item) => item.id === 'player-review')!.announcementScope = 'org';
		expect(() => validateBanPolicy(invalid)).toThrow('originating server');
		const disabled = structuredClone(DEFAULT_BAN_POLICY);
		disabled.categories.find((item) => item.id === 'player-review')!.announcementEnabled = false;
		expect(
			validateBanPolicy(disabled).categories.find((item) => item.id === 'player-review')!
				.announcementEnabled
		).toBeFalse();
	});

	test('requires category-approved durations, a public reason and an optional five-digit ticket', () => {
		expect(
			validateBanCase({
				categoryId: 'griefing',
				reason: ' Intentional team killing ',
				days: 3,
				ticketId: '00123',
				notes: 'Only staff see this.',
				originServerId: 'server-one'
			})
		).toMatchObject({
			categoryId: 'griefing',
			reason: 'Intentional team killing',
			ticketId: '00123'
		});
		expect(() => validateBanCase({ categoryId: 'cheating', reason: 'Cheating', days: 7 })).toThrow(
			'approved durations'
		);
		expect(() => validateBanCase({ categoryId: 'griefing', reason: '', days: 3 })).toThrow(
			'public reason'
		);
		expect(() =>
			validateBanCase({ categoryId: 'griefing', reason: 'X', days: 3, ticketId: '1234' })
		).toThrow('exactly five');
	});

	test('prepares a case before insertion and snapshots its player message afterwards', () => {
		const policy = validateBanPolicy({ ...DEFAULT_BAN_POLICY, enabled: true });
		const prepared = prepareBanCase(
			policy,
			{ categoryId: 'player-review', days: 0, ticketId: '00420', notes: 'Evidence retained.' },
			{ reason: 'Account review', scope: 'org', originServerId: 'eu-01' }
		);
		const complete = finalizeBanCase(policy, prepared, {
			entryId: 'entry-abcdef',
			playerName: 'Mercury',
			source: 'EXOTIX EU-01',
			expiresAt: null
		});
		expect(complete).toMatchObject({
			category: 'Player Review',
			reason: 'Account review',
			originServerId: 'eu-01'
		});
		expect(complete.playerMessage).toContain('T-00420');
		expect(complete.playerMessage).not.toContain('Evidence retained.');
	});

	test('renders player and public text without exposing internal notes', () => {
		const policy = validateBanPolicy(DEFAULT_BAN_POLICY);
		expect(banReference('00123', 'entry-abcdef')).toBe('T-00123');
		expect(banReference(null, 'entry-abcdef')).toBe('B-ENTRYA');
		const player = playerMessageFor(policy, 'griefing', values);
		expect(player).toContain('Griefing');
		expect(player).toContain('T-00123');
		expect(player).not.toContain('Only staff');
		expect(announcementFor(policy, 'griefing', values)).toContain('Mercury');
	});
});
