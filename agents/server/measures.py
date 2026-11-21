"""How we measure a player's habits, and whether the NPCs have answered them.

Plain counting over the messages a game already sends. Nothing here is tied
to one game: a habit is any value of any event field that the player picks
far more often than an even spread would give.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

from . import config

Message = dict[str, Any]


def _options(setup: Message, event_name: str, field_name: str) -> list[str] | None:
    """The allowed names for one event field, or None if it isn't a list of names."""
    spec = setup.get("events", {}).get(event_name, {}).get("fields", {}).get(field_name)
    if isinstance(spec, list):
        return spec
    if isinstance(spec, str):
        named = setup.get("lists", {}).get(spec)
        if isinstance(named, list):
            return named
    return None


def is_player_choice(setup: Message, field_name: str) -> bool:
    """Whether a field on a player's event is something the player chose.

    A field that reports the outcome, or what an NPC was doing at the time,
    says nothing about the player's habits.
    """
    if field_name in config.NOT_A_HABIT_FIELDS:
        return False
    prefixes = config.NOT_A_HABIT_PREFIXES + tuple(f"{npc}_" for npc in (setup.get("npcs") or {}))
    return not field_name.startswith(prefixes)


def is_npc_event(setup: Message, event_name: str) -> bool:
    """Whether an event is an NPC's own action, and so says nothing about the player.

    `setup` does not say who sends an event, so this goes by what it does
    declare. The event is named after one of an NPC's decisions, or every
    named field it has offers exactly the options of one of those decisions.
    An event with other named fields as well is one the player sends too.
    """
    fields = (setup.get("events", {}).get(event_name) or {}).get("fields") or {}
    named = [set(names) for field_name in fields if (names := _options(setup, event_name, field_name))]
    decided: list[set[str]] = []
    for npc in (setup.get("npcs") or {}).values():
        for decision, detail in ((npc or {}).get("decisions") or {}).items():
            if decision == event_name:
                return True
            decided.append(set((detail or {}).get("options") or {}))
    return bool(named) and all(names in decided for names in named)


def is_guess(field_name: str) -> bool:
    """Whether a field is a guess at what the player is about to do, and not what they did."""
    return any(word in field_name for word in config.GUESS_WORDS)


def says_outcome(setup: Message, event_name: str) -> bool:
    """Whether an event also says how the action turned out."""
    fields = (setup.get("events", {}).get(event_name) or {}).get("fields") or {}
    return any(name in config.OUTCOME_FIELDS for name in fields)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def habits(setup: Message, events: list[Message], minimum_uses: int = 3) -> list[dict[str, Any]]:
    """The player's habits, strongest first.

    Each habit is one value of one field, with its `share` of the player's
    uses of that field and its `lift`: how far the share sits above an even
    spread across the options.

    A field shows up once. When two events carry the same field, the habit is
    counted on the event that also says how the action turned out, or else on
    the one seen most. A field that is only a guess is never a habit.
    """
    counts: dict[tuple[str, str], Counter] = defaultdict(Counter)
    for event in events:
        if event.get("by") != "player" or is_npc_event(setup, event.get("name", "")):
            continue
        for field_name, value in (event.get("data") or {}).items():
            if not is_player_choice(setup, field_name) or is_guess(field_name):
                continue
            if _options(setup, event["name"], field_name) is not None and isinstance(value, str):
                counts[(event["name"], field_name)][value] += 1

    # One event for each field.
    best: dict[str, str] = {}
    for (event_name, field_name), counter in counts.items():
        rank = (says_outcome(setup, event_name), sum(counter.values()))
        other = best.get(field_name)
        if other is None or rank > (says_outcome(setup, other), sum(counts[(other, field_name)].values())):
            best[field_name] = event_name

    found = []
    for (event_name, field_name), counter in counts.items():
        if best[field_name] != event_name:
            continue
        total = sum(counter.values())
        options = _options(setup, event_name, field_name) or []
        if total < minimum_uses or not options:
            continue
        even = 1 / len(options)
        for value, uses in counter.items():
            share = uses / total
            found.append({
                "event": event_name,
                "field": field_name,
                "value": value,
                "uses": uses,
                "share": round(share, 3),
                "lift": round(share - even, 3),
            })
    return sorted(found, key=lambda habit: habit["lift"], reverse=True)


