# Running the agent server

Every command here is run from inside `agents/`.

## Start it

```bash
./.venv/bin/python -m server
```

That serves on port 8000:

| Address | What it is |
| --- | --- |
| `ws://localhost:8000/ws` | The game's socket. It speaks the messages in [api.md](api.md). |
| `ws://localhost:8000/watch` | The viewer stream: every message in, every message out and every trace. |
| `http://localhost:8000/screen/` | The second screen, and `panels.js` for a game's own page. It is served when `demo/tennis-screen/index.html` exists. A page on another address may fetch from it. |
| `http://localhost:8000/health` | Which parts loaded, and where each match stands. |

The server reads `GEMINI_API_KEY` from the first place that has one: the environment, then `agents/.env`, then the `.env` at the top of the repo. The top of the repo has `.env.example`: copy it to `.env` there and add your key.

- **A server started with no key exported** uses the key in `agents/.env`, or else the one in the repo's `.env`.
- **At start-up it prints one line** that says which of those places the key came from. It never prints the key.
- **A different key in one of the `.env` files is kept as a fallback.** When a call fails because the active key has run out of credit, the server moves to the fallback once, for good, and tries the call again.

At start-up it loads the watcher, the designer and the adapter. If one can't load, it prints one line that says why and runs without that part. The game still gets `ready`, and every round still gets measured.

## Flags

| Flag | What it does |
| --- | --- |
| `--port 8000` | The port to serve on. |
| `--host localhost` | Use `0.0.0.0` when the game runs on another machine. |
| `--record` | Write each match's viewer stream to `data/streams/<match_id>.jsonl`. If that file already exists, it is moved to `<match_id>.earlier-1.jsonl` (then `-2` and so on) and the newest keeps the plain name. |
| `--no-adapt` | The unchanged baseline for the proof run. The game gets its own `default_behaviour` back in `ready`, as version 0 (or every option equally likely if it has none), and no `strategy_update` is ever sent. No model is called. |
| `--fresh-design` | Design each game again, even if a design is stored in `data/designs/`. |
| `--screen DIR` | Serve another folder at `/screen`. |

## Stored designs

A design is stored in `data/designs/` under the game's name and its `setup`.

- **After a game changes its `setup`**, run one practice session first, then live matches. A live match can't playtest on its own.
- **A playtested design is never replaced** by one with no playtest.
- **`--fresh-design` designs again**, for when the game's mechanics change but its `setup` doesn't. Run it with a practice session. A live match keeps a stored playtested design even with `--fresh-design`.
- **A design learned from a stand-in** (`"stand_in": true` in `practice`) is kept apart from the real game's.

## Before a demo

A stored design is named after the game's `setup`. When the game's engine changes and its `setup` doesn't, the stored practice table is stale. So the last step before people play is one practice session against the final game build.

1. Stop the server, then start it again with `--fresh-design`:

   ```bash
   ./.venv/bin/python -m server --fresh-design
   ```

2. Start the final game build in practice mode, so it connects with `"mode": "practice"` and its `practice` block.
3. Wait for the server to close the practice socket. That means the new design is stored in `data/designs/`.
4. Start the live matches. A live match keeps the stored playtested design even with `--fresh-design` on, so the server can stay as it is.

A practice session against the stand-in doesn't replace this step, because a design learned from a stand-in is kept apart from the real game's.

## Settings

Pacing and thresholds are set in the environment. Most live in `server/config.py`, which also names the model for each job. The ones a developer is most likely to touch:

