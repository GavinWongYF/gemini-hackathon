"""Reading the matchup table the playtest filled in.

A row says how one NPC option did against one kind of player. A baseline row
says how the first behaviour did against that player. An option is a counter
when it beats the baseline by a clear margin, and the best counters for a
live player are weighted by how much that player resembles each practice
player.
"""
from __future__ import annotations

import math
import os
from typing import Any

import json

from server import config
from server.interfaces import Matchup

# A baseline row carries this in `option` and an empty `decision`.
BASELINE = "baseline"

# An option must win this much more often than the baseline, as a share of
# the baseline rate, before it counts as a counter.
CLEAR_MARGIN = float(os.environ.get("NPC_COUNTER_MARGIN", "0.25"))

# And never by less than this many points of win rate, so a baseline near
# zero does not turn noise into a counter.
MIN_GAP = float(os.environ.get("NPC_COUNTER_MIN_GAP", "0.1"))

# The gap must also be this many standard errors wide, so a lucky run of a
# few practice rounds is not taken for a counter.
SURENESS = float(os.environ.get("NPC_COUNTER_SURENESS", "2"))


def baseline_row(player: str, npc: str, rounds: int, npc_wins: int, stats: dict[str, Any] | None = None) -> Matchup:
    """The row for the first behaviour, with no option forced."""
    return Matchup(player=player, npc=npc, decision="", option=BASELINE,
                   rounds=rounds, npc_wins=npc_wins, stats=stats or {})


def is_baseline(row: Matchup) -> bool:
    return row.option == BASELINE and row.decision == ""


def win_rate(row: Matchup) -> float:
    """The share of practice rounds the NPC won."""
    return row.npc_wins / row.rounds if row.rounds else 0.0


def baseline(matchups: list[Matchup], player: str, npc: str) -> Matchup | None:
    """The baseline row for one practice player and one NPC, if it was run."""
    for row in matchups:
        if is_baseline(row) and row.player == player and row.npc == npc:
            return row
    return None


def players(matchups: list[Matchup]) -> list[str]:
    """Every practice player in the table, in the order first seen."""
    seen: list[str] = []
    for row in matchups:
        if row.player not in seen:
            seen.append(row.player)
    return seen


def beats(rate: float, base: float, margin: float = CLEAR_MARGIN) -> bool:
    """Whether a win rate is clearly above the baseline rate."""
    return rate - base + 1e-9 >= max(margin * base, MIN_GAP)


def noise(rate: float, rounds: int, base: float, base_rounds: int) -> float:
    """One standard error of the gap between two measured win rates."""
    return math.sqrt(rate * (1 - rate) / rounds + base * (1 - base) / base_rounds)


def counters(matchups: list[Matchup], player: str, margin: float = CLEAR_MARGIN) -> list[dict[str, Any]]:
    """The options that clearly beat the baseline against one practice player, best first."""
    found = []
    for row in matchups:
        if is_baseline(row) or row.player != player:
            continue
        base = baseline(matchups, player, row.npc)
        if base is None or not row.rounds or not base.rounds:
            continue
        rate, base_rate = win_rate(row), win_rate(base)
        if not beats(rate, base_rate, margin):
            continue
        if rate - base_rate + 1e-9 < SURENESS * noise(rate, row.rounds, base_rate, base.rounds):
            continue  # could be luck at this many rounds
        found.append({
            "player": player,
            "npc": row.npc,
            "decision": row.decision,
            "option": row.option,
            "npc_wins": row.npc_wins,
            "rounds": row.rounds,
            "baseline_wins": base.npc_wins,
            "baseline_rounds": base.rounds,
            "gap": round(rate - base_rate, 3),
        })
    return sorted(found, key=lambda counter: counter["gap"], reverse=True)