def habit_payoff(habit: dict[str, Any], events: list[Message], rounds: list[Message]) -> dict[str, Any]:
    """How well a habit is working for the player.

    Every use of the habit takes the result of the round it happened in. The
    payoff is the share of uses that came in rounds the player won.
    """
    won = {r["round"]: r.get("winner") == "player" for r in rounds}
    uses = wins = 0
    for event in events:
        if event.get("by") != "player" or event.get("name") != habit["event"]:
            continue
        if (event.get("data") or {}).get(habit["field"]) != habit["value"]:
            continue
        if event.get("round") not in won:
            continue
        uses += 1
        wins += 1 if won[event["round"]] else 0
    return {"uses": uses, "wins": wins, "payoff": round(wins / uses, 3) if uses else None}


def player_win_rate(rounds: list[Message]) -> float | None:
    """The share of finished rounds the player won."""
    if not rounds:
        return None
    return round(sum(1 for r in rounds if r.get("winner") == "player") / len(rounds), 3)


def _bucket(spec: Any, value: Any) -> str | None:
    """Which third of its declared range a number falls in: low, middle or high."""
    if not isinstance(spec, dict) or not _is_number(value):
        return None
    low, high = spec.get("min"), spec.get("max")
    if not _is_number(low) or not _is_number(high) or high <= low:
        return None
    share = (value - low) / (high - low)
    return "low" if share < 1 / 3 else "high" if share > 2 / 3 else "middle"


def _as_names(setup: Message, event: Message) -> dict[str, str]:
    """Every field of one event as a name: a named value as it is, a number as low, middle or high."""
    fields = (setup.get("events", {}).get(event.get("name")) or {}).get("fields") or {}
    named: dict[str, str] = {}
    for field_name, value in (event.get("data") or {}).items():
        if _options(setup, event["name"], field_name) is not None and isinstance(value, str):
            named[field_name] = value
        else:
            bucket = _bucket(fields.get(field_name), value)
            if bucket is not None:
                named[field_name] = bucket
    return named


def tells(setup: Message, events: list[Message], limit: int = 8) -> dict[str, list[dict[str, Any]]]:
    """Early signs, and whether they hold up.

    When one player event is followed by a different player event in the same
    round, a moment later, the first is an early sign and the second is what
    really happened. Each value of the first is counted against each named
    value of the second. A sign has `held` when it was seen often enough, was
    followed by the same thing a high enough share of the time, and that
    share is above how often the same thing follows anyway (its `lift`). The
    rest are `weak`, with the reason. Both lists put the most telling first.
    """
    declared = setup.get("events", {})
    player = [event for event in events if event.get("by") == "player" and event.get("name") in declared
              and not is_npc_event(setup, event["name"])]
    counts: dict[tuple[str, str, str, str, str], Counter] = defaultdict(Counter)
    anyway: dict[tuple[str, str, str], Counter] = defaultdict(Counter)   # what follows, whatever the sign was
    for first, second in zip(player, player[1:]):
        if first.get("round") != second.get("round") or first["name"] == second["name"]:
            continue
        began, ended = first.get("t"), second.get("t")
        if not _is_number(began) or not _is_number(ended) or not 0 <= ended - began <= config.TELL_WINDOW_SECONDS:
            continue
        signs = _as_names(setup, first)
        for then_field, then_value in (second.get("data") or {}).items():
            if not is_player_choice(setup, then_field) or is_guess(then_field) or not isinstance(then_value, str):
                continue
            if _options(setup, second["name"], then_field) is None:
                continue
            anyway[(first["name"], second["name"], then_field)][then_value] += 1
            for field_name, value in signs.items():
                counts[(first["name"], field_name, value, second["name"], then_field)][then_value] += 1

    held, weak = [], []
    for (event_name, field_name, value, then_event, then_field), counter in counts.items():
        pairs = sum(counter.values())
        then_value, hits = counter.most_common(1)[0]
        base = anyway[(event_name, then_event, then_field)]
        lift = hits / pairs - base[then_value] / sum(base.values())
        row = {"event": event_name, "field": field_name, "value": value, "then_event": then_event,
               "then_field": then_field, "then_value": then_value, "hits": hits, "pairs": pairs,
               "share": round(hits / pairs, 3), "lift": round(lift, 3)}
        if pairs < config.TELL_MIN_PAIRS:
            weak.append({**row, "why": "seen too few times"})
        elif hits / pairs < config.TELL_MIN_SHARE:
            weak.append({**row, "why": "not followed often enough"})
        elif lift + 1e-9 < config.TELL_MIN_LIFT:
            weak.append({**row, "why": "the same thing follows anyway"})
        else:
            held.append(row)
    held.sort(key=lambda row: (row["lift"], row["pairs"]), reverse=True)
    weak.sort(key=lambda row: (row["why"] != "the same thing follows anyway", row["pairs"]), reverse=True)
    return {"held": held[:limit], "weak": weak[:limit]}


