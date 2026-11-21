"""The designer, with a fake model and a fake game. No network."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from server import config, matchups
from server import designer as D
from server.contract import check_behaviour, check_message
from server.models_client import ModelError, ModelReply

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"


def load(game: str) -> dict[str, Any]:
    return json.loads((EXAMPLES / game / "setup.json").read_text(encoding="utf-8"))


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


TENNIS_REPLY = {
    "values": [
        {"name": "Comes To Net", "about": "Comes up to the net", "type": "noul",
         "instructions": "From the counts of the player's shot events, was `from` a short zone more than once?",
         "levels": [], "options": [], "value_of": ""},
        {"name": "favours_forehand", "about": "Leans on the forehand", "type": "score",
         "instructions": "From the counts of the player's shot events, how often was `side` equal to `forehand`?",
         "levels": ["Never", "About half", "Almost always"], "options": [], "value_of": ""},
        {"name": "goes_left", "about": "Aims left", "type": "choice",
         "instructions": "Where do most of the player's shots land?",
         "levels": [], "options": [{"key": "left", "meaning": "Left zones"}, {"key": "other", "meaning": "Anywhere else"}],
         "value_of": "left"},
        {"name": "broken", "about": "No question", "type": "choice", "instructions": "x", "levels": [], "options": [], "value_of": ""},
    ],
    "personas": [
        {"name": "forehand_lover", "about": "Leans on the forehand.", "plays": [
            {"pick": "shot.side=forehand", "share": 0.7},
            {"pick": "shot.lands=left_deep", "share": 0.5},
            {"pick": "shot.nothing=here", "share": 0.5},
        ]},
        {"name": "net_rusher", "about": "Comes to the net early.", "plays": [{"pick": "shot.from=middle_short", "share": 0.6}]},
        {"name": "even", "about": "No clear habit.", "plays": []},
    ],
    "weights": [
        {"option": "opponent.shot_type.lob", "value": "comes_to_net", "weight": 0.6},
        {"option": "opponent.shot_type.lob", "value": "not_a_value", "weight": 0.6},
        {"option": "opponent.position.left_deep", "value": "goes_left", "weight": 3},
    ],
    "notes": ["Net play decides whether a lob pays."],
}


def fake_ask(reply: dict[str, Any], calls: list[dict[str, Any]] | None = None):
    async def ask(model, thinking, prompt, schema, *, system=None, timeout=120.0):
        if calls is not None:
            calls.append({"model": model, "thinking": thinking, "prompt": prompt, "schema": schema})
        return ModelReply(data=reply, model=model, thinking=thinking, ms=12.0)
    return ask


async def failing_ask(*args: Any, **kwargs: Any):
    raise ModelError("no answer")


class FakeGame:
    """Stands in for the game's practice mode: lobs beat the net rusher, nothing else matters."""

    def __init__(self) -> None:
        self.runs: list[tuple[Any, int, dict[str, Any]]] = []

    async def run(self, behaviour, player, rounds):
        self.runs.append((player, rounds, behaviour))
        name = player["name"] if isinstance(player, dict) else player
        lob = behaviour["npcs"]["opponent"]["decisions"]["shot_type"]["lob"]["base"]
        wins = 15 if (name == "net_rusher" and lob == 1) else 8
        return {"type": "practice_result", "player": name, "rounds": rounds,
                "wins": {"player": rounds - wins, "opponent": wins}, "stats": {}}


async def test_design_from_model_reply_fits_the_contract():
    setup, calls, lines = court(), [], []
    design = await D.GeminiDesigner(ask=fake_ask(TENNIS_REPLY, calls)).design(setup, None, lines.append)

    names = [spec.name for spec in design.values]
    # The model's values here count nothing and name no picture, so they make way for ones built from the setup.
    assert names[0] == "share_of_side_forehand" and not {"comes_to_net", "favours_forehand", "goes_left"} & set(names)
    assert any("wrote 3 of the questions and 3 practice players" in note for note in design.notes)
    assert {"like_forehand_lover", "like_net_rusher", "like_even"} <= set(names)
    like = next(spec for spec in design.values if spec.name == "like_net_rusher")
    assert like.question["type"] == "choice" and like.question["value_of"] == "net_rusher"
    assert set(like.question) == {"type", "instructions", "criteria", "value_of"}

    opponent = design.behaviour["npcs"]["opponent"]["decisions"]
    assert design.behaviour["version"] == 1
    # comes_to_net and goes_left were dropped (they count nothing and name no picture), so no weight leans on them.
    assert opponent["shot_type"]["lob"] == {"base": 0.25}
    assert "goes_left" not in (opponent["position"]["left_deep"].get("when") or {})
    assert check_behaviour(setup, design.behaviour, names, complete=True) == []

    assert calls[0]["model"] == D.config.DESIGNER_MODEL and calls[0]["thinking"] == D.config.DESIGNER_THINKING
    assert [line["status"] for line in lines] == ["start", "done", "done", "step"]   # the second ask for missing numbers, then the dials
    assert design.matchups == [] and design.timings == {}


