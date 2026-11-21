"""How an NPC picks, on the game side.

Call `pick` at the one place in your game where an NPC chooses what to do. It
only reads what the game already holds, so it never waits on the network.
"""
from __future__ import annotations

import random
from typing import Any


def pick(
    npc: str,
    decision: str,
    legal: list[str],
    behaviour: dict[str, Any],
    values: dict[str, float],
    facts: dict[str, Any],
    rng: random.Random | None = None,
) -> tuple[str, bool]:
    """Return the option to play, and whether a rule decided it.

    npc, decision: the names your `setup` gave them
    legal:         the options allowed right now
    behaviour:     the latest behaviour you received
    values:        the latest `player_read` values, each 0 to 1
    facts:         what the NPC can see right now, by the names in `setup`
    """
    rng = rng or random
    mine = behaviour.get("npcs", {}).get(npc)
    if not mine or not legal:
        return (rng.choice(legal) if legal else "", False)

    # 1. Rules first. The first rule that fits and is legal decides.
    for rule in mine.get("rules", []):
        choice = rule.get("do", {}).get(decision)
        if choice in legal and all(holds(cond, values, facts) for cond in rule.get("if", [])):
            return choice, True

    # 2. Otherwise score every legal option, then pick in proportion to the scores.
    options = mine.get("decisions", {}).get(decision, {})
    scores = []
    for name in legal:
        option = options.get(name, {})
        score = option.get("base", 0)
        for value_name, weight in option.get("when", {}).items():
            score += weight * values.get(value_name, 0)
        scores.append(max(score, 0))
    if sum(scores) == 0:
        return rng.choice(legal), False
    return rng.choices(legal, weights=scores)[0], False


def holds(cond: dict[str, Any], values: dict[str, float], facts: dict[str, Any]) -> bool:
    """Whether one condition of a rule is true right now."""
    x = values.get(cond["value"], 0) if "value" in cond else facts.get(cond.get("fact"))
    if "is" in cond:
        return x == cond["is"]
    if "in" in cond:
        return x in cond["in"]
    if x is None:
        return False
    if "above" in cond:
        return x > cond["above"]
    if "below" in cond:
        return x < cond["below"]
    return False
