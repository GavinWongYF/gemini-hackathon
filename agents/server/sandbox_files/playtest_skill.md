---
name: playtest
description: Test a candidate rule set against the match facts before it may be kept. Use it on every candidate, every time.
---

# Playtest a rule set

Run the evaluator on a candidate file. It needs no network.

```bash
python3 /workspace/tools/evaluate.py /workspace/candidates/<name>.json --facts /workspace/runs/<run id>/facts.json
```

Test several in one command by joining the calls with `;` (not `&&`, because a failed test returns a non-zero exit code):

```bash
cd /workspace && for n in <run id>_a <run id>_b; do python3 tools/evaluate.py candidates/$n.json --facts runs/<run id>/facts.json; done
```

Each call prints one JSON line and saves the same result to `/workspace/tests/<name>.json`.

- `player_win_share`: the share of rounds the live player is expected to win against this rule set.
- `target`: the share to aim for. `distance` is how far off the rule set is. Smaller is better.
- `by_persona`: the same share against each kind of player, with how much the live player resembles each one.
- `ruled_share`: how many of the NPC's choices were forced by a rule and not by the weights.
- `passed`: true when every name in the rule set exists in the game and `distance` is 0.25 or less.
- `problems`: what to fix when the rule set uses a name the game did not declare.

What the number is: an estimate built from the practice results in `matchups`. It plays simulated decisions through the game's own `pick` and adds up how each chosen option did against each kind of player. It never plays the real game, it treats decisions as independent, and it cannot see the player adapting. Use it to compare candidates, and say so when two are too close to call.

A candidate that fails can be fixed and tested again under the same name. Only a candidate with `passed: true` may be copied into `/workspace/library/`. To reuse a rule set an earlier run left in the library, test it again against this run's facts first, because its old result was measured on older facts.
