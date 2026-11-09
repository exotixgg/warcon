# Private MATCH STATS card

Automation offers **Match stats whisper**, with the preset `{match_card}` and a default five-second delay. Creating a rule does not enable it automatically. It requires the match feed and the Chat capability. The delay is the earliest eligible observation; native outbox delivery serializes recipients through the server lane.

Only a newly confirmed `match_ended` event captures a card opportunity. A fresh player observation after the delay supplies final scoreboard counters while the feed still reports `MatchState.PostMatch`. Startup, recovery and a status/map boundary alone do not create cards. A card is addressed only to participants observed at confirmation and still connected at evaluation and delivery, including reserved-slot/VIP players.

The snapshot reads this server's open match and its persisted player rows, including leavers, then overlays the latest observed tallies. It never closes the match or writes player rows early. Rank uses competition ranking by kills (1, 1, 3); leader ties use SteamID order. Cash is the match tally's signed cash delta, not wallet balance or TIX.

Personal streak/rival details are omitted when the feed does not cover that player's scoreboard kills and deaths. The streak leader is omitted when participant coverage is incomplete. Enemy rival records exclude suicides and team kills; the rival is the opponent with most kills against the recipient, with SteamID order breaking ties. Kills and cash leaders include every recorded participant without a minimum-playtime floor.

The next map/weather are captured from the validated explicit rotation pointers before travel, including repeated map names and random rotation order. Unavailable rotation information displays `…`. Cards expire at travel, a rotation-slot change, a new game process, departure, loss of a fresh roster, or the end of the post-match phase. The 120-second absolute ceiling allows fan-out while the post-match guard remains authoritative.

Names shorten at grapheme boundaries. The card tries 20/16/12/8-character names, then omits the optional rival and retries before further compaction. Normal catalogue map/weather labels and realistic values retain complete personal stats and next fields within 256 characters. Defensive field bounds also retain complete lines for unexpected inputs. Welcome leader lines use the same formatting helper and retain their existing wording/layout.

Intents and the rule's last processed event/match marker commit together. Outbox keys include the rule, database match row and recipient. Repeated events/evaluation cannot enqueue duplicate cards, including across worker restarts. An unqueued in-memory opportunity is deliberately lost on worker ownership reset; durable pending rows are still checked against current delivery state. Changed/disabled rules cancel queued cards through the native settings guard.

Validation covers pure formatting/data rules and a disposable Postgres enqueue-to-dispatcher integration suite, including 100 recipients. This does not establish live in-game visual acceptance or enable a production rule.
