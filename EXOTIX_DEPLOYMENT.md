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
