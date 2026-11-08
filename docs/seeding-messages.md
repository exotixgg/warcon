# Seeding messages

The existing **Seeding reward** automation contains an optional **Seeding messages**
section. It shares the reward rule's population thresholds and requires
stay-until-filled crediting. Existing rules remain opt-in. Saving message-enabled
rules requires Chat as well as the existing reserved-slot permission.

- The first card waits for a real faction and the configured delay (default 60 seconds).
  A queued welcome/faction whisper blocks it; actual delivery starts that delay again.
- While the feed reports `PreMatch.WaitingForPlayers`, below the configured round-start
  population (default 20), the pool repeats in order every 5 minutes by default.
- A late joiner during play gets one explanation if the server is still seeding.
  There are no periodic cards during `Playing`, even if population drops below 20.
- Only players whose pending time was credited receive the completion card.
  Loading, post-match and unknown phases suppress cards. Stale queued cards expire.
- The pool accepts up to 20 messages, one per editor line, including JSON strings
  for multiline cards. All messages use the existing 256-character renderer.

For a 50-player credit target, use **at most 49** for earning and **filled at 50**.
Someone who leaves before filling forfeits pending time. This changes neither the
native direct-slot reward requirement nor any external TIX accounting.

| Placeholder | Meaning |
| --- | --- |
| `{seed_session}` | Current connection's credited plus pending time |
| `{seed_pending}` | Current connection's time not yet credited |
| `{seed_season}` | Credited current-official-season time across the organisation |
| `{seed_all}` | Credited all-time time across the organisation |
| `{seed_credited_now}` | Time banked for this completion notice |
| `{seed_target}` | Reward rule's filled population |
| `{round_start_players}` | Configured round-start population for reminders |

Season and all-time totals reuse the leaderboard queries and include archived
servers. Live credit replaces the current session's persisted counter rather than
being counted twice. Displayed rates are editable explanatory text; no TIX balance
is calculated, credited or claimed by this feature.

Migration 0055 adds `player_sessions.pending_seed_seconds`. Pending time is saved
with the existing session heartbeat and loaded on worker restart. Like other live
counters, an abrupt crash can lose the interval since the last heartbeat. Banking
forces a session write in the same transaction as the notification. Closing a
session clears pending time; historical credited totals are unchanged.

Notification timing and rotation are kept in the rule's existing state. Deleting
or editing a rule invalidates queued cards. Dry runs continue to replay native slot
eligibility and explicitly state that live seeding cards are not replayed.
