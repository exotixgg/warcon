// The Death whisper rule's pure part: its settings, the pick of a message, whom one batch's deaths
// bring a whisper (the cooldown, the rule's list, reserved slots, the player count) and the rule's
// own placeholders. The live path and the dry run run the same step (src/test/death-whisper.test.ts).
import { describe, expect, test } from 'bun:test';
import { ApiError } from './http';
import {
	DEATH_WHISPER_KEEP_MS,
	deathBlanks,
	deathVars,
	deathWhisperStep,
	deathWhisperText,
	deathWhisperSettingsKey,
	reportableTeamKill,
	fittingMessages,
	pickMessage,
	pruneWhispered,
	validateDeathWhisper,
	type Death,
	type DeathWhisperConfig,
	type WhisperedTracks
} from './death-whisper';
import { SETTINGS_KEYS, ruleNeeds, validateConfig } from './triggers';
import { MESSAGE_RULES, placeholdersFor } from '$lib/placeholders';
import { FAILURES_ONLY, FEED_KINDS, ONE_PER_SERVER, TRAIL_FAILURES_ONLY } from '$lib/rule-kinds';
import { automationPoolEditorValue } from '$lib/automation-message';
import { renderTemplate } from './triggers';

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 3, 20, 0, 0);
const A = '76561198000000501';
const B = '76561198000000502';
const C = '76561198000000503';

const refused = (raw: Record<string, unknown>): string => {
	try {
		validateDeathWhisper(raw);
	} catch (err) {
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(400);
		return (err as ApiError).message;
	}
	throw new Error('accepted');
};

const cfg = (over: Partial<DeathWhisperConfig> = {}): DeathWhisperConfig => ({
	...validateDeathWhisper({ messages: ['one', 'two', 'three'] }),
	...over
});
let n = 0;
const death = (steamId: string): Death => ({ steamId, eventId: `e${n++}` });
/** a step at NOW with 50 on, nothing reserved, the first message the pick allows */
const step = (
	c: DeathWhisperConfig,
	tracks: WhisperedTracks,
	deaths: Death[],
	at: Partial<Parameters<typeof deathWhisperStep>[3]> = {}
) =>
	deathWhisperStep(c, tracks, deaths, {
		now: NOW,
		on: 50,
		reserved: new Set(),
		rand: () => 0,
		...at
	});

describe('settings', () => {
	test('a list of messages, a 30-minute cooldown, someone on, nobody spared, by default', () => {
		expect(validateDeathWhisper({ messages: ['Join our Discord.'] })).toEqual({
			messages: ['Join our Discord.'],
			teamKillMessages: [],
			cooldownMinutes: 30,
			minPlayers: 1,
			spareReserved: false,
			exempt: []
		});
		// the API and the editor's textarea alike
		expect(validateDeathWhisper({ messages: 'a\n\n  b  \nc' }).messages).toEqual(['a', 'b', 'c']);
	});

	test('preserves lines inside an entry, cuts safely, and deduplicates entries', () => {
		const c = validateDeathWhisper({
			messages: ['first\nline', 'x'.repeat(255) + '🎯', 'same', 'same', `tab\there`]
		});
		expect(c.messages).toEqual(['first\nline', 'x'.repeat(255), 'same', 'tab here']);
	});

	test('refused: no message or more than 100; cooldown can be disabled and numbers are clamped', () => {
		expect(refused({ messages: [] })).toBe('Add at least one message to whisper.');
		expect(refused({ messages: ['', '  '] })).toBe('Add at least one message to whisper.');
		expect(refused({ messages: Array.from({ length: 101 }, (_, i) => `m${i}`) })).toBe(
			'A pool holds at most 100 messages.'
		);
		expect(validateDeathWhisper({ messages: ['a'], cooldownMinutes: 0 }).cooldownMinutes).toBe(0);
		expect(validateDeathWhisper({ messages: ['a'], cooldownMinutes: -5 }).cooldownMinutes).toBe(0);
		const c = validateDeathWhisper({ messages: ['a'], cooldownMinutes: 9999, minPlayers: 5000 });
		expect([c.cooldownMinutes, c.minPlayers]).toEqual([1440, 1000]);
		expect(
			validateDeathWhisper({ messages: Array.from({ length: 100 }, (_, i) => `m${i}`) }).messages
		).toHaveLength(100);
	});

	test('its list: SteamID64 strings only, up to 100', () => {
		expect(validateDeathWhisper({ messages: ['a'], exempt: [A, A, B] }).exempt).toEqual([A, B]);
		expect(refused({ messages: ['a'], exempt: [76561198000000501] })).toContain('as strings');
		expect(refused({ messages: ['a'], exempt: ['Ramon'] })).toContain('is not a SteamID64');
		const many = Array.from({ length: 101 }, (_, i) => String(76561198000001000n + BigInt(i)));
		expect(refused({ messages: ['a'], exempt: many })).toBe(
			'At most 100 players can be left alone.'
		);
	});

	test('the kind as the rest of the panel knows it', () => {
		expect(validateConfig('death_whisper', { messages: ['a'] })).toEqual(
			validateDeathWhisper({ messages: ['a'] })
		);
		// it whispers, so saving it takes Chat
		expect(ruleNeeds('death_whisper', {})).toEqual(['chat.send', 'whispers players']);
		// a kill feed rule, quiet on Discord and in the trail when it goes, several to a server
		expect(FEED_KINDS).toContain('death_whisper');
		expect(FAILURES_ONLY).toContain('death_whisper');
		expect(TRAIL_FAILURES_ONLY).toEqual(['death_whisper']);
		expect(ONE_PER_SERVER).not.toContain('death_whisper');
		// Pending whispers are guarded against a disabled/edited rule, including legacy configs.
		expect(SETTINGS_KEYS.death_whisper).toBe(deathWhisperSettingsKey);
		expect(deathWhisperSettingsKey({ messages: ['a'] })).toBe(
			deathWhisperSettingsKey(validateDeathWhisper({ messages: ['a'], teamKillMessages: [] }))
		);
		// its own placeholders, and the player's, their stats here and across the org, the server's
		expect(MESSAGE_RULES.death_whisper?.own).toEqual([
			'killer',
			'weapon',
			'distance',
			'death_summary'
		]);
		expect(placeholdersFor('death_whisper').map((g) => g.key)).toEqual([
			'own',
			'player',
			'stats',
			'org',
			'server'
		]);
	});
});

