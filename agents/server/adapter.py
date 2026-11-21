"""The adapter: the larger loop that rewrites how the NPCs play.

It gathers the facts in code, hands them to a rule writer, checks what comes
back against the contract, and returns a `strategy_update`. Every change says
what it expects to happen, and later updates carry `checks` that report, from
measured play, whether each expectation held.

Which writer runs depends on how long the game says it can wait (see
config.writer_for). This file holds the model-call writer. A writer that
tests rule sets before answering can replace it without touching the rest.
"""
from __future__ import annotations

import asyncio
import contextvars
import copy
import json
import os
import re
import time
from dataclasses import asdict
from typing import Any, Awaitable, Callable

from server import config, matchups, measures, models_client
from server.designer import (
    chosen_by_player, counted_fields, env_dials, first_behaviour, numeric_settings, shorten, usable_dials, world_settings,
)
from server.interfaces import (
    Adapter, Behaviour, Facts, MatchState, Matchup, Message, Proposal, RuleWriter, Trace, trace_message,
)

try:  # the shared contract check, when it is there
    from server.contract import check_behaviour as _contract_check
    from server.contract import check_setting as _setting_check
    from server.contract import is_pick_setting
except Exception:  # pragma: no cover - only when the contract module is missing
    _contract_check = None
    _setting_check = None

    def is_pick_setting(spec: Any) -> bool:
        picks = spec.get("max_picks") if isinstance(spec, dict) else None
        return isinstance(picks, int) and not isinstance(picks, bool) and picks >= 1

MAX_RULES = 4          # for each NPC, as the contract says
MAX_LINES = 3          # observations and plan
MIN_LINES = 2          # the panels show the first two, so there are always two
MAX_WORDS = config.MAX_LINE_WORDS  # for each line

# Fairness: once the player has lost this many rounds in a row and won under
# the floor share of the last few, the newest rule is softened into a weight.
# One step at a time, with a rest between steps, and never down to no rules.
FAIR_ROUNDS = int(os.environ.get("NPC_FAIR_ROUNDS", "4"))
FAIR_LOST_IN_A_ROW = int(os.environ.get("NPC_FAIR_LOST_IN_A_ROW", "2"))
FAIR_FLOOR = float(os.environ.get("NPC_FAIR_FLOOR", "0.5"))
FAIR_CEILING = float(os.environ.get("NPC_FAIR_CEILING", "0.75"))
FAIR_REST_ROUNDS = int(os.environ.get("NPC_FAIR_REST_ROUNDS", "2"))
FAIR_FAILED_REST_ROUNDS = int(os.environ.get("NPC_FAIR_FAILED_REST_ROUNDS", "1"))  # the rest after a step that did not pay off
DIAL_STEP = float(os.environ.get("NPC_FAIR_DIAL_STEP", "0.15"))     # one step, as a share of the setting's range
FAIR_NO_RETURN_ROUNDS = int(os.environ.get("NPC_FAIR_NO_RETURN_ROUNDS", "4"))  # a rule fairness took off stays off this long
FAIR_SNAP = float(os.environ.get("NPC_FAIR_SNAP", "0.05"))          # a weight this close to the default becomes the default

# What the adapter keeps for itself. None of it is sent to the game.
PRIVATE_UPDATE_KEYS = ("eased_after_rounds", "dial_after_rounds", "rounds_at", "removed", "constant",
                       "direction", "removed_rules", "caps", "played_at", "before", "took_back", "seen_round")
PRIVATE_CHANGE_KEYS = ("after_round", "habit", "wants", "held")

# An expectation is judged once the habit has shown up this often since.
CHECK_MIN_USES = int(os.environ.get("NPC_CHECK_MIN_USES", "2"))

# A weight has to move at least this much for a player to see the difference.
CLEAR_SHIFT = float(os.environ.get("NPC_CLEAR_SHIFT", "0.1"))

RECENT_ROUNDS = 5
FAIRNESS = "fairness"  # the `kind` on a change that is a fairness adjustment and not a rule change
CHECK = "check"        # the writer name when the adapter's own check takes a rule off
LIKE = "like_"

Ask = Callable[..., Awaitable[models_client.ModelReply]]


# ---------------------------------------------------------------- small helpers

# Odd dashes, dots and curly quotes a model may write, and the plain mark each becomes.
_PLAIN = {
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2212": "-",
    "\u00b7": ",", "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
}


def tidy(text: Any) -> str:
    """One clean line: plain punctuation, single spaces."""
    line = str(text or "")
    for odd, plain in _PLAIN.items():
        line = line.replace(odd, plain)
    return " ".join(line.split())


def words(name: Any) -> str:
    """A name from the game as plain words, with spaces where it had underscores."""
    return str(name).replace("_", " ")


_SCORE = r"(?:0?\.\d+|1\.0+)"


def how_often(score: float) -> str:
    """A 0 to 1 score in the words a person would use."""
    if score >= 0.9:
        return "almost always"
    if score >= 0.65:
        return "most of the time"
    if score >= 0.35:
        return "about half the time"
    return "sometimes" if score >= 0.15 else "rarely"


def no_scores(line: str) -> str:
    """Turn any raw 0 to 1 score in a line into plain words. Counts like "9 of 12" stay."""
    def said(found: re.Match[str]) -> str:
        return how_often(float(found.group(1)))
    line = re.sub(rf"\b(?:at|with) an? ({_SCORE}) (?:rate|score|level|value|share)\b", said, line)
    line = re.sub(rf"\b(?:an? )?(?:rate|score|level|value|share) of ({_SCORE})\b", said, line)
    return re.sub(rf"(?<![\w.])({_SCORE})(?!\w)", said, line)


def plain(text: Any) -> str:
    """A line a person will read: tidy, no underscores left inside names, and no raw scores."""
    return no_scores(re.sub(r"(?<=[A-Za-z0-9])_(?=[A-Za-z0-9])", " ", tidy(text)))


def tidy_lines(lines: Any, limit: int = MAX_LINES) -> list[str]:
    cleaned = [shorten(plain(line), MAX_WORDS) for line in (lines if isinstance(lines, list) else [])]
    return [line for line in cleaned if line][:limit]


def fill_lines(lines: list[str], spare: list[str]) -> list[str]:
    """Two or three lines, most important first: the ones given, topped up from `spare` when short."""
    lines = list(lines[:MAX_LINES])
    for line in spare:
        if len(lines) >= MIN_LINES:
            break
        if line and line not in lines:
            lines.append(line)
    return lines


def plan_lines_for(changes: list[dict[str, Any]]) -> list[str]:
    """Short plan lines built in code from the changes, for when a writer gave too few."""
    lines: list[str] = []
    for change in changes:
        where, new = str(change.get("where", "")), change.get("to")
        if change.get("kind") == FAIRNESS:
            continue
        if where.endswith(".rules"):
            if isinstance(new, str):
                tail = new.split("I play ", 1)[-1] if "I play " in new else new.split("I always play ", 1)[-1]
                lines.append(shorten(f"New rule: I play {tail}", MAX_WORDS))
            else:
                lines.append("I let one rule go.")
        elif where.count(".") == 2:
            _, decision, option = where.split(".")
            more = float((new or {}).get("base", 0)) >= float((change.get("from") or {}).get("base", 0))
            lines.append(shorten(f"I lean {'more' if more else 'less'} on {words(option)} for {words(decision)}.", MAX_WORDS))
    return lines + ["I keep watching how you play."]


def names_of(setup: Message, spec: Any) -> list[str] | None:
    """The allowed names for a fact, or None if it isn't a list of names."""
    if isinstance(spec, list):
        return [str(name) for name in spec]
    if isinstance(spec, str) and isinstance(setup.get("lists", {}).get(spec), list):
        return [str(name) for name in setup["lists"][spec]]
    return None


def option_ids(setup: Message) -> dict[str, tuple[str, str, str]]:
    """Every NPC option under one id: "<npc>.<decision>.<option>"."""
    ids = {}
    for npc, spec in (setup.get("npcs") or {}).items():
        for decision, detail in (spec.get("decisions") or {}).items():
            for option in (detail.get("options") or {}):
                ids[f"{npc}.{decision}.{option}"] = (npc, decision, option)
    return ids


def condition_text(cond: dict[str, Any]) -> str:
    name = words(cond.get("fact", cond.get("value")))
    if "is" in cond:
        return f"{name} is {words(cond['is'])}"
    if "in" in cond:
        return f"{name} is one of {', '.join(words(item) for item in cond['in'])}"
    if "above" in cond:
        return f"{name} is above {cond['above']}"
    if "below" in cond:
        return f"{name} is below {cond['below']}"
    return name


def rule_text(rule: dict[str, Any]) -> str:
    """A rule as one plain sentence, for `changes` and the second screen."""
    do = " and ".join(f"{words(option)} for {words(decision)}" for decision, option in (rule.get("do") or {}).items())
    conditions = " and ".join(condition_text(cond) for cond in rule.get("if") or [])
    return f"When {conditions}, I play {do}." if conditions else f"I always play {do}."


def _same_rule(a: dict[str, Any], b: dict[str, Any]) -> bool:
    key = lambda rule: json.dumps({"if": rule.get("if") or [], "do": rule.get("do") or {}}, sort_keys=True)
    return key(a) == key(b)


def _rules(behaviour: Behaviour, npc: str) -> list[dict[str, Any]]:
    return list(((behaviour.get("npcs") or {}).get(npc) or {}).get("rules") or [])


def habit_key(habit: dict[str, Any]) -> dict[str, Any]:
    return {"event": habit["event"], "field": habit["field"], "value": habit["value"]}


def habit_line(habit: dict[str, Any]) -> str:
    """A habit in the opponent's own words, with its count."""
    total = round(habit["uses"] / habit["share"]) if habit.get("share") else habit["uses"]
    return f"You picked {words(habit['value'])} on {habit['uses']} of your {total} {words(habit['event'])}s."


def why_for(change: dict[str, Any], plan: list[str]) -> str:
    """A reason for a change whose writer gave none: the plan line that names what changed,
    or else a line built from the change itself. No change is sent without a reason."""
    parts = [words(part) for part in str(change.get("where", "")).split(".")[1:] if part != "rules"]
    for line in plan:
        if parts and parts[-1] in line.lower():
            return line
    return plan_lines_for([change])[0]


def tell_line(tell: dict[str, Any]) -> str:
    """An early sign that held up, with its count."""
    return (f"{words(tell['field'])} {words(tell['value'])} was followed by {words(tell['then_field'])} "
            f"{words(tell['then_value'])} on {tell['hits']} of {tell['pairs']}.")


def sign_facts(setup: Message) -> dict[str, tuple[str, str]]:
    """The facts that repeat an event's field at the moment an NPC chooses: fact name to (event, field).

    A fact is matched by name, as `<event>_<field>` or `<first word of the event>_<field>`.
    A rule that checks one of these reacts to an early sign.
    """
    facts = setup.get("facts") or {}
    found: dict[str, tuple[str, str]] = {}
    for event_name, spec in (setup.get("events") or {}).items():
        for field_name in ((spec or {}).get("fields") or {}):
            for fact in (f"{event_name}_{field_name}", f"{event_name.split('_')[0]}_{field_name}"):
                if fact in facts:
                    found[fact] = (event_name, field_name)
    return found


