# Structured ban policy

An optional organisation policy extends WARCON's existing ban lists, shared Ban/Edit Ban
dialogs, list synchronization and delivery outbox. Owners configure it in the collapsed
**Moderation settings** panel at the bottom of **Ban List**. Player messages and announcement
pools stay together there. Legacy Quick Reasons and Ban Message settings appear inside that
panel only while the structured policy is disabled.
It starts disabled: deploying this feature does not enable announcements or change existing bans.

| Category | Durations | Default announcement |
| --- | --- | --- |
| Rule Violation | 1, 3, 7, 30 days; permanent | Origin server |
| Griefing | 1, 3, 7, 30 days; permanent | Origin server |
| Abusive Conduct | 1, 3, 7, 30 days; permanent | Origin server |
| Cheating | Permanent | Every server in the organisation |
| Player Review | Permanent, until staff lift it | Origin server only |

Player Review always uses the organisation ban list. Other categories retain WARCON's existing
choice between a server's own list and the organisation list, subject to the moderator's permissions.
Announcement scope is separate from ban scope. Player Review's announcement scope is fixed to
the origin; owners can switch announcements off and configure the other categories' destinations.

Every new managed manual ban requires a category while the policy is enabled. An optional
five-digit ticket keeps leading zeroes and displays as `t-01234`. The category supplies the public
reason; there is no separate public-reason field. Private notes use a full-width textarea below
the player-message preview. Only
staff with ban-management access receive case notes. Notes are excluded from game messages,
announcements, generic list responses, audit details and webhooks.

The shared form is used from organisation and server ban lists, online/past player lists and
player dossiers. Organisation-level forms offer an originating-server selector. Without an
origin, a local announcement is not sent; the form explains this before submission.

## Messages

Each category has an editable player-message template and an announcement pool of up to 20
lines, selected in order or randomly. Starter text is provided for review, not a finalized
community policy. Player Review text describes an access restriction while staff review it.

Available placeholders: `{category}`, `{reason}`, `{duration}`, `{expires}`, `{reference}`,
`{ticket_id}`, `{name}` / `{player}`, and `{source}` / `{server}` / `{event_server}`.
The server placeholders refer to the originating server, not each broadcast destination.
`{reference}` uses `t-01234` for a ticket or the existing WARCON ban reference when unticketed.
There is no private-note placeholder.

Player text is limited to 200 characters and broadcast text to 256 after expansion. The player
message is stored with the case and used when the panel removes a banned player, including on
later joins. An overlong public announcement is recorded as skipped; it does not undo the ban.

The ban, case and delivery intents are committed together. One announcement line is chosen per
ban and reused for all destinations. Existing outbox deduplication prevents duplicate intents;
uncertain game responses follow WARCON's no-automatic-retry behavior. Announcements expire after
two minutes and skip empty servers. Revoked/expired bans or changed public case/policy settings
invalidate pending delivery. Edits do not create another announcement.

## Compatibility and edits

Existing/imported bans and automated rule bans remain native WARCON entries. Import is adoption
of existing game bans, not a new moderated case. Direct/raw RCON remains a privileged game-command
interface; it does not create a managed case. This policy is not an access-control replacement
for those capabilities.

Categorized edits retain their fixed duration choices even if the policy is later disabled.
Changing notes, ticket or wording preserves the original expiry, author and creation date.
Choosing a different duration starts that duration from the edit time. Legacy entries keep their
existing editor. Disabling the policy stops pending announcements but preserves existing cases
and their player-message snapshots.

Migration `0054_ban_policy.sql` adds separate organisation-policy and case tables. It does not
rewrite historical entries. Tests use disposable databases; development previews use only the
built-in demo game server.