async def test_design_never_fails_when_the_model_does():
    for game in ("tennis", "csgo"):
        setup, lines = load(game), []
        design = await D.GeminiDesigner(ask=failing_ask).design(setup, None, lines.append)
        names = [spec.name for spec in design.values]
        assert names and all(spec.question["type"] in ("score", "choice", "noul") for spec in design.values)
        assert check_behaviour(setup, design.behaviour, names, complete=True) == []
        assert any(line["status"] == "error" for line in lines)
        assert any("built in code alone" in note for note in design.notes)


async def test_first_behaviour_is_even_without_a_default():
    setup = court()
    del setup["default_behaviour"]
    behaviour = D.first_behaviour(setup)
    assert behaviour["npcs"]["opponent"]["decisions"]["shot_type"] == {"flat": {"base": 0.333}, "lob": {"base": 0.333}, "drop": {"base": 0.333}}
    assert behaviour["npcs"]["opponent"]["rules"] == [] and behaviour["version"] == 1


async def test_playtest_fills_the_matchup_table_and_traces_each_result(monkeypatch):
    monkeypatch.setattr(D, "PLAYTEST_ROUNDS", 20)
    setup, lines, game = court(), [], FakeGame()
    setup["practice"] = {"players": {"baseliner": {"about": "Stays back."}}, "stand_in": True}
    design = await D.GeminiDesigner(ask=fake_ask(TENNIS_REPLY)).design(setup, game, lines.append)

    players = ["baseliner", "forehand_lover", "net_rusher", "even"]
    options = 3 + 3
    played = {run[0] if isinstance(run[0], str) else run[0].get("name") for run in game.runs}  # plus any added main-choice player
    assert set(players) <= played and len(game.runs) == len(played) * (options + 1)
    assert game.runs[0][0] == "baseliner"                       # the game's own scripted player goes by name
    assert [run[0] for run in game.runs[:7]] == ["baseliner"] * 7   # no model needed for these, so they go first
    persona = game.runs[7][0]
    assert persona["name"] == "forehand_lover"
    assert persona["plays"]["shot"]["side"] == {"forehand": 0.7, "backhand": 0.3}
    assert abs(sum(persona["plays"]["shot"]["lands"].values()) - 1) < 0.01
    run = {"type": "practice_run", "match_id": setup["match_id"], "run_id": "p1", "player": persona, "rounds": 20, "behaviour": game.runs[7][2]}
    assert check_message(setup, run) == []

    base = matchups.baseline(design.matchups, "net_rusher", "opponent")
    assert base is not None and (base.npc_wins, base.rounds) == (8, 20)
    found = matchups.counters(design.matchups, "net_rusher")
    assert [(c["decision"], c["option"]) for c in found] == [("shot_type", "lob")]
    assert matchups.counters(design.matchups, "even") == []

    about = [line["about"] for line in lines if line["stage"] == "playtest"]
    assert "lob for shot type against net rusher: opponent won 15 of 20." in about
    assert "First behaviour against even: opponent won 8 of 20." in about
    assert D.STAND_IN_NOTE in design.notes
    assert any(note.startswith("Playtest: lob for shot type against net rusher") for note in design.notes)
    assert design.timings["seconds_per_practice_round"] >= 0
    assert {"like_baseliner", "like_net_rusher"} <= {spec.name for spec in design.values}


async def test_playtest_survives_a_game_that_fails():
    class BrokenGame:
        async def run(self, behaviour, player, rounds):
            raise RuntimeError("socket closed")

    lines: list[dict[str, Any]] = []
    design = await D.GeminiDesigner(ask=fake_ask(TENNIS_REPLY)).design(court(), BrokenGame(), lines.append)
    assert design.matchups == []
    assert any("Three practice runs failed" in line["about"] for line in lines)


