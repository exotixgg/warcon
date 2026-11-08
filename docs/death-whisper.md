# Death Whisper cards

Use the existing **Server → Automation → Death whisper** rule. A cooldown of
**0 minutes** sends on every recorded death; positive values retain the normal
per-player cooldown. The existing random pool avoids repeating the last choice
when another message fits. The existing delivery expiry remains unchanged.

`{death_summary}` renders `Killed by Player | Weapon | 84m`. Missing details are
omitted, and deaths without another killer begin with `You died`. Names and weapon
labels are kept to 24 UTF-16 units at grapheme boundaries, making the header at
most 76 units. The individual `{killer}`, `{weapon}` and `{distance}` placeholders
retain their existing behaviour.

For a card, start a pool entry with `{death_summary}`, a blank line, then the
heading and text. The existing JSON-string editor supports this as one physical
line, for example:

```json
"{death_summary}\n\nCOMMUNITY\nJoin discord.gg/exotix."
```

A rule accepts up to **100 distinct messages**. Larger pools are rejected rather
than silently truncated. The random rotation and per-player cooldown work the
same way regardless of pool size.

EXOTIX's messages are configured in the rule, not hardcoded in the application.
The expanded pool keeps the existing proportions: seeding 20%, VIP 15%, favourites
10%, other servers 5%, Discord 15%, teammates 10%, reports 10%, website 10% and
feedback 5%. Playful lines and occasional Exi remarks introduce the same practical
calls to action. Future GOLD join announcements are explicitly labelled as planned.

The deployed pool's delivery policy is configured separately: a 10-minute
cooldown and exclusion of active reserved-slot holders. A card's body must fit
in the 178 characters left after the bounded header and blank line.
