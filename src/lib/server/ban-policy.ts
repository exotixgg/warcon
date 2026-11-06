// Persistence and write-time checks for the optional structured moderation policy. The pure
// category, duration and template rules live in $lib/ban-policy; this module deliberately keeps
// private case records separate from ordinary list rows and game-server synchronization.
import { eq, sql } from 'drizzle-orm';
import type { DbOrTx } from './db';
import type { Env } from './env';
import { ApiError } from './http';
import { writeAudit } from './audit';
import type { OrgRow, SessionUser } from './access';
import { banCases, orgBanPolicies, organizations } from './db/schema';
import {
	DEFAULT_BAN_POLICY,
	finalizeBanCase,
	prepareBanCase,
	storedBanPolicy,
	validateBanPolicy,
	type BanCase,
	type BanPolicy,
	type BanPolicyView
} from '$lib/ban-policy';

export async function banPolicyOf(db: DbOrTx, orgId: string): Promise<BanPolicyView> {
	const [row] = await db
		.select({ config: orgBanPolicies.config, updatedAt: orgBanPolicies.updatedAt })
		.from(orgBanPolicies)
		.where(eq(orgBanPolicies.orgId, orgId))
		.limit(1);
	return {
		...storedBanPolicy(row?.config ?? DEFAULT_BAN_POLICY),
		version: row?.updatedAt.toISOString() ?? 'default'
	};
}

export async function setBanPolicy(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	value: unknown
): Promise<BanPolicyView> {
	let policy: BanPolicy;
	try {
		policy = validateBanPolicy(value);
	} catch (err) {
		throw new ApiError(400, err instanceof Error ? err.message : 'The ban policy is invalid.');
	}
	await env.db.transaction(async (tx) => {
		await tx.execute(
			sql`SELECT 1 FROM ${organizations} WHERE ${organizations.id} = ${org.id} FOR NO KEY UPDATE`
		);
		await tx
			.insert(orgBanPolicies)
			.values({ orgId: org.id, config: policy, updatedAt: new Date() })
			.onConflictDoUpdate({
				target: orgBanPolicies.orgId,
				set: { config: policy, updatedAt: new Date() }
			});
	});
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'list.ban_policy',
		outcome: 'ok',
		target: org.name,
		message: policy.enabled ? 'Structured ban policy changed' : 'Structured ban policy disabled',
		detail: {
			orgId: org.id,
			enabled: policy.enabled,
			categories: policy.categories.map((category) => ({
				id: category.id,
				announcementEnabled: category.announcementEnabled,
				announcementScope: category.announcementScope,
				announcementMode: category.announcementMode,
				announcementCount: category.announcementMessages.length
			}))
		}
	});
	return banPolicyOf(env.db, org.id);
}

/**
 * Validates a policy ban before its entry is written.  Policy-on deliberately requires a
 * category; this prevents an enabled organisation from accidentally creating an unclassified
 * ban through an older dialog.  Legacy organisations retain their native behaviour untouched.
 */
export function preparedBanCase(
	policy: BanPolicy,
	moderation: unknown,
	facts: { reason: string; scope: 'org' | 'server'; originServerId: string | null }
): Omit<BanCase, 'category' | 'playerMessage'> | null {
	if (!policy.enabled) return null;
	if (moderation === undefined) throw new ApiError(400, 'Choose a ban category.');
	try {
		const prepared = prepareBanCase(policy, moderation, facts);
		if (prepared.categoryId === 'player-review' && facts.scope !== 'org')
			throw new Error('Player Review bans must use the organisation ban list.');
		return prepared;
	} catch (err) {
		throw new ApiError(400, err instanceof Error ? err.message : 'The moderation case is invalid.');
	}
}

export function finalizedBanCase(
	policy: BanPolicy,
	prepared: Omit<BanCase, 'category' | 'playerMessage'>,
	facts: { entryId: string; playerName: string; source: string; expiresAt: Date | null }
): BanCase {
	try {
		return finalizeBanCase(policy, prepared, facts);
	} catch (err) {
		throw new ApiError(400, err instanceof Error ? err.message : 'The moderation case is invalid.');
	}
}

/** Stores a fully rendered case after the list entry has supplied its stable reference id. */
export async function writeBanCase(db: DbOrTx, entryId: string, record: BanCase): Promise<void> {
	await db
		.insert(banCases)
		.values({ entryId, record, updatedAt: new Date() })
		.onConflictDoUpdate({
			target: banCases.entryId,
			set: { record, updatedAt: new Date() }
		});
}

export async function banCaseOf(db: DbOrTx, entryId: string): Promise<BanCase | null> {
	const [row] = await db
		.select({ record: banCases.record })
		.from(banCases)
		.where(eq(banCases.entryId, entryId))
		.limit(1);
	return row?.record ? (row.record as BanCase) : null;
}
