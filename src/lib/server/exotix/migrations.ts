// Separate immutable migration ledger: never append EXOTIX migrations to upstream's journal.
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Db } from '../db';
const migrations = [
	{
		id: '001_ban_policy',
		statements: [
			`CREATE TABLE exotix.ban_policies (org_id text PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE, config jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
			`CREATE SEQUENCE exotix.ban_case_number MAXVALUE 9999999 NO CYCLE`,
			`CREATE TABLE exotix.ban_cases (entry_id text PRIMARY KEY REFERENCES public.list_entries(id) ON DELETE CASCADE, record jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`
		]
	},
	{
		id: '002_message_pools',
		statements: [
			`CREATE TABLE exotix.message_pool_configs (org_id text PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE, config jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
			`CREATE TABLE exotix.message_pool_state (org_id text NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE, server_id text NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE, pool_id text NOT NULL, cursor integer NOT NULL DEFAULT 0, last_index integer NOT NULL DEFAULT -1, last_at timestamptz, PRIMARY KEY (org_id, server_id, pool_id))`
		]
	},
	{
		id: '003_weapon_rule_tests',
		statements: [
			`CREATE TABLE exotix.weapon_rule_tests (org_id text NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE, pool_id text NOT NULL, steam_id text NOT NULL, config_key text NOT NULL, count integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (org_id, pool_id, steam_id))`
		]
	}
];
export async function pendingExotixMigrations(db: Db): Promise<number> {
	const [exists] = await db.execute<{ ledger: string | null }>(
		sql`SELECT to_regclass('exotix.schema_migrations')::text AS ledger`
	);
	if (!exists?.ledger) return migrations.length;
	const applied = await db.execute<{ id: string; checksum: string }>(
		sql`SELECT id, checksum FROM exotix.schema_migrations`
	);
	for (const m of migrations) {
		const row = applied.find((r) => r.id === m.id);
		if (
			row &&
			row.checksum !== createHash('sha256').update(JSON.stringify(m.statements)).digest('hex')
		)
			throw new Error(`EXOTIX migration changed: ${m.id}`);
	}
	return migrations.filter((m) => !applied.some((r) => r.id === m.id)).length;
}
export async function runExotixMigrations(db: Db): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(179087, 1)`);
		await tx.execute(sql`CREATE SCHEMA IF NOT EXISTS exotix`);
		await tx.execute(
			sql`CREATE TABLE IF NOT EXISTS exotix.schema_migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`
		);
		for (const m of migrations) {
			const checksum = createHash('sha256').update(JSON.stringify(m.statements)).digest('hex');
			const [applied] = await tx.execute<{ checksum: string }>(
				sql`SELECT checksum FROM exotix.schema_migrations WHERE id = ${m.id}`
			);
			if (applied) {
				if (applied.checksum !== checksum) throw new Error(`EXOTIX migration changed: ${m.id}`);
				continue;
			}
			for (const statement of m.statements) await tx.execute(sql.raw(statement));
			await tx.execute(
				sql`INSERT INTO exotix.schema_migrations (id, checksum) VALUES (${m.id}, ${checksum})`
			);
		}
	});
}
