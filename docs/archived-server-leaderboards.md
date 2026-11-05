# Archived server leaderboards

Stock WARCON at [e40fd65](https://github.com/warcon-app/warcon/tree/e40fd657312c6aae6d735d5d552ae40447f91395) selects existing server records for its [panel](https://github.com/warcon-app/warcon/blob/e40fd657312c6aae6d735d5d552ae40447f91395/src/routes/api/servers/%5Bid%5D/leaderboard/%2Bserver.ts) and [public](https://github.com/warcon-app/warcon/blob/e40fd657312c6aae6d735d5d552ae40447f91395/src/routes/api/public/servers/%5Bid%5D/leaderboard/%2Bserver.ts) organisation boards. Deleting a server leaves its stored player history outside those boards. Stock WARCON has no archive switch at that revision.

EXOTIX adds a separate archive registry keyed by the original WARCON server ID. A history appears with a label such as **EXOTIX-EU-01 (retired 2026-10-23)**. A replacement that reuses the same name keeps its own ID and history. Archive entries contain only the ID, owning organisation, original name, retirement date and publication flag. Live polling and controls use the live server registry.

- Organisation boards and their CSV exports include registered archives for site and organisation owners. The organisation portion of player careers uses the same scope. Accounts with individual server grants and API keys retain their live-server scope.
- Public organisation boards and careers include an archive only when it is explicitly published and the organisation allows public leaderboards. Open them from an existing live server with its public leaderboard enabled.
- **This server** reads only the selected live server. Select **Organisation** and **All time** to see the full published history, and sort by **Seed time** to see stored seeding credit. The chosen time range and minimum playtime still apply.

## Register a retirement

For a host or credential change that should continue the same history, edit the existing live server entry so its ID survives. For a genuine replacement, record the old ID, organisation, name and retirement date, then register the replacement separately.

After migration 0053, a database operator can register a retired ID in the `archived_servers` table. Use a verified backup and rehearse the transaction on an isolated restore without a worker or live RCON access. Confirm ownership from the successful create and delete audit records, confirm that player history exists and that all of its sessions are closed, and confirm the ID is absent from `servers`. Use the audit date in the organisation's local timezone. Insert the original `id`, `org_id`, `name` and `retired_on`. Require any existing registration to match that identity on reruns. Set `public_leaderboards` to `true` only for approved public histories. It defaults to `false` and can be set back to `false` to withdraw that history from public views.

Leaderboards read the existing session and leaderboard rollups under the old ID. Registration only records archive metadata. Verify the archive labels and compare organisation and single-server results after publishing. Follow the [EXOTIX deployment procedure](../EXOTIX_DEPLOYMENT.md) for code promotions.
