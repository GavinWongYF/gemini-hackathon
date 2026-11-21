"""Early signs, habits without doubles and counters that are specific to a player. No network."""
from __future__ import annotations

import copy
from typing import Any

from server import adapter as A
from server import matchups, measures
from server.contract import check_behaviour
from server.designer import first_behaviour
from server.interfaces import Design, MatchState, Matchup, PlayerState, ValueSpec


import pytest

from server import config


@pytest.fixture(autouse=True)
def counts_alone(monkeypatch):
    """These tests check the early signs on plain counts: no table weight in the fair band, no holding
    updates, no wait for a won round and no code-built step up."""
    monkeypatch.setattr(config, "FAIR_BLEND_ROUNDS", 0.0)
    monkeypatch.setattr(config, "FAIR_WINDOW_ROUNDS", 0)      # the band as it was: one count over the whole match
    monkeypatch.setattr(config, "SEND_HOLDING_UPDATES", False)
    monkeypatch.setattr(config, "ADD_ONLY_AFTER_WIN", False)
    monkeypatch.setattr(config, "DOSE_STEP", 0.0)
    monkeypatch.setattr(config, "DOSE_MAX_STEP", 1.0)
    monkeypatch.setattr(config, "MIN_UPDATE_GAP_SECONDS", 0.0)
    monkeypatch.setattr(config, "FAIR_EASE_GAP_ROUNDS", 0)
    monkeypatch.setattr(config, "WRITER_COMPACT", False)       # these tests read the long prompt
    monkeypatch.setattr(config, "PAUSE_LISTS", False)
    monkeypatch.setattr(config, "MIN_VISIBLE_STEP", 0.0)
    monkeypatch.setattr(config, "DOSE_SECONDS", 0.0)


def pitch() -> dict[str, Any]:
    """A throwing game: the player winds up, then throws, and a keeper tries to guess where."""
    sides = ["left", "right"]
    return {
        "type": "setup", "match_id": "m_001", "game": "pitch", "mode": "live",
        "about": "One player throws at a goal. An AI keeper guards it.",
        "goal": "Start beatable, then read this player until they score about half the time.",
        "plan": {"rounds": 9, "update_seconds": 20},
        "npcs": {"keeper": {"about": "The AI in the goal.", "decisions": {
            "guard": {"when": "The moment the player winds up.", "options": {
                "stay": "Stay in the middle.", "go_left": "Move left.", "go_right": "Move right."}},
        }}},
        "events": {
            "wind_up": {"about": "The player started a throw.", "fields": {
                "lean": sides, "aim": sides, "aim_guess": sides, "reach": {"min": 0, "max": 1, "about": "How far back the arm went."}}},
            "throw": {"about": "The player let go.", "fields": {"aim": sides, "result": ["in", "out"]}},
        },
        "facts": {"wind_lean": sides, "wind_reach": {"min": 0, "max": 1, "about": "How far back the arm went."}, "throws_so_far": "number"},
        "default_behaviour": {"version": 0, "npcs": {"keeper": {"rules": [], "decisions": {
            "guard": {"stay": {"base": 0.6}, "go_left": {"base": 0.2}, "go_right": {"base": 0.2}}}}}},
    }


def event(name: str, round_number: int, t: float, **data: Any) -> dict[str, Any]:
    return {"type": "event", "match_id": "m_001", "name": name, "round": round_number, "t": t, "by": "player", "data": data}


def throws() -> list[dict[str, Any]]:
    """Six throws that lean left and go left, then four that lean right and go either way."""
    events: list[dict[str, Any]] = []
    for number in range(1, 7):
        events += [event("wind_up", number, 10.0 * number, lean="left", aim="left", aim_guess="right", reach=0.9),
                   event("throw", number, 10.0 * number + 0.1, aim="left", result="in")]
    for number, aim in zip(range(7, 11), ["left", "right", "left", "right"]):
        events += [event("wind_up", number, 10.0 * number, lean="right", aim="right", aim_guess="left", reach=0.5),
                   event("throw", number, 10.0 * number + 0.1, aim=aim, result="out")]
    return events


def a_match() -> tuple[MatchState, list[dict[str, Any]]]:
    setup = pitch()
    design = Design(values=[ValueSpec("goes_left", "Throws to the left", {"type": "noul", "instructions": "Left?"})],
                    behaviour=first_behaviour(setup))
    lines: list[dict[str, Any]] = []
    match = MatchState(match_id="m_001", setup=setup, design=design, behaviour=copy.deepcopy(design.behaviour),
                       player=PlayerState(values={"goes_left": 0.8}, confidence={"goes_left": 0.9}), trace=lines.append)
    match.events = throws()
    match.rounds = [{"type": "round_end", "match_id": "m_001", "round": n, "t": 10.0 * n + 5, "winner": "player" if n % 2 else "keeper"}
                    for n in range(1, 11)]
    return match, lines