describe('the pick', () => {
	test('one message is always that one', () => {
		for (const r of [0, 0.5, 0.999999]) expect(pickMessage([0], 0, () => r)).toBe(0);
		expect(pickMessage([0], -1, () => 0.7)).toBe(0);
		// the only message that fits, even if the player had it last
		expect(pickMessage([2], 2, () => 0.1)).toBe(2);
	});

	test('never the one the player had last while there is another, every other one in reach', () => {
		const rands = [0, 0.2, 0.4, 0.6, 0.8, 0.999999];
		for (let last = 0; last < 4; last++) {
			const got = new Set(rands.map((r) => pickMessage([0, 1, 2, 3], last, () => r)));
			expect(got.has(last)).toBe(false);
			expect([...got].sort()).toEqual([0, 1, 2, 3].filter((i) => i !== last));
		}
		expect(pickMessage([0, 1], 0, () => 0.9)).toBe(1);
		expect(pickMessage([0, 1], 1, () => 0)).toBe(0);
	});

	test('with no last message known, any one', () => {
		const got = new Set([0, 0.34, 0.67, 0.999999].map((r) => pickMessage([0, 1, 2], -1, () => r)));
		expect([...got].sort()).toEqual([0, 1, 2]);
		// a list that shrank since the player's last: the old place is no constraint
		expect(pickMessage([0, 1], 5, () => 0.999999)).toBe(1);
	});

	test('a message naming what the death lacks is passed over while another fits', () => {
		const c = cfg({
			messages: [
				'Killed by {Killer}',
				'Hello {name}',
				'{weapon} from {distance} m',
				'Rest {player}'
			]
		});
		expect(fittingMessages(c)).toEqual([0, 1, 2, 3]);
		expect(fittingMessages(c, ['killer'])).toEqual([1, 2, 3]);
		expect(fittingMessages(c, ['distance'])).toEqual([0, 1, 3]);
		expect(fittingMessages(c, ['killer', 'weapon', 'distance'])).toEqual([1, 3]);
		// when nothing fits, any: the author asked for it
		expect(fittingMessages(cfg({ messages: ['Killed by {killer}'] }), ['killer'])).toEqual([0]);
		// the step goes by it, the player's last message aside
		const tracks: WhisperedTracks = new Map([[A, { at: NOW - 60 * MIN, index: 1 }]]);
		const fall = { ...death(A), blank: ['killer', 'weapon'] as const };
		expect(step(c, tracks, [fall], { rand: () => 0 }).picks[0].index).toBe(3);
	});

	test('what a death leaves empty', () => {
		const vars = deathVars({
			killer: null,
			victim: { steamId: A },
			cause: null,
			distanceM: 12,
			suicide: false
		});
		expect(deathBlanks(vars)).toEqual(['killer', 'weapon']);
		expect(
			deathBlanks(
				deathVars({
					killer: { steamId: B, name: 'Ghost' },
					victim: { steamId: A },
					cause: 'Id.Item.AK74M',
					distanceM: 3,
					suicide: false
				})
			)
		).toEqual([]);
	});
});

