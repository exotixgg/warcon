# Map and weather placeholders

These use the existing **Server** placeholder group in every automation message editor.

| Placeholder | Value |
| --- | --- |
| `{map}` | Existing current map, using WARCON's display names |
| `{weather}` | Current live lighting/weather preset, e.g. `Day Late Rain` |
| `{current_weather}` | Alias for `{weather}` |
| `{next_map}` | The explicit next rotation entry, e.g. `Ozeti` |
| `{next_weather}` | That entry's starting lighting/weather, e.g. `Day Early Clear` |

Example: `Now: {map} · {weather}\nNext: {next_map} · {next_weather}`.
Use the existing JSON-string message input for actual multiline cards.

Current weather comes from `/v1/status`, including manual weather changes. Upcoming
values use `/v1/rotation` and its explicit `next` marker, checked against the status
rotation pointers and current map. Repeated maps retain their distinct weather.
Random rotation is supported when the server explicitly identifies its next entry.
No entry is guessed from ordering, map names or the configuration file.

The worker reads rotation only when an enabled rule's message needs it, caching for
up to 30 seconds. A changed map/pointer, an observation failure, or a requested
refresh after a command invalidates that snapshot. Failure of this optional read
does not stop normal observations. Missing, stale, disabled, denied or inconsistent
rotation data renders `…`; missing weather does too. Dry runs show `…` for these
values unless the replay supplies them explicitly.

`next_weather` describes the next map's initial preset, not the Weather cycle rule's
next change during the current match. All values are relative to the live current
match when the message is rendered. A later round-end card must capture the intended
match boundary explicitly; these placeholders do not change existing match broadcasts.

No schema change, new automation rule, map/rotation edit or message activation is required.