| Variable | Default | What it sets |
| --- | --- | --- |
| `NPC_READY_WAIT_SECONDS` | 3 | How long a live game waits for `ready` when its design isn't stored yet. After that it gets `ready` with its default behaviour, and the design follows as a `strategy_update` with `new_values`. |
| `NPC_PRACTICE_TIMEOUT_SECONDS` | 120 | How long the game has to answer one `practice_run`. |
| `NPC_START_ON_GAME_DEFAULT` | 1 | Start each match on the game's own `default_behaviour`, so the NPCs begin beatable. Set to 0 to start on the designed behaviour. |
| `NPC_ADAPTER_FIRST_DELAY_SECONDS` | 10 | When the larger loop first looks at a match. |
| `NPC_ADAPTER_REST_SECONDS` | 4 | How long it waits after a look that changed nothing. |
| `NPC_ADAPTER_TIMEOUT_SECONDS` | 25 | A standard rewrite that takes longer is dropped, and the current rules stay. |
| `NPC_SHORT_LOOP` | 1 | Set to 0 to turn the short loop off, to measure what the larger loop earns alone. |
| `NPC_LARGER_LOOP` | 1 | Set to 0 to turn the larger loop off, to measure what the short loop earns alone. |
| `NPC_ADAPTER_WRITERS` | 1 | Set to 0 to keep the fairness check but switch the rule writers off. |
| `NPC_DEFAULT_UPDATE_SECONDS` | 20 | The `update_seconds` for a game that leaves it out. |
| `NPC_NOT_A_HABIT_FIELDS` | `result,outcome,winner,hit,success,timing,quality,confidence,reason` | Fields that say how an action turned out. They are never counted as habits. Matched as whole names. |
| `NPC_NOT_A_HABIT_PREFIXES` | `other_,opponent_,enemy_,npc_` | Fields that start with these describe the other side, so they are never habits either. |
| `NPC_OUTCOME_FIELDS` | `result,outcome,winner,hit,success` | When two events repeat the same field, the habit is counted on the event that carries one of these. |
| `NPC_GUESS_WORDS` | `guess,predicted,estimate` | A field with one of these in its name is a guess at another field, so it is never a habit. |
| `NPC_MAX_LINE_WORDS` | 12 | The most words in a line a player reads, like an observation or a plan line. |
| `NPC_MAX_ABOUT_WORDS` | 8 | The most words in a value's label. |
| `NPC_TELL_WINDOW_SECONDS` | 1.0 | An early event followed by another player event within this time counts as an early sign and what came after it. |
| `NPC_TELL_MIN_PAIRS` | 5 | An early sign must be seen this often before it can hold up. |
| `NPC_TELL_MIN_SHARE` | 0.7 | And be followed by the same thing at least this share of the time. |
| `NPC_TELL_MIN_LIFT` | 0.1 | And beat how often that thing follows anyway by at least this much. |
| `NPC_COUNTER_MARGIN` | 0.25 | How much better than the baseline an option must win, as a share of the baseline rate, to count as a counter. |
| `NPC_COUNTER_MIN_GAP` | 0.1 | And by at least this many points of win rate. |
| `NPC_COUNTER_SURENESS` | 2 | And by at least this many standard errors. |
| `NPC_GENERAL_COUNTER_SHARE` | 0.75 | An option is general when it clearly beats the default against this share of the practice players. |
| `NPC_GENERAL_COUNTER_STEP` | 0.15 | The most a general counter's weight may rise in one update. |
| `NPC_HOLE_WIN_RATE` | 0.9 | An option that wins this often against every practice player is a hole in the game. It is never raised. |
| `NPC_ALWAYS_ON_SHARE` | 0.8 | A rule that decides this share of a decision's picks is always on, so the next look takes it off. |
| `NPC_ALWAYS_ON_MIN_PICKS` | 5 | Over at least this many picks. |
| `NPC_FAIR_BLEND_ROUNDS` | 8 | How many rounds the practice table's estimate counts as, beside the rounds played, in the blended share. |
| `NPC_FAIR_SHARE_FLOOR` | 0.42 | The bottom of the fair band for the blended share. Nothing whose estimate falls under it is sent. |
| `NPC_FAIR_SHARE_CEILING` | 0.58 | The top of the fair band. |
| `NPC_FAIR_BRAKE_LOSSES` | 5 | After this many losses in a row, the NPCs ease whatever the blended share says. |
| `NPC_FAIR_NO_FLAP_ROUNDS` | 3 | After any change in strength, nothing moves the other way for this many rounds. The brake is the exception. |
| `NPC_SEND_HOLDING_UPDATES` | 1 | Every look that completes sends an update, with empty `changes` when nothing changed. Set to 0 to send only real changes. |
| `NPC_ADD_ONLY_AFTER_WIN` | 1 | Strength is added only when the player won the most recent round. |
| `NPC_DOSE_STEP` | 0.1 | How much more of its picks the best counter gets in one step, when the player keeps winning and nothing else was added. |
| `NPC_DOSE_MAX_STEP` | 0.15 | The most of a decision's picks one option may gain in one update. 1 means no cap. |
| `NPC_FAIR_TARGET_SHARE` | 0.5 | The player's share of rounds a counter is sized for when it goes in as a weight. |
| `NPC_RULE_FIRE_SHARE` | 0.5 | How often a rule with conditions is taken to fire, for that estimate. |
| `NPC_FAIR_ROUNDS` | 4 | How many recent rounds a check of an earlier change looks at. |
| `NPC_FAIR_REST_ROUNDS` | 2 | The rounds between two fairness steps. |
| `NPC_FAIR_FAILED_REST_ROUNDS` | 1 | The rest after a step that didn't pay off. |
| `NPC_FAIR_DIAL_STEP` | 0.15 | One step of a fairness setting, as a share of its range. |
| `NPC_FAIR_NO_RETURN_ROUNDS` | 4 | Nothing of a counter the fairness check took off comes back for this many rounds. As a rule it never comes back. |
| `NPC_FAIR_SNAP` | 0.05 | A weight this close to the default becomes the default. |
| `NPC_FAIRNESS_DIALS` | none | Settings the fairness check may turn, written `setting:up` or `setting:down` (the direction that makes the game harder), with commas between. Used only when the design didn't mark any. |
| `NPC_WATCH_MIN_INTERVAL_SECONDS` | 1 | The short loop reads the player at most this often. |
| `NPC_WATCH_IDLE_SECONDS` | 3 | With no player event for this long, fresh pictures alone start a read. |
| `NPC_WATCH_WINDOW_SECONDS` | 20 | How many seconds of events the short loop looks back over. |
| `NPC_WATCHER_READ_TIMEOUT` | 1.2 | A read that takes longer is tried once more. |
| `NPC_MIN_CONFIDENCE` | 0.6 | Below this confidence a value is tracked but not acted on. |
| `NPC_MANAGED_OVERHEAD_SECONDS` | 85 | How long a managed agent run spends before its first rule set is tested. |
| `NPC_MANAGED_SECONDS_PER_CANDIDATE` | 5 | And how long on each rule set after that. |
| `NPC_MANAGED_MAX_CANDIDATES` | 6 | The most rule sets one run may try. |

