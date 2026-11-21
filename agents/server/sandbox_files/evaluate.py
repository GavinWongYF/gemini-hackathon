"""Score one behaviour against the facts of a match. No network, standard library only.

    python3 evaluate.py <behaviour.json> --facts <facts.json>

It prints one JSON line and saves the same result as <out-dir>/<name>.json,
where <name> is the behaviour file's name without ".json". Each test is also
added as one line to <out-dir>/history.jsonl.

What the score means
    `player_win_share` is the share of rounds we expect the live player to
    win if the NPCs play this behaviour. For each practice player in the
    matchup table it plays many simulated decisions through `pick`, the same
    function the game uses, and reads how each chosen option did against that
    practice player in the playtest. An NPC's chance to win a round is its
    baseline rate against that practice player, plus the gap between each
    chosen option's row and the baseline. The practice players are then
    weighted by how much the live player resembles each one.

    The goal is a fair fight, not a win. `distance` is how far the share is
    from `target` (a half unless the facts say otherwise), and the best
    behaviour is the one with the smallest distance. A result has
    `passed: true` when the behaviour only uses names the game declared and
    its distance is at most PASS_BAND.

What it cannot see
    - It never plays the game. Every number comes from the matchup rows, so
      an option with no row counts as no better than the baseline.
    - It adds the gaps of separate decisions together. Two options that only
      work as a pair, or that cancel each other, look the same as any others.
    - It does not know how often each fact is true in a real round. A fact is
      drawn from a practice player's `plays` when a field there matches the
      fact's name, and evenly from its declared names otherwise.
    - The values are the live read of the player and stay fixed, so it cannot
      see the player changing how they play in answer to the new rules.
    - Rows from a few practice rounds are noisy, and it trusts them as given.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
from typing import Any, Callable

BASELINE = "baseline"   # a baseline row has this option and an empty decision
LIKE = "like_"          # the value that says how much the player resembles a practice player
MAX_RULES = 4
PASS_BAND = 0.25        # a behaviour passes when the player's share is this close to the target
TRIALS = 1500           # simulated decision points for each practice player
SEED = 7
COMPARISONS = ("is", "in", "above", "below")

Pick = Callable[..., tuple[str, bool]]


def fingerprint(behaviour: dict[str, Any]) -> str:
    """A short hash of what the NPCs do. The version number is left out."""
    text = json.dumps(behaviour.get("npcs"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def names_for(setup: dict[str, Any], spec: Any) -> list[str] | None:
    """The names a fact may take, or None when it is a number or free text."""
    if isinstance(spec, list):
        return spec
    if isinstance(spec, str):
        named = (setup.get("lists") or {}).get(spec)
        if isinstance(named, list):
            return named
    return None


def options_for(setup: dict[str, Any], npc: str, decision: str) -> list[str]:
    spec = ((setup.get("npcs") or {}).get(npc) or {}).get("decisions", {}).get(decision) or {}
    return list(spec.get("options") or [])


def problems(behaviour: Any, facts: dict[str, Any]) -> list[str]:
    """Every way this behaviour uses a name or a shape the game did not declare."""
    setup = facts.get("setup") or {}
    known_values = set(facts.get("values") or {}) | set(facts.get("value_about") or {})
    known_facts = setup.get("facts") or {}
    found: list[str] = []
    if not isinstance(behaviour, dict) or not isinstance(behaviour.get("npcs"), dict):
        return ["A behaviour is {\"version\": n, \"npcs\": {...}}."]
    for npc in setup.get("npcs") or {}:
        if npc not in behaviour["npcs"]:
            found.append(f"No entry for the NPC `{npc}`.")
    for npc, entry in behaviour["npcs"].items():
        if npc not in (setup.get("npcs") or {}):
            found.append(f"`{npc}` is not an NPC in setup.")
            continue
        if not isinstance(entry, dict):
            found.append(f"The entry for `{npc}` must hold `decisions` and `rules`.")
            continue
        decisions = entry.get("decisions") or {}
        for decision, options in decisions.items():
            allowed = options_for(setup, npc, decision)
            if not allowed:
                found.append(f"`{decision}` is not a decision of `{npc}`.")
                continue
            for option, weights in (options or {}).items():
                if option not in allowed:
                    found.append(f"`{option}` is not an option of `{npc}.{decision}`.")
                    continue
                base = (weights or {}).get("base", 0)
                if not isinstance(base, (int, float)) or base < 0:
                    found.append(f"`{npc}.{decision}.{option}.base` must be a number, 0 or more.")
                for value in (weights or {}).get("when") or {}:
                    if value not in known_values:
                        found.append(f"`{value}` is not a value this match tracks.")
        rules = entry.get("rules") or []
        if len(rules) > MAX_RULES:
            found.append(f"`{npc}` has {len(rules)} rules. The most is {MAX_RULES}.")
        for index, rule in enumerate(rules):
            where = f"{npc}.rules[{index}]"
            if not isinstance(rule, dict) or not isinstance(rule.get("do"), dict) or not rule.get("do"):
                found.append(f"`{where}` needs a `do` like {{\"decision\": \"option\"}}.")
                continue
            for decision, option in rule["do"].items():
                if option not in options_for(setup, npc, decision):
                    found.append(f"`{where}` does `{decision}: {option}`, which setup does not declare.")
            for cond in rule.get("if") or []:
                if not isinstance(cond, dict) or not any(key in cond for key in COMPARISONS):
                    found.append(f"`{where}` has a condition with none of: {', '.join(COMPARISONS)}.")
                elif "value" in cond:
                    if cond["value"] not in known_values:
                        found.append(f"`{where}` reads `{cond['value']}`, which is not a tracked value.")
                elif cond.get("fact") not in known_facts:
                    found.append(f"`{where}` reads the fact `{cond.get('fact')}`, which setup does not declare.")
                else:
                    allowed = names_for(setup, known_facts[cond["fact"]])
                    wanted = cond.get("in") if "in" in cond else [cond["is"]] if "is" in cond else []
                    if allowed is not None and any(name not in allowed for name in wanted or []):
                        found.append(f"`{where}` compares `{cond['fact']}` with a name it can never be.")
    return found


def rates(facts: dict[str, Any]) -> tuple[dict[tuple[str, str], float], dict[tuple[str, str, str, str], float]]:
    """(baseline win rate by (player, npc), option win rate by (player, npc, decision, option))."""
    base: dict[tuple[str, str], float] = {}
    rows: dict[tuple[str, str, str, str], float] = {}
    for row in facts.get("matchups") or []:
        played = row.get("rounds") or 0
        if not played:
            continue
        rate = row.get("npc_wins", 0) / played
        if row.get("option") == BASELINE and not row.get("decision"):
            base[(row["player"], row["npc"])] = rate
        else:
            rows[(row["player"], row["npc"], row["decision"], row["option"])] = rate
    return base, rows


def likeness(facts: dict[str, Any], players: list[str]) -> dict[str, float]:
    """How much the live player resembles each practice player, summing to 1."""
    values = facts.get("values") or {}
    raw = {name: max(float(values.get(LIKE + name, 0) or 0), 0.0) for name in players}
    total = sum(raw.values())
    if total <= 0:
        return {name: 1 / len(players) for name in players}
    return {name: share / total for name, share in raw.items()}


def draw_facts(setup: dict[str, Any], persona: dict[str, Any], rng: random.Random) -> dict[str, Any]:
    """One made-up moment: what an NPC could see when it has to choose."""
    habits: dict[str, dict[str, float]] = {}
    for fields in (persona.get("plays") or {}).values():
        if isinstance(fields, dict):
            habits.update({name: odds for name, odds in fields.items() if isinstance(odds, dict)})
    seen: dict[str, Any] = {}
    for name, spec in (setup.get("facts") or {}).items():
        allowed = names_for(setup, spec)
        if allowed:
            odds = next((o for field, o in habits.items()
                         if name.endswith(field) and set(o) <= set(allowed) and sum(o.values()) > 0), None)
            if odds:
                seen[name] = rng.choices(list(odds), weights=list(odds.values()))[0]
            else:
                seen[name] = rng.choice(allowed)
        elif isinstance(spec, dict) and "min" in spec and "max" in spec:
            seen[name] = rng.uniform(spec["min"], spec["max"])
        elif spec == "number":
            seen[name] = rng.randint(0, 10)
    return seen


def score(behaviour: dict[str, Any], facts: dict[str, Any], pick: Pick,
          trials: int = TRIALS, seed: int = SEED) -> dict[str, Any]:
    """Estimate the share of rounds the player wins against this behaviour."""
    setup = facts.get("setup") or {}
    target = float(facts.get("target_player_share", 0.5))
    result: dict[str, Any] = {
        "ok": False, "passed": False, "target": target, "trials": trials, "seed": seed,
        "fingerprint": fingerprint(behaviour) if isinstance(behaviour, dict) else "",
        "problems": problems(behaviour, facts),
    }
    if result["problems"]:
        return result
    base, rows = rates(facts)
    npcs = list(setup.get("npcs") or {})
    # A practice player counts only when the playtest ran a baseline for every NPC.
    players = [name for name in dict.fromkeys(player for player, _ in base)
               if all((name, npc) in base for npc in npcs)]
    if not players:
        result["problems"] = ["The facts hold no matchup rows with a baseline, so nothing can be scored."]
        return result
    personas = {p.get("name"): p for p in facts.get("personas") or [] if isinstance(p, dict)}
    weights = likeness(facts, players)
    values = facts.get("values") or {}
    rng = random.Random(seed)
    by_persona: dict[str, Any] = {}
    overall, ruled, picks = 0.0, 0, 0
    for player in players:
        npc_side = 0.0
        for _ in range(trials):
            seen = draw_facts(setup, personas.get(player) or {}, rng)
            round_chance = 0.0
            for npc in npcs:
                chance = base[(player, npc)]
                for decision in (setup["npcs"][npc].get("decisions") or {}):
                    legal = options_for(setup, npc, decision)
                    option, by_rule = pick(npc, decision, legal, behaviour, values, seen, rng)
                    ruled += by_rule
                    picks += 1
                    row = rows.get((player, npc, decision, option))
                    if row is not None:
                        chance += row - base[(player, npc)]
                round_chance += min(max(chance, 0.0), 1.0)
            npc_side += min(round_chance, 1.0)
        share = 1 - npc_side / trials
        by_persona[player] = {"likeness": round(weights[player], 3), "player_win_share": round(share, 3)}
        overall += weights[player] * share
    result.update({
        "ok": True,
        "player_win_share": round(overall, 3),
        "distance": round(abs(overall - target), 3),
        "by_persona": by_persona,
        "ruled_share": round(ruled / picks, 3) if picks else 0.0,
    })
    result["passed"] = result["distance"] <= PASS_BAND
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Score one behaviour against the facts.")
    parser.add_argument("behaviour")
    parser.add_argument("--facts", required=True)
    parser.add_argument("--out-dir", default="/workspace/tests")
    parser.add_argument("--trials", type=int, default=TRIALS)
    parser.add_argument("--seed", type=int, default=SEED)
    args = parser.parse_args()

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from pick import pick  # the game's own picker, saved next to this file

    name = os.path.splitext(os.path.basename(args.behaviour))[0]
    with open(args.facts) as handle:
        facts = json.load(handle)
    try:
        with open(args.behaviour) as handle:
            behaviour = json.load(handle)
        result = score(behaviour, facts, pick, args.trials, args.seed)
    except (OSError, ValueError) as error:
        result = {"ok": False, "passed": False, "problems": [f"Could not read the behaviour: {error}"]}
    result = {"name": name, "run": facts.get("run_id"), **result}
    os.makedirs(args.out_dir, exist_ok=True)
    with open(os.path.join(args.out_dir, name + ".json"), "w") as handle:
        json.dump(result, handle)
    # Every test is also kept in one running list, so a revised candidate's earlier scores are not lost.
    with open(os.path.join(args.out_dir, "history.jsonl"), "a") as handle:
        handle.write(json.dumps({key: result.get(key) for key in (
            "name", "run", "fingerprint", "passed", "player_win_share", "distance", "problems")}) + "\n")
    print(json.dumps(result))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