def test_plan_runs_stays_inside_the_caps(monkeypatch):
    monkeypatch.setattr(D, "PLAYTEST_ROUNDS", 20)
    monkeypatch.setattr(D, "PLAYTEST_MIN_ROUNDS", 8)
    monkeypatch.setattr(D, "PLAYTEST_MAX_RUNS", 50)
    monkeypatch.setattr(D, "PLAYTEST_MAX_ROUNDS", 400)
    assert D.plan_runs(10) == (10, 20)
    assert D.plan_runs(40) == (40, 10)       # fewer rounds a run before fewer runs
    runs, rounds = D.plan_runs(500)
    assert rounds == 8 and runs * rounds <= 400


def prompt_picks(setup):
    """The picks the designer's prompt allows, from its "written exactly as one of:" line."""
    line = D._prompt(setup).split("written exactly as one of: ", 1)[1].split("\n", 1)[0]
    return [pick.strip() for pick in line.rstrip(".").split(", ")]


def test_schema_has_no_enum_of_every_pick():
    schema = json.dumps(D._schema(court()))
    assert "shot.side=forehand" not in schema  # an enum of every pick made the schema too big to serve


def test_schema_names_only_what_the_game_declared():
    schema = D._schema(court())
    picks = prompt_picks(court())  # listed in the prompt and checked in code, so the schema stays small enough to serve
    assert "shot.side=forehand" in picks and "shot.lands=left_deep" in picks and len(picks) == 2 + 6 + 6
    options = schema["properties"]["weights"]["items"]["properties"]["option"]["enum"]
    assert options == sorted(D.option_ids(court()))


async def test_settings_reach_the_design_prompt_only_as_the_dials_question():
    calls: list[dict[str, Any]] = []
    await D.GeminiDesigner(ask=fake_ask(TENNIS_REPLY, calls)).design(court(), None, lambda line: None)
    before, _, question = calls[0]["prompt"].partition("5. dials")
    assert "opponent_speed" not in before and "Write five things." in before
    assert "opponent_speed" in question and "How fast the opponent moves." in question
    dials = calls[0]["schema"]["properties"]["dials"]["items"]["properties"]
    assert dials["setting"]["enum"] == ["opponent_speed"] and dials["harder"]["enum"] == ["up", "down", "neither"]

    # A game with no number settings is not asked about dials at all.
    setup = court()
    setup["settings"] = {"surface": {"about": "What the court is made of.", "options": ["clay", "grass"], "now": "clay"}}
    assert "dials" not in D._schema(setup)["properties"]
    assert "Write four things." in D._prompt(setup) and "5. dials" not in D._prompt(setup)


async def test_the_model_marks_the_dials_and_the_design_keeps_its_personas():
    setup = court()
    setup["settings"]["rally_clock"] = {"about": "Seconds the player has to hit.", "min": 1, "max": 5, "now": 3}
    setup["settings"]["crowd_noise"] = {"about": "How loud the crowd is.", "min": 0, "max": 1, "now": 0.5}
    answer = {**TENNIS_REPLY, "dials": [
        {"setting": "opponent_speed", "harder": "up"},
        {"setting": "rally_clock", "harder": "down"},
        {"setting": "crowd_noise", "harder": "neither"},      # not a difficulty setting, so it never moves
        {"setting": "made_up", "harder": "up"},               # not a setting of this game
    ]}
    lines: list[dict[str, Any]] = []
    design = await D.GeminiDesigner(ask=fake_ask(answer)).design(setup, None, lines.append)
    assert design.dials == [{"setting": "opponent_speed", "harder": "up"}, {"setting": "rally_clock", "harder": "down"}]
    assert design.personas and all({"name", "about", "plays"} <= set(persona) for persona in design.personas)
    assert {"like_" + persona["name"] for persona in design.personas} <= {spec.name for spec in design.values}
    said = (f"Fairness dials, marked by {config.DESIGNER_MODEL}: opponent speed (harder when raised), "
            "rally clock (harder when lowered). Not marked: crowd noise.")
    assert said in design.notes and lines[-1]["about"] == said and lines[-1]["stage"] == "designer"


