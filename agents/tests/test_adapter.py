"""The adapter, with a fake model. No network."""
from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path
from typing import Any

from server import adapter as A
from server import config, matchups
from server import measures as M
from server.contract import check_behaviour, check_message
from server.designer import first_behaviour, like_values
from server.interfaces import Design, MatchState, Matchup, PlayerState, ValueSpec
from server.models_client import ModelError, ModelReply

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
PLAYERS = {"net_rusher": "Comes to the net early.", "even": "No clear habit."}


import pytest


@pytest.fixture(autouse=True)
def counts_alone(monkeypatch, request):
    """Most tests here check one mechanism on plain counts: no table weight in the fair band, no holding
    updates, and no wait for a won round. Tests marked `as_shipped` run with the settings as they ship."""
    monkeypatch.setattr(config, "DOSE_SECONDS", 0.0)            # the looks in these tests follow at once, with no clock
    if "as_shipped" in request.keywords:
        return
    monkeypatch.setattr(config, "PAUSE_LISTS", False)
    monkeypatch.setattr(config, "MIN_VISIBLE_STEP", 0.0)
    monkeypatch.setattr(config, "FAIR_BLEND_ROUNDS", 0.0)
    monkeypatch.setattr(config, "FAIR_WINDOW_ROUNDS", 0)      # the band as it was: one count over the whole match
    monkeypatch.setattr(config, "SEND_HOLDING_UPDATES", False)
    monkeypatch.setattr(config, "ADD_ONLY_AFTER_WIN", False)
    monkeypatch.setattr(config, "DOSE_STEP", 0.0)
    monkeypatch.setattr(config, "DOSE_MAX_STEP", 1.0)
    monkeypatch.setattr(config, "MIN_UPDATE_GAP_SECONDS", 0.0)
    monkeypatch.setattr(config, "FAIR_EASE_GAP_ROUNDS", 0)


def court() -> dict[str, Any]:
    """A small racket game, frozen here so a change to the example files can't break these tests."""
    zones = ["left_short", "middle_short", "right_short", "left_deep", "middle_deep", "right_deep"]
    return {
        "type": "setup", "match_id": "m_001", "game": "court", "mode": "live",
        "about": "One human player plays single points against one AI opponent.",
        "goal": "Start beatable, then take away what this player relies on until they win about half the points.",
        "plan": {"rounds": 5, "break_every": 1, "break_seconds": 3, "update_seconds": 20},
        "lists": {"zone": zones},
        "npcs": {"opponent": {"about": "The AI on the other side of the net.", "decisions": {
            "shot_type": {"when": "Each time it hits the ball.", "options": {
                "flat": "Fast and low.", "lob": "High and deep.", "drop": "Soft and short."}},
            "position": {"when": "Right after it hits the ball.", "options": {
                "middle_deep": "Wait at the middle of the baseline.", "left_deep": "Wait on the left.",
                "middle_short": "Come up to the net."}},
        }}},
        "events": {"shot": {"about": "Either side hit the ball.", "fields": {
            "side": ["forehand", "backhand"], "power": {"min": 0, "max": 1, "about": "How hard the swing was."},
            "from": "zone", "lands": "zone"}}},
        "facts": {"player_position": "zone", "rally_length": "number"},
        "views": {"court": "The game screen."},
        "settings": {"opponent_speed": {"about": "How fast the opponent moves.", "min": 0.65, "max": 1.25, "now": 0.85}},
        "default_behaviour": {"version": 0, "npcs": {"opponent": {"rules": [], "decisions": {
            "shot_type": {"flat": {"base": 0.5}, "lob": {"base": 0.25}, "drop": {"base": 0.25}},
            "position": {"middle_deep": {"base": 0.8}, "left_deep": {"base": 0.1}, "middle_short": {"base": 0.1}},
        }}}},
    }


def shot(round_number: int, side: str, by: str = "player") -> dict[str, Any]:
    return {"type": "event", "match_id": "m_001", "name": "shot", "round": round_number, "t": 1.0, "by": by,
            "data": {"side": side, "power": 0.6}}


def round_end(round_number: int, winner: str) -> dict[str, Any]:
    return {"type": "round_end", "match_id": "m_001", "round": round_number, "t": 2.0, "winner": winner,
            "how": "winner", "score": {}, "break": False}


def make_match(rounds: list[str] | None = None, table: bool = True) -> tuple[MatchState, list[dict[str, Any]]]:
    """A match where the player hits 3 forehands and 1 backhand in every round."""
    setup = court()
    values = [ValueSpec("comes_to_net", "Comes up to the net", {"type": "noul", "instructions": "Did the player come to the net?"})]
    values += like_values(PLAYERS)
    rows: list[Matchup] = []
    if table:
        for name in PLAYERS:
            rows.append(matchups.baseline_row(name, "opponent", 20, 8))
            rows.append(Matchup(name, "opponent", "shot_type", "lob", 20, 15 if name == "net_rusher" else 8))
            rows.append(Matchup(name, "opponent", "shot_type", "drop", 20, 9))
    design = Design(values=values, behaviour=first_behaviour(setup), matchups=rows)
    player = PlayerState(values={"comes_to_net": 0.8, "like_net_rusher": 0.7, "like_even": 0.3},
                         confidence={"comes_to_net": 0.9, "like_net_rusher": 0.7, "like_even": 0.7})
    lines: list[dict[str, Any]] = []
    match = MatchState(match_id="m_001", setup=setup, design=design, behaviour=copy.deepcopy(design.behaviour),
                       player=player, trace=lines.append)
    for number, winner in enumerate(rounds or [], 1):
        add_round(match, number, winner)
    return match, lines


def add_round(match: MatchState, number: int, winner: str) -> None:
    match.events += [shot(number, "forehand"), shot(number, "forehand"), shot(number, "forehand"), shot(number, "backhand")]
    match.rounds.append(round_end(number, winner))


LOB_RULE = {
    "do": "opponent.shot_type.lob",
    "if": [
        {"on": "fact:player_position", "op": "in", "names": ["left_short", "middle_short", "right_short"], "number": 0},
        {"on": "value:comes_to_net", "op": "above", "names": [], "number": 0.6},
    ],
    "why": "You came in on 9 of 12 shots.",
    "expect": "Your forehand should win you fewer points.",
    "habit": "h1",
}


def reply(**parts: Any) -> dict[str, Any]:
    base = {"observations": ["Your forehand shows up on 9 of 12 shots."], "plan": ["I'll lob when you come in."],
            "new_rules": [], "weights": []}
    return {**base, **parts}


def fake_ask(*replies: dict[str, Any], calls: list[dict[str, Any]] | None = None):
    queue = list(replies)

    async def ask(model, thinking, prompt, schema, *, system=None, timeout=120.0):
        if calls is not None:
            calls.append({"model": model, "thinking": thinking, "prompt": prompt, "schema": schema, "timeout": timeout})
        return ModelReply(data=queue.pop(0) if len(queue) > 1 else queue[0], model=model, thinking=thinking, ms=15.0)
    return ask


def value_names(match: MatchState) -> list[str]:
    return [spec.name for spec in match.design.values]


async def test_update_fits_the_contract_and_says_what_it_expects():
    match, lines = make_match(["player", "player", "opponent"])
    calls: list[dict[str, Any]] = []
    update = await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]), calls=calls)).adapt(match, "quick")

    assert update is not None
    assert check_message(match.setup, update) == []
    assert check_behaviour(match.setup, update["behaviour"], value_names(match)) == []
    assert (update["version"], update["source"], update["writer"]) == (2, "quick", "standard")
    rule = update["behaviour"]["npcs"]["opponent"]["rules"][0]
    assert rule["do"] == {"shot_type": "lob"}
    assert rule["if"] == [
        {"fact": "player_position", "in": ["left_short", "middle_short", "right_short"]},
        {"value": "comes_to_net", "above": 0.6},
    ]
    change = update["changes"][0]
    assert change["where"] == "opponent.rules" and change["from"] is None
    assert change["to"] == "When player position is one of left short, middle short, right short and comes to net is above 0.6, I play lob for shot type."
    assert change["expect"] == "Your forehand should win you fewer points."
    assert change["measure"] == "habit_payoff"
    assert not {"habit", "after_round", "held", "wants"} & set(change)            # the adapter's own notes stay with it
    assert not {"eased_after_rounds", "dial_after_rounds", "rounds_at", "removed"} & set(update)
    assert "checks" not in update                      # nothing to judge yet
    assert match.behaviour["npcs"]["opponent"]["rules"] == []   # the adapter never edits the match itself

    call = calls[0]
    assert (call["model"], call["thinking"]) == (config.ADAPTER_MODEL, config.ADAPTER_THINKING)
    assert call["timeout"] == 25                       # 1.25 times the 20 second wait
    assert "shot.side = forehand on 9 of 12" in call["prompt"]
    assert "opponent.shot_type.lob: against net_rusher" in call["prompt"]
    do = call["schema"]["properties"]["new_rules"]["items"]["properties"]["do"]["enum"]
    assert do == ["opponent.shot_type.lob"]            # only what the matchup table supports
    assert [line["status"] for line in lines] == ["step", "start", "done", "step", "done"]   # dials first, the estimate before the last
    assert lines[-1]["data"]["writer"] == "standard" and lines[-1]["data"]["repaired"] is False


async def test_works_with_no_finished_round():
    match, _ = make_match()
    match.events += [shot(1, "forehand"), shot(1, "forehand"), shot(1, "forehand"), shot(1, "backhand")]
    adapter = A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE])))
    update = await adapter.adapt(match, "quick")
    noted = adapter._ledger(match)[0]["changes"][0]
    assert update is not None and noted["after_round"] == 1
    assert noted["habit"] == {"event": "shot", "field": "side", "value": "forehand"}
    assert check_message(match.setup, update) == []


async def test_facts_have_exactly_the_agreed_keys():
    match, _ = make_match(["player"])
    facts = A.gather_facts(match)
    assert set(facts) == {"setup", "goal", "behaviour", "values", "confidence", "value_about", "measures",
                          "recent_rounds", "personas", "matchups", "counters", "earlier", "max_candidates", "world"}
    top = facts["counters"][0]
    assert (top["npc"], top["decision"], top["option"], top["against"]) == ("opponent", "shot_type", "lob", "net_rusher")
    assert top["edge"] == 0.35 and top["likeness"] == 0.7
    assert facts["personas"] == [{"name": name, "about": about} for name, about in PLAYERS.items()]
    json.dumps(facts)                                  # a writer in a sandbox gets it as a file


async def test_a_reply_that_changes_nothing_sends_nothing():
    match, lines = make_match(["player"])
    assert await A.GeminiAdapter(ask=fake_ask(reply())).adapt(match, "quick") is None
    tiny = reply(weights=[{"option": "opponent.shot_type.lob", "base": 0.27, "value": "none", "weight": 0,
                           "why": "", "expect": "", "habit": "none"}])
    assert await A.GeminiAdapter(ask=fake_ask(tiny)).adapt(match, "quick") is None
    assert "nothing a player could see" in lines[-1]["about"]


async def test_a_clear_weight_shift_is_an_update():
    match, _ = make_match(["player"])
    shift = reply(weights=[{"option": "opponent.shot_type.lob", "base": -1, "value": "comes_to_net", "weight": 0.8,
                            "why": "You came in on 3 of 4 shots.", "expect": "Your net play should pay less.", "habit": "h1"}])
    update = await A.GeminiAdapter(ask=fake_ask(shift)).adapt(match, "quick")
    assert update is not None
    change = update["changes"][0]
    assert change["where"] == "opponent.shot_type.lob"
    assert change["from"] == {"base": 0.25} and change["to"] == {"base": 0.25, "when": {"comes_to_net": 0.8}}
    assert check_behaviour(match.setup, update["behaviour"], value_names(match)) == []


async def test_a_rule_that_cannot_be_checked_is_left_out():
    match, lines = make_match(["player"])
    bad = dict(LOB_RULE, **{"if": [{"on": "fact:player_position", "op": "above", "names": [], "number": 3}]})
    assert await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[bad]))).adapt(match, "quick") is None
    both = await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[bad, LOB_RULE]))).adapt(match, "quick")
    assert both is not None and len(both["behaviour"]["npcs"]["opponent"]["rules"]) == 1
    assert lines[-1]["data"]["dropped"]


