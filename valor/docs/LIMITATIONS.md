# VALOR agent integration: limitations we actually observed

Every number here is from the N=200 run in `docs/proof/results.json` unless it says otherwise.

## Where the adaptation fails or misleads

1. **It over-reacts to noise.** `mixed_random` picks a lane at random every round, so it has no real habit. The stand-in still fired a "habit" counter (watch a flank or add cover) in **89.5%** of matches [84.5–93.0], first by round 4.6 on average. A random player makes 2-of-3 streaks easily, and the rule "≥2 of the last 3 rounds" can't tell a streak from a habit. The player's win-rate did move toward 50% (72.9% → 64.1%), so the fairness band kept the damage small. But the observations shown to the player ("won 2 of the last 3 via the left") describe luck as a habit.
2. **One counter creates the next problem.** Once enemies watch the left, the left-flanker dies in the open far more often: **55.2%** of rounds with the counter active vs **10.0%** without. The stand-in then adds cover on the left (seed 1: rounds 5–7). The two rules fight each other instead of converging. That is part of why flank_left still wins 54–62% per round after adapting, never 50%.
3. **Round-3 overshoot.** For `rush_open_mid` the first cover piece lifted the player from 21% to **67%** in round 3, above the 65% band, although the self-check predicted 60% for that candidate in the example match. Later rounds settle at 55–60%.
4. **Adaptation needs two rounds of evidence.** Rounds 1–2 are identical to the baseline by design. In a first-to-4 match that's two free rounds, so flank_left still wins **84.5%** of *matches* (baseline 100%) even though its round win-rate in rounds 4–7 drops to 56.8%.
5. **The fairness check is noisy.** It uses 60 simulated rounds per brain, so the 95% CI is roughly ±12 points. In the flank_left example the same "all three watch left" behaviour was predicted at 62% after round 2 and at 77% after round 3, which flipped the decision from accept to reject. More sims cost time (see 8).
6. **"Worse than current" is the most common rejection (1,121 of 2,530).** After a good counter is in place, the stand-in keeps proposing more changes. Most are refused, which is correct, but it means the ladder is tried and wasted every break (up to 3 candidates × 120 sims).

## Simulator abstraction gaps (sim.ts)

7. **Line of sight is lane-based, not geometric.** Same lane = visible. Adjacent lanes are visible only past the halfway line (nearest enemy only, a "corner peek") or at the same depth ±1.5 m. The real map's bus, props and chest-high blocks (1.1 m, which don't block a standing bot's eye line at ~1.45 m) are not ray-cast.
8. **The human is assumed, not measured.** Player accuracy 0.25, 0.45 s between aimed shots and 0.35 s reaction were **tuned** so that the baseline behaves as the scenarios describe (flanking dominates, rushing open mid loses). With accuracy 0.5 the player won ~100% against everything, so the outcomes are sensitive to this number. The flank "turn surprise" (+0.9 s red reaction against an attacker from an unwatched lane) is also tuned. Bots in the game see 360° and only lose time turning (7 rad/s).
9. **Simplified behaviour.** Cover protects only against fire from the front. `retreat_to_cover`/`strafe` are approximations. Allies hold their posts like the real `teamAI` plans, but in the sim both teams "hunt" after ~30 s of quiet. The real game has no timeout or hunt, so a stalemate there is possible and is not modelled.
10. **Game constants drift.** The sim imports `BOT_COMBAT`, `BLUE_COMBAT`, spawns and `MAP_COVER` from `src/game/teamAI.ts`, so it follows the team's tuning automatically. The red post positions (`redPost` in `plaza.ts`) are a mirror of `teamAI.redRoute()`, which is not exported, and can go stale.

## Latency and integration

11. **Full updates land a round late.** VALOR's break is 3.5 s (`ROUND_END_MS`). Carbon's `full` update is expected at 20–40 s (contract, *not measured*), so it arrives mid-round. The bridge queues it and applies it at the *next* round end, so a habit seen in round 2 is countered by Carbon only in round 4. Only a `quick` update (<2 s expected) can land in the same break.
12. **The self-check is not free.** It took p50 **132 ms**, p95 **481 ms** per break in Node, single thread (60 sims). The browser uses 40 sims and runs after `round_end` in a `setTimeout`, so it hitches once during the banner, never mid-round. It was not measured on the real game in a browser.
13. **No Gemini numbers yet.** The backend wasn't available locally. Every Gemini row in `latency.json` is `null` until `npx tsx scripts/proof/run.ts --live` runs against it.
14. **Frames are untested for usefulness.** 384 px JPEGs (~9.6 KB) are captured with a same-frame rAF read (no `preserveDrawingBuffer`). Under headless software GL the capture took ~2 s, which says nothing about a real GPU. Whether Neon can actually read `hugs_cover`/`peeks_bus_side` from them is unproven.
15. **Some declared events aren't emitted from the live game yet.** `shot` (the weapon has no hook the agent side can use), and `death.killer_index` is only right when the killer is a red bot. `player_in_open` uses `teamAI.isInOpen` (any geometry within 2.5 m), which counts props behind the player as "cover".
