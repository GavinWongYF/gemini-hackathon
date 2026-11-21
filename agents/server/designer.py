"""The designer: runs once per game, when a developer registers it.

From `setup` alone it decides what is worth tracking about the player, writes
the question that reads each value, writes a few practice players, and writes
the first behaviour. If the game can play practice rounds, it playtests every
NPC option against every practice player and keeps the results as the matchup
table.

The model call and the practice rounds run side by side, so the game gets its
first practice run at once. Practice mode is in no hurry: the design waits
for the model, playtests the practice players it wrote, and merges its
questions with the ones built in code. Only when the model fails, or a cap
passes, does the design go ahead on the code-built questions alone, and then
it says which in the trace and in its notes. It never runs during a match,
and it never fails.
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import re
import time
from typing import Any, Awaitable, Callable

from server import config, matchups, measures, models_client
from server.interfaces import (
    Behaviour, Design, Designer, Matchup, Message, Playtest, PracticeRefused, Trace, ValueSpec, trace_message,
)

# Practice rounds for each run, and caps on the whole playtest.
PLAYTEST_ROUNDS = int(os.environ.get("NPC_PLAYTEST_ROUNDS", "60"))
PLAYTEST_MIN_ROUNDS = int(os.environ.get("NPC_PLAYTEST_MIN_ROUNDS", "8"))
PLAYTEST_MAX_RUNS = int(os.environ.get("NPC_PLAYTEST_MAX_RUNS", "120"))
PLAYTEST_MAX_ROUNDS = int(os.environ.get("NPC_PLAYTEST_MAX_ROUNDS", "6000"))
PLAYTEST_MAX_SECONDS = float(os.environ.get("NPC_PLAYTEST_MAX_SECONDS", "180"))
PLAYTEST_RUN_TIMEOUT = float(os.environ.get("NPC_PLAYTEST_RUN_TIMEOUT", "30"))
DESIGNER_TIMEOUT = float(os.environ.get("NPC_DESIGNER_TIMEOUT_SECONDS", "240"))

# In practice mode `design` holds on this long for the model before it goes
# ahead on the code-built questions alone.
PRACTICE_WAIT = float(os.environ.get("NPC_DESIGNER_PRACTICE_WAIT_SECONDS", "150"))
# Once the model has answered, its practice players get this long to be playtested.
DESIGN_BUDGET = float(os.environ.get("NPC_DESIGN_BUDGET_SECONDS", "75"))
# While setup runs, a line says where it is at least this often.
STEP_SECONDS = float(os.environ.get("NPC_DESIGNER_STEP_SECONDS", "10"))

LIKE = "like_"
STAND_IN_NOTE = "Matchup table learned on a stand-in game. Provisional."
SCORE_LEVELS = ["Never", "Rarely", "About half the time", "Mostly", "Almost always"]

Ask = Callable[..., Awaitable[models_client.ModelReply]]

SYSTEM = (
    "You set up an adaptive-opponent service for one game. A game describes itself once, and you "
    "decide what the service should track about the human player. Use the game's own names for "
    "events, fields and options, spelled exactly as given. Be concrete and brief."
)


# ---------------------------------------------------------------- reading setup

def snake(text: str) -> str:
    """A safe snake_case name."""
    return re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_")


def words(name: Any) -> str:
    """A name from the game as plain words, for lines people read."""
    return str(name).replace("_", " ")


_LEFT_HANGING = {"a", "an", "the", "and", "or", "but", "so", "to", "of", "for", "with", "in", "on", "at", "by",
                 "when", "that", "which", "is", "was", "are", "as", "than", "then", "from", "into", "about", "i", "my", "your"}


def shorten(text: Any, limit: int) -> str:
    """A line of at most `limit` words. A longer line is cut back to the end of a
    clause when it has one, and never inside a word or on a word left hanging."""
    parts = str(text or "").split()
    if len(parts) <= limit:
        return " ".join(parts)
    kept = parts[:limit]
    for index in range(len(kept) - 1, limit // 2 - 2, -1):  # keep at least half the line
        if kept[index].endswith((".", ",", ";", ":", "!", "?")):
            kept = kept[: index + 1]
            break
    else:
        while len(kept) > 1 and kept[-1].lower().strip(".,;:") in _LEFT_HANGING:
            kept.pop()
    line = " ".join(kept).rstrip(",;:- ")
    return line if line.endswith((".", "!", "?")) else line + "."


def names_of(setup: Message, spec: Any) -> list[str] | None:
    """The allowed names for one field or fact, or None if it isn't a list of names."""
    if isinstance(spec, list):
        return [str(name) for name in spec]
    if isinstance(spec, str):
        named = setup.get("lists", {}).get(spec)
        if isinstance(named, list):
            return [str(name) for name in named]
    return None


def list_fields(setup: Message) -> list[tuple[str, str, list[str]]]:
    """Every event field the player chooses from a list of names: (event, field, names).

    Left out, because they say nothing about the player's habits: fields that
    report an outcome or what an NPC was doing, fields that are only a guess,
    and every event that is an NPC's own action. When two events repeat a
    field, it is kept on the one that also says how the action turned out.
    That is the player's main action, and the one a practice player plays.
    """
    found = []
    for event, spec in (setup.get("events") or {}).items():
        if measures.is_npc_event(setup, event):
            continue
        for field_name, kind in (spec.get("fields") or {}).items():
            options = names_of(setup, kind)
            if options and len(options) >= 2 and measures.is_player_choice(setup, field_name) \
                    and not measures.is_guess(field_name):
                found.append((event, field_name, options))
    home: dict[str, str] = {}
    for event, field_name, _ in found:
        if field_name not in home or (measures.says_outcome(setup, event) and not measures.says_outcome(setup, home[field_name])):
            home[field_name] = event
    return [row for row in found if home[row[1]] == row[0]]


def option_ids(setup: Message) -> dict[str, tuple[str, str, str]]:
    """Every NPC option under one id: "<npc>.<decision>.<option>"."""
    ids = {}
    for npc, spec in (setup.get("npcs") or {}).items():
        for decision, detail in (spec.get("decisions") or {}).items():
            for option in (detail.get("options") or {}):
                ids[f"{npc}.{decision}.{option}"] = (npc, decision, option)
    return ids


def first_behaviour(setup: Message) -> Behaviour:
    """The game's default behaviour, or every option equally likely. Version 1."""
    default = setup.get("default_behaviour") or {}
    behaviour: Behaviour = {"version": 1, "npcs": {}}
    for npc, spec in (setup.get("npcs") or {}).items():
        given = copy.deepcopy((default.get("npcs") or {}).get(npc) or {})
        decisions = {}
        for decision, detail in (spec.get("decisions") or {}).items():
            options = list(detail.get("options") or {})
            had = (given.get("decisions") or {}).get(decision) or {}
            even = round(1 / len(options), 3) if options else 0
            decisions[decision] = {
                option: (had[option] if isinstance(had.get(option), dict) else {"base": even})
                for option in options
            }
        behaviour["npcs"][npc] = {"decisions": decisions, "rules": list(given.get("rules") or [])[:4]}
    return behaviour


def forced(behaviour: Behaviour, npc: str, decision: str, option: str) -> Behaviour:
    """A copy of `behaviour` with all the weight of one decision on one option, and no rules."""
    test = copy.deepcopy(behaviour)
    test["version"] = 0
    for entry in test["npcs"].values():
        entry["rules"] = []
    choices = test["npcs"][npc]["decisions"][decision]
    for name in choices:
        choices[name] = {"base": 1 if name == option else 0}
    return test


