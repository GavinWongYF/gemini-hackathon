"""Checks every message against what the game declared in `setup`.

Three checks, used by the socket core and by anything that writes a behaviour:

    check_setup(setup)                              -> problems
    check_message(setup, message)                   -> problems
    check_behaviour(setup, behaviour, value_names)  -> problems

A problem is {"about": plain sentence, "where": dotted path, "got": the
offending value}. An empty list means the thing fits. The same three fields
go straight into an `error` message, so a game developer reads exactly what
to fix. Nothing here knows any game: every name is checked against `setup`.
"""
from __future__ import annotations

from typing import Any, Callable, Iterable

Message = dict[str, Any]
Problem = dict[str, Any]

MODES = ("live", "practice", "replay")
SOURCES = ("quick", "full")
WRITERS = ("fast", "standard", "deep", "deepest")  # how deep a rewrite goes, shallowest first
COMPARISONS = ("is", "in", "above", "below")
MAX_RULES = 4
RESERVED_IDS = ("player", "none")  # `winner` and `by` use these, so an NPC can't


def _problem(about: str, where: str, got: Any) -> Problem:
    return {"about": about, "where": where, "got": got}


def _is_number(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _is_text(x: Any) -> bool:
    return isinstance(x, str) and x != ""


# ---------------------------------------------------------------------------
# What `setup` declared
# ---------------------------------------------------------------------------

def npc_ids(setup: Message) -> list[str]:
    """Every NPC id the game declared."""
    npcs = setup.get("npcs")
    return list(npcs) if isinstance(npcs, dict) else []


def decision_names(setup: Message, npc: str) -> list[str]:
    """Every decision one NPC makes."""
    entry = (setup.get("npcs") or {}).get(npc)
    decisions = entry.get("decisions") if isinstance(entry, dict) else None
    return list(decisions) if isinstance(decisions, dict) else []


def option_names(setup: Message, npc: str, decision: str) -> list[str] | None:
    """The options of one decision, or None if `setup` has no such decision."""
    entry = (setup.get("npcs") or {}).get(npc)
    decisions = entry.get("decisions") if isinstance(entry, dict) else None
    spec = decisions.get(decision) if isinstance(decisions, dict) else None
    options = spec.get("options") if isinstance(spec, dict) else None
    if isinstance(options, (dict, list)):
        return list(options)
    return None


def _allowed_names(setup: Message, spec: Any) -> list[str] | None:
    """The names a field or fact may take, or None if it isn't a list of names."""
    if isinstance(spec, list):
        return spec
    if isinstance(spec, str) and spec not in ("number", "text"):
        named = (setup.get("lists") or {}).get(spec)
        if isinstance(named, list):
            return named
    return None


def _check_spec(setup: Message, spec: Any, where: str) -> list[Problem]:
    """Is this a kind of thing the contract knows? Used on event fields and facts."""
    lists = setup.get("lists") if isinstance(setup.get("lists"), dict) else {}
    if isinstance(spec, list):
        if not spec or not all(_is_text(name) for name in spec):
            return [_problem("A list of names needs at least one name, and every name must be text.", where, spec)]
    elif isinstance(spec, str):
        if spec not in ("number", "text") and spec not in lists:
            return [_problem(f"`{spec}` is not `number`, `text` or the name of a list in `lists`.", where, spec)]
    elif isinstance(spec, dict):
        low, high = spec.get("min"), spec.get("max")
        if not (_is_number(low) and _is_number(high)):
            return [_problem("A range needs a number for both `min` and `max`.", where, spec)]
        if low > high:
            return [_problem("In a range, `min` can't be above `max`.", where, spec)]
    else:
        return [_problem(
            "Write a list of names, the name of a list in `lists`, a {min, max} range, `number` or `text`.",
            where, spec,
        )]
    return []


def _check_value(setup: Message, spec: Any, value: Any, where: str, what: str) -> list[Problem]:
    """Does one reported value fit the kind `setup` declared for it?"""
    if value is None:  # a field that doesn't apply can be left out or null
        return []
    names = _allowed_names(setup, spec)
    if names is not None:
        if value not in names:
            return [_problem(f"{what} must be one of: {', '.join(map(str, names))}.", where, value)]
    elif isinstance(spec, dict):
        low, high = spec.get("min"), spec.get("max")
        if not _is_number(value):
            return [_problem(f"{what} must be a number from {low} to {high}.", where, value)]
        if _is_number(low) and _is_number(high) and not low <= value <= high:
            return [_problem(f"{what} must be from {low} to {high}.", where, value)]
    elif spec == "number":
        if not _is_number(value):
            return [_problem(f"{what} must be a number.", where, value)]
    elif spec == "text":
        if not isinstance(value, str):
            return [_problem(f"{what} must be text.", where, value)]
    return []


# ---------------------------------------------------------------------------
# setup
# ---------------------------------------------------------------------------

def check_setup(setup: Any) -> list[Problem]:
    """Is this `setup` a full, consistent description of a game?"""
    if not isinstance(setup, dict):
        return [_problem("`setup` must be one JSON object.", "setup", setup)]
    problems: list[Problem] = []

    if setup.get("type") != "setup":
        problems.append(_problem("The first message must have `type` set to `setup`.", "setup.type", setup.get("type")))
    for key in ("match_id", "game"):
        if not _is_text(setup.get(key)):
            problems.append(_problem(f"`{key}` must be a short piece of text.", f"setup.{key}", setup.get(key)))
    if setup.get("mode", "live") not in MODES:
        problems.append(_problem("`mode` must be `live`, `practice` or `replay`.", "setup.mode", setup.get("mode")))

    plan = setup.get("plan", {})
    if not isinstance(plan, dict):
        problems.append(_problem("`plan` must be an object, like {\"rounds\": 5, \"break_every\": 1, \"break_seconds\": 10}.", "setup.plan", plan))
    else:
        for key in ("rounds", "break_every", "break_seconds", "update_seconds", "max_candidates"):
            if key in plan and (not _is_number(plan[key]) or plan[key] < 0):
                problems.append(_problem(f"`{key}` must be a number, 0 or more.", f"setup.plan.{key}", plan[key]))
        if "writer" in plan and plan["writer"] not in WRITERS:
            problems.append(_problem(f"`writer` must be one of: {', '.join(WRITERS)}.", "setup.plan.writer", plan["writer"]))

    lists = setup.get("lists", {})
    if not isinstance(lists, dict):
        problems.append(_problem("`lists` must be an object of list name to names.", "setup.lists", lists))
    else:
        for name, names in lists.items():
            if not isinstance(names, list) or not names or not all(_is_text(n) for n in names):
                problems.append(_problem("A list needs at least one name, and every name must be text.", f"setup.lists.{name}", names))

    npcs = setup.get("npcs")
    if not isinstance(npcs, dict) or not npcs:
        problems.append(_problem("`npcs` must name at least one NPC.", "setup.npcs", npcs))
    else:
        for npc, entry in npcs.items():
            where = f"setup.npcs.{npc}"
            if npc in RESERVED_IDS:
                problems.append(_problem("An NPC can't be called `player` or `none`. Those names are taken.", where, npc))
            decisions = entry.get("decisions") if isinstance(entry, dict) else None
            if not isinstance(decisions, dict) or not decisions:
                problems.append(_problem(f"The NPC `{npc}` needs at least one decision.", f"{where}.decisions", decisions))
                continue
            for decision, spec in decisions.items():
                options = spec.get("options") if isinstance(spec, dict) else None
                if not isinstance(options, (dict, list)) or not options:
                    problems.append(_problem(
                        f"The decision `{decision}` needs at least one option.",
                        f"{where}.decisions.{decision}.options", options,
                    ))

    events = setup.get("events")
    if not isinstance(events, dict):
        problems.append(_problem("`events` must be an object of event name to description.", "setup.events", events))
    else:
        for name, spec in events.items():
            fields = spec.get("fields", {}) if isinstance(spec, dict) else None
            if not isinstance(fields, dict):
                problems.append(_problem(f"The event `{name}` needs a `fields` object.", f"setup.events.{name}.fields", fields))
                continue
            for field_name, field_spec in fields.items():
                problems += _check_spec(setup, field_spec, f"setup.events.{name}.fields.{field_name}")

    facts = setup.get("facts", {})
    if not isinstance(facts, dict):
        problems.append(_problem("`facts` must be an object of fact name to kind.", "setup.facts", facts))
    else:
        for name, spec in facts.items():
            problems += _check_spec(setup, spec, f"setup.facts.{name}")

    views = setup.get("views", {})
    if not isinstance(views, dict):
        problems.append(_problem("`views` must be an object of view name to one line on what it shows.", "setup.views", views))

    settings = setup.get("settings", {})
    if not isinstance(settings, dict):
        problems.append(_problem("`settings` must be an object of setting name to description.", "setup.settings", settings))
    else:
        for name, spec in settings.items():
            where = f"setup.settings.{name}"
            if not isinstance(spec, dict):
                problems.append(_problem("A setting needs `options`, or `min` and `max`.", where, spec))
                continue
            has_options = isinstance(spec.get("options"), list) and bool(spec["options"])
            has_range = _is_number(spec.get("min")) and _is_number(spec.get("max"))
            if not (has_options or has_range):
                problems.append(_problem("A setting needs `options`, or `min` and `max`.", where, spec))
            elif "now" in spec:
                problems += _check_setting(setup, name, spec["now"], f"{where}.now")

    practice = setup.get("practice")
    if practice is not None:
        if not isinstance(practice, dict):
            problems.append(_problem("`practice` must be an object. It can name scripted players in `players`.", "setup.practice", practice))
        elif "players" in practice and not isinstance(practice["players"], dict):
            problems.append(_problem("`players` must be an object of scripted player name to description.", "setup.practice.players", practice["players"]))

    if setup.get("default_behaviour") is not None and isinstance(npcs, dict):
        problems += check_behaviour(setup, setup["default_behaviour"], None, where="setup.default_behaviour")
    return problems


def _check_setting(setup: Message, name: str, value: Any, where: str) -> list[Problem]:
    """Does a setting's value fit what `setup` allows for it?"""
    spec = (setup.get("settings") or {}).get(name)
    if not isinstance(spec, dict):
        return [_problem(f"`setup` did not declare a setting called `{name}`.", where, value)]
    if isinstance(spec.get("options"), list):
        if value not in spec["options"]:
            return [_problem(f"The setting `{name}` must be one of: {', '.join(map(str, spec['options']))}.", where, value)]
    elif not _is_number(value) or not spec.get("min", value) <= value <= spec.get("max", value):
        return [_problem(f"The setting `{name}` must be a number from {spec.get('min')} to {spec.get('max')}.", where, value)]
    return []


# ---------------------------------------------------------------------------
# behaviour
# ---------------------------------------------------------------------------

def check_behaviour(
    setup: Message,
    behaviour: Any,
    value_names: Iterable[str] | None,
    *,
    where: str = "behaviour",
    complete: bool = False,
) -> list[Problem]:
    """Does this behaviour only use names the game and the design know?

    value_names: the values the agents track for this match. Pass None to
                 skip the check on value names, as for a game's own default.
    complete:    also require an entry for every NPC and every decision.
    """
    if not isinstance(behaviour, dict):
        return [_problem("A behaviour must be one JSON object.", where, behaviour)]
    known = None if value_names is None else set(value_names)
    problems: list[Problem] = []

    version = behaviour.get("version")
    if not _is_number(version) or version < 0:
        problems.append(_problem("`version` must be a number, 0 or more.", f"{where}.version", version))

    npcs = behaviour.get("npcs")
    if not isinstance(npcs, dict):
        problems.append(_problem("`npcs` must hold one entry for each NPC.", f"{where}.npcs", npcs))
        return problems

    declared = npc_ids(setup)
    for npc, entry in npcs.items():
        at = f"{where}.npcs.{npc}"
        if npc not in declared:
            problems.append(_problem(f"`setup` did not declare an NPC called `{npc}`.", at, npc))
            continue
        if not isinstance(entry, dict):
            problems.append(_problem("An NPC entry holds `decisions` and `rules`.", at, entry))
            continue

        decisions = entry.get("decisions", {})
        if not isinstance(decisions, dict):
            problems.append(_problem("`decisions` must be an object of decision name to options.", f"{at}.decisions", decisions))
            decisions = {}
        for decision, options in decisions.items():
            d_at = f"{at}.decisions.{decision}"
            allowed = option_names(setup, npc, decision)
            if allowed is None:
                problems.append(_problem(f"`setup` did not declare a decision called `{decision}` for `{npc}`.", d_at, decision))
                continue
            if not isinstance(options, dict):
                problems.append(_problem("A decision holds one entry for each option.", d_at, options))
                continue
            for option, weights in options.items():
                problems += _check_option(option, weights, allowed, known, f"{d_at}.{option}", decision)

        rules = entry.get("rules", [])
        if not isinstance(rules, list):
            problems.append(_problem("`rules` must be a list. It can be empty.", f"{at}.rules", rules))
            rules = []
        if len(rules) > MAX_RULES:
            problems.append(_problem(f"An NPC can have at most {MAX_RULES} rules.", f"{at}.rules", len(rules)))
        for index, rule in enumerate(rules):
            problems += _check_rule(setup, npc, rule, known, f"{at}.rules.{index}")

    if complete:
        for npc in declared:
            if npc not in npcs:
                problems.append(_problem(f"The behaviour has no entry for the NPC `{npc}`.", f"{where}.npcs", list(npcs)))
                continue
            entry = npcs[npc] if isinstance(npcs[npc], dict) else {}
            have = entry.get("decisions") if isinstance(entry.get("decisions"), dict) else {}
            for decision in decision_names(setup, npc):
                if decision not in have:
                    problems.append(_problem(
                        f"The behaviour has no entry for the decision `{decision}` of `{npc}`.",
                        f"{where}.npcs.{npc}.decisions", list(have),
                    ))
    return problems


def _check_option(
    option: str, weights: Any, allowed: list[str], known: set[str] | None, where: str, decision: str,
) -> list[Problem]:
    if option not in allowed:
        return [_problem(f"`{option}` is not an option of `{decision}`. The options are: {', '.join(allowed)}.", where, option)]
    if not isinstance(weights, dict):
        return [_problem("An option holds `base` and, if wanted, `when`.", where, weights)]
    problems: list[Problem] = []
    base = weights.get("base", 0)
    if not _is_number(base) or base < 0:
        problems.append(_problem("`base` must be a number, 0 or more.", f"{where}.base", base))
    when = weights.get("when", {})
    if not isinstance(when, dict):
        return problems + [_problem("`when` must be an object of value name to weight.", f"{where}.when", when)]
    for value_name, weight in when.items():
        if known is not None and value_name not in known:
            problems.append(_problem(f"`{value_name}` is not a value this match tracks.", f"{where}.when.{value_name}", value_name))
        if not _is_number(weight):
            problems.append(_problem("A weight must be a number. It can be negative.", f"{where}.when.{value_name}", weight))
    return problems


def _check_rule(setup: Message, npc: str, rule: Any, known: set[str] | None, where: str) -> list[Problem]:
    if not isinstance(rule, dict):
        return [_problem("A rule holds `if`, `do` and `why`.", where, rule)]
    problems: list[Problem] = []

    conditions = rule.get("if")
    if not isinstance(conditions, list):
        problems.append(_problem("`if` must be a list of conditions.", f"{where}.if", conditions))
        conditions = []
    for index, cond in enumerate(conditions):
        problems += _check_condition(setup, cond, known, f"{where}.if.{index}")

    do = rule.get("do")
    if not isinstance(do, dict) or not do:
        problems.append(_problem("`do` must name a decision and the option to pick, like {\"shot_type\": \"lob\"}.", f"{where}.do", do))
    else:
        for decision, option in do.items():
            allowed = option_names(setup, npc, decision)
            if allowed is None:
                problems.append(_problem(f"`setup` did not declare a decision called `{decision}` for `{npc}`.", f"{where}.do.{decision}", decision))
            elif option not in allowed:
                problems.append(_problem(
                    f"`{option}` is not an option of `{decision}`. The options are: {', '.join(allowed)}.",
                    f"{where}.do.{decision}", option,
                ))

    if "why" in rule and not isinstance(rule["why"], str):
        problems.append(_problem("`why` must be one plain line of text.", f"{where}.why", rule["why"]))
    return problems


def _check_condition(setup: Message, cond: Any, known: set[str] | None, where: str) -> list[Problem]:
    if not isinstance(cond, dict):
        return [_problem("A condition checks a `fact` or a `value`, using `is`, `in`, `above` or `below`.", where, cond)]
    has_fact, has_value = "fact" in cond, "value" in cond
    if has_fact == has_value:
        return [_problem("A condition checks exactly one thing: a `fact` or a `value`.", where, cond)]
    used = [word for word in COMPARISONS if word in cond]
    if not used:
        return [_problem("A condition needs one of `is`, `in`, `above` or `below`.", where, cond)]
    problems: list[Problem] = []

    if has_value:
        name = cond["value"]
        if known is not None and name not in known:
            problems.append(_problem(f"`{name}` is not a value this match tracks.", f"{where}.value", name))
        for word in ("above", "below"):
            if word in cond and not _is_number(cond[word]):
                problems.append(_problem(f"`{word}` needs a number. Values run from 0 to 1.", f"{where}.{word}", cond[word]))
        return problems

    name = cond["fact"]
    facts = setup.get("facts") if isinstance(setup.get("facts"), dict) else {}
    if name not in facts:
        return [_problem(f"`setup` did not declare a fact called `{name}`.", f"{where}.fact", name)]
    spec = facts[name]
    names = _allowed_names(setup, spec)
    what = f"The fact `{name}`"
    if "is" in cond:
        problems += _check_value(setup, spec, cond["is"], f"{where}.is", what)
    if "in" in cond:
        if not isinstance(cond["in"], list):
            problems.append(_problem("`in` needs a list.", f"{where}.in", cond["in"]))
        else:
            for item in cond["in"]:
                problems += _check_value(setup, spec, item, f"{where}.in", what)
    for word in ("above", "below"):
        if word not in cond:
            continue
        if names is not None or spec == "text":
            problems.append(_problem(f"{what} is not a number, so `{word}` can't be used on it.", f"{where}.{word}", cond[word]))
        elif not _is_number(cond[word]):
            problems.append(_problem(f"`{word}` needs a number.", f"{where}.{word}", cond[word]))
    return problems


# ---------------------------------------------------------------------------
# messages
# ---------------------------------------------------------------------------

def check_message(setup: Message, message: Any) -> list[Problem]:
    """Does this message, in either direction, fit the contract and `setup`?"""
    if not isinstance(message, dict):
        return [_problem("Every message must be one JSON object.", "message", message)]
    kind = message.get("type")
    if not _is_text(kind):
        return [_problem("Every message needs a `type`.", "type", kind)]
    if kind == "setup":
        return check_setup(message)
    checker = _CHECKS.get(kind)
    if checker is None:
        known = ", ".join(["setup", *_CHECKS])
        return [_problem(f"`{kind}` is not a message type. The types are: {known}.", "type", kind)]

    problems: list[Problem] = []
    if kind != "trace":
        match_id = message.get("match_id")
        if not _is_text(match_id):
            problems.append(_problem("Every message carries the `match_id` from `setup`.", f"{kind}.match_id", match_id))
        elif _is_text(setup.get("match_id")) and match_id != setup["match_id"]:
            problems.append(_problem(
                f"This socket is playing the match `{setup['match_id']}`.", f"{kind}.match_id", match_id,
            ))
    return problems + checker(setup, message)


def _need_number(message: Message, key: str, kind: str, optional: bool = False) -> list[Problem]:
    if key not in message and optional:
        return []
    if not _is_number(message.get(key)):
        return [_problem(f"`{key}` must be a number.", f"{kind}.{key}", message.get(key))]
    return []


def _need_lines(message: Message, key: str, kind: str) -> list[Problem]:
    lines = message.get(key)
    if not isinstance(lines, list) or not all(isinstance(line, str) for line in lines):
        return [_problem(f"`{key}` must be a list of short lines of text.", f"{kind}.{key}", lines)]
    return []


def _sides(setup: Message) -> list[str]:
    return ["player", *npc_ids(setup)]


def _check_event(setup: Message, message: Message) -> list[Problem]:
    name = message.get("name")
    events = setup.get("events") if isinstance(setup.get("events"), dict) else {}
    if name not in events:
        return [_problem(
            f"`setup` did not declare an event called `{name}`. The events are: {', '.join(events)}.",
            "event.name", name,
        )]
    problems = _need_number(message, "round", "event") + _need_number(message, "t", "event", optional=True)

    by = message.get("by")
    if by not in _sides(setup):
        problems.append(_problem(f"`by` must be `player` or an NPC id: {', '.join(npc_ids(setup))}.", "event.by", by))

    fields = events[name].get("fields", {}) if isinstance(events[name], dict) else {}
    data = message.get("data")
    if data is not None and not isinstance(data, dict):
        problems.append(_problem("`data` must be an object holding the event's fields.", "event.data", data))
    for field_name, value in (data if isinstance(data, dict) else {}).items():
        if field_name not in fields:
            problems.append(_problem(
                f"The event `{name}` has a field that `setup` did not declare.", f"event.data.{field_name}", value,
            ))
        else:
            problems += _check_value(setup, fields[field_name], value, f"event.data.{field_name}", f"The field `{field_name}`")

    picked = message.get("picked")
    if picked is not None:
        if not isinstance(picked, dict):
            problems.append(_problem("`picked` must be an object of decision to the option chosen.", "event.picked", picked))
        elif by not in npc_ids(setup):
            problems.append(_problem("Only an NPC event can carry `picked`.", "event.picked", picked))
        else:
            for decision, option in picked.items():
                allowed = option_names(setup, by, decision)
                if allowed is None:
                    problems.append(_problem(f"`setup` did not declare a decision called `{decision}` for `{by}`.", f"event.picked.{decision}", decision))
                elif option not in allowed:
                    problems.append(_problem(
                        f"`{option}` is not an option of `{decision}`. The options are: {', '.join(allowed)}.",
                        f"event.picked.{decision}", option,
                    ))

    by_rule = message.get("by_rule")
    if by_rule is not None:
        if not isinstance(by_rule, list):
            problems.append(_problem("`by_rule` must be a list of decision names.", "event.by_rule", by_rule))
        else:
            for decision in by_rule:
                if not isinstance(picked, dict) or decision not in picked:
                    problems.append(_problem("`by_rule` can only name decisions that are in `picked`.", "event.by_rule", decision))
    return problems


def _check_frames(setup: Message, message: Message) -> list[Problem]:
    problems = _need_number(message, "round", "frames", optional=True) + _need_number(message, "t", "frames", optional=True)
    views = message.get("views")
    if not isinstance(views, dict):
        return problems + [_problem("`views` must hold one picture for each view.", "frames.views", views)]
    declared = setup.get("views") if isinstance(setup.get("views"), dict) else {}
    for name, picture in views.items():
        if name not in declared:
            problems.append(_problem(
                f"`setup` did not declare a view called `{name}`. The views are: {', '.join(declared)}.",
                f"frames.views.{name}", name,
            ))
        elif not isinstance(picture, dict) or not _is_text(picture.get("mime_type")) or not isinstance(picture.get("data"), str):
            got = sorted(picture) if isinstance(picture, dict) else picture
            problems.append(_problem("A picture needs `mime_type` and base64 `data`.", f"frames.views.{name}", got))
    return problems


def _check_round_end(setup: Message, message: Message) -> list[Problem]:
    problems = _need_number(message, "round", "round_end") + _need_number(message, "t", "round_end", optional=True)
    sides = _sides(setup)
    winner = message.get("winner")
    if winner not in [*sides, "none"]:
        problems.append(_problem(f"`winner` must be `player`, `none` or an NPC id: {', '.join(npc_ids(setup))}.", "round_end.winner", winner))
    if "how" in message and not isinstance(message["how"], str):
        problems.append(_problem("`how` must be a short name for how the round ended.", "round_end.how", message["how"]))
    if "stats" in message and not isinstance(message["stats"], dict):
        problems.append(_problem("`stats` must be an object of numbers about the round.", "round_end.stats", message["stats"]))
    problems += _check_tally(message.get("score"), sides, "round_end.score", optional=True)
    if "break" in message and not isinstance(message["break"], bool):
        problems.append(_problem("`break` must be true or false.", "round_end.break", message["break"]))
    return problems


def _check_tally(tally: Any, sides: list[str], where: str, optional: bool = False) -> list[Problem]:
    """A count of rounds won, keyed by `player` and by NPC id."""
    if tally is None and optional:
        return []
    if not isinstance(tally, dict):
        return [_problem("This must be an object of rounds won, by `player` and by NPC id.", where, tally)]
    problems = []
    for side, count in tally.items():
        if side not in sides:
            problems.append(_problem(f"`{side}` is not `player` or an NPC id from `setup`.", f"{where}.{side}", side))
        elif not _is_number(count):
            problems.append(_problem("A count of rounds won must be a number.", f"{where}.{side}", count))
    return problems


def _check_values_named(values: Any, where: str) -> list[Problem]:
    """The shape `ready.values` and `strategy_update.new_values` share."""
    if not isinstance(values, dict):
        return [_problem("This must be an object of value name to {\"label\": ...}.", where, values)]
    problems = []
    for name, spec in values.items():
        if not isinstance(spec, dict) or not isinstance(spec.get("label"), str):
            problems.append(_problem("Every value needs a plain `label`.", f"{where}.{name}", spec))
    return problems


def _check_ready(setup: Message, message: Message) -> list[Problem]:
    values = message.get("values")
    problems = _check_values_named(values, "ready.values")
    names = list(values) if isinstance(values, dict) else []
    return problems + check_behaviour(setup, message.get("behaviour"), names, where="ready.behaviour")


def _check_player_read(setup: Message, message: Message) -> list[Problem]:
    problems = _need_number(message, "round", "player_read", optional=True) + _need_number(message, "t", "player_read", optional=True)
    values = message.get("values")
    if not isinstance(values, dict):
        return problems + [_problem("`values` must hold every value by name, each from 0 to 1.", "player_read.values", values)]
    for name, value in values.items():
        if not _is_number(value) or not 0 <= value <= 1:
            problems.append(_problem("A value must be a number from 0 to 1.", f"player_read.values.{name}", value))
    problems += _need_number(message, "based_on_events", "player_read", optional=True)
    for key in ("why", "picture_note"):
        if key in message and not isinstance(message[key], str):
            problems.append(_problem(f"`{key}` must be one plain line of text.", f"player_read.{key}", message[key]))
    return problems


def _check_strategy_update(setup: Message, message: Message) -> list[Problem]:
    kind = "strategy_update"
    problems = _need_number(message, "version", kind)
    if message.get("source") not in SOURCES:
        problems.append(_problem("`source` must be `quick` or `full`.", f"{kind}.source", message.get("source")))
    problems += _need_lines(message, "observations", kind) + _need_lines(message, "plan", kind)

    changes = message.get("changes", [])
    if not isinstance(changes, list):
        problems.append(_problem("`changes` must be a list.", f"{kind}.changes", changes))
    else:
        for index, change in enumerate(changes):
            if not isinstance(change, dict) or not isinstance(change.get("where"), str):
                problems.append(_problem("Each change says `where` it is, what it went `from` and `to`, and `why`.", f"{kind}.changes.{index}", change))

    if "new_values" in message:
        problems += _check_values_named(message["new_values"], f"{kind}.new_values")
    if "checks" in message and not isinstance(message["checks"], list):
        problems.append(_problem("`checks` must be a list.", f"{kind}.checks", message["checks"]))

    settings = message.get("settings")
    if settings is not None:
        if not isinstance(settings, dict):
            problems.append(_problem("`settings` must be an object of setting name to new value.", f"{kind}.settings", settings))
        else:
            for name, value in settings.items():
                problems += _check_setting(setup, name, value, f"{kind}.settings.{name}")

    behaviour = message.get("behaviour")
    problems += check_behaviour(setup, behaviour, None, where=f"{kind}.behaviour")
    if isinstance(behaviour, dict) and _is_number(message.get("version")) and behaviour.get("version") != message["version"]:
        problems.append(_problem(
            "The behaviour inside must carry the same `version` as the message.",
            f"{kind}.behaviour.version", behaviour.get("version"),
        ))
    return problems


def _check_practice_run(setup: Message, message: Message) -> list[Problem]:
    kind = "practice_run"
    problems = []
    if not _is_text(message.get("run_id")):
        problems.append(_problem("`run_id` must be a short piece of text.", f"{kind}.run_id", message.get("run_id")))
    problems += _check_practice_player(setup, message.get("player"), f"{kind}.player")
    rounds = message.get("rounds")
    if not _is_number(rounds) or rounds < 1:
        problems.append(_problem("`rounds` must be a number, 1 or more.", f"{kind}.rounds", rounds))
    return problems + check_behaviour(setup, message.get("behaviour"), None, where=f"{kind}.behaviour")


def _check_practice_player(setup: Message, player: Any, where: str) -> list[Problem]:
    """A scripted player: a name from `setup`, or a persona the agents wrote."""
    practice = setup.get("practice") if isinstance(setup.get("practice"), dict) else {}
    players = practice.get("players") if isinstance(practice.get("players"), dict) else {}
    if isinstance(player, str):
        if player not in players:
            return [_problem(
                f"`player` must be a scripted player from `setup` ({', '.join(players) or 'none declared'}) or a persona object.",
                where, player,
            )]
        return []
    if not isinstance(player, dict) or not _is_text(player.get("name")):
        return [_problem("A persona needs a `name`, and can carry `about` and `plays`.", where, player)]

    # plays: event name -> field name -> value -> how often the scripted player picks it
    plays = player.get("plays", {})
    if not isinstance(plays, dict):
        return [_problem("`plays` must be an object of event name to fields.", f"{where}.plays", plays)]
    problems: list[Problem] = []
    events = setup.get("events") if isinstance(setup.get("events"), dict) else {}
    for event_name, fields in plays.items():
        declared = events[event_name].get("fields", {}) if isinstance(events.get(event_name), dict) else None
        if declared is None:
            problems.append(_problem(f"`setup` did not declare an event called `{event_name}`.", f"{where}.plays.{event_name}", event_name))
            continue
        if not isinstance(fields, dict):
            problems.append(_problem("Each event in `plays` holds its fields.", f"{where}.plays.{event_name}", fields))
            continue
        for field_name, shares in fields.items():
            at = f"{where}.plays.{event_name}.{field_name}"
            names = _allowed_names(setup, declared.get(field_name)) if field_name in declared else None
            if names is None:
                problems.append(_problem(
                    f"`{field_name}` is not a field of `{event_name}` that takes a list of names.", at, field_name,
                ))
                continue
            if not isinstance(shares, dict):
                problems.append(_problem("A field in `plays` holds each value and how often to choose it.", at, shares))
                continue
            for value, share in shares.items():
                if value not in names:
                    problems.append(_problem(f"The field `{field_name}` must be one of: {', '.join(names)}.", f"{at}.{value}", value))
                elif not _is_number(share) or share < 0:
                    problems.append(_problem("How often a value is chosen must be a number, 0 or more.", f"{at}.{value}", share))
    return problems


def _check_practice_result(setup: Message, message: Message) -> list[Problem]:
    kind = "practice_result"
    problems = []
    if not _is_text(message.get("run_id")):
        problems.append(_problem("`run_id` must repeat the `run_id` of the `practice_run` it answers.", f"{kind}.run_id", message.get("run_id")))
    problems += _need_number(message, "rounds", kind, optional=True)
    problems += _check_tally(message.get("wins"), _sides(setup), f"{kind}.wins")
    if "stats" in message and not isinstance(message["stats"], dict):
        problems.append(_problem("`stats` must be an object of numbers.", f"{kind}.stats", message["stats"]))
    return problems


def _check_error(setup: Message, message: Message) -> list[Problem]:
    if not isinstance(message.get("about"), str):
        return [_problem("An `error` needs `about`, one plain sentence.", "error.about", message.get("about"))]
    return []


def _check_trace(setup: Message, message: Message) -> list[Problem]:
    problems = []
    for key in ("stage", "status", "about"):
        if not isinstance(message.get(key), str):
            problems.append(_problem(f"A trace needs `{key}`.", f"trace.{key}", message.get(key)))
    return problems


_CHECKS: dict[str, Callable[[Message, Message], list[Problem]]] = {
    "ready": _check_ready,
    "event": _check_event,
    "frames": _check_frames,
    "round_end": _check_round_end,
    "player_read": _check_player_read,
    "strategy_update": _check_strategy_update,
    "practice_run": _check_practice_run,
    "practice_result": _check_practice_result,
    "error": _check_error,
    "trace": _check_trace,
}