async def test_a_value_below_the_confidence_floor_is_not_offered():
    match, _ = make_match(["player"])
    match.player.confidence["comes_to_net"] = 0.3
    calls: list[dict[str, Any]] = []
    update = await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]), calls=calls)).adapt(match, "quick")
    on = calls[0]["schema"]["properties"]["new_rules"]["items"]["properties"]["if"]["items"]["properties"]["on"]["enum"]
    assert "value:comes_to_net" not in on and "fact:player_position" in on
    assert update is None                               # its only rule leaned on that value


async def test_model_failure_keeps_the_current_rules():
    async def failing(*args: Any, **kwargs: Any):
        raise ModelError("no answer")

    match, lines = make_match(["player"])
    assert await A.GeminiAdapter(ask=failing).adapt(match, "quick") is None
    assert lines[-1]["status"] == "error" and "current rules stay" in lines[-1]["about"]


async def test_checks_report_whether_an_expectation_held():
    match, _ = make_match(["player", "player", "player"])           # the forehand pays every time
    adapter = A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]), reply(weights=[
        {"option": "opponent.shot_type.drop", "base": 0.6, "value": "none", "weight": 0, "why": "", "expect": "", "habit": "none"}])))
    first = await adapter.adapt(match, "quick")
    assert first is not None
    match.behaviour = first["behaviour"]
    match.updates.append(first)

    add_round(match, 4, "opponent")
    add_round(match, 5, "opponent")
    add_round(match, 6, "player")
    second = await adapter.adapt(match, "quick")
    assert second is not None
    assert second["checks"] == [{
        "version": 2, "said": "Your forehand should win you fewer points.", "measure": "habit_payoff",
        "before": 1.0, "after": 0.333, "held": True,
    }]
    assert second["version"] == 3
    assert [r["do"] for r in second["behaviour"]["npcs"]["opponent"]["rules"]] == [{"shot_type": "lob"}]   # kept by default


async def test_eases_off_step_by_step_and_never_holds_while_the_player_keeps_losing():
    match, lines = make_match(["player", "opponent"])
    older = {"if": [], "do": {"position": "left_deep"}, "why": "older"}
    newer = {"if": [{"fact": "rally_length", "above": 3}], "do": {"shot_type": "lob"}, "why": "newer"}
    match.behaviour["npcs"]["opponent"]["rules"] = [newer, older]
    match.behaviour["npcs"]["opponent"]["decisions"]["shot_type"]["lob"] = {"base": 0.85}   # a writer had leaned on the lob
    calls: list[dict[str, Any]] = []
    adapter = A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]), calls=calls))

    def opponent(update: dict[str, Any]) -> dict[str, Any]:
        return update["behaviour"]["npcs"]["opponent"]

    assert A.struggling(match.rounds) is None                       # one lost round is not a slide
    add_round(match, 3, "opponent")                                 # two lost in a row, 1 won of the last 3
    first = await adapter.adapt(match, "quick")
    assert calls == [] and first["writer"] == "fairness"            # no model call for this one
    assert opponent(first)["rules"] == [older]                      # the newest rule comes off first
    assert opponent(first)["decisions"]["shot_type"]["lob"] == {"base": 0.55}   # halfway back to the default's 0.25
    assert first["observations"][0] == "You won 1 of the last 3 rounds."
    assert first["plan"] == ["Easing off so you win about half.", "I dropped my newest rule: lob for shot type."]
    assert all(change["kind"] == "fairness" and change["why"] == "You won 1 of the last 3 rounds, under a fair share."
               for change in first["changes"])
    assert first["changes"][0]["expect"] == "You should win more rounds again."
    assert check_message(match.setup, first) == []
    keep(match, first)
    assert await adapter.adapt(match, "quick") is None              # resting: no round has been played since the step
    assert "giving that time to show" in lines[-1]["about"]

    add_round(match, 4, "opponent")                                 # still losing: every rule off, weights halfway back again
    second = await adapter.adapt(match, "quick")
    assert opponent(second)["rules"] == [] and opponent(second)["decisions"]["shot_type"]["lob"] == {"base": 0.4}
    assert second["plan"][1] == "I dropped my rules and moved halfway back to my start."
    keep(match, second)

    add_round(match, 5, "opponent")                                 # still losing: the game's default exactly
    third = await adapter.adapt(match, "quick")
    assert A.same_play(third["behaviour"], match.setup["default_behaviour"])
    assert third["plan"][0] == "Going back to my starting play so you win about half."
    keep(match, third)

    add_round(match, 6, "opponent")
    assert await adapter.adapt(match, "quick") is None              # only now is there nothing left to ease
    assert "nothing left to ease" in lines[-1]["about"] and calls == []

    # A rule fairness took off does not come straight back, and under the band nothing is added.
    barred = A.taken_off(match, adapter._ledger(match))
    assert {"shot_type": "lob"} in barred and {"position": "left_deep"} in barred
    add_round(match, 7, "player")
    assert await adapter.adapt(match, "quick") is None and "nothing left to ease" in lines[-1]["about"] and calls == []
    proposed = copy.deepcopy(match.behaviour)
    proposed["npcs"]["opponent"]["rules"] = [{"if": [], "do": {"shot_type": "lob"}, "why": ""}]
    kept, _, refused = A.hold_to_evidence(match.setup, proposed, match.behaviour, A.gather_facts(match), barred)
    assert kept["npcs"]["opponent"]["rules"] == [] and refused == ["Left out a rule the fairness check took off earlier in this match."]


async def test_the_writers_can_be_switched_off_and_fairness_still_runs(monkeypatch):
    monkeypatch.setattr(config, "ADAPTER_WRITERS", False)
    match, lines = make_match(["player", "opponent"])
    calls: list[dict[str, Any]] = []
    adapter = A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]), calls=calls))
    assert await adapter.adapt(match, "quick") is None and calls == []
    assert "switched off" in lines[-1]["about"]
    match.design.dials = [{"setting": "opponent_speed", "harder": "up"}]
    add_round(match, 3, "opponent")
    eased = await adapter.adapt(match, "quick")
    assert eased["settings"] == {"opponent_speed": 0.76} and calls == []


async def test_unsupported_counts_never_reach_the_screen():
    match, lines = make_match(["player", "player", "opponent"])
    made_up = reply(observations=["You hit 7 of 7 shots to the left.", "Your forehand shows up on 9 of 12 shots."],
                    new_rules=[dict(LOB_RULE, why="You won 5 of 5 at the net.")])
    update = await A.GeminiAdapter(ask=fake_ask(made_up)).adapt(match, "quick")
    assert update["observations"] == ["Your forehand shows up on 9 of 12 shots.", "You picked forehand on 9 of your 12 shots."]
    assert update["changes"][0]["why"] == "You picked forehand on 9 of your 12 shots."
    assert update["behaviour"]["npcs"]["opponent"]["rules"][0]["why"] == "You picked forehand on 9 of your 12 shots."
    assert lines[-1]["data"]["unsupported_counts"] >= 2


async def test_the_wait_picks_the_writer():
    match, _ = make_match(["player"])
    match.setup["plan"]["update_seconds"] = 5
    calls: list[dict[str, Any]] = []
    update = await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]), calls=calls)).adapt(match, "quick")
    assert update["writer"] == "fast"
    assert (calls[0]["model"], calls[0]["thinking"], calls[0]["timeout"]) == (config.FAST_WRITER_MODEL, "low", 6.25)


async def test_a_deep_writer_with_nothing_falls_back_to_standard():
    class Empty:
        name = "deep"

        async def write(self, facts, budget_seconds, trace):
            return None

    match, _ = make_match(["player"])
    match.setup["plan"]["break_seconds"] = 600                      # long enough for a deep rewrite, whatever the tiers are
    adapter = A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE])), writers={"deep": Empty(), "deepest": Empty()})
    update = await adapter.adapt(match, "full")
    assert update is not None and (update["writer"], update["source"]) == ("standard", "full")


async def test_the_deep_writer_is_got_ready_once_in_the_background_and_only_when_it_can_be_used():
    class Deep:
        name = "deep"

        def __init__(self) -> None:
            self.prepared: list[str] = []

        async def prepare(self, setup, trace):
            self.prepared.append(setup["game"])
            raise RuntimeError("no sandbox today")

        async def write(self, facts, budget_seconds, trace):
            return None

    deep, lines = Deep(), []
    adapter = A.GeminiAdapter(writers={"deep": deep})
    quick_game = court()
    adapter.prepare(quick_game, lines.append)                       # a 20 second wait never reaches the deep writer
    await asyncio.sleep(0)
    assert deep.prepared == []

    slow_game = dict(court(), game="slow_court", plan={"rounds": 5, "break_seconds": 600, "update_seconds": 20})
    adapter.prepare(slow_game, lines.append)                        # returns at once
    adapter.prepare(slow_game, lines.append)
    await asyncio.sleep(0.01)
    assert deep.prepared == ["slow_court"]                          # once for each game
    assert [line["status"] for line in lines] == ["error"] and "could not get ready" in lines[0]["about"]


async def test_a_tested_proposal_is_passed_through():
    class Tested:
        name = "deepest"

        async def write(self, facts, budget_seconds, trace):
            behaviour = copy.deepcopy(facts["behaviour"])
            behaviour["npcs"]["opponent"]["rules"] = [{"if": [{"fact": "rally_length", "above": 3}],
                                                       "do": {"shot_type": "lob"}, "why": "It tested best."}]
            return {"behaviour": behaviour, "observations": ["You came in on 3 of 4 shots."], "plan": ["I'll lob."],
                    "changes": [{"where": "opponent.rules", "from": None, "to": "Always lob.", "why": "It tested best.",
                                 "expect": "Your forehand should pay less."}],
                    "tested": {"candidates": 4, "best": 0.7}}

    match, _ = make_match(["player"])
    match.setup["plan"]["writer"] = "deepest"
    update = await A.GeminiAdapter(writers={"deepest": Tested()}).adapt(match, "quick")
    assert update["writer"] == "deepest" and update["tested"] == {"candidates": 4, "best": 0.7}
    assert update["changes"][0]["to"] != "Always lob." and "lob" in update["changes"][0]["to"]   # measured from the behaviour, not taken on trust
    assert update["changes"][0]["expect"] == "Your forehand should pay less."


async def test_a_behaviour_that_fails_the_check_is_repaired_once():
    class Sloppy:
        name = "standard"

        async def write(self, facts, budget_seconds, trace):
            behaviour = copy.deepcopy(facts["behaviour"])
            behaviour["npcs"]["opponent"]["rules"] = [
                {"if": [{"fact": "no_such_fact", "is": "x"}], "do": {"shot_type": "lob"}, "why": ""},
                {"if": [{"fact": "rally_length", "above": 3}], "do": {"shot_type": "drop"}, "why": ""},
            ]
            return {"behaviour": behaviour, "observations": [], "plan": [], "changes": []}

    match, lines = make_match(["player"])
    update = await A.GeminiAdapter(writers={"standard": Sloppy()}).adapt(match, "quick")
    assert [rule["do"] for rule in update["behaviour"]["npcs"]["opponent"]["rules"]] == [{"shot_type": "drop"}]
    assert lines[-1]["data"]["repaired"] is True
    assert update["observations"] and update["plan"]                 # written in code when the writer gave none
    assert check_message(match.setup, update) == []


async def test_too_little_play_means_no_model_call():
    match, lines = make_match()
    match.player.confidence = {}
    match.events.append(shot(1, "forehand"))
    calls: list[dict[str, Any]] = []
    assert await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]), calls=calls)).adapt(match, "quick") is None
    assert calls == [] and any("too little of your play" in line["about"] for line in lines)


SPEED_DIAL = [{"setting": "opponent_speed", "harder": "up"}]


def keep(match: MatchState, update: dict[str, Any]) -> None:
    match.behaviour = update["behaviour"]
    match.updates.append(update)