async def test_dials_named_by_hand_fill_in_only_when_the_model_marks_none(monkeypatch):
    setup = court()
    lines: list[dict[str, Any]] = []
    design = await D.GeminiDesigner(ask=failing_ask).design(setup, None, lines.append)
    assert design.dials == [] and D.GeminiDesigner(ask=failing_ask).quick(setup).dials == []    # code alone marks none
    assert lines[-1]["about"] == (f"No setting is a fairness dial: {config.DESIGNER_MODEL} marked none and none "
                                  "was named by hand. Not marked: opponent speed.")

    monkeypatch.setenv("NPC_FAIRNESS_DIALS", "opponent_speed:up, made_up:down, opponent_speed:sideways")
    marked = [{"setting": "opponent_speed", "harder": "up"}]
    assert (await D.GeminiDesigner(ask=failing_ask).design(setup, None, lambda line: None)).dials == marked
    assert D.GeminiDesigner(ask=failing_ask).quick(setup).dials == marked
    silent = {**TENNIS_REPLY, "dials": [{"setting": "opponent_speed", "harder": "neither"}]}
    lines.clear()
    assert (await D.GeminiDesigner(ask=fake_ask(silent)).design(setup, None, lines.append)).dials == marked
    assert lines[-1]["about"] == "Fairness dials, named by hand in NPC_FAIRNESS_DIALS: opponent speed (harder when raised)."
    # The model's own answer wins when there is one.
    answer = {**TENNIS_REPLY, "dials": [{"setting": "opponent_speed", "harder": "down"}]}
    design = await D.GeminiDesigner(ask=fake_ask(answer)).design(setup, None, lambda line: None)
    assert design.dials == [{"setting": "opponent_speed", "harder": "down"}]


def slow_ask(reply: dict[str, Any], seconds: float):
    async def ask(model, thinking, prompt, schema, *, system=None, timeout=120.0):
        await asyncio.sleep(seconds)
        return ModelReply(data=reply, model=model, thinking=thinking, ms=seconds * 1000)
    return ask


def practice_court() -> dict[str, Any]:
    setup = court()
    setup["practice"] = {"players": {"net_rusher": {"about": "Comes to the net early."}, "even": {"about": "No clear habit."}}}
    return setup


async def test_practice_mode_waits_for_the_model_while_practice_runs(monkeypatch):
    monkeypatch.setattr(D, "PLAYTEST_ROUNDS", 20)
    setup, lines, game = practice_court(), [], FakeGame()
    seen: list[int] = []

    async def ask(model, thinking, prompt, schema, *, system=None, timeout=120.0):
        await asyncio.sleep(0.2)
        seen.append(len(game.runs))                                 # how much practice was done before the model answered
        return ModelReply(data=TENNIS_REPLY, model=model, thinking=thinking, ms=200.0)

    designer = D.GeminiDesigner(ask=ask)
    design = await designer.design(setup, game, lines.append)
    assert seen[0] == 14 and len(seen) == 2                         # both scripted players, all options, before the answer;
    #                                                                 the second call asks for the numbers players lacked
    names = [spec.name for spec in design.values]
    assert names[0] == "share_of_side_forehand" and "goes_left" not in names
    assert {"like_net_rusher", "like_even", "like_forehand_lover"} <= set(names)
    assert {"net_rusher", "even", "forehand_lover"} <= set(matchups.players(design.matchups))   # the model's players were playtested too
    assert len(game.runs) >= 21
    assert not any("built in code alone" in note for note in design.notes)
    assert check_behaviour(setup, design.behaviour, names, complete=True) == []
    assert await designer.finish(setup, game, lines.append) is None  # nothing was left behind


async def test_practice_mode_goes_ahead_alone_only_when_the_cap_passes(monkeypatch):
    monkeypatch.setattr(D, "PLAYTEST_ROUNDS", 20)
    monkeypatch.setattr(D, "PRACTICE_WAIT", 0.05)
    setup, lines, game = practice_court(), [], FakeGame()
    designer = D.GeminiDesigner(ask=slow_ask(TENNIS_REPLY, 0.3))

    design = await designer.design(setup, game, lines.append)
    names = [spec.name for spec in design.values]
    assert names[0] == "share_of_side_forehand" and "comes_to_net" not in names
    assert any("which is the cap, so this design was built in code alone" in note for note in design.notes)
    assert any(line["status"] == "error" and "which is the cap" in line["about"] for line in lines)
    assert matchups.counters(design.matchups, "net_rusher")[0]["option"] == "lob"
    assert check_behaviour(setup, design.behaviour, names, complete=True) == []

    full = await designer.finish(setup, game, lines.append)         # the model's design is still there to collect
    assert full is not None
    assert [spec.name for spec in full.values][0] == "share_of_side_forehand"
    assert "forehand_lover" in matchups.players(full.matchups) and "net_rusher" in matchups.players(full.matchups)
    assert await designer.finish(setup, game, lines.append) is None


