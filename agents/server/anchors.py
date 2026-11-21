"""Counted shares that anchor the player read.

Some values can be counted straight from the player's events: the share of
one option (or a few options) of one field. For those, the watcher asks the
Decisions API what the player's next action will be, so its answer is a
share, and blends it with the counted share by how much evidence there is.
A `like_<persona>` value whose persona carries `plays` numbers is anchored
by how well those numbers explain the counts.

Nothing here knows the game: every name comes from `setup` and the design.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any

from server import config
from server.interfaces import Message, ValueSpec

# A value's counted share leads once this many events back it: the count's
# weight is n / (n + _COUNT_PRIOR), so 8 events give the count 0.8.
_COUNT_PRIOR = 2.0

# A counted value isn't called a habit until this many events back it: until
# then it is listed in `low_confidence`.
MIN_EVENTS = 3

# Only the latest events of a match count, so a player who changes is followed.
_COUNT_LAST = 40

# Persona likeness weighs the counts as at most this many events.
_LIKENESS_EVENTS = 12

# The prefix the designer gives persona likeness values.
LIKE = "like_"


@dataclass
class Target:
    """One countable share: of `options` among `field` values of the player's `event` events."""

    event: str
    field: str
    options: list[str]   # the options that make up the share
    all_options: list[str]
    events: list[str] | None = None  # other events with the same field, when the value names no event


def _words(text: str) -> set[str]:
    """Lower-case words, with a trailing plural `s` also kept stripped."""
    found = set(re.findall(r"[a-z0-9]+", text.lower().replace("_", " ")))
    return found | {w[:-1] for w in found if len(w) > 3 and w.endswith("s")}


def list_fields(setup: Message) -> list[tuple[str, str, list[str]]]:
    """Every (event, field, options) where the field is a list of names, NPC-side fields left out."""
    prefixes = config.NOT_A_HABIT_PREFIXES + tuple(f"{npc}_" for npc in (setup.get("npcs") or {}))
    found = []
    for event, spec in (setup.get("events") or {}).items():
        for field_name, kind in ((spec or {}).get("fields") or {}).items():
            options = kind if isinstance(kind, list) else (setup.get("lists") or {}).get(kind) if isinstance(kind, str) else None
            if isinstance(options, list) and options and not field_name.startswith(prefixes):
                found.append((event, field_name, [str(o) for o in options]))
    return found


def _field_options(setup: Message, event: str, field_name: str) -> tuple[list[str], str | None]:
    """A field's options and the name of the list they come from, if any."""
    kind = (((setup.get("events") or {}).get(event) or {}).get("fields") or {}).get(field_name)
    if isinstance(kind, list):
        return [str(o) for o in kind], None
    if isinstance(kind, str) and isinstance((setup.get("lists") or {}).get(kind), list):
        return [str(o) for o in setup["lists"][kind]], kind
    return [], None


def target_for(setup: Message, spec: ValueSpec) -> Target | None:
    """The countable share a value names, or None when it can't be counted.

    A value that carries `counts` from the designer is counted exactly as it
    says, once it checks out against `setup`. Without `counts`, a guess is only
    made when it is safe: the value's own name or about line names options of
    exactly one field, and also names that field or the list its options come
    from. Anything else keeps the model's read.
    """
    counts = getattr(spec, "counts", None)
    if isinstance(counts, dict):
        event, field_name = str(counts.get("event") or ""), str(counts.get("field") or "")
        options, _ = _field_options(setup, event, field_name)
        wanted = [str(v) for v in counts.get("values") or [] if str(v) in options]
        if options and wanted and len(wanted) < len(options):
            return Target(event, field_name, wanted, options)
        return None
    if spec.name.startswith(LIKE):
        return None
    own = _words(" ".join([spec.name, spec.about]))
    # The question may say which event to count (`shot`), which only chooses among fields already matched.
    quoted = _words(" ".join(re.findall(r"`([^`]+)`", str(spec.question.get("instructions") or ""))))
    candidates: list[tuple[bool, Target]] = []
    for event, field_name, options in list_fields(setup):
        matched = [o for o in options if _words(o) <= own]
        if not matched or len(matched) == len(options):
            continue
        _, list_name = _field_options(setup, event, field_name)
        if not (_words(field_name) <= own or (list_name and _words(list_name) <= own)):
            continue
        candidates.append((_words(event) <= own | quoted, Target(event, field_name, matched, options)))
    if len({c[1].field for c in candidates}) != 1:
        return None
    named = [c for c in candidates if c[0]]
    if named:
        return named[0][1]
    target = candidates[0][1]
    target.events = [c[1].event for c in candidates]
    return target


def resolve(target: Target, events: list[Message]) -> Target:
    """When the value named no event, count the event the player sends most often with this field."""
    if not target.events or len(target.events) < 2:
        return target
    def uses(event: str) -> int:
        return sum(1 for e in events if e.get("by") == "player" and e.get("name") == event
                   and (e.get("data") or {}).get(target.field) is not None)
    best = max(target.events, key=uses)
    return Target(best, target.field, target.options, target.all_options, target.events)