The models are set by `NPC_WATCHER_MODEL`, `NPC_DESIGNER_MODEL`, `NPC_DESIGNER_THINKING`, `NPC_ADAPTER_MODEL`, `NPC_ADAPTER_THINKING`, `NPC_FAST_WRITER_MODEL`, `NPC_MANAGED_AGENT` and `NPC_MANAGED_AGENT_MODEL` in `server/config.py`. The rest of the managed agent's settings (`NPC_MANAGED_*` and `NPC_TARGET_PLAYER_SHARE`) are in `server/managed_writer.py`. The playtest's sizes (`NPC_PLAYTEST_*`, `NPC_DESIGN_BUDGET_SECONDS`, `NPC_DESIGNER_*_SECONDS`) are in `server/designer.py`. The short loop's smoothing (`NPC_WATCHER_BLEND`, `NPC_WATCHER_FEED_BACK`) is in `server/watcher.py`. `NPC_CHECK_MIN_USES` and `NPC_CLEAR_SHIFT` are in `server/adapter.py`, and `NPC_SCREEN_DIR` does what `--screen` does.

## Point a game at it

1. Open one WebSocket to `ws://localhost:8000/ws`.
2. Send `setup`, then wait for `ready`.
3. Send `event`, `frames` and `round_end` as the match goes on.
4. Keep the newest `player_read` and the newest `strategy_update`. Swap the new behaviour in at the next gap between rounds.