describe('whom a batch brings a whisper', () => {
	test('each player killed, once a batch, using their latest event in game order', () => {
		const tracks: WhisperedTracks = new Map();
		const deaths = [death(A), death(B), death(A)];
		const s = step(cfg(), tracks, deaths);
		expect(s.picks.map((p) => [p.steamId, p.eventId])).toEqual([
			[B, deaths[1].eventId],
			[A, deaths[2].eventId]
		]);
		expect(s.passed).toEqual({
			few: 0,
			waiting: 0,
			listed: 0,
			reserved: 0,
			cooling: 0,
			superseded: 1,
			empty: 0
		});
		expect(tracks.get(A)).toEqual({ at: NOW, index: 0, eventId: deaths[2].eventId });
	});

	test('not again inside the cooldown, and again once it has run', () => {
		const tracks: WhisperedTracks = new Map([
			[A, { at: NOW - 29 * MIN, index: 0 }],
			[B, { at: NOW - 30 * MIN, index: 0 }]
		]);
		const s = step(cfg(), tracks, [death(A), death(B)]);
		expect(s.picks.map((p) => p.steamId)).toEqual([B]);
		expect(s.passed.cooling).toBe(1);
		expect(tracks.get(A)!.at).toBe(NOW - 29 * MIN);
	});

	test('a new message for a player each time: never the one they had last', () => {
		const tracks: WhisperedTracks = new Map([[A, { at: NOW - 60 * MIN, index: 0 }]]);
		const s = step(cfg(), tracks, [death(A)], { rand: () => 0 });
		expect(s.picks[0].index).toBe(1);
		expect(tracks.get(A)).toMatchObject({ at: NOW, index: 1 });
	});

	test('never a player on its list, nor one with a slot when it spares them', () => {
		const tracks: WhisperedTracks = new Map();
		const c = cfg({ exempt: [A], spareReserved: true });
		const s = step(c, tracks, [death(A), death(B), death(C)], { reserved: new Set([B]) });
		expect(s.picks.map((p) => p.steamId)).toEqual([C]);
		expect(s.passed).toMatchObject({ listed: 1, reserved: 1 });
		expect(tracks.has(A) || tracks.has(B)).toBe(false);
		// a rule that does not spare slots whispers them like anyone
		expect(step(cfg(), new Map(), [death(B)], { reserved: new Set([B]) }).picks).toHaveLength(1);
	});

	test('a rule sparing slots whispers nobody until the reserved list is read, and says so', () => {
		const tracks: WhisperedTracks = new Map();
		const s = step(cfg({ spareReserved: true }), tracks, [death(A), death(B)], { reserved: null });
		expect(s.picks).toEqual([]);
		expect(s.held).toBe('reserved');
		expect(s.passed.waiting).toBe(2);
		expect(tracks.size).toBe(0);
		// one that does not spare them has nothing to wait for
		expect(step(cfg(), new Map(), [death(A)], { reserved: null }).picks).toHaveLength(1);
	});

	test('nobody while fewer than its count are on', () => {
		const tracks: WhisperedTracks = new Map();
		const s = step(cfg({ minPlayers: 20 }), tracks, [death(A), death(B)], { on: 19 });
		expect(s.picks).toEqual([]);
		expect(s.held).toBe('');
		expect(s.passed.few).toBe(2);
		expect(step(cfg({ minPlayers: 20 }), tracks, [death(A)], { on: 20 }).picks).toHaveLength(1);
		// a count of 0 acts on an empty-looking server too
		expect(step(cfg({ minPlayers: 0 }), new Map(), [death(B)], { on: 0 }).picks).toHaveLength(1);
	});

	test('undo puts the memory back, but for a player a later batch moved on since', () => {
		const before = { at: NOW - 60 * MIN, index: 2 };
		const tracks: WhisperedTracks = new Map([[A, before]]);
		const first = step(cfg(), tracks, [death(A), death(B)]);
		first.undo();
		expect(tracks.get(A)).toBe(before);
		expect(tracks.has(B)).toBe(false);
		// moved on by a later batch between the decision and the failed write: that one stands
		const again = step(cfg(), tracks, [death(B)]);
		tracks.set(B, { at: NOW + MIN, index: 1 });
		again.undo();
		expect(tracks.get(B)).toEqual({ at: NOW + MIN, index: 1 });
	});

	test('the memory keeps a player for the cooldown and an hour after', () => {
		const c = cfg({ cooldownMinutes: 10 });
		const keep = 10 * MIN + DEATH_WHISPER_KEEP_MS;
		const tracks: WhisperedTracks = new Map([
			[A, { at: NOW - keep, index: 0 }],
			[B, { at: NOW - keep + 1, index: 0 }]
		]);
		pruneWhispered(c, tracks, NOW);
		expect([...tracks.keys()]).toEqual([B]);
	});
});