def two_rules(match: MatchState) -> tuple[dict[str, Any], dict[str, Any]]:
    older = {"if": [], "do": {"position": "left_deep"}, "why": "older"}
    newer = {"if": [{"fact": "rally_length", "above": 3}], "do": {"shot_type": "lob"}, "why": "newer"}
    match.behaviour["npcs"]["opponent"]["rules"] = [newer, older]
    return newer, older


async def test_the_rules_ease_first_and_a_dial_step_that_did_not_pay_off_is_not_repeated():
    """The game here ignores the setting: the player goes on losing whatever the dial says."""
    match, lines = make_match(["player", "opponent", "opponent"])
    match.design.dials = SPEED_DIAL
    newer, older = two_rules(match)
    calls: list[dict[str, Any]] = []
    adapter = A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]), calls=calls))

    eased = await adapter.adapt(match, "quick")                                   # the rules ease first, the dial alongside
    assert eased is not None and eased["writer"] == "fairness" and calls == []
    assert eased["behaviour"]["npcs"]["opponent"]["rules"] == [older]
    assert eased["settings"] == {"opponent_speed": 0.76}                          # one step is 15% of 0.65 to 1.25
    gone, dial = eased["changes"]
    assert gone["where"] == "opponent.rules" and gone["kind"] == "fairness"
    assert dial == {
        "where": "settings.opponent_speed", "from": 0.85, "to": 0.76, "kind": "fairness",
        "why": "Fairness adjustment: you won 1 of 3, so opponent speed comes down.",
        "expect": "You should win more rounds again.", "measure": "player_win_rate",
    }
    assert eased["plan"][0] == "Easing off so you win about half."
    assert check_message(match.setup, eased) == []
    keep(match, eased)
    assert await adapter.adapt(match, "quick") is None                            # nothing more before a round is played

    add_round(match, 4, "opponent")                                               # neither step paid off
    softened = await adapter.adapt(match, "quick")                                # so the rules ease again, and the dial stays
    assert softened is not None and "settings" not in softened
    assert softened["behaviour"]["npcs"]["opponent"]["rules"] == []
    assert softened["plan"][0] == "Going back to my starting play so you win about half."
    keep(match, softened)

    add_round(match, 5, "opponent")                                               # still losing, and nothing is left to ease
    again = await adapter.adapt(match, "quick")                                   # only now may the dial move again
    assert again["settings"] == {"opponent_speed": 0.67} and again["writer"] == "fairness"
    assert [check["held"] for check in again["checks"] if check["measure"] == "player_win_rate"][0] is False
    keep(match, again)
    add_round(match, 6, "opponent")
    floor = await adapter.adapt(match, "quick")
    assert floor["settings"] == {"opponent_speed": 0.65}                          # never under the setting's `min`
    keep(match, floor)
    add_round(match, 7, "opponent")
    assert await adapter.adapt(match, "quick") is None                            # the dial is at its floor and the play is the default
    assert "nothing left to ease" in lines[-1]["about"] and calls == []           # and no rules were written while losing


async def test_far_under_the_band_the_dial_eases_and_a_rule_softens_together():
    match, _ = make_match(["opponent", "opponent", "opponent", "opponent"])       # none of the last four
    match.design.dials = SPEED_DIAL
    newer, older = two_rules(match)
    update = await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]))).adapt(match, "quick")

    assert update["writer"] == "fairness" and update["settings"] == {"opponent_speed": 0.76}
    assert update["behaviour"]["npcs"]["opponent"]["rules"] == [older]
    gone, dial = update["changes"]                                                # each step is its own item
    assert gone["where"] == "opponent.rules" and gone["to"] is None and gone["kind"] == "fairness"
    assert dial["where"] == "settings.opponent_speed" and dial["kind"] == "fairness"
    assert dial["why"].startswith("Fairness adjustment: you won 0 of 4")
    assert check_message(match.setup, update) == []

    # The rules step is never skipped for the dial, and with no dial the rule softens alone.
    match, _ = make_match(["player", "opponent", "opponent", "opponent"])
    match.design.dials = SPEED_DIAL
    two_rules(match)
    alone = await A.GeminiAdapter(ask=fake_ask(reply())).adapt(match, "quick")
    assert [change["where"] for change in alone["changes"]] == ["opponent.rules", "settings.opponent_speed"]
    match, _ = make_match(["opponent", "opponent", "opponent", "opponent"])
    two_rules(match)
    assert "settings" not in await A.GeminiAdapter(ask=fake_ask(reply())).adapt(match, "quick")


async def test_a_dial_step_that_paid_off_may_be_taken_again():
    match, _ = make_match(["player", "opponent", "opponent"])
    match.design.dials = SPEED_DIAL
    two_rules(match)
    adapter = A.GeminiAdapter(ask=fake_ask(reply()))
    keep(match, await adapter.adapt(match, "quick"))                              # 0.85 to 0.76
    for number, winner in enumerate(["player", "player", "opponent", "opponent", "opponent"], 4):
        add_round(match, number, winner)                                          # it paid off, then the player slid again
    again = await adapter.adapt(match, "quick")
    assert again["settings"] == {"opponent_speed": 0.67}                          # so the dial is trusted a second time
    assert again["writer"] == "fairness"


async def test_the_dial_is_the_last_step_up_and_never_goes_beside_a_counter():
    match, _ = make_match(["player", "player", "player", "player"])
    match.design.dials = SPEED_DIAL
    update = await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]))).adapt(match, "quick")
    assert update is not None and update["writer"] == "standard" and "settings" not in update   # the writer added a counter


async def test_a_dial_step_goes_out_alone_when_the_writer_has_nothing():
    class Quiet:
        name = "standard"

        async def write(self, facts, budget_seconds, trace):
            return None

    match, _ = make_match(["player", "player", "player", "player"], table=False)   # no practice table, so no counter to step up
    match.design.dials = SPEED_DIAL
    update = await A.GeminiAdapter(writers={"standard": Quiet()}).adapt(match, "quick")
    assert update["writer"] == "fairness" and update["settings"] == {"opponent_speed": 0.94}
    assert update["behaviour"] == {**match.behaviour, "version": match.behaviour["version"] + 1}
    assert [change["kind"] for change in update["changes"]] == ["fairness"]
    assert check_message(match.setup, update) == []


def test_only_marked_settings_move_and_each_stays_inside_its_range(monkeypatch):
    match, _ = make_match(["opponent", "opponent"])
    assert A.fairness_dial(match, []) is None                                     # nothing is marked, so nothing moves
    monkeypatch.setenv("NPC_FAIRNESS_DIALS", "opponent_speed:up")
    assert A.fairness_dial(match, [])["to"] == 0.76                               # marked by hand
    monkeypatch.delenv("NPC_FAIRNESS_DIALS")

    # A whole-number setting moves by whole steps and stops at its limit.
    match.setup["settings"] = {"enemy_count": {"about": "How many enemies start the round.", "min": 3, "max": 6, "now": 4}}
    match.design.dials = [{"setting": "enemy_count", "harder": "up"}]
    step = A.fairness_dial(match, [])
    assert (step["from"], step["to"], step["easier"]) == (4, 3, True) and "enemy count comes down" in step["why"]
    assert A.fairness_dial(match, [{"settings": {"enemy_count": 3}}]) is None

    # A setting that is harder when lowered eases by going up.
    match.setup["settings"] = {"swing_window": {"about": "Seconds the player has to swing.", "min": 1.0, "max": 3.0, "now": 2.0}}
    match.design.dials = [{"setting": "swing_window", "harder": "down"}]
    step = A.fairness_dial(match, [])
    assert step["to"] == 2.3 and "swing window goes up" in step["why"]
    # The player's share comes from counted rounds: an even run moves nothing.
    match.rounds = [round_end(n, who) for n, who in enumerate(["player", "opponent", "player", "opponent"], 1)]
    assert A.fairness_dial(match, []) is None


def test_facts_carry_the_personas_written_at_setup():
    match, _ = make_match(["player"])
    personas = [{"name": "net_rusher", "about": "Comes to the net early.", "plays": {"shot": {"side": {"forehand": 0.7, "backhand": 0.3}}}}]
    match.design.personas = personas
    assert A.gather_facts(match)["personas"] == personas


async def test_settings_are_never_sent():
    class Meddler:
        name = "standard"

        async def write(self, facts, budget_seconds, trace):
            behaviour = copy.deepcopy(facts["behaviour"])
            behaviour["npcs"]["opponent"]["rules"] = [{"if": [], "do": {"shot_type": "lob"}, "why": ""}]
            return {"behaviour": behaviour, "observations": [], "plan": [], "changes": [], "settings": {"opponent_speed": 1.25}}

    match, _ = make_match(["player"])
    calls: list[dict[str, Any]] = []
    assert "settings" not in await A.GeminiAdapter(writers={"standard": Meddler()}).adapt(match, "quick")
    await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]), calls=calls)).adapt(match, "quick")
    assert "opponent_speed" not in calls[0]["prompt"] and "opponent_speed" not in json.dumps(calls[0]["schema"])


async def test_runs_on_the_example_games_as_they_are_today():
    """No names from the examples here, so the game teams can rename things freely."""
    for game in ("tennis", "csgo"):
        setup = json.loads((EXAMPLES / game / "setup.json").read_text(encoding="utf-8"))
        npc, spec = next(iter(setup["npcs"].items()))
        decision, detail = next(iter(spec["decisions"].items()))
        option = next(iter(detail["options"]))
        event, field_name, names = next(
            (event, field_name, kind) for event, event_spec in setup["events"].items()
            for field_name, kind in event_spec["fields"].items() if isinstance(kind, list))
        design = Design(values=[ValueSpec("habit", "A habit", {"type": "noul", "instructions": "?"})], behaviour=first_behaviour(setup))
        match = MatchState(match_id=setup["match_id"], setup=setup, design=design, behaviour=copy.deepcopy(design.behaviour),
                           player=PlayerState(values={"habit": 0.9}, confidence={"habit": 0.9}))
        match.events = [{"type": "event", "match_id": setup["match_id"], "name": event, "round": 1, "t": 1.0, "by": "player",
                         "data": {field_name: names[0]}} for _ in range(4)]
        rule = {"do": f"{npc}.{decision}.{option}", "if": [{"on": "value:habit", "op": "above", "names": [], "number": 0.5}],
                "why": "", "expect": "That choice should win you fewer rounds.", "habit": "h1"}
        update = await A.GeminiAdapter(ask=fake_ask(reply(observations=[], new_rules=[rule]))).adapt(match, "quick")
        assert update is not None and check_message(setup, update) == []
        assert check_behaviour(setup, update["behaviour"], ["habit"]) == []


async def test_a_general_counter_gets_no_rule_and_one_small_weight_step():
    match, lines = make_match(["player", "player", "opponent"])
    rows: list[Matchup] = []
    for name in PLAYERS:
        rows.append(matchups.baseline_row(name, "opponent", 20, 8))
        rows.append(Matchup(name, "opponent", "shot_type", "drop", 20, 16))        # beats everyone, so it says nothing about you
        rows.append(Matchup(name, "opponent", "shot_type", "lob", 20, 15 if name == "net_rusher" else 8))
    match.design.matchups = rows
    counters = A.gather_facts(match)["counters"]
    assert (counters[0]["option"], counters[0]["general"], counters[0]["specific"]) == ("lob", False, 0.35)
    assert {row["option"] for row in counters if row["general"]} == {"drop"}

    class Greedy:
        name = "standard"

        async def write(self, facts, budget_seconds, trace):
            behaviour = copy.deepcopy(facts["behaviour"])
            behaviour["npcs"]["opponent"]["rules"] = [{"if": [], "do": {"shot_type": "drop"}, "why": "It wins."}]
            behaviour["npcs"]["opponent"]["decisions"]["shot_type"]["drop"] = {"base": 0.9}
            return {"behaviour": behaviour, "observations": [], "plan": [], "changes": []}

    update = await A.GeminiAdapter(writers={"standard": Greedy()}).adapt(match, "quick")
    opponent = update["behaviour"]["npcs"]["opponent"]
    assert opponent["rules"] == [] and opponent["decisions"]["shot_type"]["drop"] == {"base": 0.4}
    assert sum("beats every practice player" in line["about"] for line in lines) >= 1

    calls: list[dict[str, Any]] = []
    await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]), calls=calls)).adapt(match, "quick")
    assert calls[0]["schema"]["properties"]["new_rules"]["items"]["properties"]["do"]["enum"] == ["opponent.shot_type.lob"]
    assert "GENERAL OPTIONS: opponent.shot_type.drop." in calls[0]["prompt"]