async def test_setup_says_where_it_is_while_it_waits(monkeypatch):
    monkeypatch.setattr(D, "STEP_SECONDS", 0.02)
    lines: list[dict[str, Any]] = []
    await D.GeminiDesigner(ask=slow_ask(TENNIS_REPLY, 0.1)).design(court(), None, lines.append)
    steps = [line["about"] for line in lines if line["status"] == "step"]
    assert len(steps) >= 2 and "is still writing the questions and practice players" in steps[0]


async def test_the_reason_for_a_failed_design_is_in_the_notes():
    lines: list[dict[str, Any]] = []
    design = await D.GeminiDesigner(ask=failing_ask).design(court(), None, lines.append)
    assert any("failed (ModelError: no answer), so this design was built in code alone" in note for note in design.notes)
    assert any(line["status"] == "error" and "ModelError: no answer" in line["about"] for line in lines)


def test_quick_design_needs_no_model_and_skips_what_the_player_did_not_choose():
    setup = court()
    setup["events"]["shot"]["fields"].update({"result": ["in", "out"], "other_position": ["a", "b"]})
    setup["practice"] = {"players": {"net_rusher": {"about": "Comes to the net early."}, "even": {"about": "No clear habit."}}}
    design = D.GeminiDesigner(ask=failing_ask).quick(setup)
    names = [spec.name for spec in design.values]
    assert names[0] == "share_of_side_forehand" and names[-2:] == ["like_net_rusher", "like_even"]
    assert not any(spec.counts and spec.counts["field"] in ("result", "other_position") for spec in design.values)
    assert design.values[0].about == "Picks forehand often"                         # a habit in a few plain words
    assert [spec.about for spec in design.values if spec.kind == "likeness"] == ["Plays like the net rusher", "Plays like the even"]
    wordy = {**TENNIS_REPLY, "values": [dict(TENNIS_REPLY["values"][0], about="Comes up to the net very early in nearly every single rally")]}
    assert len(D._values(wordy)[0].about.split()) <= 8
    assert check_behaviour(setup, design.behaviour, names, complete=True) == []
    picks = prompt_picks(setup)
    assert not any(pick.startswith(("shot.result", "shot.other_position")) for pick in picks)


def test_practice_players_play_the_main_action_and_never_an_npc_event():
    setup = court()
    sides = ["forehand", "backhand"]
    setup["events"]["shot"]["fields"]["result"] = ["in", "out"]                 # the event that says how it turned out
    setup["events"] = {
        "wind_up": {"about": "The player started a swing.", "fields": {"side": sides, "side_guess": sides}},
        "cover": {"about": "The opponent moved early.", "fields": {"move": ["middle_deep", "left_deep", "middle_short"]}},
        **setup["events"],
    }
    setup["npcs"]["opponent"]["decisions"]["cover"] = {"when": "As the player winds up.", "options": {
        "stay": "Stay put.", "lean": "Lean one way."}}
    assert D.measures.is_npc_event(setup, "cover") and not D.measures.is_npc_event(setup, "shot")
    assert [(event, name) for event, name, _ in D.list_fields(setup)] == [("shot", "side"), ("shot", "from"), ("shot", "lands")]
    for persona in D.plain_personas(setup):
        assert set(persona["plays"]) <= {"shot"}
    assert D.plain_personas(setup)[1]["plays"] == {"shot": {"side": {"forehand": 0.7, "backhand": 0.3}}}
    # An event whose only named field offers one decision's options is the NPC's own, whatever it is called.
    setup["events"]["reposition"] = {"about": "The opponent took a new spot.", "fields": {"spot": ["middle_deep", "left_deep", "middle_short"]}}
    assert D.measures.is_npc_event(setup, "reposition")
    # What the design model puts under any other event is dropped.
    plays = D._plays(setup, [{"pick": "wind_up.side=forehand", "share": 0.9}, {"pick": "cover.move=left_deep", "share": 1},
                             {"pick": "shot.side=forehand", "share": 0.8}])
    assert plays == {"shot": {"side": {"forehand": 0.8, "backhand": 0.2}}}



async def test_a_practice_player_the_game_refuses_is_dropped_and_the_rest_carry_on():
    from server.interfaces import PracticeRefused

    class Picky(FakeGame):
        async def run(self, behaviour, player, rounds):
            name = player["name"] if isinstance(player, dict) else player
            if name in ("ghost", "phantom", "shade", "wraith"):
                raise PracticeRefused("unknown player")
            return await super().run(behaviour, player, rounds)

    setup = practice_court()
    lines: list[dict[str, Any]] = []
    players = ["ghost", "phantom", "shade", "wraith", "net_rusher", "even"]
    rows, _ = await D.run_playtest(setup, D.first_behaviour(setup), players, Picky(), lines.append)
    assert {row.player for row in rows} == {"net_rusher", "even"}
    assert sum("cannot play" in line["about"] for line in lines) == 4             # each refused player is named once
    assert not any("Three practice runs failed" in line["about"] for line in lines)


