import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { CHAT_PAGE, shownName, type ChatLine } from '$lib/chat-read';
import { readChat } from './actions';
import { chatArchiveSources as sources, chatMessages as messages } from './db/schema';
import type { Env } from './env';
import { ownershipPeriod, withOwnedTransaction } from './leadership';
import { GameError, type WardogsClient } from './rcon';

type Source = typeof sources.$inferSelect;
type Entry = typeof messages.$inferInsert;
const anchorOf = (line: ChatLine) =>
	createHash('sha256')
		.update(JSON.stringify([line.at, line.steamId, line.channel, line.text, line.name]))
		.digest('hex');

function checkpoint(s: Source) {
	return and(
		eq(sources.serverId, s.serverId),
		eq(sources.revision, s.revision),
		eq(sources.epoch, s.epoch),
		eq(sources.cursor, s.cursor),
		eq(sources.enabled, true)
	);
}

// Read the previous line as an anchor: the game can reuse a sequence on the next map,
// including after an interruption long enough to pass our old cursor.
export async function collectArchive(
	env: Env,
	server: { id: string; orgId: string; name: string },
	client: WardogsClient,
	startedAt: number
) {
	const period = ownershipPeriod();
	const [s] = await env.db
		.select()
		.from(sources)
		.where(
			and(
				eq(sources.serverId, server.id),
				eq(sources.orgId, server.orgId),
				eq(sources.enabled, true)
			)
		);
	if (!s) return 30_000;
	let epoch = s.epoch;
	let cursor = s.cursor;
	let anchor = s.anchor;
	if (s.startedAt && startedAt > s.startedAt + 60_000) {
		epoch++;
		cursor = 0;
		anchor = '';
	}
	const rows: Entry[] = [];
	let state = 'ready';
	let delay = 4000;
	// Drain bounded pages in the existing server lane. An unfinished page sequence resumes
	// on the next observation. No archive read is passed to command or Staff Call handling.
	try {
		for (let page = 0; page < 3; page++) {
			const read = await readChat(client, Math.max(0, cursor - 1), CHAT_PAGE, 3000);
			if (read.latestSeq === null || read.lines.some((l) => l.seq > read.latestSeq!))
				throw new GameError(502, 'Unusable chat sequence', 'bad_response');
			const prior = read.lines.find((l) => l.seq === cursor);
			if (read.latestSeq < cursor || (prior && anchor && anchorOf(prior) !== anchor)) {
				epoch++;
				cursor = 0;
				anchor = '';
				continue;
			}
			for (const l of read.lines) {
				if (l.seq <= cursor) continue;
				const at = l.at ? new Date(l.at) : new Date();
				const entry = { orgId: s.orgId, serverId: s.serverId, epoch, seq: l.seq, at };
				if (cursor && l.seq > cursor + 1 && at >= s.changedAt)
					rows.push({
						...entry,
						kind: 'gap',
						steamId: null,
						speaker: '',
						channel: '',
						faction: '',
						body: 'Part of this conversation was unavailable from the game.'
					});
				cursor = l.seq;
				anchor = anchorOf(l);
				if (at < s.changedAt) continue;
				rows.push({
					...entry,
					kind: 'message',
					steamId: l.steamId || null,
					speaker: shownName(l),
					channel: l.channel,
					faction: l.faction,
					body: l.text,
					ping: l.ping
				});
			}
			if (cursor >= read.latestSeq || read.lines.length < CHAT_PAGE) break;
		}
	} catch (err) {
		// Game response bodies can carry player text. Only a fixed status leaves this reader.
		if (err instanceof GameError && err.code === 'rate_limited') throw err;
		state =
			err instanceof GameError && err.code === 'chat_terms_not_accepted' ? 'terms' : 'unavailable';
		delay = 60_000;
	}
	const processStart = startedAt || s.startedAt;
	if (
		!rows.length &&
		cursor === s.cursor &&
		epoch === s.epoch &&
		state === s.state &&
		s.name === server.name &&
		Math.abs(processStart - s.startedAt) < 60_000 &&
		s.lastReadAt &&
		Date.now() - s.lastReadAt.getTime() < 60_000
	)
		return delay;
	await withOwnedTransaction(
		env,
		async (tx) => {
			// An owner can pause collection or a new worker can advance it during the RCON read.
			const claimed = await tx
				.update(sources)
				.set({
					cursor,
					epoch,
					anchor,
					startedAt: processStart,
					state,
					name: server.name,
					...(state === 'ready' ? { lastReadAt: new Date() } : {})
				})
				.where(checkpoint(s))
				.returning({ id: sources.serverId });
			if (claimed.length && rows.length)
				await tx.insert(messages).values(rows).onConflictDoNothing();
		},
		{ period }
	);
	return delay;
}