async def test_every_update_has_two_or_three_short_lines():
    match, _ = make_match(["player", "player", "opponent"])
    long = "You keep choosing the forehand side again and again on nearly every single shot, which is 9 of 12 so far"
    wordy = reply(observations=[long], plan=["I will lob."],
                  new_rules=[dict(LOB_RULE, expect="Your forehand should win you far fewer points from now on in every round we play")])
    update = await A.GeminiAdapter(ask=fake_ask(wordy)).adapt(match, "quick")
    for lines in (update["observations"], update["plan"]):
        assert 2 <= len(lines) <= 3 and all(len(line.split()) <= 12 for line in lines)
    assert update["observations"][1] == "You picked forehand on 9 of your 12 shots."     # topped up in code
    assert update["plan"] == ["I will lob.", "New rule: I play lob for shot type."]
    for change in update["changes"]:
        assert all(len(str(change.get(key, "")).split()) <= 12 for key in ("why", "expect"))
    assert A.shorten("One two three four five six, seven eight nine ten eleven twelve thirteen", 12) == "One two three four five six."
    # No raw 0 to 1 score reaches a line a player reads. A count stays as it is.
    assert A.plain("You stayed deep behind the baseline at a 0.977 rate.") == "You stayed deep behind the baseline almost always."
    assert A.plain("Your net_rush value of 0.12 is low, on 2 of 12 shots.") == "Your net rush rarely is low, on 2 of 12 shots."
    scored = reply(observations=["You come to the net at a 0.8 rate.", "You picked forehand on 9 of your 12 shots."],
                   new_rules=[dict(LOB_RULE, expect="Coming in should pay off at a 0.3 rate.")])
    update = await A.GeminiAdapter(ask=fake_ask(scored)).adapt(match, "quick")
    told = update["observations"] + update["plan"] + [change.get(key, "") for change in update["changes"] for key in ("why", "expect")]
    assert update["observations"][0] == "You come to the net most of the time."
    assert not any(A.re.search(r"\b0?\.\d", line) for line in told)
    assert A.shorten("Play the lob whenever the player comes in to the net and the", 12) == "Play the lob whenever the player comes in to the net."


async def test_a_rule_that_fires_on_every_pick_is_taken_off_at_the_next_look():
    match, lines = make_match(["player", "player", "opponent"])
    stuck = {"if": [{"fact": "player_position", "in": ["left_deep", "middle_deep", "right_deep"]}], "do": {"shot_type": "drop"}, "why": "x"}
    fine = {"if": [{"fact": "rally_length", "above": 3}], "do": {"position": "left_deep"}, "why": "y"}
    match.behaviour["npcs"]["opponent"]["rules"] = [stuck, fine]
    for number in range(1, 4):                                                    # the game says which picks a rule made
        for _ in range(2):
            match.events.append({"type": "event", "match_id": "m_001", "name": "shot", "round": number, "t": 1.5, "by": "opponent",
                                 "picked": {"shot_type": "drop", "position": "middle_deep"}, "by_rule": ["shot_type"], "data": {}})
    found = A.always_on(match, [])
    assert [(row["decision"], row["option"], row["made"], row["picks"]) for row in found] == [("shot_type", "drop", 6, 6)]

    calls: list[dict[str, Any]] = []
    adapter = A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]), calls=calls))
    update = await adapter.adapt(match, "quick")
    opponent = update["behaviour"]["npcs"]["opponent"]
    assert calls == [] and update["writer"] == "check"                            # the adapter's own check, no model call
    assert opponent["rules"] == [fine] and opponent["decisions"]["shot_type"]["drop"] == {"base": 0.4}   # a capped lift, 0.25 to 0.4
    assert update["changes"][0]["why"] == "This rule made 6 of my last 6 shot type picks."
    assert update["plan"] == ["My rule for drop for shot type fired on nearly every pick.", "So it is now a small weight, not a rule."]
    assert check_message(match.setup, update) == []
    assert {"shot_type": "drop"} in A.taken_off(match, adapter._ledger(match))    # and it does not come straight back


async def test_a_proposal_is_checked_against_the_goal_and_scaled_back(monkeypatch):
    monkeypatch.setattr(config, "FAIR_BLEND_ROUNDS", 1e6)                         # the table alone, to check the sizing
    match, lines = make_match(["player", "player", "opponent", "player", "opponent"])
    rows: list[Matchup] = []
    for name in PLAYERS:
        rows.append(matchups.baseline_row(name, "opponent", 20, 8))               # the default leaves the player 60%
        rows.append(Matchup(name, "opponent", "shot_type", "lob", 20, 19 if name == "net_rusher" else 8))
        rows.append(Matchup(name, "opponent", "shot_type", "drop", 20, 9))
    match.design.matchups = rows
    default = match.setup["default_behaviour"]
    assert matchups.estimate_share(rows, {"net_rusher": 1.0}, default, default) == 0.6
    always = copy.deepcopy(default)
    always["npcs"]["opponent"]["rules"] = [{"if": [], "do": {"shot_type": "lob"}, "why": ""}]
    assert matchups.estimate_share(rows, {"net_rusher": 1.0}, always, default) == 0.2       # the lob every time: far too much

    class Heavy:
        name = "standard"

        async def write(self, facts, budget_seconds, trace):
            behaviour = copy.deepcopy(facts["behaviour"])
            behaviour["npcs"]["opponent"]["rules"] = [{"if": [], "do": {"shot_type": "lob"}, "why": "It wins."}]
            behaviour["npcs"]["opponent"]["decisions"]["shot_type"]["lob"] = {"base": 2.0}
            return {"behaviour": behaviour, "observations": [], "plan": [], "changes": []}

    update = await A.GeminiAdapter(writers={"standard": Heavy()}).adapt(match, "quick")
    opponent = update["behaviour"]["npcs"]["opponent"]
    assert opponent["rules"] == []                                                # the always-on rule did not go out
    assert 0.25 < opponent["decisions"]["shot_type"]["lob"]["base"] < 2.0         # and the weight step was cut back
    said = [line for line in lines if "sized this" in line["about"]]
    assert said and said[0]["data"]["estimated_player_share"] >= config.FAIR_TARGET_SHARE   # sized to the middle of the band

    early, _ = make_match(["player", "player"])                                   # two rounds in: the first step is smaller
    early.design.matchups = rows
    first = await A.GeminiAdapter(writers={"standard": Heavy()}).adapt(early, "quick")
    assert 0.25 < first["behaviour"]["npcs"]["opponent"]["decisions"]["shot_type"]["lob"]["base"] < opponent["decisions"]["shot_type"]["lob"]["base"]



async def test_a_rule_with_no_condition_never_goes_out():
    class Blunt:
        name = "standard"

        async def write(self, facts, budget_seconds, trace):
            behaviour = copy.deepcopy(facts["behaviour"])
            behaviour["npcs"]["opponent"]["rules"] = [{"if": [], "do": {"position": "left_deep"}, "why": ""}]
            return {"behaviour": behaviour, "observations": [], "plan": [], "changes": []}

    match, lines = make_match(["player", "player", "opponent"])
    update = await A.GeminiAdapter(writers={"standard": Blunt()}).adapt(match, "quick")
    opponent = update["behaviour"]["npcs"]["opponent"]
    assert opponent["rules"] == [] and opponent["decisions"]["position"]["left_deep"] == {"base": 0.25}   # 0.1 plus the capped 0.15
    assert any("no condition" in line["about"] for line in lines)
    assert all(change["why"].strip() for change in update["changes"])             # and every change that is sent says why
    calls: list[dict[str, Any]] = []
    await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[dict(LOB_RULE, **{"if": []})]), calls=calls)).adapt(match, "quick")
    assert calls[0]["schema"]["properties"]["new_rules"]["items"]["properties"]["if"]["minItems"] == 1


async def test_a_fact_that_never_varied_is_not_a_condition_again():
    match, lines = make_match(["player", "player", "opponent"])
    stuck = {"if": [{"fact": "player_position", "in": ["left_deep", "middle_deep", "right_deep"]}], "do": {"shot_type": "drop"}, "why": "x"}
    match.behaviour["npcs"]["opponent"]["rules"] = [stuck]
    for number in range(1, 4):
        for _ in range(2):
            match.events.append({"type": "event", "match_id": "m_001", "name": "shot", "round": number, "t": 1.5, "by": "opponent",
                                 "picked": {"shot_type": "drop"}, "by_rule": ["shot_type"], "data": {}})
    calls: list[dict[str, Any]] = []
    adapter = A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]), calls=calls))
    keep(match, await adapter.adapt(match, "quick"))                              # the always-on check takes the rule off
    assert adapter._ledger(match)[0]["constant"] == ["player_position"]
    add_round(match, 4, "player")
    await adapter.adapt(match, "quick")
    checkable = calls[0]["schema"]["properties"]["new_rules"]["items"]["properties"]["if"]["items"]["properties"]["on"]["enum"]
    assert "fact:player_position" not in checkable and "fact:rally_length" in checkable
    proposed = copy.deepcopy(match.behaviour)
    proposed["npcs"]["opponent"]["rules"] = [{"if": [{"fact": "player_position", "is": "left_deep"}], "do": {"position": "left_deep"}, "why": ""}]
    kept, _, refused = A.hold_to_evidence(match.setup, proposed, match.behaviour, A.gather_facts(match), [], ["player_position"])
    assert kept["npcs"]["opponent"]["rules"] == [] and "one value on every pick" in refused[0]


async def test_the_timeout_setting_caps_a_standard_call(monkeypatch):
    monkeypatch.setattr(config, "ADAPTER_TIMEOUT_SECONDS", 1.0)
    match, _ = make_match(["player", "player", "opponent"])
    calls: list[dict[str, Any]] = []
    await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]), calls=calls)).adapt(match, "quick")
    assert calls[0]["timeout"] == 1.0


async def test_rounds_lost_with_no_event_from_the_player_count_as_the_scoreboard_has_them():
    match, lines = make_match()
    match.rounds = [round_end(number, "opponent") for number in range(1, 7)]      # six rounds lost, and not one event
    match.design.dials = SPEED_DIAL
    calls: list[dict[str, Any]] = []
    adapter = A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]), calls=calls))
    assert len(A.played(match)) == 6 and A.brake(A.played(match))                 # every finished round counts, so the brake trips
    update = await adapter.adapt(match, "quick")
    assert calls == []                                                            # no paid look for a player who sent nothing
    assert update is not None and update["settings"]["opponent_speed"] < 1.0      # and the code eases on its own
    assert M.how_lost_rounds_end(match.setup, match.rounds, match.events)[0].startswith(
        "You lost 6 rounds in a row and sent nothing in any of them")


def test_the_real_practice_table_marks_the_unbeatable_option_general():
    table, example = Path("data/designs/tennis-add75b313c65.json"), EXAMPLES / "tennis" / "setup.json"
    table = Path(__file__).resolve().parent.parent / table
    if not table.exists():
        import pytest
        pytest.skip("the practice table from the real game is not on this machine")
    setup = json.loads(example.read_text(encoding="utf-8"))
    rows = [Matchup(**row) for row in json.loads(table.read_text(encoding="utf-8"))["design"]["matchups"]]
    everyone = matchups.general_options(rows)
    if not everyone:
        import pytest
        pytest.skip("this table has no option that beats every practice player")
    npc, decision, option = sorted(everyone)[0]
    names = matchups.players(rows)
    ranked = matchups.best_counters(rows, matchups.likeness({}, names), top=200)
    assert all(row["general"] for row in ranked if (row["npc"], row["decision"], row["option"]) == (npc, decision, option))
    assert not ranked[0]["general"]                                               # a specific counter still comes first
    fact = next(name for name, kind in setup["facts"].items() if isinstance(kind, str) and kind != "number")
    value = setup["lists"][setup["facts"][fact]][0]
    default = setup["default_behaviour"]
    proposed = copy.deepcopy(default)
    proposed["npcs"][npc]["rules"] = [{"if": [{"fact": fact, "is": value}], "do": {decision: option}, "why": ""}]
    proposed["npcs"][npc]["decisions"][decision][option] = {"base": 5.0}
    facts = {"measures": {}, "matchups": [row.__dict__ for row in rows]}
    kept, _, refused = A.hold_to_evidence(setup, proposed, default, facts)
    assert kept["npcs"][npc]["rules"] == [] and len(refused) == 2                 # no rule
    was = float(default["npcs"][npc]["decisions"][decision].get(option, {}).get("base", 0))
    hole = (npc, decision, option) in matchups.holes(rows)                        # wins nearly every round against everyone
    step = 0 if hole else config.GENERAL_COUNTER_STEP                             # a hole is never raised at all
    assert kept["npcs"][npc]["decisions"][decision][option]["base"] == round(was + step, 2)



