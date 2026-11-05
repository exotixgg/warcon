// Category announcements use the same durable outbox and per-server delivery lane as automation.
// One chosen message belongs to the ban, even when it is delivered to several servers.
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { announcementFor, type BanCase, type BanPolicy } from '$lib/ban-policy';
import type { DbOrTx, Tx } from './db';
import {
	banCases,
	listEntries,
	lists,
	orgBanPolicies,
	outbox,
	playerSessions,
	servers,
	type OutboxRow
} from './db/schema';
import { storable, storableText } from './db/storable';
import { storedBanPolicy } from '$lib/ban-policy';

export const BAN_ANNOUNCEMENT = 'ban_announcement';
export const BAN_ANNOUNCEMENT_MAX_AGE_MS = 2 * 60_000;

// Private notes never enter the outbox; only fields which affect the public line invalidate it.
const publicCase = (record: BanCase, expiresAt: Date | null): string =>
	JSON.stringify({
		categoryId: record.categoryId,
		reason: record.reason,
		days: record.days,
		ticketId: record.ticketId,
		originServerId: record.originServerId,
		expiresAt: expiresAt?.toISOString() ?? null
	});

export interface BanAnnouncementEvent {
	orgId: string;
	entryId: string;
	steamId: string;
	expiresAt: Date | null;
	policy: BanPolicy;
	banCase: BanCase;
	source: { id: string; name: string } | null;
	/** A known player name, when the caller has already looked it up. */
	name?: string;
}

/** Called inside the transaction that creates the ban and its case. */
export async function enqueueBanAnnouncements(tx: Tx, event: BanAnnouncementEvent): Promise<void> {
	const config = event.policy.categories.find((c) => c.id === event.banCase.categoryId);
	if (!event.policy.enabled || !config?.announcementEnabled) return;
	if (config.announcementScope === 'origin' && !event.source) return;
	const destinations = await tx
		.select({ id: servers.id })
		.from(servers)
		.where(
			and(
				eq(servers.orgId, event.orgId),
				config.announcementScope === 'origin' ? eq(servers.id, event.source!.id) : undefined
			)
		);
	if (!destinations.length) return;

	// Serialise the ordered pool across this organisation, including bans on different lists.
	await tx.execute(
		sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ban-announcements:${event.orgId}:${config.id}`}, 0))`
	);
	const [count] = await tx.execute<{ n: string }>(sql`
		SELECT COUNT(DISTINCT o.params->>'entryId') AS n FROM ${outbox} o
		JOIN ${servers} s ON s.id = o.server_id
		WHERE s.org_id = ${event.orgId} AND o.trigger_kind = ${BAN_ANNOUNCEMENT}
		AND o.params->>'categoryId' = ${config.id}
		AND o.params->>'entryId' <> ${event.entryId}`);
	let name = event.name;
	if (!name) {
		const [last] = await tx
			.select({ name: playerSessions.name })
			.from(playerSessions)
			.innerJoin(servers, eq(servers.id, playerSessions.serverId))
			.where(and(eq(servers.orgId, event.orgId), eq(playerSessions.steamId, event.steamId)))
			.orderBy(desc(playerSessions.lastSeen))
			.limit(1);
		name = last?.name || event.steamId;
	}
	let message = '';
	let error = '';
	try {
		message =
			announcementFor(
				event.policy,
				config.id,
				{
					category: event.banCase.category,
					reason: event.banCase.reason,
					days: event.banCase.days,
					ticketId: event.banCase.ticketId,
					entryId: event.entryId,
					expiresAt: event.expiresAt,
					playerName: name,
					source: event.source?.name || 'Moderation'
				},
				Number(count?.n ?? 0)
			) ?? '';
	} catch (err) {
		// Invalid expanded text is visible in Recent actions without undoing a valid ban.
		error = err instanceof Error ? err.message : 'The ban announcement could not be formatted.';
	}
	if (!message && !error) return;
	await tx
		.insert(outbox)
		.values(
			destinations.map((server) => ({
				serverId: server.id,
				triggerId: null,
				triggerName: `${event.banCase.category} announcement`,
				triggerKind: BAN_ANNOUNCEMENT,
				action: 'broadcast',
				params: storable({
					message,
					entryId: event.entryId,
					categoryId: config.id,
					settings: JSON.stringify(config),
					case: publicCase(event.banCase, event.expiresAt)
				}),
				target: storableText(name!),
				detail: {
					entryId: event.entryId,
					categoryId: config.id,
					originServerId: event.source?.id ?? null
				},
				steamId: null,
				okMessage: 'Ban announcement sent.',
				dedupeKey: `ban-announcement:${event.entryId}:${server.id}`,
				...(error ? { state: 'skipped', outcome: error.slice(0, 300), doneAt: new Date() } : {})
			}))
		)
		.onConflictDoNothing({ target: outbox.dedupeKey });
}

/** The case must still be active and its owner-approved announcement settings still match. */
export async function banAnnouncementStillHolds(db: DbOrTx, row: OutboxRow): Promise<boolean> {
	const params = row.params as {
		entryId?: string;
		categoryId?: string;
		settings?: string;
		case?: string;
	} | null;
	if (!params?.entryId || !params.categoryId || !params.settings) return false;
	const [current] = await db
		.select({
			record: banCases.record,
			config: orgBanPolicies.config,
			expiresAt: listEntries.expiresAt
		})
		.from(listEntries)
		.innerJoin(banCases, eq(banCases.entryId, listEntries.id))
		.innerJoin(lists, eq(lists.id, listEntries.listId))
		.innerJoin(orgBanPolicies, eq(orgBanPolicies.orgId, lists.orgId))
		.innerJoin(servers, and(eq(servers.orgId, lists.orgId), eq(servers.id, row.serverId)))
		.where(
			and(eq(listEntries.id, params.entryId), eq(lists.kind, 'ban'), isNull(listEntries.removedAt))
		)
		.limit(1);
	if (!current || (current.expiresAt && current.expiresAt.getTime() <= Date.now())) return false;
	const policy = storedBanPolicy(current.config);
	const category = policy.categories.find((c) => c.id === params.categoryId);
	const record = current.record as BanCase;
	return (
		policy.enabled &&
		!!category?.announcementEnabled &&
		record.categoryId === params.categoryId &&
		JSON.stringify(category) === params.settings &&
		publicCase(record, current.expiresAt) === params.case
	);
}
