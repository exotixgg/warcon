import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Env } from './env';
import type { OrgRow, ServerRow, SessionUser } from './access';
import { listEntries, lists } from './db/schema';
import { ApiError, newId } from './http';
import { parseExpiry, orgServerRefs, standings } from './lists';
import { memberSlots } from './lists-sync';
import { requireSteamId } from './steam';
import { gateway } from './gateway';
import { writeAudit } from './audit';

const conflict = () =>
	new ApiError(409, 'Reservation ownership or expiry changed.', 'reservation_conflict');
const markerPattern = /^EXOTIX VIP [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const orgList = (orgId: string) =>
	and(
		eq(lists.orgId, orgId),
		eq(lists.kind, 'reserve'),
		eq(lists.isDefault, true),
		isNull(lists.serverId),
		isNull(lists.archivedAt)
	);

/** Exact scope row: organisation coverage must never hide a legacy server row during retirement. */
export async function reservationView(
	env: Env,
	org: OrgRow,
	actor: SessionUser,
	steamIdIn: unknown,
	server?: ServerRow
) {
	const steamId = requireSteamId(steamIdIn);
	const [list] = await env.db
		.select()
		.from(lists)
		.where(
			server
				? and(eq(lists.orgId, org.id), eq(lists.serverId, server.id), eq(lists.kind, 'reserve'))
				: orgList(org.id)
		)
		.limit(1);
	const [row] = list
		? await env.db
				.select()
				.from(listEntries)
				.where(
					and(
						eq(listEntries.listId, list.id),
						eq(listEntries.steamId, steamId),
						isNull(listEntries.removedAt)
					)
				)
				.limit(1)
		: [];
	const active = row && (!row.expiresAt || row.expiresAt.getTime() > Date.now()) ? row : null;
	const member =
		!server &&
		!active &&
		org.membersReserved &&
		(await memberSlots(env, org.id)).some((m) => m.steamId === steamId);
	if (!active && !member) return null;
	const refs = server ? [{ id: server.id, name: server.name }] : await orgServerRefs(env, org.id);
	const state = await standings(
		env,
		'reserve',
		refs.map((s) => s.id),
		[steamId]
	);
	return {
		steamId,
		reason: active?.reason ?? 'member',
		expiresAt: active?.expiresAt?.toISOString() ?? null,
		owned: !!active && active.addedBy === actor.id,
		member: !!member,
		scope: server ? 'server' : 'org',
		servers: refs.map((s) => ({
			id: s.id,
			state: state.get(s.id)?.get(steamId)?.state ?? 'pending'
		}))
	};
}

/** Only creates/renews/removes the caller's finite marker on the default organisation list. */
export async function mutateOwnedOrgReservation(
	env: Env,
	req: Request,
	org: OrgRow,
	actor: SessionUser,
	steamIdIn: unknown,
	body: Record<string, unknown>,
	create: boolean
) {
	const steamId = requireSteamId(steamIdIn),
		marker = body.expectedMarker;
	const remove = !create && body.remove === true;
	const allowed = create
		? ['expectedMarker', 'expiresAt']
		: remove
			? ['expectedMarker', 'expectedExpiresAt', 'remove']
			: ['expectedMarker', 'expectedExpiresAt', 'expiresAt'];
	if (
		Object.keys(body).some((k) => !allowed.includes(k)) ||
		typeof marker !== 'string' ||
		!markerPattern.test(marker)
	)
		throw new ApiError(
			400,
			'An exact EXOTIX VIP marker and finite ownership preconditions are required.'
		);
	const expected =
		!create && typeof body.expectedExpiresAt === 'string' ? new Date(body.expectedExpiresAt) : null;
	if (
		!create &&
		(!expected ||
			!Number.isFinite(expected.getTime()) ||
			expected.toISOString() !== body.expectedExpiresAt)
	)
		throw new ApiError(400, 'A canonical finite expectedExpiresAt is required.');
	const expiry = remove ? null : parseExpiry(body.expiresAt);
	if (
		!remove &&
		(!expiry ||
			expiry.toISOString() !== body.expiresAt ||
			(expected && expiry.getTime() < expected.getTime()))
	)
		throw new ApiError(
			400,
			'A canonical finite expiry at least as late as expectedExpiresAt is required.'
		);
	const result = await env.db.transaction(async (tx) => {
		const [list] = await tx.select().from(lists).where(orgList(org.id)).limit(1).for('update');
		if (!list) throw conflict();
		const [row] = await tx
			.select()
			.from(listEntries)
			.where(
				and(
					eq(listEntries.listId, list.id),
					eq(listEntries.steamId, steamId),
					isNull(listEntries.removedAt)
				)
			)
			.limit(1)
			.for('update');
		if (!remove) parseExpiry(body.expiresAt); // Revalidate after waiting on locks.
		if (create && !row) {
			// Membership coverage is independent; never turn a member slot into an owned finite row.
			if (
				org.membersReserved &&
				(await memberSlots(env, org.id)).some((m) => m.steamId === steamId)
			)
				throw conflict();
			const id = newId();
			await tx.insert(listEntries).values({
				id,
				listId: list.id,
				steamId,
				reason: marker,
				expiresAt: expiry,
				addedBy: actor.id,
				addedByName: actor.username
			});
			await tx.update(lists).set({ updatedAt: new Date() }).where(eq(lists.id, list.id));
			return { changed: true, entryId: id };
		}
		if (!row) {
			if (!remove) throw conflict();
			const [tombstone] = await tx
				.select()
				.from(listEntries)
				.where(
					and(
						eq(listEntries.listId, list.id),
						eq(listEntries.steamId, steamId),
						eq(listEntries.reason, marker),
						eq(listEntries.addedBy, actor.id),
						eq(listEntries.removedBy, actor.id),
						eq(listEntries.expiresAt, expected!),
						eq(listEntries.removal, 'manual')
					)
				)
				.orderBy(desc(listEntries.removedAt))
				.limit(1);
			if (!tombstone?.removedAt) throw conflict();
			return { changed: false, entryId: tombstone.id };
		}
		if (row.reason !== marker || row.addedBy !== actor.id || !row.expiresAt) throw conflict();
		if (
			!remove &&
			row.expiresAt.getTime() === expiry!.getTime() &&
			row.expiresAt.getTime() > Date.now()
		)
			return { changed: false, entryId: row.id };
		if (
			create ||
			row.expiresAt.getTime() !== expected!.getTime() ||
			(!remove && row.expiresAt.getTime() <= Date.now())
		)
			throw conflict();
		await tx
			.update(listEntries)
			.set(
				remove
					? {
							removedAt: new Date(),
							removedBy: actor.id,
							removedByName: actor.username,
							removal: 'manual'
						}
					: { expiresAt: expiry }
			)
			.where(
				and(
					eq(listEntries.id, row.id),
					eq(listEntries.reason, marker),
					eq(listEntries.addedBy, actor.id),
					eq(listEntries.expiresAt, expected!),
					isNull(listEntries.removedAt)
				)
			);
		await tx.update(lists).set({ updatedAt: new Date() }).where(eq(lists.id, list.id));
		return { changed: true, entryId: row.id };
	});
	if (result.changed)
		await writeAudit(env, req, {
			actor,
			orgId: org.id,
			category: 'org',
			action: remove ? 'list.owned_remove' : create ? 'list.owned_add' : 'list.renew',
			target: steamId,
			outcome: 'ok',
			message: 'Updated an attributed EXOTIX organisation reservation.',
			detail: {
				entryId: result.entryId,
				expectedExpiresAt: expected?.toISOString(),
				expiresAt: expiry?.toISOString()
			}
		});
	// Sync attempts are repeatable after a lost reply; the org list owns future-server propagation.
	await gateway().syncOrg(env, org);
	return {
		changed: result.changed,
		removed: remove,
		entry: { steamId, reason: marker, expiresAt: (remove ? expected : expiry)!.toISOString() }
	};
}