# ---------------------------------------------------------------- asking the model

def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def numeric_settings(setup: Message) -> dict[str, dict[str, Any]]:
    """The settings `setup` declares as a number with a `min` and a `max`."""
    settings = setup.get("settings")
    if not isinstance(settings, dict):
        return {}
    return {
        name: spec for name, spec in settings.items()
        if isinstance(spec, dict) and _is_number(spec.get("min")) and _is_number(spec.get("max")) and spec["max"] > spec["min"]
    }


def usable_dials(setup: Message, dials: Any) -> list[dict[str, str]]:
    """Keep the dials that name a numeric setting of this game and say which way is harder."""
    numeric = numeric_settings(setup)
    kept: list[dict[str, str]] = []
    for dial in dials if isinstance(dials, list) else []:
        if not isinstance(dial, dict):
            continue
        name, harder = dial.get("setting"), dial.get("harder")
        if name in numeric and harder in ("up", "down") and all(name != other["setting"] for other in kept):
            kept.append({"setting": name, "harder": harder})
    return kept


def env_dials(setup: Message) -> list[dict[str, str]]:
    """Dials named by hand in NPC_FAIRNESS_DIALS, written as `setting:up` or `setting:down`
    with commas between. Used when the model's design is missing."""
    dials = []
    for part in os.environ.get("NPC_FAIRNESS_DIALS", "").split(","):
        name, _, harder = part.strip().partition(":")
        if name.strip():
            dials.append({"setting": name.strip(), "harder": harder.strip().lower()})
    return usable_dials(setup, dials)


def dials_line(setup: Message, dials: list[dict[str, str]], by_model: bool) -> str | None:
    """One line on which number settings fairness may move and which it may not. None when the game has none."""
    numeric = sorted(numeric_settings(setup))
    if not numeric:
        return None
    marked = [f"{words(dial['setting'])} (harder when {'raised' if dial['harder'] == 'up' else 'lowered'})" for dial in dials]
    left = [words(name) for name in numeric if all(name != dial["setting"] for dial in dials)]
    who = f"marked by {config.DESIGNER_MODEL}" if by_model else "named by hand in NPC_FAIRNESS_DIALS"
    if marked:
        line = f"Fairness dials, {who}: " + ", ".join(marked) + "."
    else:
        line = f"No setting is a fairness dial: {config.DESIGNER_MODEL} marked none and none was named by hand."
    return line + (" Not marked: " + ", ".join(left) + "." if left else "")


def usable_counts(setup: Message, raw: Any) -> dict[str, Any] | None:
    """What a value counts, checked against the setup: {"event", "field", "values"}, or None.

    The event must be one the player sends, the field must be declared on it
    with a list of options, and every value must be one of those options. A
    count over every option is always 1, so it is dropped too. When another
    player event repeats the field and also says how the action turned out,
    the count moves to that event, the same way a doubled habit does.
    """
    if not isinstance(raw, dict) or not isinstance(raw.get("values"), list):
        return None
    events = setup.get("events") or {}
    event, field_name = str(raw.get("event") or ""), str(raw.get("field") or "")
    values = list(dict.fromkeys(str(value) for value in raw["values"]))
    if event not in events or measures.is_npc_event(setup, event) or not values:
        return None
    options = names_of(setup, ((events[event] or {}).get("fields") or {}).get(field_name))
    if not options or any(value not in options for value in values) or len(values) >= len(options):
        return None
    if not measures.says_outcome(setup, event):
        for other, spec in events.items():
            theirs = names_of(setup, ((spec or {}).get("fields") or {}).get(field_name))
            if other != event and theirs and not measures.is_npc_event(setup, other) \
                    and measures.says_outcome(setup, other) and all(value in theirs for value in values):
                event = other
                break
    return {"event": event, "field": field_name, "values": values}


def _counts(setup: Message, picks: Any) -> dict[str, Any] | None:
    """`counts` from the model's list of `event.field=value` picks. They must all name one field of one event."""
    where: set[str] = set()
    values: list[str] = []
    for pick in picks if isinstance(picks, list) else []:
        spot, sign, value = str(pick).rpartition("=")
        if not sign:
            return None
        where.add(spot)
        values.append(value)
    if len(where) != 1:
        return None
    event, _, field_name = where.pop().partition(".")
    return usable_counts(setup, {"event": event, "field": field_name, "values": values})


def lacking_plays(setup: Message) -> list[str]:
    """The setup's own practice players that came with no `plays` numbers."""
    players = (setup.get("practice") or {}).get("players") or {}
    return [str(name) for name, detail in players.items() if not (isinstance(detail, dict) and detail.get("plays"))]


def practice_personas(setup: Message, reply: dict[str, Any] | None, everyone: bool = False) -> list[dict[str, Any]]:
    """The setup's own practice players as personas with `plays`, so every likeness is judged on one scale.

    A player the setup gave `plays` keeps them. One with none gets the numbers
    the designer wrote from its about line. One with neither is left out.
    These are only used to judge likeness: the game still runs its own
    scripted player by its plain name.
    """
    written: dict[str, dict[str, Any]] = {}
    for raw in (reply or {}).get("practice_players") or []:
        if isinstance(raw, dict) and str(raw.get("name")) not in written:
            written[str(raw.get("name"))] = _plays(setup, raw.get("plays") or [])
    found = []
    for name, detail in ((setup.get("practice") or {}).get("players") or {}).items():
        detail = detail if isinstance(detail, dict) else {}
        own = detail.get("plays")
        plays = copy.deepcopy(own) if isinstance(own, dict) and own else written.get(str(name))
        if plays or everyone:  # with `everyone`, one with no numbers yet is kept so they can be filled in
            found.append({"name": str(name), "about": str(detail.get("about") or name), "plays": plays or {}})
    return found


FILL_TIMEOUT = float(os.environ.get("NPC_DESIGNER_FILL_TIMEOUT_SECONDS", "45"))
FLAT_SPREAD = float(os.environ.get("NPC_DESIGNER_FLAT_SPREAD", "0.1"))


def counted_fields(values: list[ValueSpec]) -> list[tuple[str, str]]:
    """Every (event, field) that some value counts. Likeness is judged on these, so every practice player needs them."""
    found: list[tuple[str, str]] = []
    for spec in values:
        if spec.counts and not spec.counts.get("mean") and (spec.counts["event"], spec.counts["field"]) not in found:
            found.append((spec.counts["event"], spec.counts["field"]))
    return found


def _field_options(setup: Message, event: str, field_name: str) -> list[str]:
    return names_of(setup, (((setup.get("events") or {}).get(event) or {}).get("fields") or {}).get(field_name)) or []


def missing_plays(personas: list[dict[str, Any]], fields: list[tuple[str, str]]) -> dict[str, list[tuple[str, str]]]:
    """For each practice player, the counted fields its `plays` gives no numbers for."""
    missing = {}
    for persona in personas:
        lacking = [(event, field_name) for event, field_name in fields
                   if not ((persona.get("plays") or {}).get(event) or {}).get(field_name)]
        if lacking:
            missing[persona["name"]] = lacking
    return missing