describe('its own placeholders', () => {
	const kill = (o: Partial<Parameters<typeof deathVars>[0]> = {}) =>
		deathVars({
			killer: { steamId: B, name: 'Ghost' },
			victim: { steamId: A },
			cause: 'Id.Item.AK74M',
			distanceM: 152.6,
			suicide: false,
			...o
		});

	test('who killed the player, with what, from how far', () => {
		expect(kill()).toEqual({
			killer: 'Ghost',
			weapon: 'AK74',
			distance: 153,
			death_summary: 'Killed by Ghost | AK74 | 153m'
		});
		expect(kill({ killer: { steamId: B, name: '' } }).killer).toBe(B);
	});

	test('blank where it does not apply: no killer, a suicide, no cause, no distance', () => {
		expect(kill({ killer: null }).killer).toBe('');
		expect(kill({ suicide: true }).killer).toBe('');
		expect(kill({ killer: { steamId: A, name: 'Self' } }).killer).toBe('');
		expect(kill({ cause: null }).weapon).toBe('');
		expect(kill({ distanceM: null }).distance).toBe('');
	});

	test('a team kill keeps the killer, weapon and distance with a clear header', () => {
		expect(kill({ teamKill: true }).death_summary).toBe('Team-killed by Ghost | AK74 | 153m');
		expect(kill({ teamKill: true, suicide: true }).death_summary).toBe('You died | AK74 | 153m');
	});

	test('the longest team-kill header leaves 173 units for a body and blank line', () => {
		const summary = kill({
			teamKill: true,
			killer: { steamId: B, name: 'N'.repeat(40) },
			cause: 'Id.Item.' + 'W'.repeat(40),
			distanceM: 123456789012345
		}).death_summary as string;
		expect(summary.length).toBeLessThanOrEqual(81);
		expect(
			renderTemplate('{death_summary}\n\n' + 'x'.repeat(173), { death_summary: summary }, 256)
		).toEndWith('x'.repeat(173));
	});
});

