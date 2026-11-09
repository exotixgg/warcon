# Death Whisper cards

Use the existing **Server → Automation → Death whisper** rule. A cooldown of
**0 minutes** sends on every recorded death; positive values retain the normal
per-player cooldown. Each random pool avoids repeating its own last choice when
another message fits. The existing 30-second delivery expiry remains unchanged.

The editor has two explicit pools: **Normal deaths** (`messages`) and optional
**Team-kill reports** (`teamKillMessages`). A victim whose kill-feed event has
`teamKill: true` receives only the report pool. An absent or empty report pool
skips the whisper, including for rules saved before this field existed; it never
falls back to normal promotional text. The feed's flag determines this, not
current faction names, message wording or message positions. Suicides and
unattributed deaths do not qualify as team kills; their normal-death behaviour
remains unchanged.

Both pools share one per-player cooldown, minimum-player count, reserved-slot
exemption and explicit exemption list. A report does not bypass a cooldown
started by an ordinary card, or vice versa. Skipping an empty report pool starts
no cooldown. No configuration migration changes these settings automatically.

`{death_summary}` renders `Killed by Player | Weapon | 84m`. Missing details are
omitted; team kills begin with `Team-killed by Player`, and deaths without another
killer begin with `You died`. Names and weapon labels are kept to 24 UTF-16 units
at grapheme boundaries, making the header at most 76 units for normal deaths or
81 for team kills. The individual `{killer}`, `{weapon}` and `{distance}`
placeholders retain their existing behaviour.

For a card, start a pool entry with `{death_summary}`, a blank line, then the
heading and text. The existing JSON-string editor supports this as one physical
line, for example:

```json
"{death_summary}\n\nCOMMUNITY\nJoin discord.gg/exotix."
```

A rule accepts up to **100 distinct messages in each pool**. Larger pools are
rejected rather than silently truncated. The random rotation and per-player
cooldown work the same way regardless of pool size.

Example report-only entries (one JSON string per editor line):

```json
"{death_summary}\n\nREPORT\nTeam kill? Accidents happen. If it was intentional or repeated, report it at discord.gg/exotix."
"{death_summary}\n\nNEED HELP?\nRepeated or intentional team kills? Share the details with staff at discord.gg/exotix."
```

Both pools support the same placeholders, JSON-escaped multiline entries and
256-unit rendered-message limit. Reserve at most 173 units for a body following
the longest team-kill header and blank line (178 for a normal header).

When a batch contains several deaths for one victim, only their latest event
in game order supplies the pool, killer, weapon and distance. Replayed feed
events do not create duplicate whispers. Last choices for both pools and the
shared cooldown recover from the rule's outbox after a worker restart.

Queued cards are checked against the enabled rule and its settings immediately
before delivery. Disabling/deleting the rule or editing either pool, the cooldown
or exemptions invalidates unsent cards. Old queued cards without this guard are
also skipped on upgrade. A rename with identical settings keeps queued cards.
If a later team kill arrives while an ordinary card is delayed, that ordinary
card is dropped, including after a restart or after it was claimed for delivery.
There is no automatic replacement: the shared cooldown may prevent a report,
and an empty report pool still means silence. This prevents a delayed promotion
from landing on a later team-kill death without adding another message queue.

EXOTIX's messages are configured in the rule, not hardcoded in the application.
The expanded pool keeps the existing proportions: seeding 20%, VIP 15%, favourites
10%, other servers 5%, Discord 15%, teammates 10%, reports 10%, website 10% and
feedback 5%. Playful lines and occasional Exi remarks introduce the same practical
calls to action. VIP III promotions include custom join announcements; implementing
that separate automation is outside this pool-capacity change.

EXOTIX's delivery policy is configured separately: a 10-minute cooldown and
exclusion of active reserved-slot holders.
