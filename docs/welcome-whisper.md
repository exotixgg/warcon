# Welcome whisper

Use **Server → Automation → Welcome whisper**. Enable **Wait until the player has
picked a faction** and leave **Only on a player's first visit** off to greet each
new session. Later faction switches do not repeat the welcome. WARCON's existing
presence grace period still applies to quick reconnects.

`{welcome_card}` renders the compact EXOTIX card using the current official season
across the organisation, including archived server history. Rank follows the
leaderboard's kills ranking and minimum playtime. The card includes personal
kills/deaths, K/D, playtime/seeding time, a rival, and the kills, cash, playtime and
seeding leaders. Rival means the opponent who killed this player most in the
season; team kills and suicides are excluded. The rival line includes `12K/18D`:
the receiving player's kills against that rival and deaths to them, across the
organisation in the current season. Custom messages can use
`{season_rival_kills}` and `{season_rival_deaths}` alongside `{season_rival}`.

The editor lists individual `season_*` and `leader_*` placeholders for custom
wording. Existing `{kills}` and `{org_kills}` retain their all-time meanings.
The preset shortens names at grapheme boundaries and can omit the rival to fit
the game's 256-character limit. Custom templates retain WARCON's existing final
length limit. Leaders are cached for up to one minute. Dry runs show the trigger
timing without exposing personalised organisation-wide statistics to staff who
only have server access.

Every automation message field also accepts a JSON-quoted string:

```json
"Welcome {name}\nEnjoy the server!"
```

Message pools still use one physical line per message; put escaped `\n` inside a
JSON-quoted line to make that one message multiline. Saved multiline entries
reopen in this form. Plain text and ordinary literal backslashes remain supported.