def tell_behind(cond: dict[str, Any], source: tuple[str, str], held: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The early sign that backs one condition of a rule, or None when it has not held up."""
    if isinstance(cond.get("is"), str):
        wanted = [cond["is"]]
    elif isinstance(cond.get("in"), list):
        wanted = [str(name) for name in cond["in"]]
    elif "above" in cond:
        wanted = ["high"]
    elif "below" in cond:
        wanted = ["low"]
    else:
        return None
    found = [tell for tell in held if (tell["event"], tell["field"]) == source and tell["value"] in wanted]
    return found[0] if found and {tell["value"] for tell in found} >= set(wanted) else None


def hold_to_evidence(setup: Message, behaviour: Behaviour, current: Behaviour, facts: Facts,
                     barred: list[dict[str, Any]] | None = None,
                     constant: list[str] | None = None,
                     gone: set[tuple[str, str]] | None = None,
                     caps: dict[tuple[str, str], float] | None = None) -> tuple[Behaviour, list[str], list[str]]:
    """Keep a writer's new rules and weights inside what has been measured.

    A new rule that checks an early-sign fact stays only when that sign has
    held up. An option that beats every practice player says nothing about
    this player, so it gets no new rule and its weight rises one small step
    at most. Returns the behaviour, one line for each early sign a kept rule
    leans on, and one line for each thing taken out.
    """
    behaviour = copy.deepcopy(behaviour)
    signs = sign_facts(setup)
    held = (facts["measures"].get("tells") or {}).get("held") or []
    table = [Matchup(**row) for row in facts["matchups"]]
    never = matchups.holes(table)                        # a hole in the game: never raised at all
    everyone = matchups.general_options(table) | never
    turned_down = {(decision, option) for do in (barred or []) for decision, option in do.items()}
    gone, caps = gone or set(), caps or {}
    backed: list[str] = []
    refused: list[str] = []
    for npc, entry in (behaviour.get("npcs") or {}).items():
        known = _rules(current, npc)
        kept = []
        for rule in _rules(behaviour, npc):
            if any(_same_rule(rule, old) for old in known):
                kept.append(rule)
                continue
            does = [(decision, option) for decision, option in (rule.get("do") or {}).items()]
            if any(pair in turned_down or pair in gone for pair in does):
                refused.append("Left out a rule the fairness check took off earlier in this match.")
                continue
            conditions = rule.get("if") or []
            if not conditions:
                # A rule with no condition fires on every pick. It becomes one small, capped lift in weight.
                was = ((current.get("npcs") or {}).get(npc) or {}).get("decisions") or {}
                for decision, option in does:
                    slot = entry.setdefault("decisions", {}).setdefault(decision, {})
                    start = float(((was.get(decision) or {}).get(option) or {}).get("base", 0))
                    if (npc, decision, option) in everyone or (decision, option) in turned_down:
                        continue
                    lifted = dict(slot.get(option) or {"base": start})
                    lifted["base"] = round(max(float(lifted.get("base", 0)), start + config.GENERAL_COUNTER_STEP), 2)
                    slot[option] = lifted
                refused.append("A rule with no condition fires on every pick, so it became a small weight.")
                continue
            if constant and all(cond.get("fact") in constant for cond in conditions):
                refused.append(f"Left out a rule on {words(conditions[0]['fact'])}: it has had one value on every pick so far.")
                continue
            general = [f"{words(option)} for {words(decision)}" for decision, option in does if (npc, decision, option) in everyone]
            if general:
                refused.append(f"Left out a rule for {general[0]}: it beats every practice player, so it says nothing about you.")
                continue
            lines, missing = [], None
            for cond in rule.get("if") or []:
                fact = cond.get("fact")
                if fact not in signs:
                    continue
                tell = tell_behind(cond, signs[fact], held)
                if tell is None:
                    missing = fact
                    break
                lines.append(tell_line(tell))
            if missing is not None:
                refused.append(f"Left out a rule that reads {words(missing)}: that early sign has not held up yet.")
                continue
            backed += [f"A new rule reads an early sign that held up: {line}" for line in lines]
            kept.append(rule)
        if kept or "rules" in entry:
            entry["rules"] = kept
        before = ((current.get("npcs") or {}).get(npc) or {}).get("decisions") or {}
        for decision, options in (entry.get("decisions") or {}).items():
            for option, weights in (options or {}).items():
                if not isinstance(weights, dict):
                    continue
                was = float(((before.get(decision) or {}).get(option) or {}).get("base", 0))
                if (npc, decision, option) in never or (decision, option) in turned_down:
                    if float(weights.get("base", 0)) > was + 1e-9:
                        weights["base"] = was
                        refused.append(f"Left {words(option)} for {words(decision)} where it was: " + (
                            "it wins nearly every round against everyone, which is a hole in the game."
                            if (npc, decision, option) in never else "the fairness check turned it down a short while ago."))
                elif (decision, option) in caps and float(weights.get("base", 0)) > max(was, caps[(decision, option)]) + 1e-9:
                    weights["base"] = max(was, caps[(decision, option)])
                    refused.append(f"Held {words(option)} for {words(decision)} under what it was when the fairness check turned it down.")
                elif (npc, decision, option) in everyone and float(weights.get("base", 0)) > was + config.GENERAL_COUNTER_STEP + 1e-9:
                    weights["base"] = round(was + config.GENERAL_COUNTER_STEP, 2)
                    refused.append(f"Held {words(option)} for {words(decision)} to one small step: it beats every practice player.")
    return behaviour, backed, refused


# ---------------------------------------------------------------- the facts

def gather_facts(match: MatchState, earlier: list[Message] | None = None) -> Facts:
    """Everything a rule writer is given, built in code from the match so far."""
    setup = match.setup
    values = {spec.name: round(float(match.player.values.get(spec.name, 0.0)), 3) for spec in match.design.values}
    confidence = {spec.name: round(float(match.player.confidence.get(spec.name, 0.0)), 3) for spec in match.design.values}

    personas = copy.deepcopy(match.design.personas)
    for spec in match.design.values if not personas else []:
        if spec.name.startswith(LIKE):
            name = spec.question.get("value_of", spec.name[len(LIKE):])
            personas.append({"name": name, "about": (spec.question.get("criteria") or {}).get(name, spec.about)})

    # Only a confident read of who the player resembles weights the counters.
    names = matchups.players(match.design.matchups)
    read = {LIKE + name: values.get(LIKE + name, 0.0) for name in names
            if confidence.get(LIKE + name, 0.0) >= config.MIN_CONFIDENCE}
    resembles = matchups.likeness(read, names)

    plan = setup.get("plan") or {}
    sent = earlier if earlier is not None else match.updates
    world = {
        name: {"about": spec.get("about", ""), "options": list(spec["options"]),
               "max_picks": spec.get("max_picks") if is_pick_setting(spec) else None,
               "now": world_now(setup, sent, name)}
        for name, spec in world_settings(setup).items()
    }
    return {
        "setup": setup,
        "goal": setup.get("goal", ""),
        "world": world,
        "behaviour": copy.deepcopy(match.behaviour),
        "values": values,
        "confidence": confidence,
        "value_about": {spec.name: spec.about for spec in match.design.values},
        "measures": {**measures.summary(setup, match.events, match.rounds),
                     "won_rounds": measures.how_won_rounds_end(setup, match.rounds, match.events),
                     "lost_rounds": measures.how_lost_rounds_end(setup, match.rounds, match.events)},
        "recent_rounds": [
            {key: round_end.get(key) for key in ("round", "winner", "how", "stats") if key in round_end}
            for round_end in match.rounds[-RECENT_ROUNDS:]
        ],
        "personas": personas,
        "matchups": [asdict(row) for row in match.design.matchups],
        "counters": matchups.best_counters(match.design.matchups, resembles),
        "earlier": [
            {"version": update.get("version"), "changes": [
                {key: change.get(key) for key in ("where", "to", "why", "expect", "held") if key in change}
                for change in update.get("changes") or [] if not str(change.get("where", "")).startswith("settings.")
            ]}
            for update in (earlier if earlier is not None else match.updates)[-3:]
        ],
        "max_candidates": plan.get("max_candidates"),
    }


# ---------------------------------------------------------------- the model-call writer

SYSTEM = (
    "You are the mind of the computer-controlled side in a game. While the match goes on you rewrite "
    "how it plays against this one human player.\n"
    "Voice: every line is your own thought. 'I' is you, the computer-controlled side. 'You' is the "
    "player. Example: \"You made the same choice on 6 of 8 tries. I'll be ready for it.\" Never give "
    "the player advice, tips, praise or encouragement, and never say what the player should do.\n"
    "Use only the names and numbers you are given. Quote exact counts, never words like 'often'."
)


def _condition_schema(checkable: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "on": {"type": "string", "enum": checkable},
            "op": {"type": "string", "enum": ["is", "in", "above", "below"]},
            "names": {"type": "array", "items": {"type": "string"}},
            "number": {"type": "number"},
        },
        "required": ["on", "op", "names", "number"],
    }


class ModelRuleWriter(RuleWriter):
    """One model call that writes the next rules. Used for the "fast" and "standard" writers."""

    def __init__(self, name: str, model: str, thinking: str, ask: Ask | None = None) -> None:
        self.name = name
        self.model = model
        self.thinking = thinking
        self._ask: Ask = ask or models_client.ask_json

    # -- what the model may refer to

    def _frame(self, facts: Facts) -> dict[str, Any]:
        """The ids the model answers with, and what each one stands for."""
        setup = facts["setup"]
        options = option_ids(setup)
        leaned_on = [habit for habit in facts["measures"].get("habits") or [] if habit.get("lift", 0) > 0]
        habits = {f"h{index + 1}": habit for index, habit in enumerate(leaned_on)}
        rules = {}
        for npc in (facts["behaviour"].get("npcs") or {}):
            for rule in _rules(facts["behaviour"], npc):
                rules[f"r{len(rules) + 1}"] = (npc, rule)
        usable = [name for name, level in facts["confidence"].items() if level >= config.MIN_CONFIDENCE]
        # A fact that repeats an early sign can only be checked once a sign on it has held up.
        signs = sign_facts(setup)
        tells = facts["measures"].get("tells") or {}
        held_on = {(tell["event"], tell["field"]) for tell in tells.get("held") or []}
        constant = facts["measures"].get("constant_facts") or []
        checkable = {f"fact:{name}": ("fact", name) for name, kind in (setup.get("facts") or {}).items()
                     if kind != "text" and name not in constant and (name not in signs or signs[name] in held_on)}
        checkable.update({f"value:{name}": ("value", name) for name in usable})
        # An option that beats every practice player is general: no rule may install it.
        everyone = matchups.general_options([Matchup(**row) for row in facts["matchups"]])
        general = sorted(option_id for option_id, key in options.items() if key in everyone)
        counters = {}
        for row in facts["counters"]:
            if not row.get("general"):
                counters.setdefault(f"{row['npc']}.{row['decision']}.{row['option']}", row)
        return {"options": options, "habits": habits, "rules": rules, "usable": usable,
                "checkable": checkable, "counters": counters, "signs": signs, "tells": tells, "general": general,
                "world": facts.get("world") or {}}

    def _schema(self, frame: dict[str, Any]) -> dict[str, Any]:
        text = {"type": "string"}
        compact = config.WRITER_COMPACT
        lines = {"type": "array", "minItems": MIN_LINES, "maxItems": MIN_LINES if compact else MAX_LINES, "items": text}
        habit = {"type": "string", "enum": [*frame["habits"], "none"]}
        # With a matchup table, a new rule may only install a counter the table supports for this
        # player. A rule that checks an early sign that held up may install any option but a general one.
        free = sorted(set(frame["options"]) - set(frame["general"]))
        reads_signs = any(on[len("fact:"):] in frame["signs"] for on in frame["checkable"])
        installable = free if reads_signs else (sorted(frame["counters"]) or free)
        most_rules = 2 if installable and frame["checkable"] else 0   # a rule needs a condition it can check
        installable = installable or sorted(frame["options"])[:1]
        rule_fields: dict[str, Any] = {"do": {"type": "string", "enum": installable}}
        if frame["checkable"]:
            rule_fields["if"] = {"type": "array", "minItems": 1, "items": _condition_schema(sorted(frame["checkable"]))}
        rule_fields.update({"why": text, "expect": text} if compact else {"why": text, "expect": text, "habit": habit})
        properties: dict[str, Any] = {
            "observations": lines,
            "plan": lines,
            "new_rules": {"type": "array", "maxItems": most_rules, "items": {
                "type": "object", "properties": rule_fields, "required": list(rule_fields),
            }},
            "weights": {"type": "array", "maxItems": 2 if compact else 3, "items": {
                "type": "object",
                "properties": {
                    "option": {"type": "string", "enum": sorted(frame["options"])},
                    "base": {"type": "number"},
                    "value": {"type": "string", "enum": [*frame["usable"], "none"]},
                    "weight": {"type": "number"},
                    "why": text, "expect": text, **({} if compact else {"habit": habit}),
                },
                "required": ["option", "base", "value", "weight", "why", "expect", *([] if compact else ["habit"])],
            }},
        }
        required = ["observations", "plan", "new_rules", "weights"]
        if frame["world"]:
            # A world setting: what the next round is played in. One change at most, to one name or a list of names.
            names = sorted({option for spec in frame["world"].values() for option in spec["options"]})
            most = max([spec["max_picks"] or 1 for spec in frame["world"].values()])
            properties["world"] = {"type": "array", "maxItems": 1, "items": {
                "type": "object",
                "properties": {
                    "setting": {"type": "string", "enum": sorted(frame["world"])},
                    "picks": {"type": "array", "maxItems": most, "items": {"type": "string", "enum": names}},
                    "why": text, "expect": text, **({} if compact else {"habit": habit}),
                },
                "required": ["setting", "picks", "why", "expect", *([] if compact else ["habit"])],
            }}
            required.append("world")
        if frame["rules"]:
            properties["keep_rules"] = {"type": "array", "items": {"type": "string", "enum": sorted(frame["rules"])}}
            required.append("keep_rules")
        return {"type": "object", "properties": properties, "required": required}

    def _prompt(self, facts: Facts, frame: dict[str, Any]) -> str:
        setup = facts["setup"]
        summary = facts["measures"]
        compact = config.WRITER_COMPACT
        out = [f"GOAL: {facts['goal']}", "", "MY OPTIONS (id: what it is):"]
        for option_id, (npc, decision, option) in frame["options"].items():
            detail = setup["npcs"][npc]["decisions"][decision]
            out.append(f"- {option_id}: {detail['options'][option]}" + ("" if compact else f" (chosen: {detail.get('when', '')})"))

        out += ["", "FACTS A RULE MAY CHECK AT THE MOMENT I CHOOSE:"]
        for name, kind in (setup.get("facts") or {}).items():
            allowed = names_of(setup, kind)
            if allowed is not None:
                out.append(f"- fact:{name} is one of: {', '.join(allowed)}")
            elif kind != "text":
                out.append(f"- fact:{name} is a number")
        out += ["", "VALUES A RULE MAY CHECK (my read of you, 0 to 1, confident reads only):"]
        out += [f"- value:{name} = {facts['values'][name]} ({facts['value_about'].get(name, '')})" for name in frame["usable"]] or ["- none yet"]

        rounds = summary.get("rounds") or 0
        rate = summary.get("player_win_rate")
        won = round(rate * rounds) if rate is not None else 0
        out += ["", f"SO FAR: {rounds} rounds finished. You won {won} of them."]
        recent = facts["recent_rounds"][-FAIR_ROUNDS:]
        if len(recent) >= 2:
            recent_won = sum(1 for round_end in recent if round_end.get("winner") == "player")
            out.append(f"You won {recent_won} of the last {len(recent)} rounds.")
        if struggling(facts["recent_rounds"]) is not None:
            out.append("That is under the fair share. Do not add pressure: write no new rules, and only soften weights.")

        out += ["", "YOUR HABITS (counted from your own events):"]
        for habit_id, habit in list(frame["habits"].items())[:4 if compact else None]:
            total = round(habit["uses"] / habit["share"]) if habit.get("share") else habit["uses"]
            line = f"- {habit_id}: {habit['event']}.{habit['field']} = {habit['value']} on {habit['uses']} of {total}."
            if habit.get("payoff") is not None:
                line += f" It came in rounds you won {habit['wins']} of {habit['uses']} times (payoff {habit['payoff']})."
            out.append(line)
        if not frame["habits"]:
            out.append("- none clear yet")

        out += ["", "MY RULES NOW (checked first, in order):"]
        out += [f"- {rule_id} [{npc}]: {rule_text(rule)}" for rule_id, (npc, rule) in frame["rules"].items()] or ["- none"]
        weights = {npc: entry.get("decisions") for npc, entry in (facts["behaviour"].get("npcs") or {}).items()}
        out += ["", "MY WEIGHTS NOW: " + json.dumps(weights, separators=(",", ":"))]

        if frame["counters"]:
            out += ["", "COUNTERS FROM PRACTICE (most specific to you first). A new rule may only install one of these, "
                        "unless it checks an early sign that held up:"]
            for row in [row for row in facts["counters"] if not row.get("general")][:3 if compact else None]:
                out.append(
                    f"- {row['npc']}.{row['decision']}.{row['option']}: against {row['against']} "
                    f"(you resemble them {row['likeness']}) I won {row['npc_wins']} of {row['rounds']}, "
                    f"up from {row['baseline_wins']} of {row['baseline_rounds']} with my first behaviour. "
                    f"That edge is {row.get('specific', 0):+.2f} bigger than against the other practice players."
                )
            out.append("Prefer the most specific counter, and name the habit of yours it answers.")
        if frame["general"]:
            out += ["", "GENERAL OPTIONS: " + ", ".join(frame["general"]) + ". These beat every practice player, so "
                        "they say nothing about you. Never write a rule for one. Raise its base by at most "
                        f"{config.GENERAL_COUNTER_STEP:g}, and only when no specific counter fits."]
        won_lines = facts["measures"].get("won_rounds") or []
        if won_lines:  # how the player's won rounds ended, so the next change aims at what is winning them rounds
            out += ["", "HOW YOU WIN ROUNDS (aim your next change at this): " + " ".join(won_lines)]
        lost_lines = facts["measures"].get("lost_rounds") or []
        if lost_lines:  # rounds lost with nothing sent: the plainest sign this side has gone too far
            out += ["", "HOW YOU LOSE ROUNDS (a sign I have gone too far, so add nothing that causes this): "
                        + " ".join(lost_lines)]
        fact_of = {source: fact for fact, source in frame["signs"].items()}
        held = [tell for tell in frame["tells"].get("held") or [] if (tell["event"], tell["field"]) in fact_of]
        weak = [] if compact else [tell for tell in frame["tells"].get("weak") or [] if (tell["event"], tell["field"]) in fact_of]
        if held or weak:
            out += ["", "EARLY SIGNS (what you show just before you act, then what you really did):"]
            for mark, tell in [("HELD UP", tell) for tell in held] + [(f"did not hold up, {tell['why']}", tell) for tell in weak[:4]]:
                out.append(
                    f"- {mark}: fact:{fact_of[(tell['event'], tell['field'])]} {tell['value']}, then "
                    f"{tell['then_event']}.{tell['then_field']} = {tell['then_value']} on {tell['hits']} of {tell['pairs']}."
                )
            out.append(
                "A rule may check an early-sign fact only for a sign marked HELD UP, on that same value. For a "
                "number, low is the bottom third of its range (use `below`) and high is the top third (use "
                "`above`). Such a rule may install any option of mine that is chosen at that moment, and its "
                "`why` gives the sign's count."
            )
        earlier = [(update["version"], change) for update in facts["earlier"] for change in update["changes"] if change.get("expect")]
        if earlier:
            out += ["", "WHAT I EXPECTED EARLIER:"]
            for version, change in earlier[-(2 if compact else 4):]:
                verdict = {True: "it held", False: "it did not hold"}.get(change.get("held"), "not judged yet")
                out.append(f"- v{version}: {change.get('to')} I expected: {change['expect']} Result: {verdict}.")

        if frame["world"]:
            out += ["", "WORLD SETTINGS I MAY CHANGE FOR THE NEXT ROUND (name: what it is; options; now):"]
            for name, spec in frame["world"].items():
                now = spec["now"]
                shown = ", ".join(now) if isinstance(now, list) else str(now)
                many = f" Pick up to {spec['max_picks']} different names, or none." if spec["max_picks"] else " Pick exactly one name."
                out.append(f"- {name}: {spec['about']} Options: {', '.join(spec['options'])}. Now: {shown or 'none'}.{many}")
            out.append(
                "- world: 0 or 1 change. Change a world setting only when it answers a habit of yours, or how you win "
                "or lose rounds, by what its description says it does and by the GOAL. `picks` is its new value: the "
                "names to pick (one name for a single-choice setting, [] to clear a list). `why` gives a count from "
                "above; `expect` says what should happen to your habit next. Leave world empty when nothing fits."
            )

        if compact:
            return "\n".join(out + [
                "",
                "WRITE THE NEXT UPDATE. Say only what changes.",
                "- Answer the one habit you rely on most, or what is winning you rounds. Change something a player can "
                "see: one new rule, or a weight shift of at least 0.2.",
                f"- new_rules: 0 to 2. Each forces one option (`do`) when all its `if` conditions hold. I hold at most "
                f"{MAX_RULES} rules for each NPC. keep_rules lists the current rules to keep: drop one only when it did "
                "not hold or stands in the way.",
                "- A condition names one fact or value (`on`). For names use op `is` or `in` with `names`. For a number "
                "or a value use `above` or `below` with `number`. Fill the unused one with [] or 0. A rule must be true "
                "only some of the time. Use a weight for anything that is always on.",
                "- weights: 0 to 2. `base` is the option's new score (-1 leaves it). `value` and `weight` add weight "
                "times that value (none and 0 leave it).",
                f"- `why`: one line with a count from above. `expect`: one sentence on what should happen to your habit "
                f"next. At most {MAX_WORDS} words each.",
                f"- observations: {MIN_LINES} lines of at most 10 words, each with a count from above. plan: {MIN_LINES} "
                "lines of at most 8 words, each a short sentence on what I will now do to you, the main change first.",
                "- Plain words for someone watching. Write some_name as 'some name'. Never write an id like h1 or r1, "
                "and never a raw score such as 0.8: say almost always, about half the time or rarely, or give a count.",
            ])
        out += [
            "",
            "WRITE THE NEXT UPDATE.",
            "- Take away one habit at a time. Pick the habit you rely on most, and answer it.",
            "- Change something a player can see: one new rule, or a weight shift of at least 0.2. Never change nothing.",
            f"- new_rules: 0 to 2. Each forces one option (`do`) when all of its `if` conditions hold. "
            f"I may hold at most {MAX_RULES} rules for each NPC. List the current rules to keep in keep_rules. "
            "Keep a rule unless what I expected from it did not hold, or it stands in the way of a better one.",
            "- A condition names one fact or value (`on`). For a fact that is one of several names use op "
            "`is` or `in` and put the names in `names`. For a number or a value use `above` or `below` and "
            "`number`. Fill the unused one with [] or 0. Every rule needs at least one condition that is "
            "true only some of the time: a rule that always fires is not allowed. Use a weight for that.",
            "- weights: 0 to 3 softer shifts. `base` is the option's new score before I know you (use -1 to "
            "leave it). `value` and `weight` add weight times that value to the score (use none and 0 to leave it).",
            "- For each rule and weight: `why` is one line with a count from above. `expect` is one sentence "
            "on what should happen to your habit next, like \"That choice should win you fewer rounds.\", "
            f"naming the choice. `habit` is the habit it answers. `why` and `expect` are at most {MAX_WORDS} words each.",
            f"- observations: {MIN_LINES} or {MAX_LINES} lines about how you play, the most important first, each at most "
            f"{MAX_WORDS} words with a number from above. Say it the way a spectator would, like "
            "\"You picked the same side on 9 of your 12 turns.\"",
            f"- plan: {MIN_LINES} or {MAX_LINES} lines on what I will do differently, the most important first, "
            f"each at most {MAX_WORDS} words.",
            "- Write every line for someone watching the match: plain words in a full sentence. Write a name "
            "like some_name as 'some name', with no underscores. Describe a habit, never quote a value's name. "
            "Never write an id like h1 or r1. Never write a raw score such as 0.8: say almost always, most "
            "of the time, about half the time or rarely, or give a count from above.",
        ]
        return "\n".join(out)

    # -- turning the reply into a proposal

    def _condition(self, setup: Message, frame: dict[str, Any], raw: Any) -> dict[str, Any] | None:
        """One condition in the contract's shape, or None if the reply's condition can't be used."""
        if not isinstance(raw, dict) or raw.get("on") not in frame["checkable"]:
            return None
        kind, name = frame["checkable"][raw["on"]]
        op = raw.get("op")
        number = raw.get("number")
        numeric = isinstance(number, (int, float)) and not isinstance(number, bool)
        if kind == "value":
            return {"value": name, op: min(max(float(number), 0.0), 1.0)} if op in ("above", "below") and numeric else None
        allowed = names_of(setup, setup["facts"][name])
        if allowed is not None:
            picked = [str(item) for item in (raw.get("names") or []) if str(item) in allowed]
            if op == "is" and len(picked) == 1:
                return {"fact": name, "is": picked[0]}
            if op in ("is", "in") and picked:
                return {"fact": name, "in": picked}
            return None
        if op in ("above", "below", "is") and numeric:
            return {"fact": name, op: number}
        return None

    def _proposal(self, facts: Facts, frame: dict[str, Any], reply: dict[str, Any]) -> Proposal:
        setup = facts["setup"]
        behaviour: Behaviour = copy.deepcopy(facts["behaviour"])
        changes: list[dict[str, Any]] = []
        dropped: list[str] = []

        def habit_of(raw: dict[str, Any]) -> dict[str, Any] | None:
            habit = frame["habits"].get(raw.get("habit"))
            return habit_key(habit) if habit else None

        # Rules: new ones go first, then the ones the model kept.
        keep = reply.get("keep_rules")
        kept_ids = list(frame["rules"]) if keep is None else [rule_id for rule_id in frame["rules"] if rule_id in keep]
        fresh: dict[str, list[dict[str, Any]]] = {}
        for raw in reply.get("new_rules") or []:
            if not isinstance(raw, dict) or raw.get("do") not in frame["options"]:
                dropped.append(f"A new rule named an option that does not exist: {raw!r}"[:200])
                continue
            npc, decision, option = frame["options"][raw["do"]]
            conditions = [self._condition(setup, frame, cond) for cond in raw.get("if") or []]
            if any(cond is None for cond in conditions):
                dropped.append(f"A new rule for {raw['do']} had a condition that can't be checked.")
                continue
            if not conditions:
                dropped.append(f"A new rule for {raw['do']} had no condition, so it would fire on every pick.")
                continue
            reads_sign = any(cond.get("fact") in frame["signs"] for cond in conditions)
            if frame["counters"] and raw["do"] not in frame["counters"] and not reads_sign:
                dropped.append(f"A new rule for {raw['do']} is no counter from practice and reads no early sign.")
                continue
            rule = {"if": conditions, "do": {decision: option}, "why": shorten(plain(raw.get("why")), MAX_WORDS)}
            existing = [old for rule_id, (old_npc, old) in frame["rules"].items() if old_npc == npc and rule_id in kept_ids]
            if any(_same_rule(rule, old) for old in existing + fresh.get(npc, [])):
                continue
            fresh.setdefault(npc, []).append(rule)
            changes.append({"where": f"{npc}.rules", "from": None, "to": rule_text(rule), "why": rule["why"],
                            "expect": plain(raw.get("expect")), "habit": habit_of(raw)})
        for npc, entry in (behaviour.get("npcs") or {}).items():
            kept = [rule for rule_id, (rule_npc, rule) in frame["rules"].items() if rule_npc == npc and rule_id in kept_ids]
            entry["rules"] = (fresh.get(npc, []) + kept)[:MAX_RULES]

        # Weights.
        for raw in reply.get("weights") or []:
            if not isinstance(raw, dict) or raw.get("option") not in frame["options"]:
                continue
            npc, decision, option = frame["options"][raw["option"]]
            slot = behaviour["npcs"].setdefault(npc, {}).setdefault("decisions", {}).setdefault(decision, {})
            before = copy.deepcopy(slot.get(option) or {"base": 0})
            after = copy.deepcopy(before)
            base = raw.get("base")
            if isinstance(base, (int, float)) and not isinstance(base, bool) and base >= 0:
                after["base"] = round(float(base), 2)
            value, weight = raw.get("value"), raw.get("weight")
            if value in frame["usable"] and isinstance(weight, (int, float)) and not isinstance(weight, bool):
                when = dict(after.get("when") or {})
                when[value] = round(min(max(float(weight), -1.0), 1.0), 2)
                if when[value] == 0:
                    del when[value]
                after.pop("when", None)
                if when:
                    after["when"] = when
            if after == before:
                continue
            slot[option] = after
            changes.append({"where": f"{npc}.{decision}.{option}", "from": before, "to": after, "why": plain(raw.get("why")),
                            "expect": plain(raw.get("expect")), "habit": habit_of(raw)})

        settings: dict[str, Any] = {}
        for raw in reply.get("world") or []:
            if not isinstance(raw, dict) or raw.get("setting") not in frame["world"] or raw["setting"] in settings:
                continue
            name, spec = raw["setting"], frame["world"][raw["setting"]]
            picks = [str(item) for item in raw.get("picks") or [] if isinstance(item, str)]
            value: Any = list(dict.fromkeys(picks)) if spec["max_picks"] else (picks[0] if picks else None)
            problems = _setting_check(setup, name, value) if _setting_check is not None else []
            if value is None or problems:
                dropped.append(f"A change to the setting {name} did not fit what the game allows: {value!r}"[:200])
                continue
            if value == spec["now"] or (spec["max_picks"] and spec["now"] in (None, "none") and value == []):
                continue
            settings[name] = value
            changes.append({"where": f"settings.{name}", "from": spec["now"], "to": value, "why": plain(raw.get("why")),
                            "expect": plain(raw.get("expect")), "habit": habit_of(raw)})

        proposal: Proposal = {
            "behaviour": behaviour,
            "observations": tidy_lines(reply.get("observations")),
            "plan": tidy_lines(reply.get("plan")),
            "changes": changes,
        }
        if settings:
            proposal["settings"] = settings
        if dropped:
            proposal["dropped"] = dropped
        return proposal

    async def write(self, facts: Facts, budget_seconds: float, trace: Trace) -> Proposal | None:
        frame = self._frame(facts)
        if not frame["options"]:
            return None
        if not frame["habits"] and not frame["usable"]:
            trace(trace_message("adapter", "done", "I have seen too little of your play to change anything yet.",
                                data={"writer": self.name}))
            return None
        trace(trace_message("adapter", "start", f"Asking {self.model} for the next rules.", model=self.model,
                            data={"writer": self.name, "thinking": self.thinking}))
        answer = await self._ask(
            self.model, self.thinking, self._prompt(facts, frame), self._schema(frame),
            system=SYSTEM, timeout=budget_seconds,
        )
        proposal = self._proposal(facts, frame, answer.data)
        proposal["model"] = answer.model
        proposal["ms"] = answer.ms
        trace(trace_message("adapter", "done", f"{self.model} wrote {len(proposal['changes'])} changes.", model=self.model,
                            ms=answer.ms, data={"writer": self.name, "usage": answer.usage}))
        return proposal


def writer_named(
    name: str,
    wait_seconds: float = config.DEFAULT_UPDATE_SECONDS,
    plan: dict[str, Any] | None = None,
    ask: Ask | None = None,
) -> RuleWriter:
    """The writer for one of the names in config.WRITER_TIERS.

    A managed agent run tries as many rule sets as fit in the wait. It is
    called "deepest" only when that is more than one.
    """
    if name == "fast":
        return ModelRuleWriter("fast", config.FAST_WRITER_MODEL, "low", ask)
    if name in ("deep", "deepest"):
        try:  # imported only when a game can wait long enough for it
            from server.managed_writer import ManagedAgentWriter
            candidates = config.candidates_for(wait_seconds, (plan or {}).get("max_candidates"))
            writer = ManagedAgentWriter(candidates=candidates)
            writer.name = "deepest" if candidates > 1 else "deep"
            return writer
        except Exception:
            pass  # no managed writer here, so the standard one answers
    return ModelRuleWriter("standard", config.ADAPTER_MODEL, config.ADAPTER_THINKING, ask)


# ---------------------------------------------------------------- checking a behaviour

def local_problems(setup: Message, behaviour: Any, value_names: set[str]) -> list[str]:
    """A small check of our own, used with the shared contract check or without it."""
    if not isinstance(behaviour, dict) or not isinstance(behaviour.get("npcs"), dict):
        return ["The behaviour has no `npcs`."]
    problems: list[str] = []
    declared = setup.get("npcs") or {}
    facts = setup.get("facts") or {}
    for npc, entry in behaviour["npcs"].items():
        if npc not in declared or not isinstance(entry, dict):
            problems.append(f"`{npc}` is not an NPC of this game.")
            continue
        decisions = declared[npc].get("decisions") or {}
        for decision, options in (entry.get("decisions") or {}).items():
            allowed = (decisions.get(decision) or {}).get("options")
            if allowed is None:
                problems.append(f"`{decision}` is not a decision of `{npc}`.")
                continue
            for option, weights in (options or {}).items():
                if option not in allowed:
                    problems.append(f"`{option}` is not an option of `{decision}`.")
                    continue
                base = (weights or {}).get("base", 0)
                if not isinstance(base, (int, float)) or isinstance(base, bool) or base < 0:
                    problems.append(f"`{npc}.{decision}.{option}.base` must be a number, 0 or more.")
                for value in ((weights or {}).get("when") or {}):
                    if value not in value_names:
                        problems.append(f"`{value}` is not a value this match tracks.")
        rules = entry.get("rules") or []
        if len(rules) > MAX_RULES:
            problems.append(f"`{npc}` has {len(rules)} rules. The most is {MAX_RULES}.")
        for index, rule in enumerate(rules):
            at = f"{npc}.rules.{index}"
            do = rule.get("do") if isinstance(rule, dict) else None
            if not isinstance(do, dict) or not do:
                problems.append(f"`{at}` has no `do`.")
                continue
            for decision, option in do.items():
                if option not in ((decisions.get(decision) or {}).get("options") or {}):
                    problems.append(f"`{at}` picks `{option}` for `{decision}`, which the game did not declare.")
            for cond in rule.get("if") or []:
                if not isinstance(cond, dict) or ("fact" in cond) == ("value" in cond):
                    problems.append(f"`{at}` has a condition that does not check exactly one fact or value.")
                elif "fact" in cond and cond["fact"] not in facts:
                    problems.append(f"`{at}` checks the fact `{cond['fact']}`, which the game did not declare.")
                elif "value" in cond and cond["value"] not in value_names:
                    problems.append(f"`{at}` checks the value `{cond['value']}`, which this match does not track.")
                elif not any(word in cond for word in ("is", "in", "above", "below")):
                    problems.append(f"`{at}` has a condition with nothing to compare.")
    return problems


def behaviour_problems(setup: Message, behaviour: Any, value_names: set[str]) -> list[str]:
    """Every reason this behaviour can't be sent. Empty means it passes."""
    problems = local_problems(setup, behaviour, value_names)
    if _contract_check is not None:
        try:
            found = _contract_check(setup, behaviour, value_names)
        except Exception as error:
            return problems + [f"The contract check failed: {error}"]
        for problem in found or []:
            problems.append(str(problem.get("about", problem)) if isinstance(problem, dict) else str(problem))
    return problems


def repair(setup: Message, behaviour: Behaviour, current: Behaviour, value_names: set[str]) -> Behaviour:
    """One repair attempt, in code: drop every part that fails the check and keep the rest."""
    fixed = copy.deepcopy(behaviour)
    declared = setup.get("npcs") or {}
    fixed["npcs"] = {npc: entry for npc, entry in (fixed.get("npcs") or {}).items() if npc in declared and isinstance(entry, dict)}
    for npc, entry in fixed["npcs"].items():
        allowed = declared[npc].get("decisions") or {}
        decisions = {}
        for decision, options in (entry.get("decisions") or {}).items():
            if decision not in allowed:
                continue
            kept = {}
            for option, weights in (options or {}).items():
                if option not in (allowed[decision].get("options") or {}) or not isinstance(weights, dict):
                    continue
                base = weights.get("base", 0)
                clean: dict[str, Any] = {"base": base if isinstance(base, (int, float)) and not isinstance(base, bool) and base >= 0 else 0}
                when = {value: weight for value, weight in (weights.get("when") or {}).items()
                        if value in value_names and isinstance(weight, (int, float)) and not isinstance(weight, bool)}
                if when:
                    clean["when"] = when
                kept[option] = clean
            decisions[decision] = kept
        entry["decisions"] = decisions
        good = []
        for rule in entry.get("rules") or []:
            alone = {"version": 0, "npcs": {npc: {"decisions": {}, "rules": [rule]}}}
            if not behaviour_problems(setup, alone, value_names):
                good.append(rule)
        entry["rules"] = good[:MAX_RULES]
    for npc, entry in (current.get("npcs") or {}).items():  # never lose an NPC the game is playing with
        fixed["npcs"].setdefault(npc, copy.deepcopy(entry))
    return fixed


# ---------------------------------------------------------------- what changed

def diff(current: Behaviour, new: Behaviour) -> list[dict[str, Any]]:
    """Every difference between two behaviours, as `changes` without the reasons."""
    changes: list[dict[str, Any]] = []
    for npc, entry in (new.get("npcs") or {}).items():
        old_rules, new_rules = _rules(current, npc), _rules(new, npc)
        for rule in new_rules:
            if not any(_same_rule(rule, old) for old in old_rules):
                changes.append({"where": f"{npc}.rules", "from": None, "to": rule_text(rule), "why": plain(rule.get("why"))})
        for rule in old_rules:
            if not any(_same_rule(rule, kept) for kept in new_rules):
                changes.append({"where": f"{npc}.rules", "from": rule_text(rule), "to": None, "why": "I let this rule go."})
        old_decisions = ((current.get("npcs") or {}).get(npc) or {}).get("decisions") or {}
        for decision, options in (entry.get("decisions") or {}).items():
            for option, weights in (options or {}).items():
                before = (old_decisions.get(decision) or {}).get(option)
                if before != weights:
                    changes.append({"where": f"{npc}.{decision}.{option}", "from": before, "to": weights, "why": ""})
    return changes


def _shift(before: Any, after: Any) -> float:
    """The biggest move in one option's numbers."""
    before, after = before or {}, after or {}
    moves = [abs(float(after.get("base", 0)) - float(before.get("base", 0)))]
    for value in set(before.get("when") or {}) | set(after.get("when") or {}):
        moves.append(abs(float((after.get("when") or {}).get(value, 0)) - float((before.get("when") or {}).get(value, 0))))
    return max(moves)


def visible(changes: list[dict[str, Any]]) -> bool:
    """Whether a player could see any of these changes: a rule, or a clear shift in weights."""
    for change in changes:
        if change["where"].endswith(".rules"):
            return True
        if change["where"].startswith("settings."):
            if change.get("from") != change.get("to"):
                return True
            continue
        if _shift(change.get("from"), change.get("to")) >= CLEAR_SHIFT:
            return True
    return False


def with_reasons(changes: list[dict[str, Any]], proposed: list[Any]) -> list[dict[str, Any]]:
    """Carry each `why`, `expect` and `habit` from the writer's changes onto the measured ones."""
    pool = [change for change in proposed if isinstance(change, dict)]
    for change in changes:
        match = next((p for p in pool if p.get("where") == change["where"] and p.get("to") == change["to"]), None)
        match = match or next((p for p in pool if p.get("where") == change["where"]
                               and (p.get("to") is None) == (change["to"] is None)), None)
        if match is None:
            continue
        pool.remove(match)
        for key in ("why", "expect", "habit", "measure"):
            if match.get(key):
                change[key] = plain(match[key]) if key in ("why", "expect") else match[key]
    return changes


# ---------------------------------------------------------------- are the quoted counts real?

_COUNT = re.compile(r"(\d+) (?:out )?of (?:the |your |my )?(?:last |first )?(\d+)")


def known_counts(facts: Facts) -> set[tuple[int, int]]:
    """Every "N of M" the facts support: habits, payoffs, rounds won and practice results."""
    known: set[tuple[int, int]] = set()
    summary = facts["measures"]
    for habit in summary.get("habits") or []:
        total = round(habit["uses"] / habit["share"]) if habit.get("share") else habit["uses"]
        known.add((habit["uses"], total))
        if habit.get("wins") is not None:
            known.add((habit["wins"], habit["uses"]))
    rounds = summary.get("rounds") or 0
    if summary.get("player_win_rate") is not None:
        won = round(summary["player_win_rate"] * rounds)
        known |= {(won, rounds), (rounds - won, rounds)}
    for size in range(1, len(facts["recent_rounds"]) + 1):
        recent = facts["recent_rounds"][-size:]
        won = sum(1 for round_end in recent if round_end.get("winner") == "player")
        known |= {(won, size), (size - won, size)}
    for row in facts["counters"]:
        known |= {(row["npc_wins"], row["rounds"]), (row["baseline_wins"], row["baseline_rounds"])}
    for tell in (summary.get("tells") or {}).get("held") or []:
        known.add((tell["hits"], tell["pairs"]))
    return known


def counts_hold(line: str, known: set[tuple[int, int]]) -> bool:
    """Whether every "N of M" in a line is a count the facts support."""
    return all((int(n), int(m)) in known for n, m in _COUNT.findall(line))


# ---------------------------------------------------------------- did the last change work?

def current_round(match: MatchState) -> int:
    """The round in play now. A new behaviour starts with the round after it."""
    rounds = [int(message.get("round") or 0) for message in match.events[-5:] + match.rounds[-1:]]
    return max(rounds, default=0)


def build_checks(match: MatchState, updates: list[Message]) -> list[dict[str, Any]]:
    """Judge each earlier expectation that can now be judged, from measured play."""
    checks: list[dict[str, Any]] = []
    for update in updates:
        for change in update.get("changes") or []:
            said, since = change.get("expect"), change.get("after_round")
            if not said or not isinstance(since, int) or "held" in change:
                continue  # nothing to judge, or judged in an earlier update
            before_rounds = [r for r in match.rounds if r.get("round", 0) <= since]
            after_rounds = [r for r in match.rounds if r.get("round", 0) > since]
            if change.get("measure") == "player_win_rate":
                before, after = measures.player_win_rate(before_rounds[-FAIR_ROUNDS:]), measures.player_win_rate(after_rounds)
                if before is None or after is None or len(after_rounds) < 2:
                    continue
                held = after < before if change.get("wants") == "lower" else after > before
                measure = "player_win_rate"
            else:
                habit = change.get("habit")
                if not isinstance(habit, dict):
                    continue
                was = measures.habit_payoff(habit, match.events, before_rounds)
                now = measures.habit_payoff(habit, match.events, after_rounds)
                if not was["uses"] or now["uses"] < CHECK_MIN_USES:
                    continue
                before, after = was["payoff"], now["payoff"]
                held = after < before or (before == 0 and after == 0)
                measure = "habit_payoff"
            change["held"] = held  # so the next writer sees how its earlier call went
            check = {"version": update.get("version"), "said": shorten(plain(said), MAX_WORDS), "measure": measure,
                     "before": before, "after": after, "held": held}
            if check not in checks:  # two changes can share one expectation
                checks.append(check)
    return checks[-4:]


# ---------------------------------------------------------------- fairness

def _window() -> int:
    """How many of the latest rounds the fair band reads. 0 means the older blend over the whole match."""
    return max(int(config.FAIR_WINDOW_ROUNDS), 0)


def band() -> tuple[float, float, float]:
    """(low, high, far): under low the next look eases, above high it adds strength, at far the step is widest."""
    if _window():
        return config.FAIR_LOW, config.FAIR_HIGH, config.FAIR_HIGH_FAR
    return config.FAIR_SHARE_FLOOR, config.FAIR_SHARE_CEILING, config.FAIR_FAR_SHARE


def first_step_due(match: MatchState, updates: list[Message], prior: float | None) -> bool:
    """Whether the first real update of a match may go out: nothing real was sent yet, the player has
    done enough to read, and the window reads the lower first mark or more."""
    if not _window() or any(entry.get("changes") for entry in updates):
        return False
    sent = sum(1 for event in match.events if event.get("by") == "player")
    return sent >= 3 and blended_share(played(match), prior) >= config.FAIR_FIRST_HIGH - 1e-9


def last_step_failed(match: MatchState, updates: list[Message]) -> tuple[int, int] | None:
    """(won, rounds) when the last real update added strength and the player has won too few of the rounds since."""
    real = [entry for entry in updates if entry.get("changes")]
    if not _window() or not real or real[-1].get("direction") != "up":
        return None
    since = match.rounds[int(real[-1].get("rounds_at", 0) or 0):]
    if len(since) >= config.FAIR_LAST_STEP_ROUNDS and _won(since) <= config.FAIR_LAST_STEP_WINS:
        return _won(since), len(since)
    return None


def proof_missing(match: MatchState, updates: list[Message]) -> bool:
    """Whether more strength must wait: too few rounds that started after the last real update have finished."""
    real = [entry for entry in updates if entry.get("changes")]
    if not _window() or config.FAIR_PROOF_ROUNDS <= 0 or not real:
        return False  # the first real update of a match needs no proof
    return rounds_since(match, real[-1]) < config.FAIR_PROOF_ROUNDS


def rounds_since(match: MatchState, entry: Message) -> int:
    """The finished rounds that started after an update was built."""
    seen = int(entry.get("seen_round", entry.get("rounds_at", 0)) or 0)
    return sum(1 for round_end in match.rounds if int(round_end.get("round") or 0) > seen)


def open_step(updates: list[Message]) -> tuple[Message, bool] | None:
    """The latest update that added strength and is not yet taken back whole, and whether half of it already was."""
    taken = {(entry.get("took_back") or {}).get("version"): bool((entry.get("took_back") or {}).get("whole"))
             for entry in updates if isinstance(entry.get("took_back"), dict)}
    for entry in reversed(updates):
        if entry.get("direction") == "up" and isinstance(entry.get("before"), dict) and isinstance(entry.get("behaviour"), dict):
            if taken.get(entry.get("version")) is True:
                continue
            return entry, entry.get("version") in taken
    return None


def take_back(current: Behaviour, before: Behaviour, after: Behaviour, whole: bool) -> tuple[Behaviour, list[str], list[dict[str, Any]]]:
    """The play in hand with one earlier step taken back: all of it, or half of what it raised.

    Returns the new play, the options it backs off in the game's own words, and the rules it took off.
    A rule that step added comes off when all of it goes, or when the step moved no weight to halve.
    """
    out = copy.deepcopy(current)
    half = toward_default(copy.deepcopy(current), before)
    names: list[str] = []
    removed: list[dict[str, Any]] = []
    for npc, entry in (after.get("npcs") or {}).items():
        target = (out.get("npcs") or {}).get(npc)
        if not isinstance(target, dict):
            continue
        was = ((before.get("npcs") or {}).get(npc) or {}).get("decisions") or {}
        moved = False
        for decision, options in (entry.get("decisions") or {}).items():
            for option, spec in (options or {}).items():
                old = (was.get(decision) or {}).get(option)
                slot = target.setdefault("decisions", {}).setdefault(decision, {})
                if spec == old or option not in slot:
                    continue
                if float((spec or {}).get("base", 0)) <= float((old or {}).get("base", 0)) + 1e-9 \
                        and (spec or {}).get("when") == (old or {}).get("when"):
                    continue  # that step lowered this option, so there is nothing of it to take back
                eased = old if whole else ((((half.get("npcs") or {}).get(npc) or {}).get("decisions") or {}).get(decision) or {}).get(option)
                if eased is None:
                    slot.pop(option, None)
                else:
                    slot[option] = copy.deepcopy(eased)
                moved = True
                names.append(words(option))
        added = [rule for rule in _rules(after, npc) if not any(_same_rule(rule, old) for old in _rules(before, npc))]
        here = [rule for rule in _rules(out, npc) if any(_same_rule(rule, new) for new in added)]
        if here and (whole or not moved):
            target["rules"] = [rule for rule in _rules(out, npc) if not any(_same_rule(rule, gone) for gone in here)]
            removed += here
            names += [words(option) for rule in here for option in (rule.get("do") or {}).values()]
    return out, list(dict.fromkeys(names)), removed


def _won(rounds: list[Message]) -> int:
    return sum(1 for round_end in rounds if round_end.get("winner") == "player")


def lost_in_a_row(rounds: list[Message]) -> int:
    count = 0
    for round_end in reversed(rounds):
        if round_end.get("winner") == "player":
            break
        count += 1
    return count


def brake(rounds: list[Message]) -> bool:
    """The emergency brake: the player has lost a long run of rounds in a row."""
    return lost_in_a_row(rounds) >= config.FAIR_BRAKE_LOSSES


def blended_share(rounds: list[Message], prior: float | None = None) -> float:
    """The player's share of rounds, judged on evidence and not on a handful of points.

    A match is a few rounds and a row of the practice table is many. So the
    table's estimate for the play as it stands (`prior`) counts as
    FAIR_BLEND_ROUNDS rounds, and the rounds of the match are added to it.
    With no table the middle of the band stands in for the estimate. Every
    band test uses this one number.
    """
    base = config.FAIR_TARGET_SHARE if prior is None else prior
    window = _window()
    if window:  # the last rounds only, with the rounds not yet played filled from the estimate
        latest = rounds[-window:]
        return (_won(latest) + base * (window - len(latest))) / window
    weight = max(config.FAIR_BLEND_ROUNDS, 0.0)
    if weight + len(rounds) <= 0:
        return base
    return (base * weight + _won(rounds)) / (weight + len(rounds))


def struggling(rounds: list[Message], prior: float | None = None) -> tuple[int, int] | None:
    """(rounds the player won, rounds played) when the player is losing too much: the blended
    share is under the floor of the band, or the emergency brake is on."""
    if not rounds:
        return None
    if brake(rounds) or blended_share(rounds, prior) < band()[0] - 1e-9:
        latest = rounds[-_window():] if _window() else rounds
        return _won(latest), len(latest)
    return None


def winning(rounds: list[Message], prior: float | None = None) -> tuple[int, int] | None:
    """(rounds the player won, rounds played) when the player is winning too much: the blended
    share is over the top of the band."""
    if not rounds:
        return None
    latest = rounds[-_window():] if _window() else rounds
    return (_won(latest), len(latest)) if blended_share(rounds, prior) > band()[1] + 1e-9 else None


def under_band(rounds: list[Message], prior: float | None = None) -> tuple[int, int] | None:
    """The same test as `struggling`: under the band nothing may add strength."""
    return struggling(rounds, prior)


def played(match: MatchState) -> list[Message]:
    """The rounds the player took part in. Every fairness count reads these, so a round they sat out changes nothing."""
    return measures.rounds_played(match.rounds, match.events)


def eased_lately(match: MatchState, updates: list[Message]) -> bool:
    """Whether the last ease is too fresh for another: too few rounds the player played in have finished since."""
    for update in reversed(updates):
        if update.get("direction") == "down" or isinstance(update.get("eased_after_rounds"), int):
            return len(played(match)) - int(update.get("played_at", 0) or 0) < config.FAIR_EASE_GAP_ROUNDS
    return False


_ROUND_COUNT = re.compile(r"\b(won|win|lost|lose)\w*\s+(\d+)\s+of\s+(?:(?:the|your)\s+)?(?:last\s+)?(\d+)", re.IGNORECASE)


def score_holds(line: Any, match: MatchState) -> bool:
    """Whether a line that cites rounds won or lost is true of the score right now, when it is sent.

    A writer counts at the start of its look and rounds end while it works. A
    count of rounds must match the last rounds as they stand, all of them or
    only the ones the player took part in. Counts of anything else are left alone.
    """
    text = str(line)
    if not any(word in text.lower() for word in ("round", "point", "game")):
        return True
    for verb, got, of in _ROUND_COUNT.findall(text):
        got, of = int(got), int(of)
        fits = False
        for rounds in (match.rounds, played(match)):
            if 0 < of <= len(rounds):
                wins = _won(rounds[-of:])
                fits = fits or got == (wins if verb.lower().startswith("w") else of - wins)
        if not fits:
            return False
    return True


def lost_last(rounds: list[Message]) -> bool:
    """Whether strength must wait because the player lost the most recent round. They get a chance to win one first."""
    return bool(config.ADD_ONLY_AFTER_WIN and rounds and rounds[-1].get("winner") != "player")


SETTING_WORDS = 16  # the most words in a line that says why a setting moves or why the play eases


def dial_reason(step: dict[str, Any]) -> str:
    """Why a setting moves, said by the NPC with the player's share as a percent. Built from the setting's own name."""
    verb = "lower" if step["easier"] else "raise"
    how = "again" if step.get("again") else "a step"
    if not step.get("counted"):
        return f"I {verb} {words(step['setting'])} {how}."
    share = step["won"] / step["counted"]
    return f"I {verb} {words(step['setting'])} {how}, because you win {'only ' if step['easier'] else ''}{share:.0%} of rounds."


def dial_place(step: dict[str, Any]) -> str | None:
    """Where a setting stands after its step, against where the game started it. So no two steps read the same."""
    start, to = step.get("start"), step["to"]
    if _is_number(start) and abs(to - start) < 1e-9:
        return "It is back where we began."
    if step.get("limit"):
        return f"That is as {'low' if to < step['from'] else 'high'} as it goes."
    if not _is_number(start):
        return None
    size = abs(to - step["from"])
    steps = max(1, round(abs(to - start) / size)) if size > 1e-9 else 1
    return f"It is {steps} step{'s' if steps != 1 else ''} {'above' if to > start else 'under'} where we began."


def paired(line: Any, changes: list[dict[str, Any]]) -> str | None:
    """The `where` of the one change a plan line speaks for, or None when that is not sure.

    A line pairs with a change when it is that change's own reason, or when
    it holds every word of the option or setting the change moves and no
    other change fits as well. A wrong tag is worse than none.
    """
    text = plain(line).lower()
    if len(changes) == 1:
        return changes[0]["where"]
    own = {change["where"] for change in changes if change.get("why") and plain(change["why"]).lower().startswith(text.rstrip("."))}
    if len(own) == 1:
        return next(iter(own))
    said = set(re.findall(r"[a-z0-9]+", text))
    fits: dict[str, int] = {}
    for change in changes:
        where = change["where"]
        if where.startswith("settings."):
            names = [where.split(".", 1)[1]]
        elif where.endswith(".rules"):
            rules = change.get("to") if isinstance(change.get("to"), list) else []
            names = [str(option) for rule in rules if isinstance(rule, dict) for option in (rule.get("do") or {}).values()]
        else:
            names = [where.rsplit(".", 1)[-1]]
        for name in names:
            parts = [part for part in str(name).lower().split("_") if part]
            if parts and all(part in said for part in parts):
                fits[where] = max(fits.get(where, 0), len(parts))
    best = max(fits.values(), default=0)
    top = [where for where, score in fits.items() if score == best]
    return top[0] if best and len(top) == 1 else None


def main_choices(match: MatchState, updates: list[Message], least: int = 4) -> dict[tuple[str, str], str] | None:
    """The player's main choice on each field, counted over their events since the last real update.
    None when fewer than `least` events have come since, so nothing can be judged yet."""
    real = [entry for entry in updates if entry.get("changes")]
    since = int(real[-1].get("rounds_at", 0) or 0) if real else 0
    recent = [event for event in match.events if event.get("by") == "player" and int(event.get("round") or 0) > since]
    if len(recent) < least:
        return None
    return {(str(habit["event"]), str(habit["field"])): str(habit["value"]) for habit in measures.habits(match.setup, recent, 1)}


def still_supported(match: MatchState, updates: list[Message], kept: dict[str, Any]) -> bool:
    """Whether a kept step still answers what the player does now.

    A habit a change names that was the player's main choice on its field when
    the step was kept must still be it, counted since the last real update. A
    rule's own condition is not judged, since a rule holds only some of the time.
    """
    now, then = main_choices(match, updates), kept.get("mains") or {}
    if now is None:
        return True
    for change in (kept.get("proposal") or {}).get("changes") or []:
        habit = change.get("habit")
        if not isinstance(habit, dict):
            continue
        key, value = (str(habit.get("event")), str(habit.get("field"))), str(habit.get("value"))
        if then.get(key) == value and now.get(key, value) != value:
            return False
    return True


def seen_lines(match: MatchState, facts: Facts, updates: list[Message], update: Message) -> list[dict[str, Any]]:
    """What the player did since the last real update, as at most 3 short counted lines built in code.

    The habits a new rule in this update checks come first, then the strongest
    of the rest, then how the player's won rounds ended. With fewer than 4
    player events since the last real update, the whole match is counted.
    """
    real = [entry for entry in updates if entry.get("changes")]
    since_round = int(real[-1].get("rounds_at", 0) or 0) if real else 0
    mine = [event for event in match.events if event.get("by") == "player"]
    recent = [event for event in mine if int(event.get("round") or 0) > since_round]
    habits = list(measures.habits(match.setup, recent if len(recent) >= 4 else mine))
    after = update.get("behaviour") if isinstance(update.get("behaviour"), dict) else {}
    named = json.dumps([rule.get("if") for npc in after.get("npcs") or {} for rule in _rules(after, npc)
                        if not any(_same_rule(rule, old) for old in _rules(match.behaviour, npc))])
    habits = [habit for habit in habits if float(habit.get("share") or 0) >= 0.5]  # what the player mostly does, not a side note
    habits = [habit for habit in habits if chosen_by_player(match.setup, str(habit["field"]))]  # never what the game picks for them
    counted = set(counted_fields(match.design.values))
    habits.sort(key=lambda habit: (0 if str(habit["field"]) in named else 1,          # what this update answers comes first,
                                   0 if (str(habit["event"]), str(habit["field"])) in counted else 1))  # then what a value counts
    lines = [{"text": shorten(habit_line(habit), 10), "event": str(habit["event"]), "field": str(habit["field"]),
              "value": str(habit["value"]), "count": int(habit["uses"]),
              "of": int(round(habit["uses"] / habit["share"])) if habit.get("share") else int(habit["uses"])} for habit in habits[:2]]
    won = facts["measures"].get("won_rounds") or []
    if won:
        lines.append({"text": shorten(words(won[0]), 10), "field": "round_end"})
    return lines[:3]


def holding_update(match: MatchState, facts: Facts, source: str, checks: list[dict[str, Any]],
                   prior: float | None, step_ready: bool = False) -> Message:
    """An update that changes nothing: the play as it stands under a new version, and why, in the player's terms."""
    version = int(match.behaviour.get("version", 0) or 0) + 1
    rounds = played(match)
    lost = lost_in_a_row(rounds)
    if not rounds:
        why = "No round has finished yet, so I am holding."
    elif lost == 1:
        why = "You lost the last round, so I am holding my next step." if step_ready else "You lost the last round, so I am holding."
    elif lost > 1:
        why = f"You lost the last {lost} rounds, so I am holding."
    elif struggling(rounds, prior) is not None:
        why = "You are under a fair share, so I am holding."
    else:
        why = "I see nothing new to answer yet, so I am holding."
    if _window() and rounds and not (lost == 1 and step_ready):
        latest = rounds[-_window():]
        why = f"You won {_won(latest)} of the last {len(latest)}, so I am holding."
    habits = [habit for habit in facts["measures"].get("habits") or [] if chosen_by_player(match.setup, str(habit["field"]))]
    seen = [f"You have won {_won(rounds)} of {len(rounds)} rounds so far." if rounds else "No round has finished yet."]
    seen += [habit_line(habit) for habit in habits[:2]]
    if len(seen) < MIN_LINES:
        seen.append("Your play shows no clear habit yet.")
    update: Message = {
        "type": "strategy_update",
        "match_id": match.match_id,
        "version": version,
        "source": source,
        "writer": CHECK,
        "observations": [shorten(line, MAX_WORDS) for line in seen[:3]],
        "plan": [why, "My rules and weights stay as they are."],
        "changes": [],
        "holding": True,
        "behaviour": {**copy.deepcopy(match.behaviour), "version": version},
    }
    if checks:
        update["checks"] = checks
    return update


def held_back(match: MatchState, updates: list[Message], direction: str) -> bool:
    """Whether a move `up` or `down` in strength must wait, because the last change went the other way a short while ago."""
    for update in reversed(updates):
        went = update.get("direction")
        if went in ("up", "down"):
            gap = config.FAIR_EASE_GAP_ROUNDS if _window() else config.FAIR_NO_FLAP_ROUNDS
            return went != direction and len(match.rounds) - int(update.get("rounds_at", 0) or 0) < gap
    return False


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def step_paid_off(match: MatchState, change: dict[str, Any]) -> bool | None:
    """Whether a fairness step has paid off so far: the player's share of the rounds since
    it, against their share just before it. None while no round has finished since."""
    if isinstance(change.get("held"), bool):
        return change["held"]
    since = change.get("after_round")
    if not isinstance(since, int):
        return None
    before = measures.player_win_rate([r for r in match.rounds if r.get("round", 0) <= since][-FAIR_ROUNDS:])
    after = measures.player_win_rate([r for r in match.rounds if r.get("round", 0) > since])
    if before is None or after is None:
        return None
    return after < before if change.get("wants") == "lower" else after > before


def resting(match: MatchState, updates: list[Message]) -> bool:
    """After a fairness step the next one waits, so the step has time to show: a few
    rounds, or a single round when the step has not paid off so far."""
    for update in reversed(updates):
        at = [update[key] for key in ("eased_after_rounds", "dial_after_rounds") if isinstance(update.get(key), int)]
        if not at:
            continue
        judged = [step_paid_off(match, change) for change in update.get("changes") or []
                  if change.get("measure") == "player_win_rate"]
        rest = FAIR_FAILED_REST_ROUNDS if judged and judged[0] is False else FAIR_REST_ROUNDS
        return len(match.rounds) - max(at) < rest
    return False


def last_dial_change(updates: list[Message]) -> dict[str, Any] | None:
    """The most recent fairness step that moved a setting."""
    for update in reversed(updates):
        for change in reversed(update.get("changes") or []):
            if change.get("kind") == FAIRNESS and str(change.get("where", "")).startswith("settings."):
                return change
    return None


def can_soften(match: MatchState, updates: list[Message]) -> bool:
    """Whether the rules or weights can still be eased: anything that is not yet the game's default."""
    return not same_play(match.behaviour, first_behaviour(match.setup))


def same_play(one: Behaviour, other: Behaviour) -> bool:
    """Whether two behaviours play the same: the same rules and weights, whatever their version."""
    return not diff(one, other) and not diff(other, one)


def _between(now: Any, goal: Any, share: float) -> float:
    value = float(now) + (float(goal) - float(now)) * share
    return float(goal) if abs(value - float(goal)) < FAIR_SNAP else round(value, 2)


def toward_default(current: Behaviour, default: Behaviour, share: float = 0.5) -> Behaviour:
    """`current` with every weight moved `share` of the way back to the game's default.
    A weight that lands close to the default becomes the default."""
    moved = copy.deepcopy(current)
    for npc, entry in (moved.get("npcs") or {}).items():
        start = ((default.get("npcs") or {}).get(npc) or {}).get("decisions") or {}
        decisions = entry.setdefault("decisions", {})
        for decision in sorted(set(decisions) | set(start)):
            options = decisions.setdefault(decision, {})
            for option in sorted(set(options) | set(start.get(decision) or {})):
                now = options.get(option) or {"base": 0}
                first = (start.get(decision) or {}).get(option)
                goal = first or {"base": 0}
                new: dict[str, Any] = {"base": _between(now.get("base", 0), goal.get("base", 0), share)}
                when = {}
                for value in sorted(set(now.get("when") or {}) | set(goal.get("when") or {})):
                    weight = _between((now.get("when") or {}).get(value, 0), (goal.get("when") or {}).get(value, 0), share)
                    if weight != 0 or value in (goal.get("when") or {}):
                        when[value] = weight
                if when:
                    new["when"] = when
                if first is None and new == {"base": 0}:
                    options.pop(option, None)
                else:
                    options[option] = new
    return moved


def sliding(match: MatchState, updates: list[Message]) -> bool:
    """Whether the last fairness step was a short while ago and has not paid off: the slide goes on."""
    for update in reversed(updates):
        at = [update[key] for key in ("eased_after_rounds", "dial_after_rounds") if isinstance(update.get(key), int)]
        if not at:
            continue
        judged = [step_paid_off(match, change) for change in update.get("changes") or []
                  if change.get("measure") == "player_win_rate"]
        return len(match.rounds) - max(at) <= FAIR_ROUNDS and bool(judged) and judged[0] is False
    return False


def always_on(match: MatchState, updates: list[Message]) -> list[dict[str, Any]]:
    """Rules that decided nearly every pick of their decision since they went in.

    The game reports each NPC action with what it `picked` and which
    decisions a rule made (`by_rule`). A rule that fires on almost every pick
    is no rule about a situation. Each row has the npc, the rule, the
    decision, and how many of the picks it made.
    """
    return [row for row in rule_shares(match, updates)
            if row["picks"] >= config.ALWAYS_ON_MIN_PICKS and row["made"] / row["picks"] >= config.ALWAYS_ON_SHARE]


def rule_shares(match: MatchState, updates: list[Message]) -> list[dict[str, Any]]:
    """For each rule in play: how many picks of its decision it has made since it went in."""
    found = []
    for npc in (match.behaviour.get("npcs") or {}):
        for rule in _rules(match.behaviour, npc):
            since = 0
            for update in updates:  # the first update that carried this rule
                if any(_same_rule(rule, sent) for sent in _rules(update.get("behaviour") or {}, npc)):
                    since = int(update.get("rounds_at", 0))
                    break
            for decision, option in (rule.get("do") or {}).items():
                picks = [event for event in match.events
                         if event.get("by") == npc and int(event.get("round") or 0) > since
                         and isinstance(event.get("picked"), dict) and decision in event["picked"]]
                made = [event for event in picks if decision in (event.get("by_rule") or []) and event["picked"][decision] == option]
                if picks:
                    found.append({"npc": npc, "rule": rule, "decision": decision, "option": option,
                                  "made": len(made), "picks": len(picks)})
                    break
    return found


def take_off_always_on(match: MatchState, facts: Facts, found: list[dict[str, Any]]) -> Proposal:
    """Take the always-on rules off. Each one's option keeps a small, capped lift in weight. Built in code."""
    behaviour = copy.deepcopy(match.behaviour)
    first = found[0]
    for row in found:
        entry = behaviour["npcs"][row["npc"]]
        entry["rules"] = [kept for kept in _rules(behaviour, row["npc"]) if not _same_rule(kept, row["rule"])]
        slot = entry.setdefault("decisions", {}).setdefault(row["decision"], {})
        before = slot.get(row["option"]) or {"base": 0}
        slot[row["option"]] = {**before, "base": round(float(before.get("base", 0)) + config.GENERAL_COUNTER_STEP, 2)}
    habits = facts["measures"].get("habits") or []
    did = f"{words(first['option'])} for {words(first['decision'])}"
    return {
        "behaviour": behaviour,
        "observations": [habit_line(habit) for habit in habits[:2]],
        "plan": [shorten(f"My rule for {did} fired on nearly every pick.", MAX_WORDS),
                 "So it is now a small weight, not a rule."],
        "changes": [],
        "why": shorten(f"This rule made {first['made']} of my last {first['picks']} {words(first['decision'])} picks.", MAX_WORDS),
        "counts": [(row["made"], row["picks"]) for row in found],
        "constant": sorted({cond["fact"] for row in found for cond in row["rule"].get("if") or [] if "fact" in cond}),
        "removed": [copy.deepcopy(row["rule"].get("do") or {}) for row in found],
        "removed_rules": [copy.deepcopy(row["rule"].get("do") or {}) for row in found],
        "caps": {f"{row['decision']}.{row['option']}": float(behaviour["npcs"][row["npc"]]["decisions"][row["decision"]][row["option"]]["base"])
                 for row in found},
    }


def raise_dose(match: MatchState, facts: Facts, updates: list[Message]) -> Proposal | None:
    """One step more of the best counter, when the player keeps winning and nothing else was added. Built in code.

    It waits for a full window of rounds that the player is clearly winning,
    and for a round to finish since the last update. It takes the most
    specific counter in the practice table, never an option that beats
    everyone and never one the fairness check turned down a short while ago,
    and gives it a set share more of its decision's picks. The result goes
    through the same checks as a writer's, so it can never go under the target.
    """
    ahead = winning(played(match), facts["measures"].get("prior_share"))
    if ahead is None or config.DOSE_STEP <= 0 or held_back(match, updates, "up") or lost_last(played(match)):
        return None
    if updates and len(match.rounds) <= int(updates[-1].get("rounds_at", 0) or 0):
        return None
    never = matchups.holes([Matchup(**row) for row in facts["matchups"]])
    barred = {(decision, option) for do in taken_off(match, updates) for decision, option in do.items()}
    for counter in facts["counters"]:
        npc, decision, option = counter["npc"], counter["decision"], counter["option"]
        if counter.get("general") or (npc, decision, option) in never or (decision, option) in barred:
            continue
        slot = (((match.behaviour.get("npcs") or {}).get(npc) or {}).get("decisions") or {}).get(decision) or {}
        held = max(float((slot.get(option) or {}).get("base", 0)), 0.0)
        others = sum(max(float((weights or {}).get("base", 0)), 0.0) for name, weights in slot.items() if name != option)
        if others <= 0:
            continue
        cap = step_cap(blended_share(played(match), facts["measures"].get("prior_share")), facts["measures"].get("step_seconds"))   # a bigger step for a bigger gap
        step = config.DOSE_STEP * (cap / config.DOSE_MAX_STEP if 0 < config.DOSE_MAX_STEP < 1 else 1.0)
        share = min(held / (held + others) + step, 0.9)
        behaviour = copy.deepcopy(match.behaviour)
        behaviour["npcs"][npc].setdefault("decisions", {}).setdefault(decision, {})[option] = {
            **(slot.get(option) or {}), "base": round(others * share / (1 - share), 2)}
        won, counted = ahead
        habits = facts["measures"].get("habits") or []
        return {
            "behaviour": behaviour,
            "observations": [f"You won {won} of the last {counted} rounds.", *[habit_line(habit) for habit in habits[:2]]],
            "plan": ["You are winning most rounds, so I step up.",
                     shorten(f"I play {words(option)} for {words(decision)} more often.", MAX_WORDS)],
            "changes": [],
            "why": shorten(f"You won {won} of the last {counted}, so I play {words(option)} more.", MAX_WORDS),
            "counts": [(won, counted)],
        }
    return None


def always_true(setup: Message, rule: dict[str, Any]) -> bool:
    """Whether a rule's condition lists every option the setup declares for its fact, so it is true on every pick."""
    conditions = rule.get("if") or []
    for cond in conditions:
        options = names_of(setup, (setup.get("facts") or {}).get(cond.get("fact")))
        listed = cond.get("in") if isinstance(cond.get("in"), list) else ([cond["is"]] if "is" in cond else None)
        if not options or listed is None or not set(options) <= {str(name) for name in listed}:
            return False
    return bool(conditions)


def step_cap(blended: float | None, seconds: float | None = None) -> float:
    """The most of a decision's picks one update may move. It grows with the gap: the near cap at the
    top of the band, rising in a straight line to the far cap for a player far above it.

    `seconds` is the time since the last landing that added strength. The cap
    is sized per second, so quicker updates take smaller steps and the rate
    stays the same. None means the first landing, which gets the whole cap.
    """
    near, far = config.DOSE_MAX_STEP, max(config.DOSE_MAX_STEP, config.DOSE_MAX_STEP_FAR)
    if near >= 1:
        return 1.0
    _, low, high = band()
    if blended is None or blended <= low or high <= low:
        cap = near
    else:
        cap = far if blended >= high else near + (far - near) * (blended - low) / (high - low)
    if seconds is None or config.DOSE_SECONDS <= 0:
        return cap
    return min(cap, max(config.DOSE_MIN_STEP, cap * seconds / config.DOSE_SECONDS))


# What the look now running has found. Each call of `adapt` gets its own, so two looks in flight never share it.
_LOOK: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar("look", default=None)


def onto_play(written: Behaviour, proposed: Behaviour, current: Behaviour) -> Behaviour:
    """Carry a proposal written against an older behaviour onto the behaviour in play.

    Every difference between the older behaviour and the proposal is read as
    'set this to that' and set on the behaviour in play. So a newer play is
    kept, and two looks that reach the same conclusion do not double the dose.
    """
    out = copy.deepcopy(current)
    for npc, entry in (proposed.get("npcs") or {}).items():
        target = (out.get("npcs") or {}).get(npc)
        if not isinstance(target, dict) or not isinstance(entry, dict):
            continue
        before = ((written.get("npcs") or {}).get(npc) or {}).get("decisions") or {}
        for decision, options in (entry.get("decisions") or {}).items():
            for option, spec in (options or {}).items():
                if spec != (before.get(decision) or {}).get(option):
                    target.setdefault("decisions", {}).setdefault(decision, {})[option] = copy.deepcopy(spec)
        old_rules, new_rules = _rules(written, npc), _rules(proposed, npc)
        rules = [rule for rule in _rules(out, npc)
                 if not any(_same_rule(rule, old) for old in old_rules) or any(_same_rule(rule, new) for new in new_rules)]
        for rule in new_rules:
            if not any(_same_rule(rule, old) for old in old_rules) and not any(_same_rule(rule, have) for have in rules):
                rules.append(copy.deepcopy(rule))
        if rules or "rules" in target:
            target["rules"] = rules
    return out


def counted_field(setup: Message, fact: Any) -> tuple[str, str] | None:
    """The player's event field a fact repeats, when the names line up: an early sign, or a fact that ends in the field's name."""
    signs = sign_facts(setup)
    if fact in signs:
        return signs[fact]
    found: list[tuple[bool, int, str, str]] = []
    for event_name, spec in (setup.get("events") or {}).items():
        if measures.is_npc_event(setup, event_name):
            continue
        for field_name in ((spec or {}).get("fields") or {}):
            if str(fact).endswith("_" + field_name):  # the longest name wins, on the event that says how the action turned out
                found.append((measures.says_outcome(setup, event_name), len(field_name), event_name, field_name))
    return max(found)[2:] if found else None


def fire_share(match: MatchState, facts: Facts, rule: dict[str, Any], fired: dict[str, float] | None = None) -> float:
    """How often a rule would fire right now, counted the way the game will play it.

    A rule already in play uses the share of picks it really made. Otherwise
    each condition is counted: a value at its latest read either holds or does
    not, and a fact that repeats one of the player's event fields holds as
    often as the player's own events so far say, when there are enough to
    count. A condition that cannot be counted keeps the set share.
    """
    key = matchups.rule_key(rule)
    if fired and key in fired:
        return fired[key]
    conditions = rule.get("if") or []
    if not conditions or always_true(match.setup, rule):
        return 1.0
    share = 1.0
    for cond in conditions:
        part: float | None = None
        if "value" in cond:
            read = facts["values"].get(cond.get("value"))
            if _is_number(read):
                part = 1.0
                if _is_number(cond.get("above")) and not read > cond["above"]:
                    part = 0.0
                if _is_number(cond.get("below")) and not read < cond["below"]:
                    part = 0.0
        elif "fact" in cond:
            listed = cond.get("in") if isinstance(cond.get("in"), list) else ([cond["is"]] if "is" in cond else None)
            source = counted_field(match.setup, cond.get("fact"))
            if listed is not None and source is not None:
                seen = [(event.get("data") or {}).get(source[1]) for event in match.events
                        if event.get("by") == "player" and event.get("name") == source[0]]
                seen = [value for value in seen if value is not None]
                if len(seen) >= config.ALWAYS_ON_MIN_PICKS:
                    part = sum(1 for value in seen if str(value) in {str(name) for name in listed}) / len(seen)
        share *= config.RULE_FIRE_SHARE if part is None else part
    return round(share, 3)


def all_fire_shares(match: MatchState, facts: Facts, behaviour: Behaviour, fired: dict[str, float] | None = None) -> dict[str, float]:
    """A fire share for every rule in the play in hand and in a proposal."""
    shares = dict(fired or {})
    for play in (match.behaviour, behaviour):
        for npc in (play.get("npcs") or {}):
            for rule in _rules(play, npc):
                shares.setdefault(matchups.rule_key(rule), fire_share(match, facts, rule, shares))
    return shares


def decision_moves(match: MatchState, facts: Facts, behaviour: Behaviour, fired: dict[str, float]) -> dict[tuple[str, str], float]:
    """How much of each decision's picks a proposal moves: pick shares before and after, at the
    latest read values, with `when` weights applied and each rule counted by how often it fires."""
    moves = {}
    for npc, entry in (behaviour.get("npcs") or {}).items():
        now = (match.behaviour.get("npcs") or {}).get(npc) or {}
        decisions = set(entry.get("decisions") or {}) | set(now.get("decisions") or {})
        decisions |= {decision for play in (entry, now) for rule in play.get("rules") or [] for decision in (rule.get("do") or {})}
        for decision in decisions:
            before = matchups._shares(match.behaviour, npc, decision, facts["values"], fired)
            after = matchups._shares(behaviour, npc, decision, facts["values"], fired)
            moves[(npc, decision)] = round(0.5 * sum(abs(after.get(option, 0.0) - before.get(option, 0.0))
                                                     for option in set(before) | set(after)), 4)
    return moves


def limit_steps(match: MatchState, behaviour: Behaviour, facts: Facts, fired: dict[str, float] | None = None,
                blended: float | None = None) -> Behaviour:
    """No update moves more than a capped share of any decision's picks, so strength climbs in steps.

    The cap grows with the gap (see `step_cap`). When a decision moves too
    much, a new rule that fires on most picks becomes a weight sized to the
    cap, and then the weights are shrunk toward the play in hand until every
    decision fits.
    """
    cap = step_cap(blended, facts["measures"].get("step_seconds"))
    if cap >= 1:
        return behaviour
    shares = all_fire_shares(match, facts, behaviour, fired)
    limited = copy.deepcopy(behaviour)

    def over(candidate: Behaviour) -> set[tuple[str, str]]:
        return {key for key, move in decision_moves(match, facts, candidate, shares).items() if move > cap + 0.005}

    hot = over(limited)
    if not hot:
        return behaviour
    for npc, entry in (limited.get("npcs") or {}).items():
        known = _rules(match.behaviour, npc)
        kept = []
        for rule in _rules(limited, npc):
            does = list((rule.get("do") or {}).items())
            new = not any(_same_rule(rule, old) for old in known)
            if not (new and shares[matchups.rule_key(rule)] >= config.RULE_FIRE_SHARE and any((npc, decision) in hot for decision, _ in does)):
                kept.append(rule)
                continue
            for decision, option in does:  # the rule comes off and its option gets a weight sized to the cap
                before = matchups._shares(match.behaviour, npc, decision, facts["values"], shares)
                want = min(before.get(option, 0.0) + cap, 0.95)
                slot = entry.setdefault("decisions", {}).setdefault(decision, {})
                others = sum(max(float((weights or {}).get("base", 0)), 0.0) for name, weights in slot.items() if name != option)
                held = float((slot.get(option) or {}).get("base", 0))
                if others > 0:
                    slot[option] = {**(slot.get(option) or {}), "base": round(max(held, others * want / (1 - want)), 2)}
        if "rules" in entry or kept:
            entry["rules"] = kept
    for share in (1.0, 0.75, 0.5, 0.35, 0.25, 0.15, 0.1, 0.05, 0.0):
        smaller = limited if share == 1.0 else toward_default(match.behaviour, limited, share)
        if share != 1.0:
            for npc, entry in (smaller.get("npcs") or {}).items():
                entry["rules"] = copy.deepcopy(_rules(limited, npc))
            smaller["version"] = limited.get("version")
        if share == 0.0 or not over(smaller):
            return smaller
    return limited


def practice_share(match: MatchState, facts: Facts, behaviour: Behaviour,
                   fired: dict[str, float] | None = None) -> float | None:
    """The practice table's estimate of the player's share of rounds under a behaviour, or None with no table."""
    rows = [Matchup(**row) for row in facts["matchups"]]
    names = matchups.players(rows)
    read = {LIKE + name: facts["values"].get(LIKE + name, 0.0) for name in names
            if facts["confidence"].get(LIKE + name, 0.0) >= config.MIN_CONFIDENCE}
    return matchups.estimate_share(rows, matchups.likeness(read, names), behaviour, first_behaviour(match.setup),
                                   facts["values"], fired)


def keep_it_fair(match: MatchState, behaviour: Behaviour, facts: Facts,
                 fired: dict[str, float] | None = None) -> tuple[Behaviour, float | None, str | None]:
    """Check a proposal against the goal before it is sent, and size it to fit.

    The practice table gives an estimate of the player's share of rounds
    under any behaviour (see matchups.estimate_share). A proposal may take
    that estimate down to the target, the middle of the fair band, and no
    further. One that goes further is sized down: a new rule comes off and
    its option gets the dose the table gives for the target (see
    matchups.dose), and then the whole step is cut until the estimate fits.
    Nothing may add strength when the play is already under the target.
    The rounds of the match are blended into the table's number (see
    `blended_share`), and every estimate moves by the same gap. A player
    doing better than the table says earns a little more room, never enough
    for the table's own estimate to go under the floor. Nothing estimated
    under the floor is ever sent.
    Returns the behaviour, the estimate, and one line when it was sized down.
    """
    # Every rule is counted the same way for the estimate and for the step cap: by how often it would fire right now.
    fired = all_fire_shares(match, facts, behaviour, fired)
    rows = [Matchup(**row) for row in facts["matchups"]]
    names = matchups.players(rows)
    read = {LIKE + name: facts["values"].get(LIKE + name, 0.0) for name in names
            if facts["confidence"].get(LIKE + name, 0.0) >= config.MIN_CONFIDENCE}
    resembles = matchups.likeness(read, names)
    default = first_behaviour(match.setup)

    def table(candidate: Behaviour) -> float | None:
        return matchups.estimate_share(rows, resembles, candidate, default, facts["values"], fired)

    by_table = table(match.behaviour)
    room = config.FAIR_TARGET_SHARE - config.FAIR_SHARE_FLOOR
    gap = 0.0 if by_table is None else max(by_table - blended_share(played(match), by_table), -max(room, 0.0))

    def estimate(candidate: Behaviour) -> float | None:
        guess = table(candidate)
        return None if guess is None else round(min(max(guess - gap, 0.0), 1.0), 4)

    blend = blended_share(played(match), by_table)
    behaviour = limit_steps(match, behaviour, facts, fired, blend)
    now, proposed = estimate(match.behaviour), estimate(behaviour)
    if now is None or proposed is None:
        return behaviour, proposed, None
    target = max(config.FAIR_TARGET_SHARE, config.FAIR_SHARE_FLOOR)
    need = min(target, now)
    if now + 1e-9 < config.FAIR_SHARE_FLOOR and proposed <= now + 1e-9 and not same_play(behaviour, match.behaviour):
        # Already under the floor. A change the table cannot weigh (it has no rounds for it) is still a change, so it waits.
        return {**copy.deepcopy(match.behaviour), "version": behaviour.get("version")}, now, (
            f"You are at about {now:.0%} of rounds, under a fair share, so I left my play as it is.")
    if proposed + 1e-9 >= need:
        return behaviour, proposed, None
    if len(match.rounds) < FAIR_ROUNDS:
        need = (now + need) / 2       # too few rounds to be sure of the read: an early step goes half of the way

    dosed = copy.deepcopy(behaviour)
    for npc, entry in (dosed.get("npcs") or {}).items():
        known = _rules(match.behaviour, npc)
        fresh = [rule for rule in _rules(dosed, npc) if not any(_same_rule(rule, old) for old in known)]
        entry["rules"] = [rule for rule in _rules(dosed, npc) if not any(_same_rule(rule, new) for new in fresh)]
        for rule in fresh:  # the counter stays, as a weight that plays it only as often as the target allows
            for decision, option in (rule.get("do") or {}).items():
                share = matchups.dose(rows, resembles, npc, decision, option, min(max(need + gap, 0.0), 1.0))
                slot = entry.setdefault("decisions", {}).setdefault(decision, {})
                others = sum(max(float((weights or {}).get("base", 0)), 0.0) for name, weights in slot.items() if name != option)
                if share is not None and 0 < share < 1 and others:
                    held = float((slot.get(option) or {}).get("base", 0))      # a dose never takes a weight down
                    slot[option] = {**(slot.get(option) or {}), "base": round(max(held, others * share / (1 - share)), 2)}
    for share in (1.0, 0.75, 0.5, 0.35, 0.25, 0.15, 0.1, 0.05):
        smaller = toward_default(match.behaviour, dosed, share)
        for npc, entry in (smaller.get("npcs") or {}).items():
            entry["rules"] = copy.deepcopy(_rules(dosed, npc))
        smaller["version"] = behaviour.get("version")
        smaller = limit_steps(match, smaller, facts, fired, blend)
        guess = estimate(smaller)
        if guess is not None and guess + 1e-9 >= need:
            return smaller, guess, (f"At full strength you would win about {proposed:.0%} of rounds, "
                                    f"so I sized this to leave you about {guess:.0%}.")
    return {**copy.deepcopy(match.behaviour), "version": behaviour.get("version")}, now, (
        f"That would leave you about {proposed:.0%} of rounds, under a fair share, so I left my play as it is.")


def gone_rules(updates: list[Message]) -> set[tuple[str, str]]:
    """What the rules fairness took off did. For the rest of the match none of them comes back as a rule."""
    return {pair for update in updates for do in update.get("removed_rules") or [] for pair in do.items()}


def weight_caps(updates: list[Message]) -> dict[tuple[str, str], float]:
    """The highest weight an option may have again after fairness turned it down: under what it had then."""
    caps: dict[tuple[str, str], float] = {}
    for update in updates:
        for key, cap in (update.get("caps") or {}).items():
            decision, _, option = str(key).partition(".")
            caps[(decision, option)] = min(float(cap), caps.get((decision, option), float(cap)))
    return caps


def caps_for(before: Behaviour, after: Behaviour, rules: list[dict[str, Any]]) -> dict[str, float]:
    """Caps to remember when fairness turns counters down. An option a rule played may return as a
    small weight. A weight that was lowered may return to nine tenths of what it was."""
    caps: dict[str, float] = {}
    ruled = {pair for rule in rules for pair in (rule.get("do") or {}).items()}
    for npc, entry in (before.get("npcs") or {}).items():
        now = ((after.get("npcs") or {}).get(npc) or {}).get("decisions") or {}
        for decision, options in (entry.get("decisions") or {}).items():
            for option, weights in (options or {}).items():
                was = float((weights or {}).get("base", 0))
                if (decision, option) in ruled:
                    caps[f"{decision}.{option}"] = round(was + config.GENERAL_COUNTER_STEP, 2)
                elif was > float(((now.get(decision) or {}).get(option) or {}).get("base", 0)) + 1e-9:
                    caps[f"{decision}.{option}"] = round(was * 0.9, 2)
    return caps


def taken_off(match: MatchState, updates: list[Message]) -> list[dict[str, Any]]:
    """What the rules fairness took off a short while ago did. None of them may come back yet."""
    return [do for update in updates if len(match.rounds) - int(update.get("rounds_at", 0)) < FAIR_NO_RETURN_ROUNDS
            for do in update.get("removed") or []]


def public(update: Message) -> Message:
    """The update as the game gets it: without what the adapter keeps for itself."""
    message = {key: value for key, value in update.items() if key not in PRIVATE_UPDATE_KEYS}
    message["changes"] = [{key: value for key, value in change.items() if key not in PRIVATE_CHANGE_KEYS}
                          for change in update.get("changes") or []]
    return copy.deepcopy(message)


def dial_now(setup: Message, updates: list[Message], name: str) -> float | int | None:
    """Where a setting stands: the last value sent, or the one the game started with."""
    for update in reversed(updates):
        sent = update.get("settings")
        if isinstance(sent, dict) and _is_number(sent.get(name)):
            return sent[name]
    now = ((setup.get("settings") or {}).get(name) or {}).get("now")
    return now if _is_number(now) else None


def fairness_dial(match: MatchState, updates: list[Message], prior: float | None = None) -> dict[str, Any] | None:
    """One small move of a difficulty dial, when the counted rounds call for one. Built in code.

    The NPCs get better through their rules. A dial only keeps the match
    even: it eases when the player is losing too much and tightens when the
    player is winning too much, one small step at a time, inside the
    setting's `min` and `max`. The player's share is counted from finished
    rounds. Only settings the design marked as dials can move, and after any
    fairness step the dial rests so the step has time to show.

    Nobody can see from here what a dial does in the game, so a dial step
    that did not pay off is not repeated: the next step softens a rule, and
    the dial moves again only when no rule is left to soften. When the player
    has won none of a full window, the dial eases and a rule softens in the
    same update (`with_rule`).
    """
    dials = usable_dials(match.setup, match.design.dials) or env_dials(match.setup)
    if not dials:
        return None
    losing, ahead = struggling(played(match), prior), winning(played(match), prior)   # no move at all inside the band
    share = losing or ahead
    if share is None or resting(match, updates):
        return None
    easier = losing is not None
    won, counted = share
    soften = easier and can_soften(match, updates)
    last = last_dial_change(updates)
    if last is not None and step_paid_off(match, last) is False and (soften or not easier):
        return None  # the last dial step did not pay off, so the rules do the work
    for dial in dials:
        name = dial["setting"]
        spec = match.setup["settings"][name]
        low, high = spec["min"], spec["max"]
        now = dial_now(match.setup, updates, name)
        if now is None:
            continue
        whole = all(isinstance(number, int) for number in (low, high, now))
        step = max(1, round(DIAL_STEP * (high - low))) if whole else DIAL_STEP * (high - low)
        raise_it = (dial["harder"] == "up") != easier
        to = min(high, now + step) if raise_it else max(low, now - step)
        to = to if whole else min(high, max(low, round(to, 3)))
        if abs(to - now) < 1e-9:
            continue  # already at its limit
        moves = "goes up" if to > now else "comes down"
        return {
            "setting": name, "from": now, "to": to, "easier": easier, "won": won, "counted": counted,
            "with_rule": soften and won == 0 and counted >= FAIR_ROUNDS,
            "why": shorten(f"Fairness adjustment: you won {won} of {counted}, so {words(name)} {moves}.", MAX_WORDS),
            "expect": "You should win more rounds again." if easier else "The rounds should come back toward even.",
        }
    return None


def dial_home_step(match: MatchState, updates: list[Message], prior: float | None) -> dict[str, Any] | None:
    """The first thing an ease does: a dial that sits harder than where the game started it goes one
    step back toward its start. The choices of play are taken back only once every dial is home."""
    share = struggling(played(match), prior) or last_step_failed(match, updates)
    if not _window() or share is None or eased_lately(match, updates) or resting(match, updates):
        return None
    for dial in usable_dials(match.setup, match.design.dials) or env_dials(match.setup):
        name = dial["setting"]
        spec = match.setup["settings"][name]
        now, start = dial_now(match.setup, updates, name), dial_now(match.setup, [], name)
        if now is None or start is None:
            continue
        up = dial["harder"] == "up"
        if not (now > start + 1e-9 if up else now < start - 1e-9):
            continue  # this dial is home
        low, high = spec["min"], spec["max"]
        whole = all(isinstance(number, int) for number in (low, high, now))
        size = max(1, round(DIAL_STEP * (high - low))) if whole else DIAL_STEP * (high - low)
        to = max(start, now - size) if up else min(start, now + size)
        step = {"setting": name, "from": now, "to": to if whole else round(to, 3), "easier": True,
                "won": share[0], "counted": share[1], "with_rule": False, "expect": "You should win more rounds again."}
        step["why"] = dial_reason(step)
        return step
    return None


def world_now(setup: Message, updates: list[Message], name: str) -> Any:
    """Where a world setting stands: the last value sent, or the one the game started with ([] for none picked)."""
    spec = (setup.get("settings") or {}).get(name) or {}
    now = spec.get("now")
    for update in reversed(updates):
        sent = update.get("settings")
        if isinstance(sent, dict) and name in sent:
            now = sent[name]
            break
    if is_pick_setting(spec) and not isinstance(now, list):
        now = [] if now in (None, "none") or now not in spec.get("options", []) else [now]
    return copy.deepcopy(now)


def checked_world(setup: Message, proposal: Proposal, writer: str) -> dict[str, Any]:
    """The world settings a writer proposed that pass the contract. Never number settings: those are fairness's."""
    sent = proposal.get("settings")
    if writer == FAIRNESS or not isinstance(sent, dict):
        return {}
    world = world_settings(setup)
    return {name: copy.deepcopy(value) for name, value in sent.items()
            if name in world and (_setting_check is None or not _setting_check(setup, name, value))}


def with_dial(match: MatchState, update: Message | None, step: dict[str, Any], source: str,
              checks: list[dict[str, Any]]) -> Message:
    """Add a fairness step to an update, or build an update that carries only the step.

    The step is its own `changes` item with a `kind` of fairness, so a viewer
    can tell it from a rule change. The rules are left as they are.
    """
    name, won, counted = step["setting"], step["won"], step["counted"]
    change = {
        "where": f"settings.{name}", "from": step["from"], "to": step["to"],
        "why": step["why"], "expect": step["expect"], "kind": FAIRNESS,
        "measure": "player_win_rate", "after_round": current_round(match),
    }
    if not step["easier"]:
        change["wants"] = "lower"
    if update is None:
        version = int(match.behaviour.get("version", 0) or 0) + 1
        update = {
            "type": "strategy_update",
            "match_id": match.match_id,
            "version": version,
            "source": source,
            "writer": FAIRNESS,
            "observations": [f"You won {won} of the last {counted} rounds.",
                             f"That is {'under' if step['easier'] else 'over'} a fair share."],
            "plan": ["Easing off so you win about half." if step["easier"] else "Tightening a little so the rounds stay close.",
                     "Fairness adjustment only: my rules stay as they are."],
            "changes": [],
            "behaviour": {**copy.deepcopy(match.behaviour), "version": version},
        }
        if checks:
            update["checks"] = checks
    update["changes"] = [*update.get("changes", []), change]
    update["settings"] = {**(update.get("settings") or {}), name: step["to"]}
    update["dial_after_rounds"] = len(match.rounds)
    if step["easier"]:
        update["eased_after_rounds"] = len(match.rounds)
    return update


def newest_rule(match: MatchState, updates: list[Message]) -> tuple[str, dict[str, Any]] | None:
    """The rule in play that was installed last."""
    in_play = [(npc, rule) for npc in (match.behaviour.get("npcs") or {}) for rule in _rules(match.behaviour, npc)]
    if not in_play:
        return None
    previous_versions = [None, *updates]
    for index in range(len(updates) - 1, -1, -1):
        before = (previous_versions[index] or {}).get("behaviour") or match.design.behaviour
        for npc, rule in in_play:
            was_new = any(_same_rule(rule, r) for r in _rules(updates[index].get("behaviour") or {}, npc)) and \
                not any(_same_rule(rule, r) for r in _rules(before, npc))
            if was_new:
                return npc, rule
    return in_play[0]


def ease_off(match: MatchState, facts: Facts, updates: list[Message]) -> Proposal | None:
    """Ease the rules because the player is losing too much. Built in code.

    It never holds while there is anything left to ease. The first step takes
    the newest rule off. If the player goes on losing, the next takes every
    rule off and moves every weight halfway back to the game's default, and
    the one after that is the game's default exactly. After each step it
    rests one round, so the step has a chance to show.
    """
    share = struggling(played(match), facts["measures"].get("prior_share")) or last_step_failed(match, updates)
    if share is None:
        return None
    won, counted = share
    if eased_lately(match, updates):
        return {"hold": f"You won {won} of the last {counted} rounds. I eased off a moment ago, so I am giving that time to show."}
    if not _window() and held_back(match, updates, "down") and not brake(played(match)):  # an ease never waits on a step up
        return {"hold": f"You won {won} of the last {counted} rounds. I stepped up a moment ago, so I am giving that time to show."}
    if resting(match, updates):
        return {"hold": f"You won {won} of the last {counted} rounds. I made a fairness adjustment a moment ago, so I am giving that time to show."}
    default = first_behaviour(match.setup)
    if same_play(match.behaviour, default):
        return {"hold": f"You won {won} of the last {counted} rounds. I am back on my starting play, so there is nothing left to ease."}

    in_play = [(npc, rule) for npc in (match.behaviour.get("npcs") or {}) for rule in _rules(match.behaviour, npc)]
    slide = sliding(match, updates)
    behaviour = copy.deepcopy(match.behaviour)
    removed: list[dict[str, Any]] = []
    took: dict[str, Any] | None = None
    latest = open_step(updates) if _window() else None
    back = None
    if latest is not None:
        whole = latest[1] or blended_share(played(match), facts["measures"].get("prior_share")) < config.FAIR_EASE_ALL_UNDER
        eased, names, gone = take_back(match.behaviour, latest[0]["before"], latest[0]["behaviour"], whole)
        if names and not same_play(eased, match.behaviour):
            back = (eased, names, gone, whole)
    if back is not None:
        behaviour, removed = back[0], back[2]
        took = {"version": latest[0].get("version"), "whole": back[3]}
        what = " and ".join(back[1][:2])
        again = any(f"backing off {what}" in " ".join(str(line) for line in entry.get("plan") or []) for entry in updates[-6:])
        place = ("I am back where we began" if same_play(behaviour, default)
                 else "that whole step is gone" if back[3] else "half of that step stays")
        plan = [shorten(f"That was too much, I am backing off {what}{' again' if again else ''}.", SETTING_WORDS),
                f"You win only {won / max(counted, 1):.0%}, so {place}."]
    elif in_play and not slide:
        npc, rule = newest_rule(match, updates) or in_play[0]
        behaviour["npcs"][npc]["rules"] = [kept for kept in _rules(behaviour, npc) if not _same_rule(kept, rule)]
        removed = [rule]
        # The rule's own options also move halfway back, so it does not live on as a heavy weight.
        halfway = toward_default(behaviour, default)
        for decision, option in (rule.get("do") or {}).items():
            eased = ((halfway["npcs"].get(npc) or {}).get("decisions") or {}).get(decision, {}).get(option)
            slot = behaviour["npcs"][npc].setdefault("decisions", {}).setdefault(decision, {})
            if eased is None:
                slot.pop(option, None)
            else:
                slot[option] = eased
        did = " and ".join(f"{words(option)} for {words(decision)}" for decision, option in (rule.get("do") or {}).items())
        plan = ["Easing off so you win about half.", shorten(f"I dropped my newest rule: {did}.", MAX_WORDS)]
    elif in_play or not slide:
        removed = [rule for _, rule in in_play]
        for npc in behaviour.get("npcs") or {}:
            if _rules(behaviour, npc):
                behaviour["npcs"][npc]["rules"] = []
        behaviour = toward_default(behaviour, default)
        plan = ["Easing off so you win about half.",
                "I dropped my rules and moved halfway back to my start." if in_play else "I turned my counters down by half."]
    else:
        behaviour = copy.deepcopy(default)
    if same_play(behaviour, default) and back is None:
        behaviour = copy.deepcopy(default)
        plan = ["Going back to my starting play so you win about half.", "I play the way I did when we began."]
    habits = facts["measures"].get("habits") or []
    return {
        "behaviour": behaviour,
        "observations": [f"You won {won} of the last {counted} rounds.", *[habit_line(habit) for habit in habits[:2]]],
        "plan": plan,
        "changes": [],
        "why": f"You won {won} of the last {counted} rounds, under a fair share.",
        "eased": True,
        "took_back": took,
        "removed_rules": [copy.deepcopy(rule.get("do") or {}) for rule in removed],
        "caps": caps_for(match.behaviour, behaviour, removed),
        "removed": [copy.deepcopy(rule.get("do") or {}) for rule in removed] + [
            {decision: option}
            for npc, entry in (match.behaviour.get("npcs") or {}).items()
            for decision, options in (entry.get("decisions") or {}).items()
            for option, weights in (options or {}).items()
            if float((weights or {}).get("base", 0)) > float(
                ((((behaviour.get("npcs") or {}).get(npc) or {}).get("decisions") or {}).get(decision) or {}).get(option, {}).get("base", 0)) + 1e-9
        ],
    }


# ---------------------------------------------------------------- the adapter

class _Ready:
    """Stands in for a rule writer when a finished step is waiting: it hands the step back with no model call."""

    def __init__(self, name: str, proposal: Proposal) -> None:
        self.name, self._proposal = name, proposal

    async def write(self, facts: Facts, budget_seconds: float, trace: Trace) -> Proposal | None:
        return self._proposal


class GeminiAdapter(Adapter):
    """Gathers the facts, asks a writer, checks the answer, and returns a `strategy_update`."""

    def __init__(self, ask: Ask | None = None, writers: dict[str, RuleWriter] | None = None) -> None:
        self._ask = ask
        self._writers = writers or {}
        self._sent: dict[str, list[Message]] = {}  # our own copy, in case the caller keeps no history
        self._prepared: set[str] = set()           # games whose deep writer has been got ready
        self._told: dict[str, tuple[str, ...]] = {}   # the dials each match was last told fairness may move
        self._pending: dict[str, dict[str, Any]] = {}   # a finished step kept ready until the player wins a round
        self._answered: set[str] = set()           # matches whose rule writer answered in the look now running
        self._added_at: dict[str, float] = {}      # when each match last got an update that added strength
        self._asked_at: dict[str, int] = {}        # how many player events each match had when a writer was last asked
        self._sent_at: dict[str, float] = {}       # when each match last got an update
        self._background: set[asyncio.Future[Any]] = set()

    def waiting(self, match_id: str) -> bool:
        """Whether a finished step is kept ready for this match. While it is, a look that returns nothing
        means "nothing yet, ask again at the next round end": no model call is made and no rest is needed."""
        return match_id in self._pending

    def _ready_step(self, match: MatchState, prior: float | None) -> dict[str, Any] | None:
        """The step kept ready for this match, or None once it has expired."""
        kept = self._pending.get(match.match_id)
        if kept is None:
            return None
        rounds = played(match)
        now, then = getattr(match, "play_seconds", None), kept.get("play_at")
        aged = (now - then) if _is_number(now) and _is_number(then) and now >= then and (now or then) else time.monotonic() - kept["at"]
        real = [entry for entry in self._sent.get(match.match_id, []) if entry.get("changes")]
        too_many = (rounds_since(match, real[-1]) >= config.PENDING_STEP_ROUNDS if real and _window()
                    else len(rounds) - kept["played"] >= 3)
        if (aged > config.PENDING_STEP_SECONDS or too_many
                or len(rounds) < kept["played"] or blended_share(rounds, prior) <= config.FAIR_TARGET_SHARE):
            self._pending.pop(match.match_id, None)
            return None
        return kept

    def _writer(self, name: str, wait: float, plan: dict[str, Any]) -> RuleWriter:
        return self._writers.get(name) or writer_named(name, wait, plan, self._ask)

    def prepare(self, setup: Message, trace: Trace) -> None:
        """Get the deep writer ready in the background, if this game can ever wait long enough to use it.

        Call it once at setup. It returns at once, so it never delays `ready`,
        and a failure is one trace line. `adapt` also calls it, so a game is
        covered even when nobody did.
        """
        game = str(setup.get("game") or "")
        if game in self._prepared:
            return
        self._prepared.add(game)
        try:
            plan = setup.get("plan") or {}
            waits = [plan.get("update_seconds", config.DEFAULT_UPDATE_SECONDS), plan.get("break_seconds")]
            waits = [float(wait) for wait in waits if isinstance(wait, (int, float)) and not isinstance(wait, bool) and wait > 0]
            deep = [wait for wait in waits if config.writer_for(wait, plan.get("writer")) in ("deep", "deepest")]
            if not deep:
                return
            get_ready = getattr(self._writer("deep", max(deep), plan), "prepare", None)
            if not callable(get_ready):
                return

            async def run() -> None:
                try:
                    await get_ready(setup, trace)
                except Exception as error:
                    trace(trace_message("adapter", "error", f"The deep writer could not get ready: {type(error).__name__}: {str(error)[:120]}"))

            task = asyncio.ensure_future(run())
            self._background.add(task)
            task.add_done_callback(self._background.discard)
        except Exception as error:
            trace(trace_message("adapter", "error", f"The deep writer could not get ready: {type(error).__name__}: {str(error)[:120]}"))

    async def adapt(self, match: MatchState, source: str) -> Message | None:
        try:
            return await self._adapt(match, source)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # the current behaviour stays
            match.trace(trace_message("adapter", "error", f"The rewrite failed, so my current rules stay: {type(error).__name__}: {str(error)[:160]}"))
            return None

    async def _adapt(self, match: MatchState, source: str) -> Message | None:
        setup, trace = match.setup, match.trace
        self.prepare(setup, trace)
        plan = setup.get("plan") or {}
        if source == "full":
            wait = plan.get("break_seconds")
        else:
            source = "quick"
            wait = plan.get("update_seconds", config.DEFAULT_UPDATE_SECONDS)
        wait = float(wait) if isinstance(wait, (int, float)) and not isinstance(wait, bool) and wait > 0 else config.DEFAULT_UPDATE_SECONDS
        name = config.writer_for(wait, plan.get("writer"))
        budget = 1.25 * wait
        if name in ("standard", "fast"):
            budget = min(budget, config.ADAPTER_TIMEOUT_SECONDS)

        updates = self._ledger(match)
        checks = build_checks(match, updates)
        facts = gather_facts(match, updates)
        # Facts a rule was keyed on that turned out true on every pick. No new rule may lean on them.
        facts["measures"]["constant_facts"] = sorted({name for entry in updates for name in entry.get("constant") or []})
        facts["measures"]["prior_share"] = practice_share(match, facts, match.behaviour, {
            matchups.rule_key(row["rule"]): row["made"] / row["picks"]
            for row in rule_shares(match, updates) if row["picks"] >= config.ALWAYS_ON_MIN_PICKS})
        began = time.monotonic()

        # Fairness. When the player is losing too much the rules and weights ease
        # first, and no rules are written. A dial may move alongside, never in
        # place of that step. When the player is winning too much the rules are
        # written as usual, and the dial's step goes out beside them as its own change.
        self._say_dials(match)
        prior = facts["measures"].get("prior_share")
        look: dict[str, Any] = {"answered": False}  # this call's own, so a second look in flight cannot clear it
        _LOOK.set(look)
        facts["measures"]["step_seconds"] = self._step_seconds(match)
        home = dial_home_step(match, updates, prior)   # an ease is due and a dial sits harder than its start: it goes back first
        if home is not None:
            self._pending.pop(match.match_id, None)
            update = None
        else:
            update = await self._rewrite(match, source, name, wait, budget, plan, updates, checks, facts, began)
        direction = None                               # which way this update moves the strength, kept for the next look
        if update is not None and update.get("writer") != CHECK:
            direction = update.get("direction") or ("down" if update.get("writer") == FAIRNESS else "up")
        if update is None and home is None and config.ADAPTER_WRITERS and not proof_missing(match, updates) and not look.get("in_band"):
            more = raise_dose(match, facts, updates)   # the player keeps winning and nothing was added
            if more is not None:
                trace(trace_message("adapter", "step", more["why"], data={"writer": CHECK}))
                update = await self._rewrite(match, source, name, wait, budget, plan, updates, checks, facts, began, more)
                direction = "up" if update is not None else None
        step = home or fairness_dial(match, updates, prior)    # counted now, on the rounds as they stand when it is sent
        far = config.FAIR_DIAL_JOINS and blended_share(played(match), prior) >= band()[2] and len(match.rounds) >= config.FAIR_FAR_ROUNDS
        if step is not None and home is None:
            way = "down" if step["easier"] else "up"
            if (held_back(match, updates, way) and not (step["easier"] and brake(played(match)))) or direction not in (None, way):
                step = None                            # no move against the last change in strength so soon
            elif step["easier"] and config.FAIR_EASE_GAP_ROUNDS > 0 and (update is not None or eased_lately(match, updates)):
                step = None                            # one ease does one thing, and eases do not stack
            elif not step["easier"] and (lost_last(played(match)) or (update is not None and not far)):
                step = None                            # the dial is the last step up: never beside a counter, never after a lost round
            elif not step["easier"] and update is not None:   # far above the band the dial joins in, and says so
                moves = "goes up" if step["to"] > step["from"] else "comes down"
                step["why"] = shorten(f"You won {step['won']} of {step['counted']}, so {words(step['setting'])} also {moves}.", MAX_WORDS)
        if (step is not None and home is None and update is None and step["easier"]
                and not same_play(match.behaviour, first_behaviour(match.setup))):
            trace(trace_message("adapter", "step", "The rules and weights ease first, so the fairness dial waits.",
                                data={"writer": FAIRNESS, "setting": step["setting"]}))
            step = None
        if step is not None:
            place = None
            if _window():
                spec = match.setup["settings"][step["setting"]]
                earlier = [entry for entry in updates if entry.get("changes")]
                step["start"] = dial_now(match.setup, [], step["setting"])
                step["limit"] = min(abs(step["to"] - spec["min"]), abs(step["to"] - spec["max"])) < 1e-9
                step["again"] = bool(earlier) and any(
                    change["where"] == f"settings.{step['setting']}" and _is_number(change.get("from")) and _is_number(change.get("to"))
                    and (change["to"] > change["from"]) == (step["to"] > step["from"]) for change in earlier[-1]["changes"])
                step["why"] = dial_reason(step)        # said by the NPC, with the share as a percent
                place = dial_place(step)               # and where the setting now stands, so no two steps read the same
            alone = update is None
            update = with_dial(match, update, step, source, checks)
            if _window() and alone:
                update["plan"] = [step["why"], *([place] if place else update["plan"][1:2])]
            trace(trace_message("adapter", "done", step["why"],
                                data={"writer": FAIRNESS, "setting": step["setting"], "from": step["from"], "to": step["to"]}))
            direction = direction or ("down" if step["easier"] else "up")
        small = False
        if (update is not None and direction == "up" and config.MIN_VISIBLE_STEP > 0 and "settings" not in update
                and update.get("writer") != FAIRNESS and isinstance(update.get("behaviour"), dict)):
            # A real update stops the game, so it must be a change a person can see within a few rounds.
            after = update["behaviour"]
            took = max(decision_moves(match, facts, after, all_fire_shares(match, facts, after, None)).values(), default=0.0)
            if took < config.MIN_VISIBLE_STEP:
                trace(trace_message("adapter", "step", f"My next change would move only {took:.0%} of my picks, too little to stop the game for.",
                                    data={"writer": update.get("writer"), "step": round(took, 3)}))
                update, direction, small = None, None, True
        if update is None:
            # Only a look in which a rule writer answered sends a holding update. The code-only checks between looks never do.
            last = self._sent.get(match.match_id, [])[-1:]
            new_round = not last or int(last[0].get("rounds_at", -1) or 0) != len(match.rounds)
            if not (config.SEND_HOLDING_UPDATES and (look["answered"] or small or (look.get("in_band") and new_round and match.rounds))):
                return None
            if (facts.get("behaviour") or {}).get("version") != match.behaviour.get("version"):
                return None  # another look landed while this one was out, so there is nothing to say again
            update = holding_update(match, facts, source, checks, prior, match.match_id in self._pending)
            if small:
                update["plan"][0] = "My next change is too small to notice, so I am holding."
            trace(trace_message("adapter", "done", update["plan"][0], data={"writer": CHECK, "holding": True}))
        sent_at = self._sent_at.get(match.match_id)
        if sent_at is not None and 0 <= time.monotonic() - sent_at < config.MIN_UPDATE_GAP_SECONDS:
            trace(trace_message("adapter", "done", "I sent an update a moment ago, so this one waits for the next look.",
                                data={"writer": update.get("writer")}))
            return None
        self._sent_at[match.match_id] = time.monotonic()
        if direction == "up" and config.DOSE_MAX_STEP < 1:
            allowed = step_cap(blended_share(played(match), prior), self._step_seconds(match))
            after = update.get("behaviour") if isinstance(update.get("behaviour"), dict) else match.behaviour
            moves = decision_moves(match, facts, after, all_fire_shares(match, facts, after, None))
            took = max(moves.values(), default=0.0)
            trace(trace_message("adapter", "step", f"This step moves {took:.2f} of my picks at the most, and {allowed:.2f} was allowed.",
                                data={"writer": update.get("writer"), "step": round(took, 3), "allowed": round(allowed, 3)}))
            self._added_at[match.match_id] = time.monotonic()
        if direction is not None:
            update["direction"] = direction
        if update.get("changes") and look.get("kept"):
            update["kept"] = True                      # released from a kept step: the next look waits for play to resume
        if update.get("changes"):
            update["seen_round"] = max((int(event.get("round") or 0) for event in match.events), default=0)
            if direction == "up" and isinstance(update.get("behaviour"), dict):
                update["before"] = copy.deepcopy(match.behaviour)   # so an ease can take this very step back
        if config.PAUSE_LISTS and update.get("changes"):
            # The game stops and shows these two lists, so they are short, counted and built to one form.
            ease = update.get("writer") == FAIRNESS
            given_lines = [{"text": shorten(plain(line), SETTING_WORDS if ease else 10)} for line in update.get("observations") or []]
            # An ease leads with the score, which is its reason. Only a line that really counts rounds is tagged as one.
            score = [{**line, "field": "round_end"} for line in given_lines if _ROUND_COUNT.search(line["text"])][:1] if ease else []
            seen = score + seen_lines(match, facts, updates, update)   # counted now, since the last real update
            if look.get("kept"):                       # a kept step never repeats the lines of the update before it
                before_it = [entry for entry in updates if entry.get("changes")]
                said = set(before_it[-1].get("observations") or []) if before_it else set()
                seen = [line for line in seen if line["text"] not in said] or seen
            texts = {line["text"] for line in seen}
            if len(seen) < MIN_LINES:
                # A writer's own count of a habit covers another stretch of the match, so it never stands beside these.
                seen += [line for line in given_lines if line["text"] not in texts and not line["text"].startswith("You picked ")]
            update["seen"] = seen[:3]
            update["observations"] = [line["text"] for line in update["seen"]]
            dials = [change["where"] for change in update["changes"] if change["where"].startswith("settings.")]
            lines = [line for line in update.get("plan") or [] if plain(line) != "I keep watching how you play."] or list(update.get("plan") or [])
            changing: list[dict[str, Any]] = []
            for line in lines:
                where = paired(line, update["changes"])
                limit = SETTING_WORDS if (ease or (where or "").startswith("settings.")) else 8
                changing.append({"text": shorten(plain(line), limit), **({"where": where} if where else {})})
            for where in dials:     # a setting that moved always gets its own line, with its reason
                if not any(line.get("where") == where for line in changing):
                    why = next((change.get("why") for change in update["changes"] if change["where"] == where), "")
                    changing.insert(1 if changing else 0, {"text": shorten(plain(why), SETTING_WORDS), "where": where})
            changing.sort(key=lambda line: line.get("where", "").startswith("settings."))   # the change of play first
            update["changing"] = changing[:3]
            update["plan"] = [line["text"] for line in update["changing"]]
        update["played_at"] = len(played(match))
        update["rounds_at"] = len(match.rounds)
        self._sent.setdefault(match.match_id, []).append(update)
        return public(update)

    def _step_seconds(self, match: MatchState) -> float | None:
        """Seconds since this match last got an update that added strength. None before the first one."""
        added = self._added_at.get(match.match_id)
        return None if added is None else max(0.0, time.monotonic() - added)

    def _ledger(self, match: MatchState) -> list[Message]:
        """The updates this adapter made for the match, with the notes it keeps for itself.

        Only the ones that were really sent count, when the caller keeps a history.
        """
        book = self._sent.setdefault(match.match_id, [])
        if any(int(entry.get("rounds_at", 0)) > len(match.rounds) for entry in book):
            book.clear()  # the same id is playing a new match
        if match.updates:
            sent = {update.get("version") for update in match.updates}
            return [entry for entry in book if entry.get("version") in sent]
        return list(book)

    def _say_dials(self, match: MatchState) -> None:
        """Say once for each match which settings fairness may move, so it shows in the log."""
        if not numeric_settings(match.setup):
            return
        marked = usable_dials(match.setup, match.design.dials)
        dials, source = (marked, "marked in the design") if marked else (env_dials(match.setup), "named by hand in NPC_FAIRNESS_DIALS")
        names = tuple(dial["setting"] for dial in dials)
        if self._told.get(match.match_id) == names:
            return  # said already, and nothing has changed since (a late design can bring new dials)
        self._told[match.match_id] = names
        if dials:
            about = f"Fairness may move these settings, {source}: " + ", ".join(words(dial["setting"]) for dial in dials) + "."
        else:
            about = "No setting is marked as a fairness dial, so fairness works through the rules alone."
        match.trace(trace_message("adapter", "step", about, data={"dials": dials}))

    async def _rewrite(self, match: MatchState, source: str, name: str, wait: float, budget: float,
                       plan: dict[str, Any], updates: list[Message], checks: list[dict[str, Any]],
                       facts: Facts, began: float, given: Proposal | None = None) -> Message | None:
        """The rules half of an update: soften a rule if the player is losing too much, else ask a writer.

        `given` is a proposal built in code. It skips the writers and goes through the same checks.
        """
        setup, trace = match.setup, match.trace
        value_names = {spec.name for spec in match.design.values}

        kept: dict[str, Any] | None = None
        stuck = [] if given is not None else always_on(match, updates)      # checked on every look, under the band too
        proposal = given if given is not None else (None if stuck else ease_off(match, facts, updates))
        if proposal is not None and "hold" in proposal:
            trace(trace_message("adapter", "done", proposal["hold"], data={"writer": "fairness"}))
            return None
        prior = facts["measures"].get("prior_share")
        low = under_band(played(match), prior)
        if not stuck and proposal is None and low is not None:
            # Under the fair band the writers may only ease, so nothing is written at all.
            trace(trace_message("adapter", "done", f"You won {low[0]} of {low[1]} rounds, so I add nothing for now.",
                                data={"writer": "fairness"}))
            return None
        if proposal is not None and given is None and not stuck and self._pending.pop(match.match_id, None):
            trace(trace_message("adapter", "step", "You are losing too much now, so I dropped the step I had ready.",
                                data={"writer": "fairness"}))
        if (_window() and not stuck and proposal is None and given is None and winning(played(match), prior) is None
                and not first_step_due(match, updates, prior)):
            # Inside the band: hold. No model call, and a step kept from before is not wanted any more.
            latest = played(match)[-_window():]
            if self._pending.pop(match.match_id, None):
                trace(trace_message("adapter", "step", "You are back inside a fair share, so I dropped the step I had ready.",
                                    data={"writer": "fairness"}))
            trace(trace_message("adapter", "done", f"You won {_won(latest)} of the last {len(latest)}, so I am holding."
                                if latest else "No round has finished yet, so I am holding.", data={"writer": "fairness", "in_band": True}))
            (_LOOK.get() or {})["in_band"] = True
            return None
        if not stuck and proposal is None and not config.ADAPTER_WRITERS:
            trace(trace_message("adapter", "done", "The rule writers are switched off, so only the fairness check runs.",
                                data={"writer": "fairness"}))
            return None
        if stuck:
            proposal = take_off_always_on(match, facts, stuck)
            name = CHECK
            trace(trace_message("adapter", "step", proposal["why"], data={"writer": CHECK}))
        elif given is not None:
            name = CHECK
        elif proposal is not None:
            name = "fairness"
        else:
            if not any(event.get("by") == "player" for event in match.events):
                trace(trace_message("adapter", "done", "You have done nothing I can read yet, so I change nothing.",
                                    data={"writer": name}))
                return None
            if held_back(match, updates, "up"):
                trace(trace_message("adapter", "done", "I eased off a short while ago, so I add nothing yet.",
                                    data={"writer": "fairness"}))
                return None
            kept = self._ready_step(match, prior)
            if kept is not None and (lost_last(played(match)) or proof_missing(match, updates)):
                return None                            # a step is ready and waits for a won round and for proof: no model call
            if kept is not None and not still_supported(match, updates, kept):
                self._pending.pop(match.match_id, None)
                trace(trace_message("adapter", "step", "What you do has changed since I prepared my step, so I dropped it.",
                                    data={"writer": kept["name"]}))
                kept = None
            if kept is not None:
                (_LOOK.get() or {})["kept"] = True
                self._pending.pop(match.match_id, None)
                trace(trace_message("adapter", "step", "You won a round, so the step I had ready goes out now.",
                                    data={"writer": kept["name"]}))
            if kept is None:
                # A paid look is only worth it when the player has done something since the last one started.
                seen = sum(1 for event in match.events if event.get("by") == "player")
                if self._asked_at.get(match.match_id) == seen:
                    trace(trace_message("adapter", "done", "Nothing new from you since my last look, so I only "
                                        "checked the score.", data={"writer": "fairness"}))
                    return None
                self._asked_at[match.match_id] = seen
            writer = _Ready(kept["name"], kept["proposal"]) if kept is not None else self._writer(name, wait, plan)
            name = getattr(writer, "name", name)
            try:
                proposal = await asyncio.wait_for(writer.write(facts, budget, trace), budget)
                if kept is None:
                    (_LOOK.get() or {})["answered"] = True  # a rule writer's look completed: this look says where it stands
            except (asyncio.TimeoutError, models_client.ModelError) as error:
                about = f"did not answer within {budget:g} seconds" if isinstance(error, asyncio.TimeoutError) else str(error)[:160]
                trace(trace_message("adapter", "error", f"The {name} writer {about}. My current rules stay.",
                                    ms=(time.monotonic() - began) * 1000, data={"writer": name}))
                return None
            if proposal is None and name not in ("standard", "fast"):
                left = budget - (time.monotonic() - began)
                writer = self._writer("standard", wait, plan)
                name = getattr(writer, "name", "standard")
                if left > 5:
                    try:
                        proposal = await asyncio.wait_for(writer.write(facts, left, trace), left)
                    except (asyncio.TimeoutError, models_client.ModelError):
                        proposal = None
            if not isinstance(proposal, dict) or not isinstance(proposal.get("behaviour"), dict):
                trace(trace_message("adapter", "done", f"The {name} writer had nothing to change. My current rules stay.", data={"writer": name}))
                return None
            # The writer took a while. Rounds may have ended since it began, so the band is tested again now.
            earlier = [entry for entry in updates if entry.get("changes")]
            if (lost_last(played(match)) or proof_missing(match, updates)) and earlier and earlier[-1].get("kept"):
                trace(trace_message("adapter", "done", "My last step was one I had kept ready, so I do not keep another.",
                                    data={"writer": "fairness"}))
                return None
            if lost_last(played(match)) or proof_missing(match, updates):
                # The work is not thrown away: the step is kept ready and goes out after the next round the player wins.
                self._pending[match.match_id] = {"proposal": proposal, "name": name, "at": time.monotonic(),
                                                 "play_at": getattr(match, "play_seconds", None),
                                                 "mains": main_choices(match, updates, 1) or {},
                                                 "played": len(played(match)),
                                                 "base": (kept or {}).get("base") or copy.deepcopy(facts.get("behaviour"))}
                trace(trace_message("adapter", "done", "You lost the last round, so I add nothing until you win one."
                                    if lost_last(played(match)) else "I want to see my last change play first, so my next step waits.",
                                    data={"writer": "fairness", "pending": True}))
                return None
            late = struggling(played(match), prior)
            if late is not None:
                trace(trace_message("adapter", "done",
                                    f"You won {late[0]} of {late[1]} rounds by the time my new rules were ready, so I dropped them.",
                                    data={"writer": "fairness"}))
                return None

        written = (kept or {}).get("base") or facts.get("behaviour") or {}
        if given is None and name != FAIRNESS and not stuck and written and written != {**match.behaviour, "version": written.get("version")}:
            # The play changed while this was being written (another look landed). Its changes are set on the play in hand.
            proposal = {**proposal, "behaviour": onto_play(written, proposal["behaviour"], match.behaviour)}
            trace(trace_message("adapter", "step", "My play changed while I was writing, so I set only what this look asks for on top of it.",
                                data={"writer": name}))
        facts["measures"]["step_seconds"] = self._step_seconds(match)   # the step is sized at the landing, not at the start

        # Check the behaviour. One repair attempt, then keep the current rules.
        version = int(match.behaviour.get("version", 0) or 0) + 1
        behaviour: Behaviour = {**proposal["behaviour"], "version": version}
        if name != FAIRNESS and not stuck:  # taking an always-on rule off adds nothing, so it is never held back
            behaviour, backed, refused = hold_to_evidence(setup, behaviour, match.behaviour, facts, taken_off(match, updates),
                                                          facts["measures"].get("constant_facts"),
                                                          gone_rules(updates), weight_caps(updates))
            for line in backed + refused:
                trace(trace_message("adapter", "step", line, data={"writer": name}))
            fired = {matchups.rule_key(row["rule"]): row["made"] / row["picks"]
                     for row in rule_shares(match, updates) if row["picks"] >= config.ALWAYS_ON_MIN_PICKS}
            behaviour, estimated, scaled = keep_it_fair(match, behaviour, facts, fired)
            stood, stands = practice_share(match, facts, match.behaviour, fired), practice_share(match, facts, behaviour, fired)
            eases = stood is not None and stands is not None and stands > stood + 0.01   # a clear point easier, not a hair
            if eases and given is None and struggling(played(match), prior) is None:
                # Only the fairness check eases, and only under the band or on the brake. A writer never makes me weaker.
                trace(trace_message("adapter", "done", "That would make me easier and you are inside a fair share, so I am holding.",
                                    data={"writer": name, "estimated_player_share": stands, "was": stood}))
                return None
            proposal = {**proposal, "direction": "down" if eases else "up"}
            if scaled:
                trace(trace_message("adapter", "step", scaled, data={"writer": name, "estimated_player_share": estimated}))
            elif estimated is not None:
                trace(trace_message("adapter", "step", f"By the practice table and the rounds so far you should still win about {estimated:.0%} of rounds.",
                                    data={"writer": name, "estimated_player_share": estimated}))
        problems = behaviour_problems(setup, behaviour, value_names)
        repaired = bool(problems)
        if problems:
            behaviour = repair(setup, behaviour, match.behaviour, value_names)
            still = behaviour_problems(setup, behaviour, value_names)
            if still:
                trace(trace_message("adapter", "error", f"The new rules failed the check twice, so my current rules stay: {still[0]}",
                                    data={"writer": name, "problems": still[:5]}))
                return None

        # A reason that quotes a count the facts don't support is rewritten from the top habit.
        habits = facts["measures"].get("habits") or []
        known = known_counts(facts) | {tuple(pair) for pair in proposal.get("counts") or []}
        unsupported = 0
        for npc in behaviour.get("npcs") or {}:
            for rule in _rules(behaviour, npc):
                is_new = not any(_same_rule(rule, old) for old in _rules(match.behaviour, npc))
                if is_new:
                    rule["why"] = shorten(plain(rule.get("why")), MAX_WORDS)
                if is_new and not counts_hold(rule["why"], known):
                    unsupported += 1
                    rule["why"] = habit_line(habits[0]) if habits else ""

        changes = with_reasons(diff(match.behaviour, behaviour), proposal.get("changes") or [])
        world = checked_world(setup, proposal, name)
        changes += [{key: value for key, value in change.items() if value is not None}
                    for change in proposal.get("changes") or []
                    if isinstance(change, dict) and str(change.get("where", "")).startswith("settings.")
                    and change["where"][len("settings."):] in world]
        if name == FAIRNESS:  # every fairness step is marked, with its counted reason
            for index, change in enumerate(changes):
                change.update({"kind": FAIRNESS, "why": proposal.get("why", ""), "measure": "player_win_rate"})
                if index == 0:
                    change["expect"] = "You should win more rounds again."
        if name == CHECK:
            for change in changes:
                change["why"] = proposal.get("why", "")
        if not changes or (name != FAIRNESS and not visible(changes)):
            trace(trace_message("adapter", "done", "The new rules changed nothing a player could see, so I sent nothing.",
                                data={"writer": name, "problems": problems[:5]}))
            return None

        # Say what each change expects, so a later update can check it.
        after_round = current_round(match)
        for change in changes:
            if not change.get("expect"):
                continue
            change["after_round"] = after_round
            if change.get("measure") != "player_win_rate":
                target = change.get("habit") if isinstance(change.get("habit"), dict) else (habit_key(habits[0]) if habits else None)
                if target is None:
                    change.pop("expect")
                    continue
                change["habit"] = target
                change["measure"] = "habit_payoff"
        for change in changes:
            if "expect" not in change:
                change.pop("habit", None)

        # Lines that quote a count the facts don't support are left out.
        written = tidy_lines(proposal.get("observations"))
        observations = [line for line in written if counts_hold(line, known) and score_holds(line, match)]
        unsupported += len(written) - len(observations)
        won_so_far = sum(1 for round_end in match.rounds if round_end.get("winner") == "player")
        so_far = f"You have won {won_so_far} of {len(match.rounds)} rounds so far." if match.rounds else "No round has finished yet."
        observations = fill_lines(observations, [habit_line(habit) for habit in habits] + [so_far])
        for change in changes:
            if isinstance(change.get("why"), str) and not (counts_hold(change["why"], known) and score_holds(change["why"], match)):
                unsupported += 1
                change["why"] = habit_line(habits[0]) if habits else ""
            for key in ("why", "expect"):
                if isinstance(change.get(key), str):
                    change[key] = shorten(change[key], MAX_WORDS)
        plan_lines = [line for line in tidy_lines(proposal.get("plan")) if counts_hold(line, known) and score_holds(line, match)]
        plan_lines = fill_lines(plan_lines, plan_lines_for(changes))
        for change in changes:  # every change that is sent says why
            if not str(change.get("why") or "").strip():
                change["why"] = why_for(change, plan_lines)
        update: Message = {
            "type": "strategy_update",
            "match_id": match.match_id,
            "version": version,
            "source": source,
            "writer": name,
            "observations": observations,
            "plan": plan_lines,
            "changes": changes,
            "behaviour": behaviour,
        }
        if world:
            update["settings"] = world
        if checks:
            update["checks"] = checks
        if "tested" in proposal:
            update["tested"] = proposal["tested"]
        if proposal.get("eased"):
            update["eased_after_rounds"] = len(match.rounds)
        if proposal.get("removed"):
            update["removed"] = proposal["removed"]
        for key in ("removed_rules", "caps", "direction", "took_back"):
            if proposal.get(key):
                update[key] = proposal[key]
        if proposal.get("constant"):
            update["constant"] = proposal["constant"]

        trace(trace_message(
            "adapter", "done",
            f"Version {version} is ready: {len(changes)} changes from the {name} writer.",
            model=proposal.get("model"), ms=(time.monotonic() - began) * 1000,
            data={"writer": name, "repaired": repaired, "problems": problems[:5],
                  "dropped": proposal.get("dropped", []), "checks": len(checks),
                  "unsupported_counts": unsupported},
        ))
        return update