# ---------------------------------------------------------------- what a value counts, and plays for every practice player

def two_events() -> dict[str, Any]:
    """The court game, with a second player event that repeats a field before the outcome is known."""
    setup = court()
    setup["events"]["shot"]["fields"]["result"] = ["in", "out"]
    setup["events"]["wind_up"] = {"about": "The player began a swing.", "fields": {"side": ["forehand", "backhand"]}}
    setup["events"]["position"] = {"about": "The opponent chose where to wait.",
                                   "fields": {"position": ["middle_deep", "left_deep", "middle_short"]}}
    return setup


def test_a_count_is_checked_against_the_setup_and_moves_to_the_event_with_the_outcome():
    setup = two_events()
    ok = {"event": "shot", "field": "lands", "values": ["left_short", "left_deep"]}
    assert D.usable_counts(setup, ok) == ok
    moved = D.usable_counts(setup, {"event": "wind_up", "field": "side", "values": ["forehand"]})
    assert moved == {"event": "shot", "field": "side", "values": ["forehand"]}    # the doubled field: the event that says the outcome
    assert D.usable_counts(setup, {"event": "position", "field": "position", "values": ["left_deep"]}) is None   # not the player's event
    assert D.usable_counts(setup, {"event": "shot", "field": "power", "values": ["high"]}) is None                # not a list of options
    assert D.usable_counts(setup, {"event": "shot", "field": "nothing", "values": ["x"]}) is None                 # not declared
    assert D.usable_counts(setup, {"event": "shot", "field": "side", "values": ["sideways"]}) is None            # not an option
    assert D.usable_counts(setup, {"event": "shot", "field": "side", "values": ["forehand", "backhand"]}) is None   # every option
    assert D.usable_counts(setup, None) is None and D.usable_counts(setup, {"event": "shot", "field": "side"}) is None


async def test_each_value_says_what_it_counts_and_a_bad_count_is_dropped_but_the_value_kept():
    setup = court()
    reply = json.loads(json.dumps(TENNIS_REPLY))
    reply["values"][0]["counts"] = ["shot.from=left_short", "shot.from=middle_short", "shot.from=right_short"]
    reply["values"][1]["counts"] = ["shot.side=forehand"]
    reply["values"][2]["counts"] = ["shot.lands=left_deep", "shot.side=forehand"]   # two fields: not one share
    calls: list[dict[str, Any]] = []
    design = await D.GeminiDesigner(ask=fake_ask(reply, calls)).design(setup, None, lambda line: None)
    by_name = {spec.name: spec for spec in design.values}
    assert by_name["comes_to_net"].counts == {"event": "shot", "field": "from", "values": ["left_short", "middle_short", "right_short"]}
    assert by_name["favours_forehand"].counts == {"event": "shot", "field": "side", "values": ["forehand"]}
    assert "goes_left" not in by_name     # counts nothing and names no picture, so it is dropped
    assert "share_of_side_forehand" not in by_name            # it counts the same thing, so the model's value and label stay
    assert by_name["favours_forehand"].about == "Leans on the forehand"
    assert [spec.name for spec in D.plain_values(setup)] == ["share_of_side_forehand"]
    assert D.plain_values(setup)[0].counts == by_name["favours_forehand"].counts
    assert all(spec.counts is None for spec in design.values if spec.name.startswith(D.LIKE))
    value_item = calls[0]["schema"]["properties"]["values"]["items"]
    assert "shot.side=forehand" in prompt_picks(setup) and "counts" in value_item["required"]
    assert "- counts:" in calls[0]["prompt"]