def summary(setup: Message, events: list[Message], rounds: list[Message]) -> dict[str, Any]:
    """One snapshot for the second screen and for the proof run."""
    top = habits(setup, events)[:3]
    for habit in top:
        habit.update(habit_payoff(habit, events, rounds))
    return {
        "rounds": len(rounds),
        "player_win_rate": player_win_rate(rounds),
        "habits": top,
        "tells": tells(setup, events),
    }


def rounds_played(rounds: list[Message], events: list[Message]) -> list[Message]:
    """The finished rounds the player took part in: those with at least one event the player sent.

    A round the player sat out says nothing about how the match is going
    for them, so every fairness count reads this list and not all rounds.
    """
    took_part = {event.get("round") for event in events if event.get("by") == "player"}
    return [round_end for round_end in rounds if round_end.get("round") in took_part]


def how_won_rounds_end(setup: Message, rounds: list[Message], events: list[Message], minimum: int = 3) -> list[str]:
    """How the rounds the player won ended, in plain lines built from the game's own names.

    The first line counts the most common `how` of those rounds. The second
    says what the player's last event in those rounds had in common: the
    listed field and value seen most often. Nothing here knows the game.
    """
    won = [round_end for round_end in rounds if round_end.get("winner") == "player"]
    ways: dict[str, int] = {}
    for round_end in won:
        if round_end.get("how"):
            ways[str(round_end["how"])] = ways.get(str(round_end["how"]), 0) + 1
    if len(won) < minimum or not ways:
        return []
    how, count = max(ways.items(), key=lambda item: item[1])
    lines = [f"{count} of your {len(won)} won rounds ended {how}."]
    those = {round_end.get("round") for round_end in won if str(round_end.get("how")) == how}
    last: dict[Any, Message] = {}
    for event in events:  # in time order, so the last one of each round stays
        if event.get("by") == "player" and event.get("round") in those:
            last[event.get("round")] = event
    seen: dict[tuple[str, str, str], int] = {}
    for event in last.values():
        for field_name, value in (event.get("data") or {}).items():
            if _options(setup, str(event.get("name")), field_name) and field_name not in config.OUTCOME_FIELDS \
                    and not is_guess(field_name):
                key = (str(event.get("name")), field_name, str(value))
                seen[key] = seen.get(key, 0) + 1
    common = [(hits, key) for key, hits in seen.items() if hits >= max(minimum, (len(last) + 1) // 2)]
    for hits, (event_name, field_name, value) in sorted(common, reverse=True)[:2]:
        lines.append(f"Your last {event_name} in those rounds had {field_name} {value} in {hits}.")
    return lines
