# Adaptive NPCs: the agent side

This folder is the agent side of a shared repo.
The game lives in the repo's `client/` folder.

It is a service that makes a game's NPCs adapt to each player. A game describes itself once, reports what happens over one WebSocket, and gets back new NPC behaviour as the match goes on. It is built for any game that can describe its NPCs in JSON.

Built at the Gemini 4 NYC Hackathon on 21 November 2026.

## The problem

Developers spend a lot of time configuring NPC AI. They hand-tune weights and write rules for every enemy, and the result plays the same way against everyone. Players learn the pattern and get bored.

This service writes and rewrites that behaviour for the developer. The NPCs keep adapting to how each person plays, which gives players a reason to stay.

## How it works

Three jobs run on the agent side. Each uses its own Gemini model, and each model is a setting in [server/config.py](server/config.py) that an environment variable can change.

- **The designer** runs on Gemini 4 Carbon (`gemini-4-carbon`, `NPC_DESIGNER_MODEL`). It runs only at setup, when a developer registers a game. It reads the game's `setup`, writes the questions it will ask about each player, writes player personas, and playtests the game with no screen to learn which NPC option works against which kind of player. It never runs during a match.
- **The watcher** runs on Gemini Decision 1 (`gemini-decision-1`, `NPC_WATCHER_MODEL`) during play. It reads the player's events and frames and sends back a `player_read`: a number from 0 to 1 for each habit it tracks.
- **The adapter** is the larger loop. It runs during a match, rewrites the NPC behaviour, says why, and sends it as a `strategy_update`. What does the writing depends on how long the game can wait: one Gemini 4 Hydrogen call (`gemini-4-hydrogen`, `NPC_FAST_WRITER_MODEL`), one Gemini 4 Neon call at low thinking (`gemini-4-neon`, `NPC_ADAPTER_MODEL`), or a managed agent running Neon that writes rule sets and tests them before it answers (`NPC_MANAGED_AGENT`, `NPC_MANAGED_AGENT_MODEL`).

The game picks every NPC move locally with `pick`, using the newest values and behaviour it holds. So nothing in the game ever waits on a model.

The developer states the game's pacing in `setup`, and the agent side chooses how deep each rewrite goes. `plan.update_seconds` is how long the game can wait for a routine update, and `plan.break_seconds` is how long a break lasts. [docs/api.md](docs/api.md#the-plan-sets-how-deep-updates-go) has the table.

## Plug in your game

1. **Describe your game in a `setup` file.** Name your NPCs, the decisions they make and their options, the events you'll report, the facts an NPC can check, and the pictures you can send. [examples/tennis/setup.json](examples/tennis/setup.json) is a full one.

2. **Connect and report what happens.** The client sends `setup`, waits for `ready`, and keeps the newest behaviour for you.

   ```python
   import json
   from adaptive_npc import Client

   client = Client(json.load(open("setup.json")))
   await client.connect()
   await client.event("shot", round=1, by="player", data={"side": "forehand", "lands": "left_deep"})
   await client.round_end(round=1, winner="player", how="winner", score={"player": 1, "opponent": 0})
   ```

3. **Call `pick` wherever an NPC makes a choice.** Call `start_round` at the start of each round, so a new behaviour only goes in between rounds.

   ```python
   settings = client.start_round()
   option, by_rule = client.pick("opponent", "shot_type", ["topspin", "flat", "slice", "dropshot", "lob"], facts={"player_position": "middle_short"})
   ```

The JavaScript client has the same shape, and runs in a browser and in Node:

```js
import { Client } from "./sdk/js/client.js";

const client = new Client(setup);
await client.connect();
client.startRound();
const [option, byRule] = client.pick("opponent", "shot_type", ["topspin", "flat", "slice", "dropshot", "lob"], { player_position: "middle_short" });
```

If your game can play rounds with no screen, add a `practice` block to `setup` and pass `on_practice_run` (or `onPracticeRun` in JavaScript). The designer then playtests your game at setup.

If your game can see what the player is about to do, like the start of a swing, send it as its own event before the main action. A decision can react to it, and the agent side only writes a rule on it once the sign holds up. [docs/api.md](docs/api.md#early-signs) has the details.

## Show it in your game

Two side panels show what the agent side is doing, next to your game's own view. The left one shows this player's strongest habits and what the NPC does about each. The right one shows what the NPCs noticed and plan to change.

```html
<script type="module" src="http://AGENT_HOST:8000/screen/panels.js"></script>
<npc-panel side="left"></npc-panel>
<npc-panel side="right"></npc-panel>
```

They read the server's viewer stream. They show a title and a waiting line once `ready` is sent, and draw nothing when the server is down. A page can set the CSS variables `--npc-pad` for their padding and `--npc-accent` for their accent colour, and a `match` attribute pins a panel to one match. [docs/running.md](docs/running.md#put-the-side-panels-in-a-game-page) has more.

## The two examples

Tennis is the live demo and CS:GO is a recorded one. They use the same messages and the same code. Only their `setup` files differ.

- **Tennis** has one NPC, the `opponent`, with three decisions on every shot and a fourth, `anticipate`, made from an early sign: the start of the player's swing. It sends a `default_behaviour`, and has one setting, `opponent_speed`.
- **CS:GO** has one NPC entry, `enemies`, for a squad that shares one behaviour. It leaves out `default_behaviour`, so the designer writes the first one. It has settings the agent side may change between rounds, like `enemy_count`.
- **Their pacing differs, so their updates differ.** Tennis is an open-ended match that never breaks by itself, with `update_seconds` set to 20, so the same server gives it one quick model call per update. CS:GO sets `update_seconds` to 8 and has one 150 second break mid-match, so it gets fast calls between rounds and, at the break, a managed agent that writes several rule sets and tests them before answering. That difference comes only from each game's `plan`.

[examples/README.md](examples/README.md) puts the two side by side.

## Docs

- **[docs/api.md](docs/api.md)** is the full contract: every message, every field and how `pick` works.
- **[docs/examples.md](docs/examples.md)** walks through tennis and CS:GO with full JSON.
- **[docs/running.md](docs/running.md)** covers running the server, its settings, the stand-in game and the side panels.
- **The SDKs** are in [sdk/python/adaptive_npc/](sdk/python/adaptive_npc/) and [sdk/js/](sdk/js/). Both are checked against the same cases in [sdk/test-vectors.json](sdk/test-vectors.json).