async def test_every_practice_player_of_the_game_gets_plays_and_still_runs_by_its_plain_name():
    setup = court()
    setup["practice"] = {"players": {
        "net_charger": {"about": "Comes to the net on most points."},
        "plain_one": {"about": "No habit at all."},
        "lefty": {"about": "Hits to the left.", "plays": {"shot": {"lands": {"left_deep": 1.0}}}},
    }}
    assert D.lacking_plays(setup) == ["net_charger", "plain_one"]
    reply = json.loads(json.dumps(TENNIS_REPLY))
    reply["practice_players"] = [
        {"name": "net_charger", "plays": [{"pick": "shot.from=middle_short", "share": 0.7}, {"pick": "shot.oops=x", "share": 1}]},
        {"name": "plain_one", "plays": []},
    ]
    calls: list[dict[str, Any]] = []
    game = FakeGame()
    design = await D.GeminiDesigner(ask=fake_ask(reply, calls)).design(setup, game, lambda line: None)
    personas = {persona["name"]: persona for persona in design.personas}
    assert round(personas["net_charger"]["plays"]["shot"]["from"]["middle_short"], 2) == 0.7     # written from its about line
    assert round(sum(personas["net_charger"]["plays"]["shot"]["from"].values()), 2) == 1.0 and "oops" not in personas["net_charger"]["plays"]["shot"]
    assert personas["lefty"]["plays"]["shot"]["lands"] == {"left_deep": 1.0}                     # the game's own numbers are kept
    assert "forehand_lover" in personas and "plain_one" in personas      # none written for it, so it gets the others' average
    ran = [player for player, _, _ in game.runs]
    assert "net_charger" in ran and "lefty" in ran                                                # the game's own players run by name
    assert not any(isinstance(player, dict) and player["name"] in setup["practice"]["players"] for player in ran)
    wanted = calls[0]["schema"]["properties"]["practice_players"]
    assert wanted["items"]["properties"]["name"]["enum"] == ["net_charger", "plain_one"] and wanted["minItems"] == 2
    assert "practice_players" in calls[0]["prompt"]
    assert "practice_players" not in D._schema(court())["properties"]                             # nothing asked when there are none


def test_a_design_stored_before_counts_and_plays_still_loads():
    from dataclasses import asdict

    from server.interfaces import Design, ValueSpec
    old = {"name": "favours_forehand", "about": "Leans on the forehand", "question": {"type": "noul", "instructions": "x"}}
    spec = ValueSpec(**old)
    assert spec.counts is None
    new = ValueSpec(**old, counts={"event": "shot", "field": "side", "values": ["forehand"]})
    assert ValueSpec(**asdict(new)) == new                                                        # saved and loaded as it is
    design = Design(values=[spec], behaviour=D.first_behaviour(court()), personas=[{"name": "even", "about": "x", "plays": {}}])
    assert D.practice_personas(court(), None) == [] and design.personas[0]["plays"] == {}
    quick = D.GeminiDesigner(ask=failing_ask).quick(court())
    assert all(spec.counts is None or spec.counts["event"] == "shot" for spec in quick.values)


async def test_every_practice_player_gets_full_numbers_on_every_counted_field():
    setup = court()
    setup["practice"] = {"players": {"net_charger": {"about": "Comes to the net on most points."},
                                     "plain_one": {"about": "No habit at all."}}}
    first = json.loads(json.dumps(TENNIS_REPLY))
    first["values"][0]["counts"] = ["shot.from=left_short", "shot.from=middle_short", "shot.from=right_short"]
    first["values"][1]["counts"] = ["shot.side=forehand"]
    first["practice_players"] = [{"name": "net_charger", "plays": [{"pick": "shot.from=middle_short", "share": 0.7}]},
                                 {"name": "plain_one", "plays": []}]
    second = {"players": [
        {"name": "net_charger", "plays": [{"pick": "shot.side=forehand", "share": 0.55}, {"pick": "shot.from=left_deep", "share": 1}]},
        {"name": "forehand_lover", "plays": [{"pick": "shot.from=middle_deep", "share": 0.8}]},
        {"name": "somebody_else", "plays": [{"pick": "shot.side=forehand", "share": 1}]},
    ]}
    calls: list[dict[str, Any]] = []

    async def ask(model, thinking, prompt, schema, *, system=None, timeout=120.0):
        calls.append({"prompt": prompt, "schema": schema})
        return ModelReply(data=first if len(calls) == 1 else second, model=model, thinking=thinking, ms=10.0)

    design = await D.GeminiDesigner(ask=ask).design(setup, None, lambda line: None)
    fields = D.counted_fields(design.values)
    assert {("shot", "from"), ("shot", "side")} <= set(fields) and len(calls) == 2
    personas = {persona["name"]: persona for persona in design.personas}
    assert {"net_charger", "plain_one", "forehand_lover", "net_rusher", "even"} <= set(personas)
    for persona in personas.values():                                             # a full distribution on every counted field
        for event, field_name in fields:
            shares = persona["plays"][event][field_name]
            assert set(shares) == set(D._field_options(setup, event, field_name)) and abs(sum(shares.values()) - 1) < 0.02
    assert personas["net_charger"]["plays"]["shot"]["side"]["forehand"] == 0.55   # from the second ask
    assert personas["net_charger"]["plays"]["shot"]["from"]["middle_short"] == 0.7   # a field it already had is left alone
    assert personas["forehand_lover"]["plays"]["shot"]["from"]["middle_deep"] == 0.8
    # backhand_first is the player added so that backhand is someone's main choice.
    side = [personas[name]["plays"]["shot"]["side"]["forehand"]
            for name in ("forehand_lover", "net_charger", "backhand_first") if name in personas]
    assert personas["plain_one"]["plays"]["shot"]["side"]["forehand"] == round(sum(side) / len(side), 3)     # the average of the others
    asked = calls[1]["schema"]["properties"]["players"]["items"]["properties"]
    assert {"even", "forehand_lover", "net_charger", "net_rusher", "plain_one"} <= set(asked["name"]["enum"])
    assert all(pick.startswith(("shot.from=", "shot.side=", "shot.lands=")) for pick in asked["plays"]["items"]["properties"]["pick"]["enum"])
    assert "need numbers for some fields" in calls[1]["prompt"]
    assert any("second ask" in note for note in design.notes)


