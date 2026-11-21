# Examples

A new game is one JSON file. These two games use the same messages, the same `pick` and the same clients. Only their `setup` files differ.

- [tennis/setup.json](tennis/setup.json) is the live demo.
- [csgo/setup.json](csgo/setup.json) is a recorded one.

| In `setup` | Tennis | CS:GO |
| --- | --- | --- |
| `game` | `tennis` | `csgo` |
| A round | One point | One round |
| `npcs` | `opponent`, one AI player | `enemies`, a squad that shares one behaviour |
| `decisions` | `shot_type`, `aim` and `position` on every shot, and `anticipate` the moment the player starts a swing | `formation` at the start, `on_contact` when the player is seen, `on_gunfire` when shots are heard |
| `lists` | `zone`, `human_shot_type`, `ai_shot_type`, `arm_zone` | `place`, `weapon` |
| `events` | `swing_start` (the early sign), `anticipate`, `shot`, `missed_swing` | `round_start`, `entered`, `spotted`, `kill` |
| `facts` | `player_position`, `player_arm_zone`, `player_last_side`, `player_last_shot_type`, `rally_length`, and the `swing_*` facts from the early sign | `player_last_seen`, `enemies_alive`, `seconds_into_round` |
| `views` | `court`, `player_cam` | `screen`, `player_cam` |
| `settings` | `opponent_speed` | `enemy_count`, `loadout`, `extra_cover` |
| `plan` | Open-ended: no fixed number of points and no breaks, `update_seconds` 20 | 4 rounds, one 150 second break after round 2, `update_seconds` 8 |
| `practice` | Three scripted players: `forehand_lover`, `baseline_grinder`, `even` | none |
| `default_behaviour` | sent, so the agent side starts from it | left out, so the agent side writes the first one |
| `goal` | Start beatable, then take away the player's habits one at a time until points are about even | Make every round close |

The `plan` row is what sets how deep the updates go. The same server gives the open-ended tennis match one quick model call per update. It gives CS:GO fast calls between rounds, and at the long break a managed agent that writes several rule sets and tests them before answering. Nothing else in the two files asks for that difference.

To add a third game, write the same fields for it:

1. **Who the NPCs are**, with one plain line each.
2. **The decisions each NPC makes**, with when it makes them and the options.
3. **The events** it will report and their fields.
4. **The facts** an NPC can check when it decides.
5. **The pictures** it can send.
6. **Any settings** the agent side may change between rounds.
7. **Its pacing** in `plan`: rounds, breaks and how long it can wait for an update.

Add a `practice` block too if the game can play rounds with no screen. [../docs/api.md](../docs/api.md) has every field, and [../docs/examples.md](../docs/examples.md) walks through both games message by message.