# ---------------------------------------------------------------- the dose, from a real table and a real recording

REAL_TABLE = Path(__file__).resolve().parent.parent / "data" / "designs" / "tennis-add75b313c65.json"
REAL_MATCH = Path(__file__).resolve().parent.parent / "data" / "streams" / "real_baseline_grinder_adapt_0_20261121-135059.jsonl"


def real_table() -> tuple[dict[str, Any], list[Matchup]]:
    import pytest
    if not REAL_TABLE.exists():
        pytest.skip("the practice table from the real game is not on this machine")
    setup = json.loads((EXAMPLES / "tennis" / "setup.json").read_text(encoding="utf-8"))
    return setup, [Matchup(**row) for row in json.loads(REAL_TABLE.read_text(encoding="utf-8"))["design"]["matchups"]]


def strongest(rows: list[Matchup]) -> tuple[str, str, str, str]:
    """The practice player and counter with the biggest edge in the table that is not a hole in the game."""
    never = matchups.holes(rows)
    best = max((row for row in rows if not matchups.is_baseline(row) and (row.npc, row.decision, row.option) not in never),
               key=lambda row: matchups.edge(rows, row.player, row.npc, row.decision, row.option) or 0)
    return best.player, best.npc, best.decision, best.option


def real_match(setup: dict[str, Any], rows: list[Matchup], player: str, rounds: int) -> tuple[MatchState, Facts]:
    default = setup["default_behaviour"]
    match = MatchState(match_id="m_real", setup=setup, design=Design(values=[], behaviour=default, matchups=rows),
                       behaviour=copy.deepcopy(default), player=PlayerState(values={}, confidence={}), trace=lambda line: None)
    match.rounds = [round_end(number, "player") for number in range(1, rounds + 1)]
    facts = {"matchups": [row.__dict__ for row in rows], "measures": {},
             "values": {A.LIKE + player: 0.9}, "confidence": {A.LIKE + player: 0.9}}
    return match, facts


def test_the_dose_lands_the_player_on_the_target_and_not_at_full_strength(monkeypatch):
    monkeypatch.setattr(config, "FAIR_BLEND_ROUNDS", 1e6)                         # the table alone, to check the sizing
    setup, rows = real_table()
    player, npc, decision, option = strongest(rows)
    base = matchups.win_rate(matchups.baseline(rows, player, npc))
    full = base + matchups.edge(rows, player, npc, decision, option)
    share = matchups.dose(rows, {player: 1.0}, npc, decision, option, 0.5)
    assert share == round(((1 - 0.5) - base) / (full - base), 3) and 0 < share < 0.6   # well short of every pick

    match, facts = real_match(setup, rows, player, rounds=6)
    fact = next(name for name, kind in setup["facts"].items() if isinstance(kind, str) and kind != "number")
    proposed = copy.deepcopy(match.behaviour)
    proposed["npcs"][npc]["rules"] = [{"if": [{"fact": fact, "in": setup["lists"][setup["facts"][fact]]}],
                                       "do": {decision: option}, "why": ""}]
    fired = {matchups.rule_key(proposed["npcs"][npc]["rules"][0]): 1.0}             # its condition was true on every pick
    kept, estimate, line = A.keep_it_fair(match, proposed, facts, fired)
    assert kept["npcs"][npc]["rules"] == [] and "sized this" in line               # a weight, not a rule that always fires
    options = kept["npcs"][npc]["decisions"][decision]
    played = options[option]["base"] / sum(weights["base"] for weights in options.values())
    assert played <= share + 0.02 and estimate >= config.FAIR_TARGET_SHARE - 1e-9
    assert options[option]["base"] > setup["default_behaviour"]["npcs"][npc]["decisions"][decision].get(option, {}).get("base", 0)

    early, facts = real_match(setup, rows, player, rounds=2)                       # 2-0 after two rounds: a smaller step
    first, _, _ = A.keep_it_fair(early, copy.deepcopy(proposed), facts, fired)
    assert first["npcs"][npc]["rules"] == []
    assert first["npcs"][npc]["decisions"][decision][option]["base"] < options[option]["base"]


def test_what_fairness_turned_down_does_not_come_back_as_copies_and_a_hole_is_never_raised():
    setup, rows = real_table()
    player, npc, decision, option = strongest(rows)
    default = setup["default_behaviour"]
    fact = next(name for name, kind in setup["facts"].items() if isinstance(kind, str) and kind != "number")
    proposed = copy.deepcopy(default)
    proposed["npcs"][npc]["rules"] = [{"if": [{"fact": fact, "is": value}], "do": {decision: option}, "why": ""}
                                      for value in setup["lists"][setup["facts"][fact]][:3]]   # one counter, split three ways
    proposed["npcs"][npc]["decisions"][decision][option] = {"base": 3.0}
    never = sorted(matchups.holes(rows))
    for _, hole_decision, hole_option in never:
        proposed["npcs"][npc]["decisions"][hole_decision][hole_option] = {"base": 3.0}
    facts = {"measures": {}, "matchups": [row.__dict__ for row in rows]}
    kept, _, refused = A.hold_to_evidence(setup, proposed, default, facts, barred=[{decision: option}])
    assert kept["npcs"][npc]["rules"] == []
    assert kept["npcs"][npc]["decisions"][decision][option]["base"] == default["npcs"][npc]["decisions"][decision][option]["base"]
    for _, hole_decision, hole_option in never:
        assert kept["npcs"][npc]["decisions"][hole_decision][hole_option]["base"] == \
            default["npcs"][npc]["decisions"][hole_decision][hole_option]["base"]
    assert any("turned it down" in line for line in refused)


async def test_nothing_is_added_while_the_match_so_far_is_under_the_band():
    import pytest
    if not REAL_MATCH.exists():
        pytest.skip("the recording from the real game is not on this machine")
    stream = [json.loads(line) for line in REAL_MATCH.read_text(encoding="utf-8").splitlines() if line.strip()]
    ends = [row["message"] for row in stream if row.get("dir") == "in" and row["message"].get("type") == "round_end"]
    twelve = ends[:12]
    won = sum(1 for end in twelve if end.get("winner") == "player")
    assert A.under_band(twelve) is not None and won < 6                            # under the band on the match so far

    class Never:
        name = "standard"

        async def write(self, facts, budget_seconds, trace):
            raise AssertionError("no writer may add strength while the player is under the band")

    order = ["opponent"] * 8 + ["player", "opponent", "player", "player"]          # 3 of the last 4, and 3 of 12 overall
    match, lines = make_match(order)
    assert A.under_band(match.rounds) == (3, 12)
    assert await A.GeminiAdapter(writers={"standard": Never()}).adapt(match, "quick") is None
    assert any("nothing left to ease" in line["about"] or "add nothing" in line["about"] for line in lines)


async def test_a_proposal_that_lands_after_the_player_dropped_under_the_band_is_dropped(monkeypatch):
    def slow(lost: int):
        class Slow:
            name = "standard"

            async def write(self, facts, budget_seconds, trace):
                for number in range(5, 5 + lost):                                 # rounds end while the writer is busy
                    add_round(match, number, "opponent")
                behaviour = copy.deepcopy(facts["behaviour"])
                behaviour["npcs"]["opponent"]["decisions"]["shot_type"]["lob"] = {"base": 0.6}
                return {"behaviour": behaviour, "observations": [], "plan": [], "changes": []}
        return Slow()

    match, lines = make_match(["player", "player", "opponent", "player"])
    assert await A.GeminiAdapter(writers={"standard": slow(4)}).adapt(match, "quick") is None     # 3 of 8 by then
    assert any("by the time my new rules were ready" in line["about"] for line in lines)

    monkeypatch.setattr(config, "ADD_ONLY_AFTER_WIN", True)
    match, lines = make_match(["player", "player", "opponent", "player"])
    assert await A.GeminiAdapter(writers={"standard": slow(1)}).adapt(match, "quick") is None     # one lost round is enough
    assert any("until you win one" in line["about"] for line in lines)


async def test_the_always_on_check_runs_while_the_player_is_under_the_band():
    match, lines = make_match(["player", "opponent", "opponent", "player", "opponent", "player", "opponent", "player"])
    assert A.struggling(match.rounds) is None and A.under_band(match.rounds) is None
    match.rounds[0]["winner"] = "opponent"                                        # 3 of 8 on the match so far
    assert A.under_band(match.rounds) == (3, 8)
    stuck = {"if": [{"fact": "player_position", "in": ["left_deep", "middle_deep", "right_deep"]}], "do": {"shot_type": "drop"}, "why": "x"}
    match.behaviour["npcs"]["opponent"]["rules"] = [stuck]
    for number in range(1, 9):
        match.events.append({"type": "event", "match_id": "m_001", "name": "shot", "round": number, "t": 1.5, "by": "opponent",
                             "picked": {"shot_type": "drop"}, "by_rule": ["shot_type"], "data": {}})
    update = await A.GeminiAdapter(ask=fake_ask(reply())).adapt(match, "quick")
    assert update["writer"] == "check" and update["behaviour"]["npcs"]["opponent"]["rules"] == []


def test_the_rounds_of_the_match_are_blended_with_the_table(monkeypatch):
    monkeypatch.setattr(config, "FAIR_BLEND_ROUNDS", 8.0)
    assert A.blended_share([], 0.6) == 0.6
    assert round(A.blended_share([round_end(n, "opponent") for n in range(1, 5)], 0.6), 3) == 0.4     # (0.6 x 8 + 0) / 12
    four = [round_end(n, "player" if n == 1 else "opponent") for n in range(1, 5)]
    assert A.struggling(four, 0.6) is None                                        # 1 of 4 is noise beside the table
    assert A.struggling([round_end(n, "opponent") for n in range(1, 6)], 0.9) == (0, 5)   # the brake: 5 lost in a row

    match, _ = make_match(["player", "player", "opponent", "player", "opponent"])
    facts = A.gather_facts(match)
    proposed = copy.deepcopy(match.behaviour)
    proposed["npcs"]["opponent"]["decisions"]["shot_type"]["lob"] = {"base": 0.4}
    same, by_table, _ = A.keep_it_fair(match, copy.deepcopy(proposed), facts)
    assert same == proposed and by_table > config.FAIR_TARGET_SHARE              # the step goes through
    match.rounds = [round_end(n, "player" if n == 1 else "opponent") for n in range(1, 5)]     # 1 of 4 so far
    held, shown, line = A.keep_it_fair(match, copy.deepcopy(proposed), facts)
    assert held["npcs"]["opponent"]["decisions"]["shot_type"]["lob"]["base"] < 0.4 and line     # the rounds pull the estimate down


async def test_the_dial_never_eases_alone_while_there_is_play_left_to_ease():
    match, lines = make_match(["player", "opponent", "opponent", "opponent"])
    match.design.dials = SPEED_DIAL
    two_rules(match)
    adapter = A.GeminiAdapter(ask=fake_ask(reply()))
    first = await adapter.adapt(match, "quick")
    assert first["behaviour"]["npcs"]["opponent"]["rules"] != match.behaviour["npcs"]["opponent"]["rules"]   # the rules step went
    keep(match, first)
    again = await adapter.adapt(match, "quick")                                   # resting: no rules step this look
    assert again is None or again["behaviour"]["npcs"]["opponent"]["rules"] != match.behaviour["npcs"]["opponent"]["rules"]


