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

EXOTIX's initial 20 entries are configured in the rule, not hardcoded in the
application. They cover seeding (4), VIP (3), favourites (3), Discord (3), teammates
(2), reports (2), the website (2), and feedback (1). The initial configuration has
no cooldown, no population minimum, and no reserved-slot or individual exemptions.
All 20 entries fit the 256-character transport budget with the bounded header.
