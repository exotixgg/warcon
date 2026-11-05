# EXOTIX WARCON deployment

WARCON application code follows official `warcon-app/warcon`. The EXOTIX overlay
contains deployment wiring and operating instructions. Add custom application
features separately after the upstream baseline has been verified.

See [Archived server leaderboards](docs/archived-server-leaderboards.md) for the
EXOTIX archive extension and the retirement registration procedure.

## Branches and environments

| Branch       | Purpose                                                         |
| ------------ | --------------------------------------------------------------- |
| `main`       | Clean mirror of official upstream `main`                        |
| `exotix`     | Reviewed integration branch; default branch for future features |
| `staging`    | Promotion branch for the isolated staging application           |
| `production` | Promotion branch for the production application                 |

Existing Coolify resources:

- Staging: `warcon-staging`, resource `ropbdb0smbr0ja6trzfqeay5`.
- Production: `warcon`, resource `kt53qmh7xfhgimxqpqa0eari`, at
  `https://warcon.exotix.gg`.
- Both use `docker-compose.coolify.yml` with independent generated `SERVICE_*`
  credentials and database volumes. Preserve the existing volumes and secrets.
- Staging follows reviewed `staging` promotions. Production auto-deployment is
  disabled and its commit is pinned to the revision verified on staging.

The `Propose upstream update` workflow maintains the clean mirror and proposes an
upstream merge into `exotix`. It does not promote or deploy an update.

## Upgrade and feature promotion

1. Merge official upstream into a proposal based on `exotix`. Keep custom features
   scoped and resolve conflicts explicitly. Require the existing `test` and
   `docker` checks before merging.
2. Back up staging before its promotion. Create a promotion branch from the current
   `staging`, merge `exotix` into it, and resolve conflicts there. Compare the resulting
   tree with the reviewed integration revision. Open its pull request into `staging`
   and retain the required checks, including the up-to-date branch requirement.
   Verify the deployed commit, web and worker health, sign-in page, and the affected
   read-only application flows.
3. Run integration and smoke suites against fresh disposable databases, never
   the environment's real database. Staging must not contain live RCON targets.
4. Back up production and validate its archive before promotion. Rehearse a
   production-data restore in an isolated database with no worker or live game
   connections; verify row counts and the candidate's migrations.
5. Create a production promotion branch from the current `production` and merge the
   verified `staging` revision into it. Open its pull request into `production` and
   retain the required checks. Its resulting tree must match the tested staging
   revision. This preserves both branches' histories without weakening protection.
6. Set production's Coolify branch to `production` and its commit pin to that
   exact verified staging commit. Queue the production deployment deliberately.
   Keep production auto-deployment disabled.
7. Verify public HTTPS, the deployed image and embedded commit, web/worker health,
   database continuity, existing server connections, and settings. Record the
   deployed revision and the previous revision for rollback.

Application rollback and database recovery are separate operations. Prefer a code
rollback when the schema remains compatible; do not restore the database or drop
old extension tables as routine cleanup. Do not enable new AFK/weather rules or
alter game rotations as part of a code upgrade.

### Specific revisions on the installed Coolify 4.1.2

The regular Compose deployment path replaces the requested commit with the current
branch head, even when `git_commit_sha` is saved. For production promotion, use
Coolify's specific-revision queue path with the tested `commit` and `rollback: true`.
In this installed version that flag preserves the requested code revision; it does
not restore database data. Keep the branch set to `production` and automatic
deployment disabled. Verify the completed deployment record and both running image
tags against the tested staging SHA, rather than trusting the saved commit field.

The existing Compose build context also removes `.git` before the image build, so
WARCON's embedded commit file can be empty. Use the verified deployment/image SHA
as the current provenance record until build-metadata wiring is added separately.

## Backups

The existing root-only host helper is `/usr/local/sbin/exotix-warcon-backup`,
versioned in `scripts/exotix-warcon-backup.sh` with its systemd service and timer.
It creates a custom-format database archive, validates the archive listing, and
keeps the matching environment file without displaying credentials.

- Before upgrading: `exotix-warcon-backup pre-upgrade`.
- Production destination: `/data/warcon-backups/production`, restricted to root.
- Daily timer: 02:15 UTC, 14-day retention; pre-upgrade snapshots are retained.
- Staging backups use a separate `/data/warcon-backups/staging` directory.
- Preserve the original encryption/authentication keys with each backup.

These backups are on the VPS and do not protect against loss of that host.