def test_a_new_rule_that_lists_every_option_counts_as_always_on(monkeypatch):
    monkeypatch.setattr(config, "FAIR_BLEND_ROUNDS", 1e6)
    setup, rows = real_table()
    player, npc, decision, option = strongest(rows)
    fact = next(name for name, kind in setup["facts"].items() if isinstance(kind, str) and kind != "number")
    every = setup["lists"][setup["facts"][fact]]
    whole = {"if": [{"fact": fact, "in": every}], "do": {decision: option}, "why": ""}
    part = {"if": [{"fact": fact, "is": every[0]}], "do": {decision: option}, "why": ""}
    assert A.always_true(setup, whole) and not A.always_true(setup, part)
    assert not A.always_true(setup, {"if": [], "do": {decision: option}})
    assert not A.always_true(setup, {"if": [{"fact": fact, "in": every}, {"fact": fact, "is": every[0]}], "do": {decision: option}})

    def sized(rule: dict[str, Any], fired: dict[str, float] | None) -> tuple[Any, Any, Any]:
        match, facts = real_match(setup, rows, player, rounds=6)
        proposed = copy.deepcopy(match.behaviour)
        proposed["npcs"][npc]["rules"] = [rule]
        return A.keep_it_fair(match, proposed, facts, fired)

    assert sized(whole, None) == sized(whole, {matchups.rule_key(whole): 1.0})    # no pick history needed to know it
    assert sized(whole, None)[2] != sized(whole, {matchups.rule_key(whole): 0.5})[2]   # its full strength is not taken as half the time


def test_under_the_floor_nothing_is_added_even_when_the_table_cannot_weigh_it(monkeypatch):
    monkeypatch.setattr(config, "FAIR_BLEND_ROUNDS", 8.0)
    match, _ = make_match(["player", "player", "player", "player", "opponent", "opponent"])
    facts = A.gather_facts(match)
    proposed = copy.deepcopy(match.behaviour)                                     # the table has no rounds for this decision
    proposed["npcs"]["opponent"]["rules"] = [{"if": [{"fact": "rally_length", "above": 3}], "do": {"position": "left_deep"}, "why": ""}]
    same, by_table, line = A.keep_it_fair(match, copy.deepcopy(proposed), facts)
    assert same == proposed and line is None and by_table > config.FAIR_SHARE_FLOOR
    match.rounds = [round_end(n, "opponent") for n in range(1, 5)]                # 0 of 4: the blended share is 40%
    held, shown, line = A.keep_it_fair(match, copy.deepcopy(proposed), facts)
    assert held["npcs"]["opponent"]["rules"] == [] and shown < config.FAIR_SHARE_FLOOR
    assert "left my play as it is" in line


async def test_the_dial_is_counted_when_the_update_is_sent_not_when_the_look_began(monkeypatch):
    monkeypatch.setattr(config, "ADD_ONLY_AFTER_WIN", True)
    match, lines = make_match(["player", "player", "player", "player"], table=False)
    match.design.dials = SPEED_DIAL

    class Slow:
        name = "standard"

        async def write(self, facts, budget_seconds, trace):
            for number in (5, 6):                                                 # the player loses two rounds meanwhile
                add_round(match, number, "opponent")
            return None

    assert A.fairness_dial(match, []) is not None                                 # ahead when the look began
    assert await A.GeminiAdapter(writers={"standard": Slow()}).adapt(match, "quick") is None
    assert not any("opponent speed goes up" in line["about"] for line in lines)


async def test_a_player_who_keeps_winning_gets_one_step_more_of_the_best_counter(monkeypatch):
    class Quiet:
        name = "standard"

        async def write(self, facts, budget_seconds, trace):
            return None

    monkeypatch.setattr(config, "DOSE_STEP", 0.1)
    match, lines = make_match(["player", "player", "player", "player"])
    adapter = A.GeminiAdapter(writers={"standard": Quiet()})
    update = await adapter.adapt(match, "quick")
    shot_type = update["behaviour"]["npcs"]["opponent"]["decisions"]["shot_type"]
    assert update["writer"] == "check" and update["behaviour"]["npcs"]["opponent"]["rules"] == []
    assert shot_type["lob"] == {"base": 0.4} and shot_type["drop"] == {"base": 0.25}   # the lob goes from 25% to 35% of picks
    assert update["changes"][0]["why"] == "You won 4 of the last 4, so I play lob more."
    assert check_message(match.setup, update) == []
    keep(match, update)
    assert await adapter.adapt(match, "quick") is None                            # no round has finished since: no second step
    add_round(match, 5, "player")
    again = await adapter.adapt(match, "quick")
    assert again["behaviour"]["npcs"]["opponent"]["decisions"]["shot_type"]["lob"]["base"] > 0.4

    low, _ = make_match(["opponent"] * 8 + ["player", "opponent", "player", "player"])    # ahead lately, 3 of 12 on the match
    assert A.winning(low.rounds) is None and A.raise_dose(low, A.gather_facts(low), []) is None


# ---------------------------------------------------------------- the loop as it ships: holding, adding after a win, no flapping

@pytest.mark.as_shipped
async def test_every_look_sends_an_update_and_a_blocked_one_is_a_holding_update():
    class Quiet:
        name = "standard"

        async def write(self, facts, budget_seconds, trace):
            return None

    match, _ = make_match(["player", "opponent"], table=False)
    update = await A.GeminiAdapter(writers={"standard": Quiet()}).adapt(match, "quick")
    assert update["changes"] == [] and update["version"] == match.behaviour["version"] + 1
    assert update["behaviour"] == {**match.behaviour, "version": update["version"]}             # the play in hand, unchanged
    assert update["plan"][0] == "You won 1 of the last 2, so I am holding."           # inside the band: the share, in plain words
    assert 2 <= len(update["observations"]) <= 3 and check_message(match.setup, update) == []
    assert all(len(line.split()) <= config.MAX_LINE_WORDS for line in update["observations"] + update["plan"])


@pytest.mark.as_shipped
async def test_strength_is_added_only_after_a_round_the_player_won(monkeypatch):
    monkeypatch.setattr(config, "MIN_UPDATE_GAP_SECONDS", 0.0)                    # the looks here follow at once
    match, _ = make_match(["player", "player", "player", "opponent"])
    adapter = A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE])))
    held = await adapter.adapt(match, "quick")
    assert held["changes"] == [] and "holding" in held["plan"][0]                                  # they lost the last round
    add_round(match, 5, "player")
    added = await adapter.adapt(match, "quick")
    assert added["changes"] and not any("holding" in line for line in added["plan"])              # now it may add


def test_the_dose_follows_the_formula_and_a_table_without_a_hole_has_none():
    rows = [matchups.baseline_row("forehand_lover", "opponent", 60, 16),          # the default wins 27%
            Matchup("forehand_lover", "opponent", "aim", "left_deep", 60, 48),    # the counter wins 80%
            matchups.baseline_row("even", "opponent", 60, 14),
            Matchup("even", "opponent", "aim", "left_deep", 60, 8)]
    share = matchups.dose(rows, {"forehand_lover": 1.0}, "opponent", "aim", "left_deep", 0.5)
    assert abs(share - (0.5 - 16 / 60) / (48 / 60 - 16 / 60)) < 0.005 and 0.43 <= share <= 0.44
    assert matchups.holes(rows) == set()
    table = Path(__file__).resolve().parent.parent / "data" / "designs" / "tennis-08422b638ce0.json"
    if not table.exists():
        pytest.skip("the newest practice table is not on this machine")
    live = [Matchup(**row) for row in json.loads(table.read_text(encoding="utf-8"))["design"]["matchups"]]
    for player in matchups.players(live):                                         # the file is remade as the game changes
        for row in live:
            if row.player == player and not matchups.is_baseline(row):
                share = matchups.dose(live, {player: 1.0}, row.npc, row.decision, row.option, 0.5)
                assert share is None or 0 <= share <= 1


def test_a_rule_fairness_took_off_never_returns_as_a_rule_in_that_match():
    setup = court()
    current = first_behaviour(setup)
    proposed = copy.deepcopy(current)
    proposed["npcs"]["opponent"]["rules"] = [{"if": [{"fact": "rally_length", "above": 3}], "do": {"shot_type": "lob"}, "why": ""}]
    proposed["npcs"]["opponent"]["decisions"]["shot_type"]["lob"] = {"base": 3.0}
    facts = {"measures": {}, "matchups": []}
    ledger = [{"removed_rules": [{"shot_type": "lob"}], "caps": {"shot_type.lob": 0.4}, "rounds_at": 2}]
    kept, _, refused = A.hold_to_evidence(setup, proposed, current, facts, [], None, A.gone_rules(ledger), A.weight_caps(ledger))
    assert kept["npcs"]["opponent"]["rules"] == [] and kept["npcs"]["opponent"]["decisions"]["shot_type"]["lob"] == {"base": 0.4}
    assert len(refused) == 2                                                      # long after the short no-return window too


@pytest.mark.as_shipped
async def test_over_a_long_match_the_dose_climbs_in_steps_and_does_not_saw(monkeypatch):
    import random
    monkeypatch.setattr(config, "MIN_UPDATE_GAP_SECONDS", 0.0)                    # the rounds here take no time

    class Keen:
        name = "standard"

        async def write(self, facts, budget_seconds, trace):
            behaviour = copy.deepcopy(facts["behaviour"])
            lob = behaviour["npcs"]["opponent"]["decisions"]["shot_type"]["lob"]
            lob["base"] = max(lob["base"], 2.0)                                   # always asks for far too much, never for less
            return {"behaviour": behaviour, "observations": [], "plan": [], "changes": []}

    def dose(match: MatchState) -> float:
        options = match.behaviour["npcs"]["opponent"]["decisions"]["shot_type"]
        return options["lob"]["base"] / sum(weights["base"] for weights in options.values())

    climbed = 0
    for seed in range(10):
        dice = random.Random(seed)
        match, _ = make_match()
        adapter = A.GeminiAdapter(writers={"standard": Keen()})
        seen = [dose(match)]
        for number in range(1, 25):
            share = 0.56 - 0.245 * (dose(match) - 0.25)                           # 56% against the default, less as the lob grows
            add_round(match, number, "player" if dice.random() < share else "opponent")
            update = await adapter.adapt(match, "quick")
            before = dose(match)
            if update is None:                                                    # a code-only check with nothing to send
                seen.append(round(before, 4))
                continue
            assert check_message(match.setup, update) == []
            keep(match, update)
            seen.append(round(dose(match), 4))
            if dose(match) > before + 1e-9:                                       # a step up: after a win, and never a leap
                assert match.rounds[-1]["winner"] == "player" and dose(match) - before <= config.DOSE_MAX_STEP_FAR + 0.01
        moves = [after - before for before, after in zip(seen, seen[1:]) if abs(after - before) > 1e-9]
        turns = sum(1 for one, two in zip(moves, moves[1:]) if (one > 0) != (two > 0))
        assert turns <= 2, (seed, seen)                                           # it climbs and may ease, but it does not saw
        climbed += max(seen) > seen[0]
    assert climbed >= 7                                                           # a player who loses from the start is left alone


@pytest.mark.as_shipped
def test_nothing_estimated_under_the_floor_ships():
    stream = Path(__file__).resolve().parent.parent / "data" / "streams" / "real_forehand_lover_adapt_2_20261121-141349.jsonl"
    if not stream.exists() or not REAL_TABLE.exists():
        pytest.skip("the recording from the real game is not on this machine")
    rows = [json.loads(line) for line in stream.read_text(encoding="utf-8").splitlines() if line.strip()]
    setup = next(row["message"] for row in rows if row["message"].get("type") == "setup")
    table = [Matchup(**row) for row in json.loads(REAL_TABLE.read_text(encoding="utf-8"))["design"]["matchups"]]
    sent = [(row["t"], row["message"]) for row in rows if row["message"].get("type") == "strategy_update"]
    (_, v5), (at6, v6) = [(at, message) for at, message in sent if message["version"] in (5, 6)]
    ends = [row["message"] for row in rows if row["message"].get("type") == "round_end" and row["t"] <= at6]

    match = MatchState(match_id="m_real", setup=setup, design=Design(values=[], behaviour=setup["default_behaviour"], matchups=table),
                       behaviour=copy.deepcopy(v5["behaviour"]), player=PlayerState(values={}, confidence={}), trace=lambda line: None)
    match.rounds = ends
    facts = {"matchups": [row.__dict__ for row in table], "measures": {},
             "values": {A.LIKE + "forehand_lover": 0.9}, "confidence": {A.LIKE + "forehand_lover": 0.9}}
    kept, estimate, _ = A.keep_it_fair(match, copy.deepcopy(v6["behaviour"]), facts)
    assert A.same_play(kept, v5["behaviour"]) or estimate >= config.FAIR_SHARE_FLOOR - 1e-9      # version 6 as sent said about 0%