A message that doesn't fit what `setup` declared gets an `error` back that names the field, and the match carries on. Up to 500 messages that arrive before `ready` are held, with only the newest pictures kept, and taken in once `ready` is sent. A game should still wait for `ready`.

Give every match its own `match_id`. A `setup` with a `match_id` the server already knows is treated as the same game reconnecting: it gets `ready` with the latest behaviour and picks up where it was. The same id starts a new match in two cases: the old match has played every round in its `plan` (when the plan sets `rounds`), or the game comes back and reports round 1 again.

To set a game up before anyone plays, connect once with `"mode": "practice"` and a `practice` block. The server sends `practice_run` messages, the game answers each with a `practice_result`, and the design is stored in `data/designs/`. A later live match of the same game gets `ready` straight away. When the design is stored, the server closes the practice socket with code 1000. A game that doesn't know a player in a `practice_run` can answer with `error` and `where: "practice_run.player"`, and the playtest carries on without that player.

## The stand-in game

The stand-in plays a game with no screen, from the game's `setup` and a `sim.json` that holds its scripted players and outcome table:

```bash
./.venv/bin/python -m sim --setup examples/tennis/setup.json --model examples/tennis/sim.json --url ws://localhost:8000/ws
```

- **Its scripted players** for tennis are `forehand_lover`, `baseline_grinder` and `even`, the same three the real game names in its `practice` block. Pick one with `--player`.
- **It sends early signs.** Before each player shot it sends `swing_start`, and after it the opponent's `anticipate` event. Each player shows the real shot at the start of the swing as often as their `tells` say, so `forehand_lover` gives it away and `baseline_grinder` disguises it.
- **It answers practice runs** the way the real game does, so the designer can playtest with it.

## Open the second screen

Go to `http://localhost:8000/screen/` in a browser on the machine that runs the server. It follows the latest match. A page opened late first gets the match so far.

Any other viewer can read the same stream from `ws://localhost:8000/watch`. Each line carries `match`, the match id. Add `?match_id=m_001` to follow one match only.

## Put the side panels in a game page

The side panels show what the agent side is doing next to the game's own view. The left one shows this player's strongest habits right now, each with one line on what the NPC does about it. The right one shows what the larger loop noticed and what it plans.

```html
<script type="module" src="http://AGENT_HOST:8000/screen/panels.js"></script>

<npc-panel side="left"></npc-panel>
<npc-panel side="right"></npc-panel>
```

- **They read the viewer stream** at `/watch` on the server the script came from. The page around them needs no other code.
- **They draw from the moment `ready` is sent**, with a title and one waiting line, and fill in as the match goes on.
- **They draw nothing when the server is down**, so the game page looks the same without them.
- **With more than one match going**, they stay on the match being played. Another game on the same server takes over only once the followed game has left, or when the followed match has had no player event and the other one gets one. A `match` attribute pins a panel to one match, like `<npc-panel side="left" match="m_001">`.
- **They pick an accent colour that shows on the colour behind them.** A page can set `--npc-accent` to choose its own, and `--npc-pad` for their inner padding.
- **`panels-test.html`** in `demo/tennis-screen/` shows them without a game. Open `http://localhost:8000/screen/panels-test.html?replay=sample-stream.jsonl&speed=4` to play a recorded match through them.

## Run the tests

```bash
./.venv/bin/python -m pytest -q
node sdk/js/test.mjs
```

They play scripted matches against fake parts on a free port, and check both SDKs against the same `pick` cases. No model is called, except by the live watcher test, which runs only when `GEMINI_API_KEY` is set.
