import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { ApiError } from '../http';
import {
	DEFAULT_BAN_POLICY,
	manualBanCase,
	banCaseMessage,
	validateBanPolicy,
	type BanCaseView,
	type BanPolicyView
} from '$lib/exotix/ban-policy';
export async function policyOf(db: DbOrTx, orgId: string): Promise<BanPolicyView> {
	const [row] = await db.execute<{ config: unknown; version: string }>(
		sql`SELECT config, updated_at::text AS version FROM exotix.ban_policies WHERE org_id = ${orgId}`
	);
	return row
		? { ...validateBanPolicy(row.config), version: row.version }
		: { ...structuredClone(DEFAULT_BAN_POLICY), version: 'default' };
}
export async function savePolicy(db: DbOrTx, orgId: string, raw: unknown): Promise<BanPolicyView> {
	let policy;
	try {
		policy = validateBanPolicy(raw);
	} catch (e) {
		throw new ApiError(400, (e as Error).message);
	}
	await db.execute(
		sql`INSERT INTO exotix.ban_policies (org_id, config) VALUES (${orgId}, ${JSON.stringify(policy)}::text::jsonb) ON CONFLICT (org_id) DO UPDATE SET config = excluded.config, updated_at = clock_timestamp()`
	);
	return policyOf(db, orgId);
}
export async function prepareManualBan(db: DbOrTx, orgId: string, body: Record<string, unknown>) {
	const policy = await policyOf(db, orgId);
	if (!policy.enabled) return null;
	try {
		return manualBanCase(policy, (body.moderation ?? {}) as Record<string, unknown>);
	} catch (e) {
		throw new ApiError(400, (e as Error).message);
	}
}
export async function caseOf(db: DbOrTx, entryId: string): Promise<BanCaseView | null> {
	const [row] = await db.execute<{ record: BanCaseView }>(
		sql`SELECT record FROM exotix.ban_cases WHERE entry_id = ${entryId}`
	);
	return row?.record ?? null;
}
export async function casesOf(db: DbOrTx, ids: string[]): Promise<Map<string, BanCaseView>> {
	if (!ids.length) return new Map();
	const rows = await db.execute<{ entry_id: string; record: BanCaseView }>(
		sql`SELECT entry_id, record FROM exotix.ban_cases WHERE entry_id IN (${sql.join(
			ids.map((id) => sql`${id}`),
			sql`, `
		)})`
	);
	return new Map(rows.map((r) => [r.entry_id, r.record]));
}
export async function writeCase(db: DbOrTx, entryId: string, record: BanCaseView): Promise<void> {
	await db.execute(
		sql`INSERT INTO exotix.ban_cases (entry_id, record) VALUES (${entryId}, ${JSON.stringify(record)}::text::jsonb) ON CONFLICT (entry_id) DO UPDATE SET record = excluded.record, updated_at = now()`
	);
}
export async function automaticCase(
	db: DbOrTx,
	orgId: string,
	reason: string,
	days: number,
	rule: string
): Promise<BanCaseView | null> {
	const policy = await policyOf(db, orgId);
	if (!policy.enabled) return null;
	const [n] = await db.execute<{ number: string }>(
		sql`SELECT nextval('exotix.ban_case_number')::text AS number`
	);
	const reference = `a-${n.number.padStart(7, '0')}`;
	// Existing rules retain their configured duration; this adds attribution, not a new trigger.
	const category =
		policy.categories.find((c) => c.id === 'rule-violation')?.label ?? 'Rule violation';
	return {
		policyVersion: policy.version,
		source: 'automated',
		reference,
		categoryId: 'rule-violation',
		category,
		severity: 'Configured automation',
		days,
		presetDays: days,
		appealText: policy.appealText,
		messageTemplate: policy.messageTemplate,
		description: `Automated ban. Source: ${rule}. Rule reason: ${reason}. Duration: ${days ? `${days} days` : 'permanent'}. Review the trigger and audit history for evidence.`,
		message: banCaseMessage(category, days, reference, policy.appealText, policy.messageTemplate)
	};
}
export async function resolveReview(db: DbOrTx, entryId: string): Promise<void> {
	await db.execute(
		sql`UPDATE exotix.ban_cases SET record = jsonb_set(record, '{reviewStatus}', '"resolved"'::jsonb), updated_at = now() WHERE entry_id = ${entryId} AND record->>'reviewStatus' = 'pending'`
	);
}
export async function changeDescription(
	db: DbOrTx,
	entryId: string,
	value: unknown
): Promise<void> {
	if (typeof value !== 'string' || !value.trim() || value.trim().length > 10000)
		throw new ApiError(400, 'Internal description is required (maximum 10000 characters).');
	await db.execute(
		sql`UPDATE exotix.ban_cases SET record = jsonb_set(record, '{description}', ${JSON.stringify(value.trim())}::text::jsonb), updated_at = now() WHERE entry_id = ${entryId}`
	);
}
export async function refreshCaseDuration(
	db: DbOrTx,
	entryId: string,
	expiresAt: Date | null,
	rule: string,
	reason: string
): Promise<void> {
	const c = await caseOf(db, entryId);
	if (!c) return;
	// The extension starts now; do not round a few elapsed milliseconds into an extra day.
	c.days = expiresAt ? Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 86400000)) : 0;
	c.extensions = [
		...(c.extensions ?? []),
		{ at: new Date().toISOString(), rule, reason, expiresAt: expiresAt?.toISOString() ?? null }
	];
	c.message = banCaseMessage(c.category, c.days, c.reference, c.appealText, c.messageTemplate);
	await writeCase(db, entryId, c);
}