@pytest.mark.as_shipped
async def test_only_a_look_where_a_writer_answered_sends_a_holding_update_and_never_two_in_a_second():
    class Never:
        name = "standard"

        async def write(self, facts, budget_seconds, trace):
            raise AssertionError("the writer is not asked under the band")

    class Quiet:
        name = "standard"

        async def write(self, facts, budget_seconds, trace):
            return None

    low, lines = make_match(["opponent"] * 6, table=False)                        # the brake is on and the default is in play
    code_only = A.GeminiAdapter(writers={"standard": Never()})
    for _ in range(5):                                                            # the code-only checks between looks send nothing
        assert await code_only.adapt(low, "quick") is None
    assert not any((line.get("data") or {}).get("holding") for line in lines)

    match, lines = make_match(["player", "opponent"], table=False)
    adapter = A.GeminiAdapter(writers={"standard": Quiet()})
    first = await adapter.adapt(match, "quick")
    assert first["changes"] == [] and "holding" in first["plan"][0]              # the writer answered and had nothing
    assert await adapter.adapt(match, "quick") is None                            # the same instant: no second update
    assert "so I am holding" in lines[-1]["about"] or "Nothing new from you" in lines[-1]["about"]


@pytest.mark.as_shipped
async def test_a_writer_never_makes_the_opponent_weaker():
    class Soft:
        name = "standard"

        async def write(self, facts, budget_seconds, trace):
            behaviour = copy.deepcopy(facts["behaviour"])
            behaviour["npcs"]["opponent"]["decisions"]["shot_type"]["lob"] = {"base": 0.25}    # back to the default: easier
            return {"behaviour": behaviour, "observations": [], "plan": ["I will ease off."], "changes": []}

    match, lines = make_match(["player", "player", "opponent", "player", "player"])           # above the band, so the writer is asked
    match.behaviour["npcs"]["opponent"]["decisions"]["shot_type"]["lob"] = {"base": 1.0}       # a counter is in play
    assert A.struggling(match.rounds, 0.5) is None
    update = await A.GeminiAdapter(writers={"standard": Soft()}).adapt(match, "quick")
    assert any("make me easier" in line["about"] for line in lines)               # the writer's ease is refused
    assert update["behaviour"]["npcs"]["opponent"]["decisions"]["shot_type"]["lob"]["base"] >= 1.0   # and nothing got weaker


def test_the_step_cap_grows_with_the_gap(monkeypatch):
    monkeypatch.setattr(config, "DOSE_MAX_STEP", 0.15)
    assert A.step_cap(0.5) == 0.15 and A.step_cap(0.58) == 0.15                   # at the band: the near cap
    assert A.step_cap(0.70) == 0.35 and A.step_cap(0.9) == 0.35                   # far above it: the far cap
    assert round(A.step_cap(0.64), 3) == 0.25                                     # a straight line between


def test_the_step_cap_counts_rules_and_when_weights_at_the_latest_read(monkeypatch):
    monkeypatch.setattr(config, "DOSE_MAX_STEP", 0.15)
    match, _ = make_match(["player", "opponent", "player"])
    facts = A.gather_facts(match)                                                 # comes_to_net reads 0.8
    proposed = copy.deepcopy(match.behaviour)
    opponent = proposed["npcs"]["opponent"]
    opponent["decisions"]["shot_type"]["drop"] = {"base": 0.25, "when": {"comes_to_net": 0.9}}     # a big move through a `when`
    wall = {"if": [{"fact": "player_position", "in": ["left_deep", "middle_deep", "right_deep"]},
                   {"value": "comes_to_net", "above": 0.6}], "do": {"position": "left_deep"}, "why": ""}
    opponent["rules"] = [wall]                                                    # on whenever the value holds, and it holds
    assert A.fire_share(match, facts, wall) == config.RULE_FIRE_SHARE             # the value holds; the fact cannot be counted
    shares = A.all_fire_shares(match, facts, proposed)
    assert max(A.decision_moves(match, facts, proposed, shares).values()) > 0.3   # as written: far over the cap

    near = A.limit_steps(match, copy.deepcopy(proposed), facts, None, 0.55)
    assert near["npcs"]["opponent"]["rules"] == []                                # the rule became a weight sized to the cap
    assert near["npcs"]["opponent"]["decisions"]["position"]["left_deep"]["base"] > 0.1
    assert max(A.decision_moves(match, facts, near, shares).values()) <= 0.15 + 0.006
    far = A.limit_steps(match, copy.deepcopy(proposed), facts, None, 0.75)       # a player far above the band gets bigger steps
    moved = A.decision_moves(match, facts, far, shares)
    assert 0.15 < max(moved.values()) <= 0.35 + 0.006

    often = {"if": [{"fact": "player_last_side", "is": "forehand"}], "do": {"position": "left_deep"}, "why": ""}
    match.setup["facts"]["player_last_side"] = ["forehand", "backhand"]
    assert A.counted_field(match.setup, "player_last_side") == ("shot", "side")
    assert A.fire_share(match, facts, often) == 0.75                              # 9 of the player's 12 shots were forehands


async def test_far_above_the_band_the_dial_moves_beside_what_the_writer_added():
    match, _ = make_match(["player"] * 6)
    match.design.dials = SPEED_DIAL
    update = await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]))).adapt(match, "quick")
    assert update["writer"] == "standard" and update["settings"] == {"opponent_speed": 0.94}
    dial = next(change for change in update["changes"] if change["where"] == "settings.opponent_speed")
    assert dial["why"] == "You won 6 of 6, so opponent speed also goes up." and dial["kind"] == "fairness"
    assert any(change["where"] == "opponent.rules" for change in update["changes"])
    assert check_message(match.setup, update) == []


async def test_the_writer_is_not_asked_again_until_the_player_does_something_new():
    match, lines = make_match(["player", "player", "opponent", "player"])
    calls: list[dict[str, Any]] = []
    adapter = A.GeminiAdapter(ask=fake_ask(reply(), calls=calls))
    await adapter.adapt(match, "quick")
    assert len(calls) == 1
    await adapter.adapt(match, "quick")                                           # no player event since that call started
    assert len(calls) == 1 and "Nothing new from you since my last look" in lines[-1]["about"]
    add_round(match, 5, "player")                                                 # the player plays on
    await adapter.adapt(match, "quick")
    assert len(calls) == 2


async def test_two_eases_never_go_out_with_fewer_than_two_played_rounds_between_them(monkeypatch):
    monkeypatch.setattr(config, "FAIR_EASE_GAP_ROUNDS", 2)
    match, lines = make_match(["player", "opponent", "opponent", "opponent"])
    match.design.dials = SPEED_DIAL
    two_rules(match)
    adapter = A.GeminiAdapter(ask=fake_ask(reply()))
    first = await adapter.adapt(match, "quick")
    assert first["writer"] == "fairness" and "settings" not in first              # one ease does one thing: a rule, no dial
    keep(match, first)
    assert await adapter.adapt(match, "quick") is None                            # no played round since
    add_round(match, 5, "opponent")
    assert await adapter.adapt(match, "quick") is None                            # one played round since: still waiting
    match.rounds.append(round_end(6, "opponent"))                                 # no event from the player in it: it counts all the same
    second = await adapter.adapt(match, "quick")
    assert second is not None and second["writer"] == "fairness"                  # two played rounds since: the next ease


@pytest.mark.as_shipped
async def test_a_step_held_after_a_lost_round_goes_out_after_the_next_win_with_no_second_call(monkeypatch):
    monkeypatch.setattr(config, "MIN_UPDATE_GAP_SECONDS", 0.0)                    # the looks here follow at once
    match, lines = make_match(["player", "player", "player", "opponent"])
    calls: list[dict[str, Any]] = []
    adapter = A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]), calls=calls))
    held = await adapter.adapt(match, "quick")
    assert held["changes"] == [] and held["plan"][0] == "You lost the last round, so I am holding my next step."
    assert adapter.waiting(match.match_id) and len(calls) == 1
    assert await adapter.adapt(match, "quick") is None and len(calls) == 1        # still waiting: nothing sent, nobody asked
    add_round(match, 5, "player")
    out = await adapter.adapt(match, "quick")
    assert out["changes"] and len(calls) == 1 and not adapter.waiting(match.match_id)   # the kept step, with no second call
    assert out["kept"] is True and all({"value", "count", "of"} <= set(line) for line in out["seen"] if "event" in line)
    assert not any("holding" in line for line in out["plan"])

    match, _ = make_match(["player", "player", "player", "opponent"])             # a kept step does not live for ever
    adapter = A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]), calls=calls))
    await adapter.adapt(match, "quick")
    for number in (5, 6, 7):
        add_round(match, number, "opponent")
    assert len(calls) == 2
    await adapter.adapt(match, "quick")
    assert len(calls) == 2 and not adapter.waiting(match.match_id)                # back inside a fair share: the kept step is dropped, nobody is asked


async def test_the_writer_is_told_how_the_player_wins_rounds():
    from server import measures
    match, _ = make_match(["player", "player", "opponent", "player", "player"])
    for round_end_message in match.rounds:
        round_end_message["how"] = "not_reached" if round_end_message["winner"] == "player" else "error"
    for event in match.events:
        event["data"]["lands"] = "right_deep" if event["data"]["side"] == "backhand" else "left_deep"   # the last shot of a round
    lines = measures.how_won_rounds_end(match.setup, match.rounds, match.events)
    assert lines[0] == "4 of your 4 won rounds ended not_reached."
    assert "Your last shot in those rounds had lands right_deep in 4." in lines
    assert A.gather_facts(match)["measures"]["won_rounds"] == lines
    calls: list[dict[str, Any]] = []
    await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]), calls=calls)).adapt(match, "quick")
    assert "HOW YOU WIN ROUNDS" in calls[0]["prompt"] and "ended not_reached" in calls[0]["prompt"]
    assert measures.how_won_rounds_end(match.setup, match.rounds[:1], match.events) == []     # too few to say


async def test_a_line_that_cites_the_score_is_true_when_it_is_sent():
    match, _ = make_match(["opponent", "opponent"])
    assert A.score_holds("I will ease off since you won 0 of 2 rounds.", match)
    for number, winner in ((3, "player"), (4, "player"), (5, "player")):          # rounds end while the writer works
        add_round(match, number, winner)
    assert not A.score_holds("I will ease off since you won 0 of 2 rounds.", match)     # 3 of 5 by now, 2 of the last 2
    assert A.score_holds("You won 3 of 5 rounds so far.", match) and A.score_holds("You lost 2 of the last 5 rounds.", match)
    assert A.score_holds("Your forehand won 21 of 29 times.", match)             # not a count of rounds: left alone

    class Stale:
        name = "standard"

        async def write(self, facts, budget_seconds, trace):
            behaviour = copy.deepcopy(facts["behaviour"])
            behaviour["npcs"]["opponent"]["decisions"]["shot_type"]["lob"] = {"base": 0.4}
            return {"behaviour": behaviour, "observations": ["You won 0 of 2 rounds."], "plan": ["You won 0 of 2 rounds, so I lob."],
                    "changes": []}

    update = await A.GeminiAdapter(writers={"standard": Stale()}).adapt(match, "quick")
    assert update is not None and not any("0 of 2" in line for line in update["observations"] + update["plan"])