def counted_share(events: list[Message], target: Target) -> tuple[float, int, int]:
    """(share, uses, events counted) over the player's latest events of the target's kind."""
    values = [
        (e.get("data") or {}).get(target.field)
        for e in events
        if e.get("by") == "player" and e.get("name") == target.event
    ]
    values = [str(v) for v in values if v is not None][-_COUNT_LAST:]
    if not values:
        return 0.0, 0, 0
    uses = sum(1 for v in values if v in target.options)
    return uses / len(values), uses, len(values)


def count_weight(n: int) -> float:
    """How much the counted share leads, from 0 with no events to near 1 with many."""
    return n / (n + _COUNT_PRIOR)


def next_action_question(target: Target) -> dict[str, Any]:
    """A question about the player's next action, so its answer is a share.

    "Does the player play X?" is true after one X, so its probability is not
    a share. "What will the next one be?" is.
    """
    return {
        "type": "choice",
        "instructions": (
            f"The player's next `{target.event}` event: which `{target.field}` will it have? "
            f"Judge by the counts of the player's `{target.field}` so far and by the latest frames."
        ),
        "criteria": {option: option.replace("_", " ") for option in target.all_options},
    }


def share_from_answer(target: Target, answer: dict[str, Any]) -> tuple[float, float]:
    """(share, confidence) from the next-action choice: the probability of the target's options."""
    probabilities = {str(k): float(p) for k, p in (answer.get("probabilities") or {}).items()}
    share = sum(probabilities.get(o, 0.0) for o in target.options)
    return min(max(share, 0.0), 1.0), min(max(float(answer.get("confidence", 0.0)), 0.0), 1.0)


def persona_likeness(
    setup: Message, personas: list[dict[str, Any]], events: list[Message], wanted: list[str] | None = None
) -> tuple[dict[str, float], int]:
    """How likely each persona is to have made the player's counted choices.

    Returns ({persona name: probability}, events counted). The probabilities
    add up to 1 over the personas.

    A persona is only judged on what its `plays` say. On a field it says
    nothing about, it is scored with the average of what the personas that do
    speak on that field say, so silence gives neither an edge nor a penalty
    and the ranking comes from the fields where personas really differ.

    If any persona in `wanted` has no `plays` at all, nothing is returned, so
    no persona is ranked below the others just because it has no numbers.
    """
    by_name = {str(p.get("name")): p for p in personas}
    if wanted is not None:
        if any(name not in by_name or "plays" not in by_name[name] for name in wanted):
            return {}, 0
        personas = [by_name[name] for name in wanted]
    fields = {(e, f): opts for e, f, opts in list_fields(setup)}

    def says(persona: dict[str, Any], event: str, field_name: str) -> dict[str, float]:
        shares = ((persona.get("plays") or {}).get(event) or {}).get(field_name) or {}
        return {str(k): float(v) for k, v in shares.items()} if isinstance(shares, dict) else {}

    used = sorted({(event, field_name) for p in personas for event, by_field in (p.get("plays") or {}).items()
                   for field_name in (by_field or {}) if (event, field_name) in fields})
    if not used or len(personas) < 2:
        return {}, 0

    counts: dict[tuple[str, str], dict[str, int]] = {}
    seen = 0
    for event, field_name in used:
        values = [str((e.get("data") or {}).get(field_name)) for e in events
                  if e.get("by") == "player" and e.get("name") == event
                  and (e.get("data") or {}).get(field_name) is not None][-_COUNT_LAST:]
        counts[(event, field_name)] = {v: values.count(v) for v in set(values)}
        seen = max(seen, len(values))
    if seen == 0:
        return {}, 0

    # What the personas that speak on a field say, on average: the "no opinion" answer.
    consensus: dict[tuple[str, str], dict[str, float]] = {}
    for event, field_name in used:
        speaking = [says(p, event, field_name) for p in personas if says(p, event, field_name)]
        options = fields[(event, field_name)]
        consensus[(event, field_name)] = {o: sum(s.get(o, 0.0) for s in speaking) / len(speaking) for o in options}

    # The evidence counts as at most _LIKENESS_EVENTS events, so a long match
    # doesn't push one persona to certainty over a small difference.
    temper = min(1.0, _LIKENESS_EVENTS / seen)
    logs: dict[str, float] = {}
    for persona in personas:
        total = 0.0
        for (event, field_name), got in counts.items():
            options = fields[(event, field_name)]
            shares = says(persona, event, field_name) or consensus[(event, field_name)]
            for value, n in got.items():
                # A little of an even spread, so one unexpected choice isn't impossible.
                q = 0.85 * shares.get(value, 0.0) + 0.15 / len(options)
                total += n * math.log(q)
        logs[str(persona.get("name"))] = temper * total
    top = max(logs.values())
    weights = {name: math.exp(v - top) for name, v in logs.items()}
    norm = sum(weights.values())
    return {name: w / norm for name, w in weights.items()}, seen
