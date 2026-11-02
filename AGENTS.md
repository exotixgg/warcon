# WARCON EX

- Respond and write documentation in English unless the user requests another language.
- `main` mirrors `warcon-app/warcon/main`. Keep custom changes on `exotix`.
- Promote reviewed changes through `exotix` -> `staging` -> `production` using pull requests and the required `test` and `docker` checks.
- Keep application code aligned with official WARCON until a custom feature is explicitly requested. The Coolify Compose file, deployment documentation, backup helpers and upstream-sync workflow are the deployment overlay.
- Staging and production are separate Coolify applications, databases, volumes and credentials. See `EXOTIX_DEPLOYMENT.md` for their identifiers and promotion procedure.
- Keep production pinned to the exact commit verified on staging. A production branch merge alone must not deploy it.
- Do not copy production credentials into this repository, staging, logs or reports. Preserve `ENCRYPTION_KEY` and existing authentication secrets across upgrades.
- Run database and integration tests against disposable databases only. Never run `scripts/smoke.sh` against staging or production: it creates users, servers and automation.
- A production-data restore rehearsal runs in an isolated database without an application worker or access to live game servers.
- An application upgrade does not authorize enabling new automation rules or changing game-server settings, maps or rotations.
- Use focused commits for future custom features and retain their checks when merging upstream updates.
