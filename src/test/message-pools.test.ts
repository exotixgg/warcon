import { describe, expect, test } from 'bun:test';
import {
	chooseMessageIndexes,
	eligibleMessageIndexes,
	effectivePools,
	renderPoolMessage,
	validateMessagePools,
	type MessagePool
} from '$lib/message-pools';

const pool = (id: string, extra: Partial<MessagePool> = {}): MessagePool => ({
	id,
	name: id,
	action: 'join',
	enabled: true,
	mode: 'ordered',
	messages: ['Hello {player_name}', 'Welcome to {server_name}', 'Enjoy {map}'],
	sendCount: 2,
	initialDelaySeconds: 0,
	spacingSeconds: 10,
	allServers: true,
	serverIds: [],
	onlyFirstVisit: false,
	categoryId: '',
	banSources: ['policy', 'legacy', 'automatic'],
	weaponTags: [],
	teamKillsOnly: false,
	thresholds: [],
	everyMinutes: 10,
	minPlayers: 1,
	maxPlayers: null,
	...extra
});

describe('message pools', () => {
	test('all-server defaults include future servers; a named-server pool overrides them', () => {
		const all = pool('all');
		const infantry = pool('infantry', { allServers: false, serverIds: ['infantry'] });
		const config = validateMessagePools({ pools: [all, infantry] });
		expect(effectivePools(config, 'regular').map((p) => p.id)).toEqual(['all']);
		expect(effectivePools(config, 'infantry').map((p) => p.id)).toEqual(['infantry']);
		expect(effectivePools(config, 'new-server').map((p) => p.id)).toEqual(['all']);
	});

	test('ordered events take two messages and continue from the next slot', () => {
		const p = pool('round', { action: 'round_start', messages: ['A', 'B', 'C'] });
		expect(chooseMessageIndexes(p, 0, -1)).toEqual([0, 1]);
		expect(chooseMessageIndexes(p, 2, 1)).toEqual([2, 0]);
	});

	test('random selection has no immediate repeat or duplicate within an event', () => {
		const p = pool('random', { mode: 'random' });
		expect(chooseMessageIndexes(p, 0, 1, () => 0)).toEqual([0, 1]);
		expect(chooseMessageIndexes(p, 0, 0, () => 0)).toEqual([1, 0]);
	});

	test('ban and weapon placeholders are action-specific and private descriptions are unavailable', () => {
		const ban = pool('ban', {
			action: 'ban',
			categoryId: 'cheating',
			sendCount: 1,
			messages: ['{player_name} banned for {ban_category} ({ban_duration}).']
		});
		expect(validateMessagePools({ pools: [ban] }).pools[0].banSources).toEqual([
			'policy',
			'legacy',
			'automatic'
		]);
		expect(() =>
			validateMessagePools({ pools: [{ ...ban, messages: ['{description}'] }] })
		).toThrow('placeholders');
		const weapon = pool('grenade-launcher', {
			action: 'weapon',
			messages: ['{player_name}: {weapon} is forbidden.'],
			sendCount: 1,
			weaponTags: ['Id.Item.GrenadeLauncher'],
			thresholds: [
				{ count: 1, action: 'whisper', days: 0, scope: 'server' },
				{ count: 2, action: 'kick', days: 0, scope: 'server' },
				{ count: 3, action: 'ban', days: 7, scope: 'server' }
			]
		});
		expect(
			validateMessagePools({ pools: [weapon] }).pools[0].thresholds.map((step) => step.action)
		).toEqual(['whisper', 'kick', 'ban']);
		expect(
			validateMessagePools({ pools: [weapon] }).pools[0].thresholds[0].message
		).toBeUndefined();
		const distinctSteps = {
			...weapon,
			thresholds: [
				{ ...weapon.thresholds[0], message: 'Warning: {weapon} is banned.' },
				{ ...weapon.thresholds[1], message: 'Kicked for using {weapon}.' },
				{ ...weapon.thresholds[2], message: 'Banned for using {weapon} twice.' }
			]
		};
		expect(validateMessagePools({ pools: [distinctSteps] }).pools[0].thresholds).toEqual(
			distinctSteps.thresholds
		);
		expect(() =>
			validateMessagePools({
				pools: [
					{
						...distinctSteps,
						thresholds: [{ ...distinctSteps.thresholds[0], message: '{ban_reason}' }]
					}
				]
			})
		).toThrow('placeholders');
	});

	test('overlapping assignments and malformed weapon rules are refused', () => {
		const one = pool('one', { allServers: false, serverIds: ['a'] });
		const two = pool('two', { allServers: false, serverIds: ['a'] });
		expect(() => validateMessagePools({ pools: [one, two] })).toThrow('Only one pool');
		expect(() =>
			validateMessagePools({
				pools: [
					pool('bad', {
						action: 'weapon',
						weaponTags: ['Grenade Launcher'],
						thresholds: [{ count: 1, action: 'ban', days: 1, scope: 'server' }]
					})
				]
			})
		).toThrow('weapon tags');
	});

	test('placeholder values containing braces stay literal', () => {
		expect(
			renderPoolMessage('Hello {player_name} on {server_name}', {
				player_name: '{ban_reason}',
				server_name: 'WARDOGS'
			})
		).toBe('Hello {ban_reason} on WARDOGS');
	});

	test('a pool accepts 50 messages and skips round awards without a recorded winner', () => {
		const messages = Array.from({ length: 50 }, (_, index) => `Line ${index + 1}`);
		expect(
			validateMessagePools({ pools: [pool('fifty', { messages, sendCount: 1 })] }).pools[0].messages
		).toHaveLength(50);
		expect(() =>
			validateMessagePools({
				pools: [pool('too-many', { messages: [...messages, 'Line 51'], sendCount: 1 })]
			})
		).toThrow('50');
		expect(
			eligibleMessageIndexes(
				{ action: 'round_end', messages: ['Top {top_kills_name}: {top_kills_count}', 'GG'] },
				{
					top_kills_name: '',
					top_kills_count: ''
				}
			)
		).toEqual([1]);
	});
});