describe('separate report pool', () => {
	const report = (steamId: string): Death => ({ ...death(steamId), teamKill: true });
	const both = (over: Partial<DeathWhisperConfig> = {}) =>
		cfg({
			messages: ['normal one', 'normal two'],
			teamKillMessages: ['report one', 'report two'],
			cooldownMinutes: 10,
			...over
		});

	test('team kills get reports only; normal deaths retain their own choices', () => {
		const c = both();
		const s = step(c, new Map(), [report(A), death(B)]);
		expect(s.picks.map((p) => [p.pool, deathWhisperText(c, p)])).toEqual([
			['teamKillMessages', 'report one'],
			['messages', 'normal one']
		]);
	});

	test('missing or empty report pools skip team kills without reserving a cooldown', () => {
		for (const teamKillMessages of [undefined, []]) {
			const tracks: WhisperedTracks = new Map();
			const c = both({ teamKillMessages });
			expect(step(c, tracks, [report(A)]).picks).toEqual([]);
			expect(tracks.size).toBe(0);
			expect(step(c, tracks, [death(A)]).picks[0].pool).toBe('messages');
		}
	});

	test('the cooldown is shared in both directions, including exactly ten minutes', () => {
		for (const firstReport of [true, false]) {
			const tracks: WhisperedTracks = new Map();
			const c = both();
			step(c, tracks, [firstReport ? report(A) : death(A)]);
			expect(
				step(c, tracks, [firstReport ? death(A) : report(A)], { now: NOW + 10 * MIN - 1 }).picks
			).toEqual([]);
			expect(
				step(c, tracks, [firstReport ? death(A) : report(A)], { now: NOW + 10 * MIN }).picks
			).toHaveLength(1);
		}
	});

	test('both pools honor reserved slots, explicit exemptions and unknown reserved lists', () => {
		for (const d of [report, death]) {
			const c = both({ spareReserved: true, exempt: [A] });
			const s = step(c, new Map(), [d(A), d(B), d(C)], { reserved: new Set([B]) });
			expect(s.picks.map((p) => p.steamId)).toEqual([C]);
			expect(step(c, new Map(), [d(C)], { reserved: null }).held).toBe('reserved');
		}
	});

	test('last-choice indexes remain independent across alternating pools', () => {
		const c = both({ cooldownMinutes: 0 });
		const tracks: WhisperedTracks = new Map();
		const chosen = [death(A), report(A), death(A), report(A)].map((d) =>
			deathWhisperText(c, step(c, tracks, [d]).picks[0])
		);
		expect(chosen).toEqual(['normal one', 'report one', 'normal two', 'report two']);
	});

	test('latest victim event supplies both the pool and event id, even at zero cooldown', () => {
		const c = both({ cooldownMinutes: 0 });
		for (const events of [
			[death(A), report(A)],
			[report(A), death(A)]
		]) {
			const tracks: WhisperedTracks = new Map();
			const s = step(c, tracks, events);
			expect(s.picks).toHaveLength(1);
			expect(s.picks[0]).toMatchObject({
				eventId: events[1].eventId,
				pool: events[1].teamKill ? 'teamKillMessages' : 'messages'
			});
			expect(step(c, tracks, [events[1]]).picks).toEqual([]);
		}
	});

	test('the report pool has its own fitting-placeholder cache and 100-entry cap', () => {
		const c = both({ teamKillMessages: ['{weapon}', 'report'] });
		expect(fittingMessages(c, ['weapon'], 'teamKillMessages')).toEqual([1]);
		expect(fittingMessages(c, ['weapon'])).toEqual([0, 1]);
		expect(
			validateDeathWhisper({
				messages: ['a'],
				teamKillMessages: Array.from({ length: 100 }, (_, i) => `r${i}`)
			}).teamKillMessages
		).toHaveLength(100);
		expect(
			refused({ messages: ['a'], teamKillMessages: Array.from({ length: 101 }, (_, i) => `r${i}`) })
		).toBe('A pool holds at most 100 messages.');
	});

	test('JSON multiline reports survive editor roundtrip and the rendered 256-unit cap', () => {
		const templates = [
			'{death_summary}\n\nREPORT\nTeam kill? Accidents happen. If it was intentional or repeated, report it at discord.gg/exotix.',
			'x'.repeat(255) + '🎯'
		];
		const saved = validateConfig('death_whisper', {
			messages: ['ad'],
			teamKillMessages: automationPoolEditorValue(templates).split('\n')
		}) as DeathWhisperConfig;
		expect(saved.teamKillMessages).toEqual([templates[0], 'x'.repeat(255)]);
		const reopened = automationPoolEditorValue(saved.teamKillMessages!);
		expect(
			(
				validateConfig('death_whisper', {
					messages: ['ad'],
					teamKillMessages: reopened.split('\n')
				}) as DeathWhisperConfig
			).teamKillMessages
		).toEqual(saved.teamKillMessages);
		expect(MESSAGE_RULES.death_whisper?.fields).toEqual(['messages', 'teamKillMessages']);
		const rendered = renderTemplate(
			'{death_summary}\n\n' + 'x'.repeat(256),
			{ death_summary: 'Team-killed by Ghost | AK74 | 153m' },
			256
		);
		expect(rendered).toHaveLength(256);
		expect(rendered.startsWith('Team-killed by Ghost | AK74 | 153m\n\n')).toBe(true);
	});

	test('only the feed flag plus an attributed non-suicide kill qualifies', () => {
		const k = {
			killer: { steamId: B, name: 'Ghost' },
			victim: { steamId: A },
			suicide: false,
			teamKill: true,
			cause: null,
			distanceM: null
		};
		expect(reportableTeamKill(k)).toBe(true);
		for (const change of [
			{ teamKill: false },
			{ killer: null },
			{ suicide: true },
			{ killer: { steamId: A, name: 'Self' } }
		]) {
			expect(reportableTeamKill({ ...k, ...change })).toBe(false);
		}
	});
});