def likeness(values: dict[str, float], names: list[str], prefix: str = "like_") -> dict[str, float]:
    """How much the live player resembles each practice player, summing to 1.

    Reads the `like_<name>` values. With no read yet, every player counts the same.
    """
    raw = {name: max(float(values.get(prefix + name, 0.0)), 0.0) for name in names}
    total = sum(raw.values())
    if not names:
        return {}
    if total <= 0:
        return {name: round(1 / len(names), 3) for name in names}
    return {name: round(share / total, 3) for name, share in raw.items()}


def best_counters(
    matchups: list[Matchup],
    resembles: dict[str, float],
    margin: float = CLEAR_MARGIN,
    top: int = 5,
) -> list[dict[str, Any]]:
    """The counters worth installing against a live player, most specific first.

    `resembles` maps each practice player to a weight (see `likeness`). Each
    row is one option against one practice player it clearly beats, with its
    `edge` over the baseline and the `likeness` of the live player to that
    practice player.

    An option that beats everyone says nothing about this player. So each row
    also has `specific`: its edge against this practice player minus its
    average edge against the others. Rows are ranked by specific times
    likeness. An option that clearly beats the baseline against every
    practice player is marked `general` and goes last.
    """
    names = players(matchups)
    everyone = general_options(matchups, margin)
    rows = []
    for player, weight in resembles.items():
        if weight <= 0:
            continue
        for counter in counters(matchups, player, margin):
            key = (counter["npc"], counter["decision"], counter["option"])
            others = [edge(matchups, other, *key) for other in names if other != player]
            others = [gap for gap in others if gap is not None]
            rows.append({
                "npc": counter["npc"],
                "decision": counter["decision"],
                "option": counter["option"],
                "edge": counter["gap"],
                "specific": round(counter["gap"] - (sum(others) / len(others) if others else 0.0), 3),
                "general": key in everyone,
                "against": player,
                "likeness": weight,
                "npc_wins": counter["npc_wins"],
                "rounds": counter["rounds"],
                "baseline_wins": counter["baseline_wins"],
                "baseline_rounds": counter["baseline_rounds"],
            })
    rows.sort(key=lambda row: (not row["general"], row["specific"] * row["likeness"]), reverse=True)
    return rows[:top]


def edge(matchups: list[Matchup], player: str, npc: str, decision: str, option: str) -> float | None:
    """How far one option moves the NPC's win rate against one practice player, or None if never played."""
    base = baseline(matchups, player, npc)
    for row in matchups:
        if (row.player, row.npc, row.decision, row.option) == (player, npc, decision, option):
            if base is None or not row.rounds or not base.rounds:
                return None
            return round(win_rate(row) - win_rate(base), 3)
    return None


def general_options(matchups: list[Matchup], margin: float = CLEAR_MARGIN) -> set[tuple[str, str, str]]:
    """The options that clearly beat the baseline against every practice player.

    They make the NPC harder for everyone, so they are no answer to one player's habits.
    """
    names = players(matchups)
    if len(names) < 2:
        return set()
    clear = [{(row["npc"], row["decision"], row["option"]) for row in counters(matchups, name, margin)} for name in names]
    needed = max(2, math.ceil(config.GENERAL_COUNTER_SHARE * len(names)))
    return {key for key in set.union(*clear) if sum(key in found for found in clear) >= needed}


def holes(matchups: list[Matchup]) -> set[tuple[str, str, str]]:
    """Options that win nearly every round against every practice player: a hole in the game, not a counter."""
    names = players(matchups)
    if len(names) < 2:
        return set()
    strong = [{(row.npc, row.decision, row.option) for row in matchups
               if row.player == name and not is_baseline(row) and row.rounds and win_rate(row) >= config.HOLE_WIN_RATE}
              for name in names]
    return set.intersection(*strong)


