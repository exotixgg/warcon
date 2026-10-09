// A failed query's message lists its parameters (Drizzle: "Failed query: <sql>\nparams: <params>").
// Nothing logs, stores or answers that text: the log gets it through forLog, without the
// parameters; a row or a client gets a fixed phrase.
import { expect, test } from 'bun:test';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { stage, type ServerMemory } from './observe';

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