def _fill_schema(setup: Message, missing: dict[str, list[tuple[str, str]]]) -> dict[str, Any]:
    picks = sorted({f"{event}.{field_name}={value}" for fields in missing.values() for event, field_name in fields
                    for value in _field_options(setup, event, field_name)})
    return {
        "type": "object",
        "properties": {"players": {
            "type": "array", "minItems": len(missing), "maxItems": len(missing),
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "enum": sorted(missing)},
                    "plays": {"type": "array", "items": {
                        "type": "object",
                        "properties": {"pick": {"type": "string", "enum": picks}, "share": {"type": "number"}},
                        "required": ["pick", "share"],
                    }},
                },
                "required": ["name", "plays"],
            },
        }},
        "required": ["players"],
    }


def _fill_prompt(setup: Message, personas: list[dict[str, Any]], missing: dict[str, list[tuple[str, str]]]) -> str:
    described = {key: value for key, value in setup.items() if key not in ("type", "match_id", "mode", "plan", "views", "settings")}
    wanted = [
        {"name": persona["name"], "about": persona["about"],
         "fields": {f"{event}.{field_name}": _field_options(setup, event, field_name) for event, field_name in missing[persona["name"]]}}
        for persona in personas if persona["name"] in missing
    ]
    return "\n".join([
        "A game described itself with this JSON:",
        json.dumps(described, indent=1),
        "",
        "These practice players need numbers for some fields, so they can all be compared on the same fields:",
        json.dumps(wanted, indent=1),
        "",
        "For each player give plays: one entry for every option of each field listed for it, as "
        "event.field=value with its share from 0 to 1. Shares for one field add up to 1. Work the numbers "
        "out from the player's about line and from how the game says it is played. Where the about line "
        "says nothing about a field, give the shares an ordinary player of this game would have.",
    ])


def add_plays(setup: Message, personas: list[dict[str, Any]], missing: dict[str, list[tuple[str, str]]], reply: Any) -> int:
    """Put the second answer's numbers in, only for the fields that were asked for. Returns how many fields it filled."""
    filled = 0
    for raw in (reply or {}).get("players") or [] if isinstance(reply, dict) else []:
        if not isinstance(raw, dict) or str(raw.get("name")) not in missing:
            continue
        persona = next(one for one in personas if one["name"] == str(raw.get("name")))
        for event, fields in _plays(setup, raw.get("plays") or []).items():
            for field_name, shares in fields.items():
                slot = persona.setdefault("plays", {}).setdefault(event, {})
                if (event, field_name) in missing[persona["name"]] and not slot.get(field_name):
                    slot[field_name] = shares
                    filled += 1
    return filled


def fill_from_others(setup: Message, personas: list[dict[str, Any]], fields: list[tuple[str, str]]) -> int:
    """Give a practice player the average of the others on any counted field it still has no numbers for.

    With nobody to average, the shares are even. Returns how many fields were filled this way.
    """
    filled = 0
    for event, field_name in fields:
        options = _field_options(setup, event, field_name)
        have = [persona["plays"][event][field_name] for persona in personas
                if ((persona.get("plays") or {}).get(event) or {}).get(field_name)]
        if not options:
            continue
        average = {value: (sum(float(shares.get(value, 0)) for shares in have) / len(have) if have else 1 / len(options))
                   for value in options}
        total = sum(average.values()) or 1
        for persona in personas:
            slot = persona.setdefault("plays", {}).setdefault(event, {})
            if not slot.get(field_name):
                slot[field_name] = {value: round(share / total, 3) for value, share in average.items()}
                filled += 1
    return filled