async def test_a_field_every_practice_player_plays_the_same_way_is_not_counted():
    setup = court()
    reply = json.loads(json.dumps(TENNIS_REPLY))
    reply["values"][0]["counts"] = ["shot.from=left_short", "shot.from=middle_short", "shot.from=right_short"]
    reply["values"][1]["counts"] = ["shot.side=forehand"]
    still = [{"pick": "shot.from=middle_deep", "share": 1.0}]                     # everybody stands in the same place
    reply["personas"] = [
        {"name": "forehand_lover", "about": "Leans on the forehand.", "plays": [{"pick": "shot.side=forehand", "share": 0.8}, *still]},
        {"name": "backhand_lover", "about": "Leans on the backhand.", "plays": [{"pick": "shot.side=forehand", "share": 0.2}, *still]},
        {"name": "even", "about": "No clear habit.", "plays": [{"pick": "shot.side=forehand", "share": 0.5}, *still]},
    ]
    design = await D.GeminiDesigner(ask=fake_ask(reply)).design(setup, None, lambda line: None)
    names = [spec.name for spec in design.values]
    assert "comes_to_net" not in names and "favours_forehand" in names           # where they stand tells nobody apart
    assert D.flat_fields(design.personas, [("shot", "from"), ("shot", "side")]) == [("shot", "from")]
    assert any("every practice player has the same numbers" in note for note in design.notes)
    assert "tells players of this game apart" in D._prompt(setup)


async def test_the_games_own_numbers_for_a_practice_player_are_used_as_given():
    setup = court()
    given = {"shot": {"side": {"forehand": 0.9, "backhand": 0.1}}}
    setup["practice"] = {"players": {"hitter": {"about": "Hits forehands.", "plays": given},
                                     "plain_one": {"about": "No habit at all."}}}
    assert check_message(setup, setup) == [] and D.lacking_plays(setup) == ["plain_one"]      # the contract takes `plays` as it is
    reply = json.loads(json.dumps(TENNIS_REPLY))
    reply["values"][0]["counts"] = ["shot.from=left_short", "shot.from=middle_short", "shot.from=right_short"]
    reply["values"][1]["counts"] = ["shot.side=forehand"]
    reply["practice_players"] = [{"name": "hitter", "plays": [{"pick": "shot.side=forehand", "share": 0.2}]},
                                 {"name": "plain_one", "plays": []}]
    calls: list[dict[str, Any]] = []
    design = await D.GeminiDesigner(ask=fake_ask(reply, calls)).design(setup, None, lambda line: None)
    hitter = next(persona for persona in design.personas if persona["name"] == "hitter")
    assert hitter["plays"]["shot"]["side"] == {"forehand": 0.9, "backhand": 0.1}  # exactly the game's numbers, never the model's
    assert abs(sum(hitter["plays"]["shot"]["from"].values()) - 1) < 0.02          # a field it does not cover is filled as usual
    assert calls[0]["schema"]["properties"]["practice_players"]["items"]["properties"]["name"]["enum"] == ["plain_one"]
    asked = json.loads(calls[1]["prompt"].split("same fields:\n", 1)[1].split("\n\nFor each player", 1)[0])
    keys = next(entry for entry in asked if entry["name"] == "hitter")["fields"].keys()
    assert "shot.from" in keys and "shot.side" not in keys