def test_the_step_is_sized_by_the_seconds_since_the_last_one_that_added_strength(monkeypatch):
    monkeypatch.setattr(config, "DOSE_MAX_STEP", 0.15)
    monkeypatch.setattr(config, "DOSE_SECONDS", 10.0)
    monkeypatch.setattr(config, "DOSE_MIN_STEP", 0.05)
    assert A.step_cap(0.5, None) == 0.15                                          # the first landing gets the whole cap
    assert A.step_cap(0.5, 5.0) == pytest.approx(0.075)                           # half the time, half the step
    assert A.step_cap(0.5, 1.0) == 0.05                                           # never under the smallest step
    assert A.step_cap(0.5, 60.0) == 0.15                                          # never over the cap


def test_a_look_written_against_an_older_play_is_set_on_the_play_in_hand():
    match, _ = make_match(["player", "player"])
    written = copy.deepcopy(match.behaviour)
    npc = next(iter(written["npcs"]))
    decision = next(iter(written["npcs"][npc]["decisions"]))
    first, second = list(written["npcs"][npc]["decisions"][decision])[:2]
    proposed = copy.deepcopy(written)
    proposed["npcs"][npc]["decisions"][decision][first] = {"base": 0.9}
    in_play = copy.deepcopy(written)                                              # another look landed in between
    in_play["version"] = int(written.get("version", 0) or 0) + 1
    in_play["npcs"][npc]["decisions"][decision][second] = {"base": 0.7}
    landed = A.onto_play(written, proposed, in_play)
    assert landed["npcs"][npc]["decisions"][decision][first] == {"base": 0.9}     # what this look asked for is set
    assert landed["npcs"][npc]["decisions"][decision][second] == {"base": 0.7}    # and the newer play is kept
    assert A.onto_play(written, proposed, landed) == landed                       # the same conclusion twice adds nothing


@pytest.mark.as_shipped
async def test_a_real_update_has_short_counted_lists_and_a_holding_update_says_so(monkeypatch):
    monkeypatch.setattr(config, "MIN_UPDATE_GAP_SECONDS", 0.0)
    match, _ = make_match(["player", "player", "opponent", "player"])
    update = await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]))).adapt(match, "quick")
    if update is not None and update["changes"]:
        assert "holding" not in update and 1 <= len(update["observations"]) <= 3 and len(update["plan"]) <= 3
        assert all(len(line.split()) <= 10 and any(char.isdigit() for char in line) for line in update["observations"])
        assert all(len(line.split()) <= 8 for line in update["plan"])
    quiet, _ = make_match(["player", "opponent"], table=False)
    held = await A.GeminiAdapter(ask=fake_ask(reply())).adapt(quiet, "quick")
    assert held is not None and held["holding"] is True and held["changes"] == []
    assert check_message(quiet.setup, held) == []


async def test_the_dial_goes_second_beside_a_change_of_play_and_a_switch_keeps_it_out(monkeypatch):
    match, _ = make_match(["player"] * 6)
    match.design.dials = SPEED_DIAL
    update = await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]))).adapt(match, "quick")
    wheres = [change["where"] for change in update["changes"]]
    assert wheres.index("settings.opponent_speed") > wheres.index("opponent.rules")   # the change of play first, the dial second
    monkeypatch.setattr(config, "FAIR_DIAL_JOINS", False)
    match, _ = make_match(["player"] * 6)
    match.design.dials = SPEED_DIAL
    update = await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]))).adapt(match, "quick")
    assert update is not None and "settings" not in update                            # switched off: the dial never joins


@pytest.mark.as_shipped
async def test_the_last_eight_rounds_decide_and_an_ease_takes_the_latest_step_back(monkeypatch):
    monkeypatch.setattr(config, "MIN_UPDATE_GAP_SECONDS", 0.0)
    assert A.blended_share([round_end(number, "player") for number in (1, 2)], 0.5) == pytest.approx((2 + 0.5 * 6) / 8)
    match, lines = make_match(["player", "player", "player"])
    calls: list[dict[str, Any]] = []
    adapter = A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]), calls=calls))
    first = await adapter.adapt(match, "quick")
    assert first["changes"] and "holding" not in first and len(calls) == 1          # above 60% of the window: a real step
    assert [line["text"] for line in first["seen"]] == first["observations"]
    assert [line["text"] for line in first["changing"]] == first["plan"] and all("where" in line for line in first["changing"])
    assert "won" not in first["observations"][0].split()[:3] and check_message(match.setup, first) == []
    keep(match, first)
    add_round(match, 4, "player")
    more = await adapter.adapt(match, "quick")                                       # one round since: the last step has no proof yet
    assert more is None or more["changes"] == []
    assert adapter.waiting(match.match_id)                                           # the next step is kept ready meanwhile
    for number in (5, 6, 7, 8):
        add_round(match, number, "opponent")
    asked = len(calls)
    eased = await adapter.adapt(match, "quick")                                      # 1 of the 5 rounds since the step: it was too much
    assert eased["writer"] == "fairness" and len(calls) == asked                     # in code, with no model call
    assert eased["plan"][0].startswith("That was too much, I am backing off") and not adapter.waiting(match.match_id)
    assert eased["behaviour"]["npcs"]["opponent"]["rules"] == [] and check_message(match.setup, eased) == []


def test_a_setting_moves_with_a_reason_said_by_the_opponent_as_a_percent():
    up = {"setting": "opponent_speed", "easier": False, "won": 9, "counted": 12}
    assert A.dial_reason(up) == "I raise opponent speed a step, because you win 75% of rounds."
    assert A.dial_reason({**up, "easier": True, "won": 3, "counted": 10}) == "I lower opponent speed a step, because you win only 30% of rounds."


@pytest.mark.as_shipped
async def test_the_first_real_update_goes_out_at_an_even_share_and_later_ones_need_the_high_mark(monkeypatch):
    monkeypatch.setattr(config, "MIN_UPDATE_GAP_SECONDS", 0.0)
    match, _ = make_match(["opponent", "player"], table=False)                       # 1 of 2: the window reads one half
    assert A.winning(match.rounds, None) is None and A.first_step_due(match, [], None)
    adapter = A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE])))
    first = await adapter.adapt(match, "quick")
    assert first["changes"] and "holding" not in first                               # the first step does not wait for luck
    keep(match, first)
    for number, winner in ((3, "opponent"), (4, "player"), (5, "opponent"), (6, "player")):
        add_round(match, number, winner)
    later = await adapter.adapt(match, "quick")                                      # 3 of 6: inside the band, so it holds
    assert later is None or later["changes"] == []


@pytest.mark.as_shipped
async def test_on_an_ease_the_dial_goes_home_before_any_choice_of_play_is_taken_back(monkeypatch):
    monkeypatch.setattr(config, "MIN_UPDATE_GAP_SECONDS", 0.0)
    match, _ = make_match(["player"] * 6)
    match.design.dials = SPEED_DIAL
    calls: list[dict[str, Any]] = []
    adapter = A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE]), calls=calls))
    first = await adapter.adapt(match, "quick")
    assert first["settings"] == {"opponent_speed": 0.94}                             # far above: the dial joined the step
    keep(match, first)
    play = copy.deepcopy(match.behaviour["npcs"])
    for number in (7, 8, 9, 10):
        add_round(match, number, "opponent")
    back = await adapter.adapt(match, "quick")
    assert back["writer"] == "fairness" and back["settings"] == {"opponent_speed": 0.85} and len(calls) == 1
    assert [change["where"] for change in back["changes"]] == ["settings.opponent_speed"]
    assert back["plan"][0].startswith("I lower opponent speed a step, because you win only")
    assert back["plan"][1] == "It is back where we began." and "I keep watching how you play." not in back["plan"]
    for line in back["seen"]:                                                        # only a real count of rounds is tagged as one
        assert (line.get("field") == "round_end") == ("event" not in line) and ("round" in line["text"] or "event" in line)
    assert len({line["value"] for line in back["seen"] if "value" in line}) == len([line for line in back["seen"] if "value" in line])
    assert back["behaviour"]["npcs"] == play and check_message(match.setup, back) == []      # the play is untouched so far
    keep(match, back)
    for number in (11, 12):
        add_round(match, number, "opponent")
    eased = await adapter.adapt(match, "quick")                                      # the dial is home: now the play eases
    assert eased["writer"] == "fairness" and "settings" not in eased and eased["behaviour"]["npcs"] != play
    assert eased["plan"][0].startswith("That was too much, I am backing off") and eased["plan"][1].startswith("You win only ")
    assert "%" in eased["plan"][1] and eased["plan"] != back["plan"] and check_message(match.setup, eased) == []


def test_a_plan_line_is_tagged_with_the_change_it_speaks_for_or_not_at_all():
    changes = [{"where": "opponent.shot_type.slice", "from": {"base": 0.2}, "to": {"base": 0.5}, "why": "You hit topspin on 8 of 10."},
               {"where": "opponent.aim.right_short", "from": {"base": 0.2}, "to": {"base": 0.5}, "why": "You stay deep."},
               {"where": "settings.opponent_speed", "from": 0.85, "to": 0.94, "why": "I raise opponent speed a step."}]
    assert A.paired("I will pull you short to the right.", changes) == "opponent.aim.right_short"
    assert A.paired("I will use more low slice shots.", changes) == "opponent.shot_type.slice"
    assert A.paired("I raise opponent speed a step.", changes) == "settings.opponent_speed"
    assert A.paired("I will make this harder for you.", changes) is None             # not sure, so no tag at all
    assert A.paired("Anything at all.", changes[:1]) == "opponent.shot_type.slice"   # one change: every line is about it


def test_each_ease_of_a_setting_says_what_is_different_this_time():
    step = {"setting": "opponent_speed", "easier": True, "won": 2, "counted": 8, "from": 0.76, "to": 0.67, "start": 0.85}
    assert A.dial_reason({**step, "again": True}) == "I lower opponent speed again, because you win only 25% of rounds."
    assert A.dial_place(step) == "It is 2 steps under where we began."
    assert A.dial_place({**step, "from": 0.94, "to": 0.85}) == "It is back where we began."
    assert A.dial_place({**step, "from": 0.67, "to": 0.65, "limit": True}) == "That is as low as it goes."


def with_world(match: MatchState) -> MatchState:
    match.setup["settings"]["obstacles"] = {
        "about": "Extra obstacles placed on the court for the next round: up to 2 spot names.",
        "options": ["net_left", "net_right", "baseline_mid"], "now": "none", "max_picks": 2}
    return match


async def test_a_writer_may_change_a_world_setting_to_answer_a_habit():
    from server.contract import check_message
    match, lines = make_match(["player"])
    with_world(match)
    calls: list[dict[str, Any]] = []
    world = [{"setting": "obstacles", "picks": ["net_left", "net_left", "baseline_mid"],
              "why": "You came in on 9 of 12 shots.", "expect": "Coming in should win you fewer points.", "habit": "h1"}]
    update = await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE], world=world), calls=calls)).adapt(match, "quick")
    assert update is not None and update["settings"] == {"obstacles": ["net_left", "baseline_mid"]}
    change = next(change for change in update["changes"] if change["where"] == "settings.obstacles")
    assert change["from"] == [] and change["to"] == ["net_left", "baseline_mid"] and change["why"]
    assert check_message(match.setup, update) == []
    assert "Extra obstacles placed on the court" in calls[0]["prompt"]           # the model reads what the setting does
    assert "world" in calls[0]["schema"]["properties"]
    assert "opponent_speed" not in calls[0]["schema"]["properties"]["world"]["items"]["properties"]["setting"]["enum"]


async def test_a_world_setting_that_breaks_the_contract_is_dropped():
    match, _ = make_match(["player"])
    with_world(match)
    world = [{"setting": "obstacles", "picks": ["net_left", "net_right", "baseline_mid"], "why": "x", "expect": "y", "habit": "h1"}]
    update = await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE], world=world))).adapt(match, "quick")
    assert update is not None and "settings" not in update
    assert not any(change["where"].startswith("settings.") for change in update["changes"])
    numeric = [{"setting": "opponent_speed", "picks": ["net_left"], "why": "x", "expect": "y", "habit": "h1"}]
    update = await A.GeminiAdapter(ask=fake_ask(reply(new_rules=[LOB_RULE], world=numeric))).adapt(match, "quick")
    assert update is not None and "settings" not in update