def flat_fields(personas: list[dict[str, Any]], fields: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Counted fields on which the practice players have about the same numbers. They tell nobody apart.

    Only numbers that were written for a player count, so call this before
    the gaps are filled with averages. One player's numbers alone prove nothing.
    """
    flat = []
    for event, field_name in fields:
        rows = [((persona.get("plays") or {}).get(event) or {}).get(field_name) or {} for persona in personas]
        rows = [row for row in rows if row]
        values = {value for row in rows for value in row}
        if len(rows) >= 2 and all(max(float(row.get(value, 0)) for row in rows) - min(float(row.get(value, 0)) for row in rows)
                                  <= FLAT_SPREAD for value in values):
            flat.append((event, field_name))
    return flat


def _schema(setup: Message) -> dict[str, Any]:
    text = {"type": "string"}
    picks = [f"{event}.{field_name}={value}" for event, field_name, values in list_fields(setup) for value in values]
    plays_item = {
        "type": "object",
        # A plain string, checked against the setup in code: an enum of every pick made the schema too big to serve.
        "properties": {"pick": text, "share": {"type": "number"}},
        "required": ["pick", "share"],
    }
    persona = {
        "type": "object",
        "properties": {"name": text, "about": text},
        "required": ["name", "about"],
    }
    if picks:
        persona["properties"]["plays"] = {"type": "array", "items": plays_item}
        persona["required"].append("plays")
    schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "values": {
                "type": "array", "minItems": 3, "maxItems": MAX_VALUES,
                "items": {
                    "type": "object",
                    "properties": {
                        "name": text,
                        "about": text,
                        "type": {"type": "string", "enum": ["noul", "score", "choice"]},
                        "instructions": text,
                        "levels": {"type": "array", "items": text},
                        "options": {"type": "array", "items": {
                            "type": "object",
                            "properties": {"key": text, "meaning": text},
                            "required": ["key", "meaning"],
                        }},
                        "value_of": text,
                    },
                    "required": ["name", "about", "type", "instructions", "levels", "options", "value_of"],
                },
            },
            "personas": {"type": "array", "minItems": 3, "maxItems": 5, "items": persona},
            "weights": {
                "type": "array", "maxItems": 8,
                "items": {
                    "type": "object",
                    "properties": {
                        "option": {"type": "string", "enum": sorted(option_ids(setup)) or ["none"]},
                        "value": text,
                        "weight": {"type": "number"},
                    },
                    "required": ["option", "value", "weight"],
                },
            },
            "notes": {"type": "array", "maxItems": 3, "items": text},
        },
        "required": ["values", "personas", "weights", "notes"],
    }
    if picks:  # what each value counts, when it is a plain share of one field
        value_item = schema["properties"]["values"]["items"]
        value_item["properties"]["counts"] = {"type": "array", "items": text}  # checked by usable_counts
        value_item["required"].append("counts")
    lacking = lacking_plays(setup)
    if picks and lacking:  # the game's own practice players that came with no numbers
        schema["properties"]["practice_players"] = {
            "type": "array", "minItems": len(lacking), "maxItems": len(lacking),
            "items": {
                "type": "object",
                "properties": {"name": {"type": "string", "enum": lacking}, "plays": {"type": "array", "items": plays_item}},
                "required": ["name", "plays"],
            },
        }
        schema["required"].append("practice_players")
    numeric = sorted(numeric_settings(setup))
    if numeric:
        schema["properties"]["dials"] = {
            "type": "array", "minItems": len(numeric), "maxItems": len(numeric),
            "items": {
                "type": "object",
                "properties": {
                    "setting": {"type": "string", "enum": numeric},
                    "harder": {"type": "string", "enum": ["up", "down", "neither"]},
                },
                "required": ["setting", "harder"],
            },
        }
        schema["required"].append("dials")
    return schema


def _prompt(setup: Message) -> str:
    described = {key: value for key, value in setup.items() if key not in ("type", "match_id", "mode", "plan", "views", "settings")}
    views = setup.get("views") or {}
    numeric = {
        name: {key: spec[key] for key in ("about", "min", "max") if key in spec}
        for name, spec in numeric_settings(setup).items()
    }
    dials = [] if not numeric else [
        "",
        "5. dials: the game has these number settings: " + json.dumps(numeric),
        "Give one entry for each. This is only about what the number does. The NPCs never change a "
        "setting to answer a habit, and a separate fairness check may nudge a marked setting to keep "
        "a match even. harder is `up` when a higher number makes the NPCs harder for the player to "
        "beat, `down` when a higher number makes them easier to beat, and `neither` only when the "
        "number has nothing to do with how hard or how fast the game is.",
    ]
    return "\n".join([
        "A game described itself with this JSON:",
        json.dumps(described, indent=1),
        "",
        "Pictures the game can send, one frame at a time: " + (json.dumps(views) if views else "none"),
        "",
        f"Write {'five' if numeric else 'four'} things.",
        "",
        "1. values: what is worth tracking about the human player, 8 to 10 of them and of different "
        "kinds: how often the player picks an option, how big a number they report is, and at least two "
        "that only a picture of the player can answer (posture, how high the arm is, how close to the "
        "camera, which way they face), each naming the picture to look at. Each one is a habit of the "
        "player that should change what an NPC does. Never two values where one is the other's opposite. Each has:",
        "- name: snake_case. The value runs from 0 (never seen) to 1 (does it all the time).",
        "- about: the habit in plain words, as a spectator would say it, 5 words or fewer. It starts "
        "with a verb and names no field: write it like 'Rushes forward early', never like 'How often x is y'.",
        "- type and instructions: one question that reads it. The question is always about the PLAYER, "
        "never about whether an NPC option will work. It must be answerable from exact counts of the "
        "last 20 seconds of events (using the event and field names above), or from one frame of a "
        "named picture. Say in the question which counts or which picture to look at.",
        "  noul: a yes or no question. Leave levels and options empty and value_of blank.",
        "  score: a how-often question. Give 3 to 5 ordered levels, lowest first. The value is the level reached.",
        "  choice: pick one of 2 to 6 named options, each with a meaning. value_of is the option key "
        "whose probability is the value.",
        "- counts: when the value is simply how often the player's events show certain options of ONE "
        "field, list those options as event.field=value. They must all come from the same event and "
        "field, and never be every option of that field. Leave counts empty for anything else: a value "
        "read from a picture, from a number field, or from more than one field.",
        "  Every pick, in counts and in plays, is written exactly as one of: "
        + ", ".join(f"{e}.{f}={v}" for e, f, vs in list_fields(setup) for v in vs) + ".",
        "Track what tells players of this game apart. Read the game's about text and the practice "
        "players' about lines for where players differ, and prefer those fields. Never write a value "
        "on something the description says is the same for every player: if the player stands still, "
        "where they hit from says nothing.",
        "",
        "2. personas: 3 to 5 kinds of player this game will meet, used to playtest the NPCs. One of them "
        "has no clear habit. Each has a snake_case name, an about line of at most 16 words, and plays: "
        "how often that kind of player chooses each value of a field. Each plays entry is one "
        "event.field=value and its share from 0 to 1. Shares for one field add up to 1. Cover every "
        "field that one of your values counts, with a share for every option of that field, so every "
        "persona can be compared on the same fields. Leave out fields that no value counts.",
        *([] if not (lacking_plays(setup) and list_fields(setup)) else [
            "Also practice_players: the game already has these practice players of its own: "
            + ", ".join(lacking_plays(setup)) + ". Give one entry for each, with its name and plays numbers "
            "worked out from its about line under practice.players, in the same shape as a persona's plays "
            "and covering the same fields: every field that one of your values counts.",
        ]),
        "",
        "3. weights: `when` entries to add to the first behaviour. Each names one NPC option, one of "
        "your value names, and a weight from -1 to 1 that is added to the option's score in proportion "
        "to the value. Use a positive weight on the option that answers the habit, in line with the "
        "game's goal. At most 8.",
        "",
        "4. notes: up to 3 short lines on why these values, for people watching the setup.",
        *dials,
    ])


# ---------------------------------------------------------------- turning the reply into a design

def _question(raw: dict[str, Any]) -> dict[str, Any] | None:
    """One Decisions API question from the model's flat answer, or None if it is unusable."""
    kind = raw.get("type")
    instructions = str(raw.get("instructions") or "").strip()
    if not instructions:
        return None
    if kind == "noul":
        return {"type": "noul", "instructions": instructions}
    if kind == "score":
        levels = [str(level) for level in (raw.get("levels") or []) if str(level).strip()]
        if len(levels) < 2:
            levels = list(SCORE_LEVELS)
        return {"type": "score", "instructions": instructions, "criteria": levels[:8]}
    if kind == "choice":
        criteria = {
            str(option.get("key")): str(option.get("meaning") or option.get("key"))
            for option in (raw.get("options") or []) if isinstance(option, dict) and option.get("key")
        }
        wanted = str(raw.get("value_of") or "")
        if len(criteria) < 2 or wanted not in criteria:
            return None
        return {"type": "choice", "instructions": instructions, "criteria": criteria, "value_of": wanted}
    return None


def _values(reply: dict[str, Any], setup: Message | None = None) -> list[ValueSpec]:
    """The model's values. With the setup given, each one also says what it counts, when that holds up."""
    specs: list[ValueSpec] = []
    for raw in reply.get("values") or []:
        if not isinstance(raw, dict):
            continue
        name = snake(raw.get("name", ""))
        question = _question(raw)
        if not name or name.startswith(LIKE) or question is None or any(spec.name == name for spec in specs):
            continue
        about = shorten(str(raw.get("about") or words(name)).strip(), config.MAX_ABOUT_WORDS)
        counts = _counts(setup, raw.get("counts")) if setup is not None else None
        specs.append(ValueSpec(name=name, about=about, question=question, counts=counts))
    return specs[:MAX_VALUES]


def _plays(setup: Message, entries: list[Any]) -> dict[str, Any]:
    """`plays` in the contract shape: event, then field, then value, each with a share that sums to 1."""
    allowed = {(event, field_name): values for event, field_name, values in list_fields(setup)}
    plays: dict[str, dict[str, dict[str, float]]] = {}
    for entry in entries or []:
        if not isinstance(entry, dict) or "=" not in str(entry.get("pick", "")):
            continue
        where, value = str(entry["pick"]).rsplit("=", 1)
        event, _, field_name = where.partition(".")
        if value not in allowed.get((event, field_name), []):
            continue
        try:
            share = min(max(float(entry.get("share", 0)), 0.0), 1.0)
        except (TypeError, ValueError):
            continue
        plays.setdefault(event, {}).setdefault(field_name, {})[value] = share
    for event, fields in plays.items():
        for field_name, shares in fields.items():
            total = sum(shares.values())
            missing = [value for value in allowed[(event, field_name)] if value not in shares]
            if total < 1 and missing:  # spread what is left over the values the persona did not mention
                for value in missing:
                    shares[value] = (1 - total) / len(missing)
            total = sum(shares.values()) or 1
            fields[field_name] = {value: round(share / total, 3) for value, share in shares.items()}
    return plays


def _personas(setup: Message, reply: dict[str, Any]) -> list[dict[str, Any]]:
    personas: list[dict[str, Any]] = []
    taken = set((setup.get("practice") or {}).get("players") or {})
    for raw in reply.get("personas") or []:
        if not isinstance(raw, dict):
            continue
        name = snake(raw.get("name", ""))
        if not name or name in taken:
            continue
        taken.add(name)
        personas.append({
            "name": name,
            "about": str(raw.get("about") or name).strip(),
            "plays": _plays(setup, raw.get("plays") or []),
        })
    return personas[:5]


def without_doubles(values: list[ValueSpec]) -> list[ValueSpec]:
    """Drop a value that counts exactly what an earlier one counts, so no habit shows twice.

    The model's values come first in the list, so its value and label are the ones kept.
    """
    seen: set[tuple[Any, ...]] = set()
    kept = []
    for spec in values:
        if spec.counts:
            key = (spec.counts.get("event"), spec.counts.get("field"), tuple(sorted(spec.counts.get("values") or [])))
            if key in seen:
                continue
            seen.add(key)
        kept.append(spec)
    return kept


def plain_values(setup: Message) -> list[ValueSpec]:
    """Values built in code: the share of each name in the most telling field of the player's events.

    The most telling field is the list-of-names field with the fewest names,
    because a habit shows fastest where there are few ways to choose.
    """
    fields = list_fields(setup)
    if not fields:
        return []
    event, field_name, options = min(fields, key=lambda found: len(found[2]))
    tracked = options[:1] if len(options) == 2 else options[:4]
    return [
        ValueSpec(
            name=snake(f"share_of_{field_name}_{option}"),
            about=shorten(f"Picks {words(option)} often", config.MAX_ABOUT_WORDS),
            question={
                "type": "score",
                "instructions": (
                    f"Look at the counts of the player's `{event}` events. "
                    f"How often was `{field_name}` equal to `{option}`?"
                ),
                "criteria": list(SCORE_LEVELS),
            },
            counts=usable_counts(setup, {"event": event, "field": field_name, "values": [option]}),
        )
        for option in tracked
    ]


# ---------------------------------------------------------------- a spread of different reads

MIN_VALUES, MAX_VALUES = 8, 10   # values besides likeness
MAX_SHARES_PER_FIELD = 2
MAX_LABEL_WORDS = 6
# Words in a game's description that say the player does not choose where they are.
_FIXED_WORDS = ("fixed", "stationary", "by itself", "automatically")
_PLACE_FIELDS = ("position", "from")


def range_fields(setup: Message) -> list[tuple[str, str, dict[str, Any]]]:
    """Every (event, field, spec) on a player event where the field is a number with a min and max."""
    found = []
    for event, spec in (setup.get("events") or {}).items():
        if measures.is_npc_event(setup, event):
            continue
        for field_name, kind in ((spec or {}).get("fields") or {}).items():
            if isinstance(kind, dict) and _is_number(kind.get("min")) and _is_number(kind.get("max")) \
                    and kind["max"] > kind["min"]:
                found.append((event, field_name, kind))
    return found


def chosen_by_player(setup: Message, field_name: str) -> bool:
    """A field the player really chooses: not an outcome, not the NPC's side, not a place the game picks."""
    if not measures.is_player_choice(setup, field_name):
        return False
    about = str(setup.get("about") or "").lower()
    if any(word in about for word in _FIXED_WORDS) and any(place in field_name for place in _PLACE_FIELDS):
        return False
    return True


def player_views(setup: Message) -> list[str]:
    """The pictures that show the player, by name."""
    return [str(name) for name, about in (setup.get("views") or {}).items() if "player" in str(about).lower()]


def view_of(setup: Message, spec: ValueSpec) -> str | None:
    """The picture a value's question names, if any."""
    text = str(spec.question.get("instructions") or "")
    for name in (setup.get("views") or {}):
        if re.search(rf"\b{re.escape(str(name))}\b", text):
            return str(name)
    return None


def level_value(event: str, field_name: str, spec: dict[str, Any]) -> ValueSpec:
    middle = (float(spec["min"]) + float(spec["max"])) / 2
    return ValueSpec(
        name=snake(f"level_of_{field_name}"),
        about=shorten(f"High {words(field_name)}", MAX_LABEL_WORDS),
        question={"type": "noul", "instructions": (
            f"Will the player's next `{event}` have `{field_name}` above {middle:g}? "
            f"Judge by the mean of `{field_name}` in the counts.")},
        counts={"event": event, "field": field_name, "mean": True,
                "min": float(spec["min"]), "max": float(spec["max"])},
        kind="level",
    )


def camera_values(setup: Message) -> list[ValueSpec]:
    """Two reads only a picture of the player can answer, written from the view's name."""
    views = player_views(setup)
    if not views:
        return []
    view = views[-1]  # a view about the player alone is usually listed after the game screen
    return [
        ValueSpec(name=snake(f"close_to_{view}"), about="Leans in close to camera", kind="camera", question={
            "type": "noul", "instructions": (
                f"Look at the `{view}` picture. Is the player close to the camera, filling more than "
                f"half of the picture's height?")}),
        ValueSpec(name=snake(f"side_on_in_{view}"), about="Stands side-on to the camera", kind="camera", question={
            "type": "noul", "instructions": (
                f"Look at the `{view}` picture. Is the player turned side-on, with one shoulder much "
                f"closer to the camera than the other?")}),
    ]


def shape_values(setup: Message, values: list[ValueSpec]) -> list[ValueSpec]:
    """Check the values against the rules and fill the gaps, so a read carries a spread of kinds.

    Each value gets its kind. A value that counts nothing and names no picture,
    a share on something the player does not choose, a share that is the
    complement of an earlier one, and a third share on one field are dropped. Then camera, level and share values are added from the
    setup until there are at least MIN_VALUES, and at most MAX_VALUES are kept.
    Likeness values are not touched here.
    """
    views = list((setup.get("views") or {}))
    kept: list[ValueSpec] = []
    per_field: dict[tuple[str, str], list[set[str]]] = {}
    for spec in values:
        if spec.name.startswith(LIKE):
            continue
        spec.about = shorten(spec.about, MAX_LABEL_WORDS)
        counts = spec.counts or {}
        if counts.get("mean"):
            spec.kind = "level"
        elif counts:
            key = (counts["event"], counts["field"])
            if not chosen_by_player(setup, key[1]):
                continue
            picked = set(counts.get("values") or [])
            options = set(_field_options(setup, *key))
            earlier = per_field.setdefault(key, [])
            if len(earlier) >= MAX_SHARES_PER_FIELD or any(not (picked & e) and (picked | e) == options for e in earlier):
                continue
            earlier.append(picked)
            spec.kind = "share"
        elif view_of(setup, spec) and views:
            spec.kind = "camera"
        else:
            continue  # counts nothing and names no picture: only a guess, so its place is filled from the setup
        kept.append(spec)

    names = {spec.name for spec in kept}

    def add(spec: ValueSpec) -> None:
        if len(kept) < MAX_VALUES and spec.name not in names:
            kept.append(spec)
            names.add(spec.name)

    for spec in camera_values(setup)[: max(0, 2 - sum(1 for v in kept if v.kind == "camera"))]:
        add(spec)
    covered_fields = {(v.counts or {}).get("field") for v in kept if v.counts}
    levels = [(e, f, k) for e, f, k in range_fields(setup) if chosen_by_player(setup, f) and f not in covered_fields]
    shares = []
    for event, field_name, options in list_fields(setup):
        if measures.is_npc_event(setup, event) or not chosen_by_player(setup, field_name) or field_name in covered_fields:
            continue
        counts = usable_counts(setup, {"event": event, "field": field_name, "values": options[:1]})
        if counts and all(field_name != f for _, f, _ in shares):
            shares.append((event, field_name, counts))
    seen_levels: set[str] = set()
    queue: list[ValueSpec] = []
    for event, field_name, spec in levels:
        if field_name not in seen_levels:
            seen_levels.add(field_name)
            queue.append(level_value(event, field_name, spec))
    for event, field_name, counts in shares:
        option = counts["values"][0]
        queue.append(ValueSpec(
            name=snake(f"share_of_{field_name}_{option}"),
            # The field is named, because an option such as "left" says nothing by itself.
            about=shorten(f"{words(field_name).capitalize()}: mostly {words(option)}", MAX_LABEL_WORDS),
            question={"type": "score", "instructions": (
                f"Look at the counts of the player's `{counts['event']}` events. "
                f"How often was `{field_name}` equal to `{option}`?"), "criteria": list(SCORE_LEVELS)},
            counts=counts, kind="share",
        ))
    # Alternate levels and shares so the spread holds when the limit cuts the list.
    lv = [q for q in queue if q.kind == "level"]
    sh = [q for q in queue if q.kind == "share"]
    for i in range(max(len(lv), len(sh))):
        for group in (lv, sh):
            if i < len(group) and len(kept) < MIN_VALUES + 2:
                add(group[i])
    return kept[:MAX_VALUES]


def missing_main_players(setup: Message, values: list[ValueSpec], personas: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Practice players to add so each main option of a counted field is someone's main choice.

    A main option is one some practice player gives at least a tenth of its
    choices. An option no practice player leans on most gets a code-built
    player who picks it about 60% of the time.
    """
    added: list[dict[str, Any]] = []
    for event, field_name in counted_fields([v for v in values if v.kind == "share"]):
        options = _field_options(setup, event, field_name)
        said = [((p.get("plays") or {}).get(event) or {}).get(field_name) or {} for p in personas + added]
        said = [s for s in said if s]
        if not said or len(options) < 2:
            continue
        # The main options are the ones the player's own events allow (a shorter list of the same
        # field on another player event), or else the ones some practice player leans on.
        narrower = []
        for other, spec in (setup.get("events") or {}).items():
            theirs = names_of(setup, ((spec or {}).get("fields") or {}).get(field_name))
            if theirs and set(theirs) < set(options) and not measures.is_npc_event(setup, other):
                narrower.append(theirs)
        if narrower:
            main = min(narrower, key=len)
        else:
            main = [o for o in options if any(float(s.get(o, 0)) >= 0.25 for s in said)]
        if len(main) > 4:
            continue
        tops = {max(s, key=lambda o: float(s.get(o, 0))) for s in said}
        for option in main:
            if option in tops:
                continue
            rest = round(0.4 / (len(main) - 1), 3) if len(main) > 1 else 0.0
            shares = {o: (0.6 if o == option else (rest if o in main else 0.0)) for o in options}
            added.append({
                "name": snake(f"{option}_first"),
                "about": f"Chooses {words(option)} for {words(field_name)} most of the time.",
                "plays": {event: {field_name: shares}},
            })
            tops.add(option)
    return added


def plain_personas(setup: Message) -> list[dict[str, Any]]:
    """Practice players built in code: one that leans on each name of the most telling field, and an even one."""
    fields = list_fields(setup)
    personas = [{"name": "even", "about": "No clear habit. Spreads choices evenly.", "plays": {}}]
    if not fields:
        return personas
    event, field_name, options = min(fields, key=lambda found: len(found[2]))
    for option in options[:3]:
        rest = round(0.3 / (len(options) - 1), 3)
        shares = {name: (0.7 if name == option else rest) for name in options}
        personas.append({
            "name": snake(f"mostly_{option}"),
            "about": f"Chooses {words(option)} for {words(field_name)} about 70% of the time.",
            "plays": {event: {field_name: shares}},
        })
    return personas


def like_values(players: dict[str, str]) -> list[ValueSpec]:
    """One `like_<name>` value for each practice player, all read by the same choice question."""
    if len(players) < 2:
        return []
    return [
        ValueSpec(
            name=LIKE + name,
            about=shorten(f"Plays like the {words(name)}", config.MAX_ABOUT_WORDS),
            question={
                "type": "choice",
                "instructions": (
                    "Which of these kinds of player is this player most like? "
                    "Judge by the counts of what the player did."
                ),
                "criteria": dict(players),
                "value_of": name,
            },
            kind="likeness",
        )
        for name, about in players.items()
    ]


def _add_weights(behaviour: Behaviour, setup: Message, weights: list[Any], value_names: set[str]) -> int:
    """Add the model's `when` entries to the first behaviour. Returns how many were added."""
    ids = option_ids(setup)
    added = 0
    for entry in weights or []:
        if not isinstance(entry, dict) or entry.get("option") not in ids:
            continue
        value = snake(entry.get("value", ""))
        try:
            weight = round(min(max(float(entry.get("weight", 0)), -1.0), 1.0), 2)
        except (TypeError, ValueError):
            continue
        if value not in value_names or weight == 0:
            continue
        npc, decision, option = ids[entry["option"]]
        behaviour["npcs"][npc]["decisions"][decision][option].setdefault("when", {})[value] = weight
        added += 1
    return added


# ---------------------------------------------------------------- the playtest

def plan_runs(count: int) -> tuple[int, int]:
    """How many of `count` runs to do, and how many rounds each, inside the caps."""
    runs = min(count, PLAYTEST_MAX_RUNS)
    rounds = min(PLAYTEST_ROUNDS, PLAYTEST_MAX_ROUNDS // max(runs, 1))
    if rounds < PLAYTEST_MIN_ROUNDS:
        rounds = min(PLAYTEST_ROUNDS, PLAYTEST_MIN_ROUNDS)
        runs = min(runs, PLAYTEST_MAX_ROUNDS // max(rounds, 1))
    return runs, rounds


def _npc_wins(result: Message, npc: str, only_npc: bool) -> tuple[int, int]:
    """(rounds played, rounds this NPC won) from one `practice_result`."""
    wins = result.get("wins") or {}
    played = int(result.get("rounds") or sum(int(count) for count in wins.values()) or 0)
    if npc in wins:
        return played, int(wins[npc])
    if only_npc and "player" in wins:
        return played, played - int(wins["player"])
    return played, 0


async def run_playtest(
    setup: Message,
    behaviour: Behaviour,
    players: list[Any],
    playtest: Playtest,
    trace: Trace,
    progress: dict[str, Any] | None = None,
    stop_at: float | None = None,
) -> tuple[list[Matchup], dict[str, float]]:
    """Play every NPC option against every practice player, plus one baseline run each.

    `players` holds persona objects and the names of the game's own scripted
    players. Every result is traced in one plain line. Returns the matchup
    rows and what was measured about the game's speed. `progress` is kept up
    to date for whoever reports on a long setup, and nothing starts after
    `stop_at` (a time.monotonic() value).
    """
    progress = progress if progress is not None else {}
    if not players:
        return [], {}
    npcs = list(setup.get("npcs") or {})
    targets = list(option_ids(setup).values())
    plan: list[tuple[Any, tuple[str, str, str] | None]] = [(player, None) for player in players]
    plan += [(player, target) for target in targets for player in players]
    runs, rounds = plan_runs(len(plan))
    if runs < len(plan):
        trace(trace_message("playtest", "start", f"Playing {runs} of {len(plan)} practice runs to stay inside the cap."))
    trace(trace_message(
        "playtest", "start",
        f"Playtesting {len(targets)} options against {len(players)} practice players, {rounds} rounds a run.",
        data={"runs": runs, "rounds": rounds},
    ))

    rows: list[Matchup] = []
    started = time.monotonic()
    failures = 0
    seconds_played = 0.0
    rounds_played = 0
    progress["runs"] = progress.get("runs", 0) + runs
    refused: set[str] = set()   # practice players the game said it cannot play
    for index, (player, target) in enumerate(plan[:runs]):
        if (player["name"] if isinstance(player, dict) else str(player)) in refused:
            continue
        now = time.monotonic()
        if now - started > PLAYTEST_MAX_SECONDS or (stop_at is not None and now > stop_at):
            trace(trace_message("playtest", "error", f"Out of time for practice. Stopped with {runs - index} runs not played."))
            break
        name = player["name"] if isinstance(player, dict) else str(player)
        progress["player"] = name
        test = behaviour if target is None else forced(behaviour, *target)
        began = time.monotonic()
        try:
            result = await asyncio.wait_for(playtest.run(test, player, rounds), PLAYTEST_RUN_TIMEOUT)
            failures = 0
            progress["done"] = progress.get("done", 0) + 1
        except PracticeRefused as error:  # the game does not know this player: drop them and carry on
            refused.add(name)
            trace(trace_message("playtest", "error",
                                f"The game cannot play {words(name)}, so that practice player is left out: {str(error)[:120]}"))
            continue
        except Exception as error:  # a failed run is skipped, never fatal
            failures += 1
            trace(trace_message("playtest", "error", f"A practice run against {words(name)} failed: {type(error).__name__}."))
            if failures >= 3:
                trace(trace_message("playtest", "error", "Three practice runs failed in a row. Stopping the playtest."))
                break
            continue
        ms = (time.monotonic() - began) * 1000
        seconds_played += ms / 1000
        rounds_played += int(result.get("rounds") or rounds)
        stats = result.get("stats") or {}
        if target is None:
            for npc in npcs:
                played, won = _npc_wins(result, npc, len(npcs) == 1)
                rows.append(matchups.baseline_row(name, npc, played, won, stats))
                trace(trace_message("playtest", "done", f"First behaviour against {words(name)}: {words(npc)} won {won} of {played}.", ms=ms))
        else:
            npc, decision, option = target
            played, won = _npc_wins(result, npc, len(npcs) == 1)
            rows.append(Matchup(player=name, npc=npc, decision=decision, option=option,
                                rounds=played, npc_wins=won, stats=stats))
            trace(trace_message(
                "playtest", "done",
                f"{words(option)} for {words(decision)} against {words(name)}: {words(npc)} won {won} of {played}.", ms=ms,
            ))
    timings = {"seconds_per_practice_round": round(seconds_played / rounds_played, 5)} if rounds_played else {}
    return rows, timings


# ---------------------------------------------------------------- the designer

async def _tick(trace: Trace, started: float, progress: dict[str, Any], asking: "asyncio.Future[Any]") -> None:
    """Say where setup is, every few seconds, so nobody watches a blank screen."""
    while True:
        await asyncio.sleep(STEP_SECONDS)
        parts = [f"Setup is {time.monotonic() - started:.0f} seconds in."]
        parts.append(f"{config.DESIGNER_MODEL} has answered." if asking.done()
                     else f"{config.DESIGNER_MODEL} is still writing the questions and practice players.")
        if progress.get("runs"):
            left = progress["runs"] - progress.get("done", 0)
            parts.append(f"Practice runs: {progress.get('done', 0)} done, {left} left"
                         + (f", now against {words(progress['player'])}." if left and progress.get("player") else "."))
        trace(trace_message("designer", "step", " ".join(parts)))


class GeminiDesigner(Designer):
    """Designs a game once: values, questions, practice players, first behaviour, matchup table."""

    def __init__(self, ask: Ask | None = None) -> None:
        self._ask: Ask = ask or models_client.ask_json
        self._unfinished: dict[str, dict[str, Any]] = {}  # by game: what `finish` needs

    async def _ask_model(self, setup: Message, trace: Trace) -> tuple[dict[str, Any] | None, str]:
        """The model's reply, or None and the reason there isn't one. Never raises."""
        model = config.DESIGNER_MODEL
        try:
            answer = await self._ask(
                model, config.DESIGNER_THINKING, _prompt(setup), _schema(setup),
                system=SYSTEM, timeout=DESIGNER_TIMEOUT,
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            reason = f"{type(error).__name__}: {str(error)[:240]}"
            trace(trace_message("designer", "error", f"{model} gave no design. {reason}", model=model))
            return None, reason
        trace(trace_message(
            "designer", "done",
            f"{model} chose {len(answer.data.get('values') or [])} things to track and wrote "
            f"{len(answer.data.get('personas') or [])} practice players.",
            model=model, ms=answer.ms, data={"usage": answer.usage, "thinking": config.DESIGNER_THINKING},
        ))
        return answer.data, ""

    def quick(self, setup: Message) -> Design:
        """A design built in code, at once: no model call and no practice.

        For a `ready` that can't wait. The watcher can read these questions
        from the first event, and `design` brings the model's own later.
        """
        practice = (setup.get("practice") or {}).get("players") or {}
        scripted = {name: str((detail or {}).get("about") or name) for name, detail in practice.items()}
        values = shape_values(setup, plain_values(setup)) + like_values(scripted)
        notes = [f"Tracking {len(values)} things about the player, built in code so play can start at once.",
                 "The design model's own questions follow when they land."]
        return Design(values=values, behaviour=first_behaviour(setup), notes=notes,
                      personas=practice_personas(setup, None) + plain_personas(setup), dials=env_dials(setup))

    async def design(self, setup: Message, playtest: Playtest | None, trace: Trace) -> Design:
        game = setup.get("game", "this game")
        model = config.DESIGNER_MODEL
        started = time.monotonic()
        progress: dict[str, Any] = {}
        behaviour = first_behaviour(setup)
        practice = (setup.get("practice") or {}).get("players") or {}
        scripted = {name: str((detail or {}).get("about") or name) for name, detail in practice.items()}
        plain = plain_personas(setup)

        trace(trace_message("designer", "start", f"Reading the description of {game} to decide what to track.", model=model))
        asking = asyncio.ensure_future(self._ask_model(setup, trace))
        ticker = asyncio.ensure_future(_tick(trace, started, progress, asking))
        rows: list[Matchup] = []
        timings: dict[str, float] = {}
        kept = False
        try:
            # Practice starts at once, with players that need no model.
            if playtest is not None:
                first_players: list[Any] = list(scripted) if scripted else plain
                rows, timings = await self._practise(setup, behaviour, first_players, playtest, trace, progress, started + PRACTICE_WAIT)
            # Practice mode holds `ready` for the model, up to a cap. With no practice
            # to run, the caller already has `quick` for `ready` and this waits it out.
            wait = PRACTICE_WAIT if playtest is not None else DESIGNER_TIMEOUT
            left = wait - (time.monotonic() - started)
            if not asking.done() and left > 0:
                await asyncio.wait({asking}, timeout=left)
            state = {"behaviour": behaviour, "scripted": scripted, "plain": plain, "rows": rows, "timings": timings}
            if asking.done():
                reply, reason = asking.result()
                if reply is None:
                    reason = f"{model} failed ({reason}), so this design was built in code alone."
            else:
                reply = None
                reason = (f"{model} had not answered after {time.monotonic() - started:.0f} seconds, which is the cap, "
                          "so this design was built in code alone.")
                trace(trace_message("designer", "error", reason, model=model))
                self._unfinished[str(game)] = {**state, "asking": asking}
                kept = True
            return await self._assemble(setup, state, reply, reason, playtest, trace, progress, time.monotonic() + DESIGN_BUDGET)
        finally:
            ticker.cancel()
            if not kept and not asking.done():
                asking.cancel()

    async def finish(self, setup: Message, playtest: Playtest | None, trace: Trace) -> Design | None:
        """The model's own design, when `design` went ahead without it because the cap passed.

        Call it after `design` has returned. It waits for the model, playtests
        the practice players it wrote, and returns the full design. Returns
        None when `design` already had the model's answer, or the model failed.
        """
        state = self._unfinished.pop(str(setup.get("game", "this game")), None)
        if state is None:
            return None
        started = time.monotonic()
        progress: dict[str, Any] = {}
        ticker = asyncio.ensure_future(_tick(trace, started, progress, state["asking"]))
        try:
            reply, _ = await state["asking"]
            if reply is None:
                return None
            return await self._assemble(setup, state, reply, "", playtest, trace, progress, time.monotonic() + DESIGN_BUDGET)
        finally:
            ticker.cancel()

    async def _ask_missing(self, setup: Message, personas: list[dict[str, Any]],
                           missing: dict[str, list[tuple[str, str]]], trace: Trace) -> int:
        """Ask once more for the numbers practice players lack on counted fields. Returns how many fields it filled. Never raises."""
        model = config.DESIGNER_MODEL
        try:
            answer = await self._ask(model, config.DESIGNER_THINKING, _fill_prompt(setup, personas, missing),
                                     _fill_schema(setup, missing), system=SYSTEM, timeout=FILL_TIMEOUT)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            trace(trace_message("designer", "error", f"{model} did not fill in the missing practice numbers, so the average of "
                                f"the other players is used. {type(error).__name__}: {str(error)[:160]}", model=model))
            return 0
        filled = add_plays(setup, personas, missing, answer.data)
        trace(trace_message("designer", "done", f"{model} filled in {filled} fields of numbers that {len(missing)} practice players lacked.",
                            model=model, ms=answer.ms, data={"usage": answer.usage}))
        return filled

    async def _practise(self, setup: Message, behaviour: Behaviour, players: list[Any], playtest: Playtest,
                        trace: Trace, progress: dict[str, Any], stop_at: float) -> tuple[list[Matchup], dict[str, float]]:
        """A playtest that can't take the design down with it."""
        try:
            return await run_playtest(setup, behaviour, players, playtest, trace, progress, stop_at)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            trace(trace_message("playtest", "error", f"The playtest stopped: {type(error).__name__}: {str(error)[:120]}"))
            return [], {}

    async def _assemble(self, setup: Message, state: dict[str, Any], reply: dict[str, Any] | None, reason: str,
                        playtest: Playtest | None, trace: Trace, progress: dict[str, Any], stop_at: float) -> Design:
        """Put a design together from the model's reply, or in code when there is none."""
        game = setup.get("game", "this game")
        scripted: dict[str, str] = state["scripted"]
        # The model's questions come first, then the ones built in code, so a
        # `ready` that went out early on the code-built ones stays true.
        values = _values(reply, setup) if reply else []
        values += [spec for spec in plain_values(setup) if all(spec.name != other.name for other in values)]
        values = shape_values(setup, without_doubles(values))
        personas = (_personas(setup, reply) if reply else []) or copy.deepcopy(state["plain"])
        own = practice_personas(setup, reply, everyone=bool(reply))
        personas += missing_main_players(setup, values, own + personas)
        everyone = own + personas
        fields = counted_fields(values)
        missing = missing_plays(everyone, fields) if reply else {}
        asked = await self._ask_missing(setup, everyone, missing, trace) if missing else 0
        flat = flat_fields(everyone, fields) if reply else []     # judged on the numbers written, before any average goes in
        averaged = fill_from_others(setup, everyone, fields) if reply else 0
        if flat:  # a field every practice player plays the same way is not a habit, so nothing counts it
            values = [spec for spec in values if not (spec.counts and (spec.counts["event"], spec.counts["field"]) in flat)]

        about = dict(scripted)
        about.update({persona["name"]: persona["about"] for persona in personas})
        values = values + like_values(about)
        behaviour = copy.deepcopy(state["behaviour"])
        added = _add_weights(behaviour, setup, (reply or {}).get("weights") or [], {spec.name for spec in values})

        notes = [f"Tracking {len(values)} things about the player, chosen from the description of {game}."]
        if reply:
            notes.append(f"{config.DESIGNER_MODEL} wrote {len(_values(reply))} of the questions and "
                         f"{len(_personas(setup, reply))} practice players. The rest were built in code.")
        if reason:
            notes.append(reason)
        notes.append("Practice players: " + ", ".join(words(name) for name in about) + ".")
        if own:
            notes.append(f"{len(own)} of the game's own practice players have plays numbers, used only to judge likeness.")
        if missing:
            notes.append(f"Numbers were missing for {len(missing)} practice players: {asked} fields came from a second ask "
                         f"and {averaged} from the average of the others.")
        if flat:
            notes.append("Dropped what counts " + ", ".join(words(field_name) for _, field_name in flat)
                         + ": every practice player has the same numbers there.")
        if added:
            notes.append(f"The first behaviour leans on {added} of those values from the first read.")
        notes.extend(str(note).strip() for note in ((reply or {}).get("notes") or [])[:3] if str(note).strip())

        rows = [row for row in state["rows"] if row.player in about]
        timings = dict(state["timings"])
        if playtest is not None:
            unplayed = [persona for persona in personas if persona["name"] not in matchups.players(rows)]
            more, measured = await self._practise(setup, behaviour, unplayed, playtest, trace, progress, stop_at)
            rows += more
            timings = timings or measured
            found = [counter for name in about for counter in matchups.counters(rows, name)[:1]]
            notes.extend("Playtest: " + matchups.describe(counter) for counter in found[:4])
            trace(trace_message(
                "playtest", "done",
                f"Kept {len(rows)} playtest results. {len(found)} of {len(about)} practice players have a clear counter.",
            ))
            if (setup.get("practice") or {}).get("stand_in") is True:
                notes.append(STAND_IN_NOTE)
        # Only the model marks a dial. When it marks none, the ones named by hand are used.
        marked = usable_dials(setup, reply.get("dials")) if reply else []
        dials = marked or env_dials(setup)
        line = dials_line(setup, dials, by_model=bool(marked))
        if line:
            notes.append(line)
            trace(trace_message("designer", "step", line, data={"dials": dials}))
        return Design(values=values, behaviour=behaviour, matchups=rows, notes=notes, timings=timings,
                      personas=copy.deepcopy(own + personas), dials=dials)
