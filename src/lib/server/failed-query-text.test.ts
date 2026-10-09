// A failed query's message lists its parameters (Drizzle: "Failed query: <sql>\nparams: <params>").
// Nothing logs, stores or answers that text: the log gets it through forLog, without the
// parameters; a row or a client gets a fixed phrase.
import { expect, test } from 'bun:test';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { stage, type ServerMemory } from './observe';
import { serializeError, type RelayError } from './relay';
import { evaluateTriggers, validateConfig, type Evaluation, type TickContext } from './triggers';
import type { TriggerRow } from './db/schema';
import type { Env } from './env';

const failedQuery = () =>
	new DrizzleQueryError(
		'insert into "player_names" ("steam_id", "name") values ($1, $2)',
		['76561190000000001', 'Quiet Fixture'],
		new Error('deadlock detected')
	);

/** Everything the console was handed while `fn` ran, as one text. */
async function logged(fn: () => Promise<unknown>): Promise<string> {
	const out: unknown[] = [];
	const saved = { warn: console.warn, error: console.error, log: console.log };
	console.warn = console.error = console.log = (...args: unknown[]) => void out.push(...args);
	try {
		await fn();
	} finally {
		Object.assign(console, saved);
	}
	return out
		.map((a) => (a instanceof Error ? `${a.stack}\n${String(a.cause)}` : String(a)))
		.join('\n');
}

test('a housekeeping stage that fails on a query logs it without the parameters', async () => {
	const m = { server: { name: 'Fixture server' } } as unknown as ServerMemory;
	const text = await logged(() =>
		stage('lists', m, async () => {
			throw failedQuery();
		})
	);
	expect(text).not.toContain('76561190000000001');
	expect(text).not.toContain('Quiet Fixture');
	expect(text).toContain('lists Fixture server');
	expect(text).toContain('insert into "player_names"');
	expect(text).toContain('deadlock detected');
});

test('the worker sends the web a fixed phrase for its own failure, and logs it without the parameters', async () => {
	let sent: RelayError | undefined;
	const text = await logged(async () => {
		sent = serializeError(failedQuery());
	});
	expect(JSON.stringify(sent)).not.toContain('76561190000000001');
	expect(JSON.stringify(sent)).not.toContain('Quiet Fixture');
	expect(sent).toEqual({ kind: 'other', status: 500, message: 'Internal error.' });
	expect(text).not.toContain('76561190000000001');
	expect(text).toContain('deadlock detected');
});

test('a rule whose check fails on a query records a fixed phrase, and the log has no parameters', async () => {
	const row = {
		id: 'rule-reset',
		name: 'Fixture reset',
		kind: 'empty_reset',
		config: validateConfig('empty_reset', { map: 'Fixture map', afterMinutes: 10 }),
		state: null,
		lastFiredAt: null
	} as unknown as TriggerRow;
	const ctx = {
		server: { id: 'srv', name: 'Fixture server' },
		status: { map: 'Other map', experiences: [], playerCount: 0 },
		players: [],
		ts: new Date()
	} as unknown as TickContext;
	// the samples read fails
	const env = {
		db: {
			select: () => {
				throw failedQuery();
			}
		}
	} as unknown as Env;
	let ev: Evaluation | undefined;
	const text = await logged(async () => {
		ev = await evaluateTriggers(env, ctx, [row]);
	});
	expect(JSON.stringify(ev)).not.toContain('76561190000000001');
	expect(ev?.updates).toEqual([
		{ id: 'rule-reset', lastResult: 'Error: the rule could not be checked.' }
	]);
	expect(text).not.toContain('76561190000000001');
	expect(text).toContain('Fixture reset');
	expect(text).toContain('deadlock detected');
});