def dose(matchups: list[Matchup], resembles: dict[str, float], npc: str, decision: str, option: str,
         target: float) -> float | None:
    """The share of picks to give a counter so the player's share lands on the target.

    With b the NPC's win rate on its default and c its win rate with the
    counter at full weight, against the practice player this player is most
    like, the share x that leaves the player a share s is ((1 - s) - b) / (c - b).
    """
    if not resembles:
        return None
    player = max(resembles, key=lambda name: resembles[name])
    base, gap = baseline(matchups, player, npc), edge(matchups, player, npc, decision, option)
    if base is None or not base.rounds or gap is None or gap <= 0:
        return None
    return round(min(max(((1 - target) - win_rate(base)) / gap, 0.0), 1.0), 3)


def rule_key(rule: dict[str, Any]) -> str:
    return json.dumps([rule.get("if"), rule.get("do")], sort_keys=True)


def _shares(behaviour: dict[str, Any], npc: str, decision: str, values: dict[str, float],
            fired: dict[str, float] | None = None) -> dict[str, float]:
    """How often each option of one decision is played: the weights as shares, with any rule on top."""
    entry = (behaviour.get("npcs") or {}).get(npc) or {}
    scores = {}
    for option, weights in ((entry.get("decisions") or {}).get(decision) or {}).items():
        score = float((weights or {}).get("base", 0))
        score += sum(float(weight) * float(values.get(value, 0)) for value, weight in ((weights or {}).get("when") or {}).items())
        scores[option] = max(score, 0.0)
    total = sum(scores.values())
    shares = {option: score / total for option, score in scores.items()} if total else {}
    for rule in reversed(entry.get("rules") or []):  # the first rule is checked first, so it is applied last here
        option = (rule.get("do") or {}).get(decision)
        if option is None:
            continue
        # How often the rule fires: what was seen in this match, or a set share when there is nothing to go on.
        fires = (fired or {}).get(rule_key(rule), config.RULE_FIRE_SHARE) if rule.get("if") else 1.0
        shares = {name: share * (1 - fires) for name, share in shares.items()}
        shares[option] = shares.get(option, 0.0) + fires
    return shares


def estimate_share(matchups: list[Matchup], resembles: dict[str, float], behaviour: dict[str, Any],
                   default: dict[str, Any], values: dict[str, float] | None = None,
                   fired: dict[str, float] | None = None) -> float | None:
    """The player's estimated share of rounds under `behaviour`, from the practice table.

    The table has, for each practice player, how often the NPC wins with its
    default and with each option at full weight. Playing an option more often
    than the default does moves the NPC's win rate by that much of the
    option's edge. The estimate mixes the practice players by how much this
    player resembles them. None when the table has no baseline to start from.
    """
    values = values or {}
    total = weighted = 0.0
    for player, weight in resembles.items():
        if weight <= 0:
            continue
        for npc in (behaviour.get("npcs") or {}):
            base = baseline(matchups, player, npc)
            if base is None or not base.rounds:
                continue
            rate = win_rate(base)
            decisions = set(((behaviour["npcs"].get(npc) or {}).get("decisions") or {})) | \
                set((((default.get("npcs") or {}).get(npc) or {}).get("decisions") or {}))
            for decision in decisions:
                now, first = _shares(behaviour, npc, decision, values, fired), _shares(default, npc, decision, {})
                for option in set(now) | set(first):
                    gap = edge(matchups, player, npc, decision, option)
                    if gap is not None:
                        rate += (now.get(option, 0.0) - first.get(option, 0.0)) * gap
            weighted += weight * (1 - min(max(rate, 0.0), 1.0))
            total += weight
    return round(weighted / total, 3) if total else None


def describe(counter: dict[str, Any]) -> str:
    """One plain line for a row from `counters` or `best_counters`."""
    def words(name: Any) -> str:
        return str(name).replace("_", " ")

    player = counter.get("against") or counter.get("player")
    return (
        f"{words(counter['option'])} for {words(counter['decision'])} against {words(player)}: "
        f"{words(counter['npc'])} won {counter['npc_wins']} of {counter['rounds']}, up from "
        f"{counter['baseline_wins']} of {counter['baseline_rounds']}."
    )