def test_early_signs_are_counted_and_only_some_hold_up():
    found = measures.tells(pitch(), throws())
    assert {"event": "wind_up", "field": "lean", "value": "left", "then_event": "throw", "then_field": "aim",
            "then_value": "left", "hits": 6, "pairs": 6, "share": 1.0, "lift": 0.2} in found["held"]   # 8 of all 10 went left
    assert any(tell["field"] == "reach" and tell["value"] == "high" and tell["hits"] == 6 for tell in found["held"])   # numbers in thirds
    weak = [tell for tell in found["weak"] if tell["field"] == "lean"]
    assert [(tell["value"], tell["pairs"], tell["why"]) for tell in weak] == [("right", 4, "seen too few times")]
    assert all(tell["then_field"] == "aim" for tell in found["held"] + found["weak"])   # never the result, never a guess
    # A throw and the next wind-up are seconds apart, so that pair is no early sign.
    assert all(tell["event"] == "wind_up" for tell in found["held"] + found["weak"])
    assert measures.summary(pitch(), throws(), [])["tells"] == found
    # A sign that is followed by the same thing as every other sign says nothing new.
    same = [event("wind_up", n, 10.0 * n, lean="left" if n % 2 else "right") for n in range(1, 13)]
    same = [e for n, first in enumerate(same, 1) for e in (first, event("throw", n, 10.0 * n + 0.1, aim="left"))]
    found = measures.tells(pitch(), same)
    assert found["held"] == [] and {tell["why"] for tell in found["weak"]} == {"the same thing follows anyway"}


def test_a_habit_shows_a_field_once_and_never_a_guess():
    found = measures.habits(pitch(), throws())
    assert [(habit["event"], habit["field"]) for habit in found if habit["field"] == "aim"] == [("throw", "aim"), ("throw", "aim")]
    assert not any(habit["field"] == "aim_guess" for habit in found)
    assert {habit["field"] for habit in found} == {"aim", "lean"}


async def test_a_rule_on_an_early_sign_needs_a_sign_that_held_up():
    match, lines = a_match()
    facts = A.gather_facts(match)
    assert A.sign_facts(match.setup) == {"wind_lean": ("wind_up", "lean"), "wind_reach": ("wind_up", "reach")}

    held = {"if": [{"fact": "wind_lean", "is": "left"}], "do": {"guard": "go_left"}, "why": ""}
    not_held = {"if": [{"fact": "wind_lean", "is": "right"}], "do": {"guard": "go_right"}, "why": ""}
    plain_rule = {"if": [{"fact": "throws_so_far", "above": 3}], "do": {"guard": "stay"}, "why": ""}
    proposed = copy.deepcopy(match.behaviour)
    proposed["npcs"]["keeper"]["rules"] = [held, not_held, plain_rule]
    kept, backed, refused = A.hold_to_evidence(match.setup, proposed, match.behaviour, facts)
    assert kept["npcs"]["keeper"]["rules"] == [held, plain_rule]
    assert backed == ["A new rule reads an early sign that held up: lean left was followed by aim left on 6 of 6."]
    assert refused == ["Left out a rule that reads wind lean: that early sign has not held up yet."]

    class Writer:
        name = "standard"

        async def write(self, facts, budget_seconds, trace):
            return {"behaviour": proposed, "observations": [], "plan": [], "changes": []}

    update = await A.GeminiAdapter(writers={"standard": Writer()}).adapt(match, "quick")
    assert update["behaviour"]["npcs"]["keeper"]["rules"] == [held, plain_rule]
    assert check_behaviour(match.setup, update["behaviour"], ["goes_left"]) == []
    assert any(line["about"] == backed[0] for line in lines)                      # the sign and its count are in the log


async def test_the_writer_is_told_which_signs_held_up_and_may_only_check_those():
    match, _ = a_match()
    calls: list[dict[str, Any]] = []

    async def ask(model, thinking, prompt, schema, *, system=None, timeout=120.0):
        from server.models_client import ModelReply
        calls.append({"prompt": prompt, "schema": schema})
        return ModelReply(data={"observations": ["a", "b"], "plan": ["c", "d"], "new_rules": [], "weights": []}, model=model, thinking=thinking, ms=1.0)

    await A.GeminiAdapter(ask=ask).adapt(match, "quick")
    prompt = calls[0]["prompt"]
    assert "- HELD UP: fact:wind_lean left, then throw.aim = left on 6 of 6." in prompt
    assert "- did not hold up, seen too few times: fact:wind_lean right" in prompt
    checkable = calls[0]["schema"]["properties"]["new_rules"]["items"]["properties"]["if"]["items"]["properties"]["on"]["enum"]
    assert "fact:wind_lean" in checkable and "fact:wind_reach" in checkable and "fact:throws_so_far" in checkable

    match.events = match.events[:4]                                               # two throws: nothing has held up yet
    calls.clear()
    await A.GeminiAdapter(ask=ask).adapt(match, "quick")
    checkable = calls[0]["schema"]["properties"]["new_rules"]["items"]["properties"]["if"]["items"]["properties"]["on"]["enum"]
    assert "fact:wind_lean" not in checkable and "fact:throws_so_far" in checkable


def test_counters_are_ranked_by_how_specific_they_are():
    rows: list[Matchup] = []
    for name in ("rusher", "waiter", "even"):
        rows.append(matchups.baseline_row(name, "keeper", 20, 8))
        rows.append(Matchup(name, "keeper", "guard", "go_left", 20, 18))                       # beats everyone
        rows.append(Matchup(name, "keeper", "guard", "go_right", 20, 15 if name == "rusher" else 8))
    assert matchups.general_options(rows) == {("keeper", "guard", "go_left")}
    ranked = matchups.best_counters(rows, {"rusher": 1.0})
    assert [(row["option"], row["general"], row["specific"]) for row in ranked] == [("go_right", False, 0.35), ("go_left", True, 0.0)]
    assert ranked[1]["edge"] > ranked[0]["edge"]                                  # the bigger raw edge still goes last
