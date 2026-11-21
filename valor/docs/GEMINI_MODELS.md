# How VALOR uses Gemini 4 and the Decisions API

VALOR is the second game on the same agent system as the tennis demo. The game side (this repo, `src/agent/`) describes VALOR once in `setup`, streams events and frames over one WebSocket, and applies what comes back. The models run in the shared backend (`agents/`, owned by Felix and Gavin; see `docs/agent-protocol/TEAM_SYNC.md`). **That backend is not in this repo and was not running locally while this was written**, so this page separates what is built and measured game-side from what the backend owns.

## Two models with separate jobs

| Model | Job | Input | Latency budget (contract) | Messages it produces | How VALOR pushes it | Status in VALOR |
| --- | --- | --- | --- | --- | --- | --- |
| **Gemini 4 Neon** (speed and vision) | Reads the player as the round goes, about once a second. Writes the `quick` update in the break. | Text events (`player_lane_change`, `kill`, `death`, `died_in_open`, `round_start` with `picked`) **plus** a 384 px JPEG of the player's screen about once a second (`views.game`) | `player_read` under 1 s after a player event. `quick` `strategy_update` within 2 s of `round_end` | `player_read` (values + `why` + `picture_note`), `strategy_update` with `source: "quick"` | Vision: two values, `hugs_cover` and `peeks_bus_side`, **can only come from the pixels**, because no event carries them. The `game` view description in `setup` tells it what to look for (lane, cover vs open paving, peeking, enemies on screen, health bar). Speed: the 3.5 s VALOR break is shorter than tennis, so the quick update has to fit inside it | Game side built: frames captured and sent at ~1 Hz while a round is live; quick updates applied in the same break. **Neon latency not measured yet**: the harness has the `--live` slot for it |
| **Gemini 4 Carbon** (reasoning) | Reads the `setup` of a game it has never seen, designs the values (the questions about the player) and the first behaviour, then rewrites the behaviour between rounds: rules, weights and new cover placement | The `setup` text, the round history (`round_end` with `how`/`score`), Neon's `player_read`s | `ready` up to ~60 s the first time. `full` `strategy_update` 20–40 s after `round_end` | `ready` (values + behaviour v1), `strategy_update` with `source: "full"`, `new_values`, `settings` (incl. `cover`) | Reasoning about an unseen game from `setup` alone. No VALOR-specific code exists on the agent side. It must reason over spatial names (lanes, cover spots), per-enemy rules (`enemy_index`), and a fairness goal ("keep the player winning about half"), and every output has to get past VALOR's self-check | Game side built: full updates that land mid-round are queued and applied at the next round end. **Carbon latency not measured yet** |
| **Decisions API** | The structured layer both models write through: the values (0–1 habits of this player), `when` weights, `rules` (`if` fact/value → `do` option), and the game-side `pick()` that turns them into choices | `setup.npcs.red.decisions` (position / target / style with plain option lines), `facts`, `settings` | — | The behaviour JSON | Every red choice in VALOR goes through `pick()` (`src/agent/protocol.ts`, an exact port of the contract), via `Brain.decide()` in `teamAI.planRound()` | Built and unit-tested (`src/agent/agent.test.ts`) |

"Expected" numbers in the table come from the contract's timing section (`API_CONTRACT_V2.md`). They were **not** measured on VALOR. Measured numbers are in `docs/proof/latency.json` and `docs/PROOF.md`.

## What exists today in VALOR (game side, measured)

- `src/agent/setup.ts` holds `valorSetup()`, the only description of VALOR the agents get. It is the same in practice and live mode.
- `src/agent/bridge.ts` holds the WebSocket client: reconnect/backoff, `setup → ready` (90 s timeout), events, ~1 Hz frames while live, `round_end`, and behaviour swaps only between rounds. It also records latency per message type (`agentBridge.getLatencyReport()`).
- `src/agent/frames.ts` captures the `game` view (384 px JPEG, quality 0.6). Real captures are in `docs/proof/frames/`. They come to about 9.6 KB each.
- `src/agent/selfcheck.ts` checks every model output before it is applied (structure, then a simulated fairness check).
- `src/agent/standin.ts` is the **offline stand-in**. It is deterministic counting, *not a model*, and is labelled `offline_standin` in the HUD status. It writes the same `strategy_update` shape so the demo adapts with no server. It cannot see pixels, so `hugs_cover`/`peeks_bus_side` stay 0 there. That gap is the reason Neon's vision is needed.

## How to drop real Gemini numbers in

1. Start the backend (`agents/server`, `ws://localhost:8000/ws`).
2. Run `npx tsx scripts/proof/run.ts --live --live-n 3`. This plays practice matches through the real backend. It records setup→ready, event→player_read and round_end→quick/full latency (p50/p95) into `docs/proof/latency.json` under `gemini`, and runs every received update through the self-check (`live_gemini.self_check` in `results.json`).
3. For frames and in-browser numbers, play a match and run `__valorAgent.report()` in the dev console.
