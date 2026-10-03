# EXOTIX deployment

This fork keeps EXOTIX changes reviewable while following the official
[`warcon-app/warcon`](https://github.com/warcon-app/warcon) repository.

## Branches

- `main` is the clean mirror of official Warcon. Do not add EXOTIX changes there.
- `exotix` contains the reviewed EXOTIX overlay and is the default development branch.
- `staging` is deployed to the isolated staging stack after a reviewed promotion PR.
- `production` is deployed to `warcon.wardogs.exotix.gg` after staging verification.

The scheduled `Propose upstream update` workflow fetches official `main`, fast-forwards the
clean mirror, merges it into `sync/upstream`, and opens or updates a pull request against
`exotix`. Upstream changes never deploy directly.

## Deployment boundaries

Coolify uses `docker-compose.coolify.yml`. Its `SERVICE_*` variables generate independent
credentials inside each Coolify resource. Never copy production secrets into Git, staging,
support messages, or issue reports. In particular, never rotate `ENCRYPTION_KEY` after a game
server is added: losing it requires every stored RCON password to be entered again.

Staging and production must use separate Coolify resources, database volumes, domains, and
generated credentials. Neither stack shares the EXOTIX Platform database.

Before production promotion:

1. Merge the upstream/customization pull request only after Warcon CI passes.
2. Promote `exotix` to `staging` through a pull request and verify login, health, worker status,
   a demo-free empty installation, and representative read/write flows against staging only.
3. Back up the production Warcon database with `pg_dump` and validate the archive listing.
4. Promote the exact tested `staging` revision to `production` through a pull request.
5. Deploy production manually in Coolify, verify HTTPS and health, then record the commit.

Application rollback and database restoration are separate decisions. A code rollback may not
be compatible with a schema migration, so keep the pre-deployment dump until the release is
verified.

## Production database backups

The host backup helper is `scripts/exotix-warcon-backup.sh`, installed as
`/usr/local/sbin/exotix-warcon-backup` (root-only). Its systemd service and timer are alongside
the helper in `scripts/`. It resolves the running database by the production Coolify resource
prefix, so deployments may replace containers without invalidating the schedule.

- Daily backup: 02:15 UTC, with persistent catch-up after downtime and 14-day retention.
- Before upgrading: run `exotix-warcon-backup pre-upgrade`; these snapshots are not pruned.
- Destination: `/data/warcon-backups/production`, mode 700; all backup files are mode 600.
- Each snapshot includes a custom-format `pg_dump`, a validated archive listing, SHA-256
  checksums, and the Coolify `.env` file needed to recover encryption/authentication keys.
- Check the schedule and last result with `systemctl list-timers exotix-warcon-backup.timer`
  and `systemctl status exotix-warcon-backup.service`.

These copies are on the same VPS. They protect an application upgrade but do not protect against
loss of the host. No off-host Warcon backup destination has been verified.

A restore rehearsal must use a separate database/container, the same PostgreSQL/TimescaleDB
version, and TimescaleDB's `timescaledb_pre_restore()` / `timescaledb_post_restore()` procedure.
Never point a rehearsal worker at live game servers. Verify archive restoration and row counts,
then apply the pending migrations to that restored copy before production deployment.

## Ban policy module

The EXOTIX module is disabled by default. Organisation owners configure its matrix and appeal
text on the organisation's Bans page. Enabling it requires a category, a configured severity,
a five-digit Discord ticket number and a private internal description on every new manual ban.
The number stays text so leading zeroes survive. The complete player message is validated
against the 200-character limit before saving; internal descriptions are excluded.

The default ordinary sanctions are 7 days, 30 days and permanent. Cheating requires reviewed
conclusive evidence and is permanent. Player review is a permanent restriction marked Pending
review; unbanning resolves the review and preserves its case in ban history. Moderators select
severity using the existing history; the module does not automatically count offenses, send
warnings or add enforcement triggers. Existing automated bans keep their configured duration
and receive a generated `a-0000001` reference plus private rule context.

Structured bans save a snapshot of their category, severity, duration, reference and appeal text.
Later policy edits do not rewrite those messages. Disabling the module restores the legacy form
for new bans and leaves existing structured bans enforced. Existing and imported legacy bans
remain editable using the original reason and expiry controls. Internal descriptions are visible
only through the existing ban-management permissions; they are omitted from player messages,
ordinary audit detail and notification content. Managed policy bans allow editing private notes;
changing a moderation decision requires documenting it in the ticket and lifting or replacing
the ban. Existing automation can still extend an entry's expiry.

Custom storage lives in `exotix.ban_policies` and `exotix.ban_cases`, linked to upstream IDs.
The additive migration has its own checksum-protected `exotix.schema_migrations` ledger and
transactional advisory lock. Never modify a released custom migration or append custom entries
to the upstream Drizzle journal. Add a new numbered migration instead. The migration service
must finish before the web and worker roles start; both check the extension ledger at startup.

Before promotion, follow the backup and restore rehearsal above and include the `exotix` schema
and its case-number sequence in restore verification. Run the policy and permission tests,
verify the form on staging with an isolated test target, and check a worker's outgoing message.
Enable the module only after reviewing the configured matrix. A code rollback preserves the
database rows, but an older upstream build uses its legacy message formatter; disabling this
module in the current build is the preferred way to restore the legacy form while retaining
structured-ban enforcement. Do not drop the custom schema or restore production as a routine
feature rollback.

Name filters, clan-tag filters, Discord role whitelists and player alerts are separate future
modules. This change establishes a small extension boundary; it does not introduce a general
third-party plugin loader. Every future upstream update still requires CI, staging checks and
review of conflicts with the ban creation, permission and enforcement paths.
