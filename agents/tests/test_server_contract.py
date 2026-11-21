"""The contract check: what fits `setup` passes, and what doesn't is named plainly."""
from __future__ import annotations

import copy
import json
from pathlib import Path

from fakes import opponent_shot, player_shot, round_end, tennis_setup

from server.contract import check_behaviour, check_message, check_setup
from server.session import baseline_behaviour

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"

CSGO_SETUP = {
    "type": "setup", "match_id": "c_001", "game": "csgo", "mode": "replay",
    "about": "One player attacks a bomb site held by a squad.", "goal": "Keep every round close.",
    "plan": {"rounds": 8, "break_every": 4, "break_seconds": 120, "update_seconds": 5, "writer": "fast", "max_candidates": 3},
    "lists": {"place": ["a_site", "b_site", "mid"]},
    "npcs": {"enemies": {"about": "A squad.", "decisions": {
        "formation": {"when": "At round start.", "options": {"all_on_site": "Stack.", "spread_out": "Spread."}},
    }}},
    "events": {
        "round_start": {"about": "A round began.", "fields": {}},
        "spotted": {"about": "The player was seen.", "fields": {"where": "place", "seconds": "number", "note": "text"}},
    },
    "facts": {"player_last_seen": "place", "enemies_alive": "number"},
    "views": {"screen": "The game screen."},
    "settings": {
        "enemy_count": {"about": "How many enemies start.", "min": 3, "max": 6, "now": 4},
        "loadout": {"about": "What they carry.", "options": ["pistols", "rifles"], "now": "rifles"},
    },
}


def wheres(problems: list[dict]) -> list[str]:
    return [problem["where"] for problem in problems]


def test_two_different_games_both_pass():
    assert check_setup(tennis_setup(practice=True)) == []
    assert check_setup(CSGO_SETUP) == []


def test_the_example_games_pass_as_written():
    for game in ("tennis", "csgo"):
        setup = json.loads((EXAMPLES / game / "setup.json").read_text())
        assert check_setup(setup) == [], game

        # An event can leave out any field it declared, or send it as null.
        name, event = next((n, e) for n, e in setup["events"].items() if e.get("fields"))
        message = {"type": "event", "match_id": setup["match_id"], "name": name, "round": 1, "t": 1.0, "by": "player", "data": {}}
        assert check_message(setup, message) == []
        message["data"] = {field: None for field in event["fields"]}
        assert check_message(setup, message) == []
        del message["data"]
        assert check_message(setup, message) == []

        # The game's own default, or every option equally likely, is a behaviour that fits.
        assert check_behaviour(setup, baseline_behaviour(setup), [], complete=True) == []


def test_a_setting_with_a_number_range_and_now():
    setup = tennis_setup()
    setup["settings"] = {"opponent_speed": {"about": "How fast the opponent moves.", "min": 0.65, "max": 1.25, "now": 0.85}}
    assert check_setup(setup) == []
    update = {
        "type": "strategy_update", "match_id": "m_001", "version": 2, "source": "quick", "observations": [], "plan": [],
        "changes": [], "settings": {"opponent_speed": 1.1}, "behaviour": {**baseline_behaviour(setup), "version": 2},
    }
    assert check_message(setup, update) == []
    update["settings"]["opponent_speed"] = 1.5
    assert wheres(check_message(setup, update)) == ["strategy_update.settings.opponent_speed"]
    setup["settings"]["opponent_speed"]["now"] = 2
    assert wheres(check_setup(setup)) == ["setup.settings.opponent_speed.now"]


def test_setup_problems_say_where():
    setup = tennis_setup()
    setup["mode"] = "tournament"
    setup["events"]["shot"]["fields"]["lands"] = "court_half"       # not a list in `lists`
    setup["npcs"]["opponent"]["decisions"]["aim"]["options"] = {}
    setup["plan"]["writer"] = "wizard"
    setup["default_behaviour"]["npcs"]["opponent"]["decisions"]["shot_type"]["smash"] = {"base": 1}
    found = wheres(check_setup(setup))
    assert "setup.mode" in found
    assert "setup.events.shot.fields.lands" in found
    assert "setup.npcs.opponent.decisions.aim.options" in found
    assert "setup.plan.writer" in found
    assert "setup.default_behaviour.npcs.opponent.decisions.shot_type.smash" in found


def test_good_messages_pass():
    setup = tennis_setup()
    for message in (player_shot("m_001", 1, 1.0), opponent_shot("m_001", 1, 2.0), round_end("m_001", 1, 9.0)):
        assert check_message(setup, message) == []


def test_undeclared_field_gets_the_error_from_the_contract():
    setup = tennis_setup()
    shot = player_shot("m_001", 1, 1.0)
    shot["data"]["spin"] = "topspin"
    assert check_message(setup, shot) == [{
        "about": "The event `shot` has a field that `setup` did not declare.",
        "where": "event.data.spin",
        "got": "topspin",
    }]


def test_field_kinds_are_checked():
    setup = tennis_setup()
    shot = player_shot("m_001", 1, 1.0)
    shot["data"].update({"side": "overhead", "power": 1.4, "lands": "the_stands", "rally": "three"})
    shot["by"] = "umpire"
    found = wheres(check_message(setup, shot))
    for where in ("event.by", "event.data.side", "event.data.power", "event.data.lands", "event.data.rally"):
        assert where in found
    # A field that doesn't apply can be null.
    shot = player_shot("m_001", 1, 1.0)
    shot["data"]["lands"] = None
    assert check_message(setup, shot) == []


def test_unknown_names_in_messages():
    setup = tennis_setup()
    assert wheres(check_message(setup, {"type": "event", "match_id": "m_001", "name": "serve", "round": 1})) == ["event.name"]
    assert wheres(check_message(setup, {"type": "dance", "match_id": "m_001"})) == ["type"]
    assert "round_end.winner" in wheres(check_message(setup, round_end("m_001", 1, 9.0, winner="crowd")))
    assert "event.match_id" in wheres(check_message(setup, player_shot("m_999", 1, 1.0)))
    picked = opponent_shot("m_001", 1, 2.0)
    picked["picked"]["shot_type"] = "smash"
    assert "event.picked.shot_type" in wheres(check_message(setup, picked))


def test_behaviour_names_are_checked():
    setup = tennis_setup()
    good = baseline_behaviour(setup)
    good["npcs"]["opponent"]["decisions"]["shot_type"]["lob"]["when"] = {"comes_to_net": 0.6}
    good["npcs"]["opponent"]["rules"] = [{
        "if": [{"fact": "player_position", "in": ["left_short", "middle_short"]}, {"value": "comes_to_net", "above": 0.5}],
        "do": {"shot_type": "lob"}, "why": "Came to the net twice.",
    }]
    assert check_behaviour(setup, good, ["comes_to_net"]) == []
    assert check_behaviour(setup, good, ["comes_to_net"], complete=True) == []

    bad = copy.deepcopy(good)
    mine = bad["npcs"]["opponent"]
    mine["decisions"]["shot_type"]["smash"] = {"base": 1}
    mine["decisions"]["footwork"] = {"shuffle": {"base": 1}}
    mine["decisions"]["aim"]["left_deep"] = {"base": -1, "when": {"never_heard_of": 0.4}}
    mine["rules"] = [
        {"if": [{"fact": "wind", "is": "strong"}], "do": {"shot_type": "lob"}, "why": "x"},
        {"if": [{"fact": "player_position", "is": "the_stands"}], "do": {"shot_type": "lob"}, "why": "x"},
        {"if": [{"fact": "player_position", "above": 3}], "do": {"shot_type": "lob"}, "why": "x"},
        {"if": [{"value": "mystery", "above": 0.5}], "do": {"shot_type": "smash"}, "why": "x"},
        {"if": [], "do": {"position": "middle_deep"}, "why": "x"},
    ]
    bad["npcs"]["ball_kid"] = {"decisions": {}, "rules": []}
    found = wheres(check_behaviour(setup, bad, ["comes_to_net"]))
    base = "behaviour.npcs.opponent"
    for where in (
        f"{base}.decisions.shot_type.smash", f"{base}.decisions.footwork",
        f"{base}.decisions.aim.left_deep.base", f"{base}.decisions.aim.left_deep.when.never_heard_of",
        f"{base}.rules",                 # five rules, and the limit is four
        f"{base}.rules.0.if.0.fact", f"{base}.rules.1.if.0.is", f"{base}.rules.2.if.0.above",
        f"{base}.rules.3.if.0.value", f"{base}.rules.3.do.shot_type",
        "behaviour.npcs.ball_kid",
    ):
        assert where in found, where


def test_complete_asks_for_every_decision():
    setup = tennis_setup()
    thin = {"version": 0, "npcs": {"opponent": {"decisions": {"shot_type": {"lob": {"base": 1}}}, "rules": []}}}
    assert check_behaviour(setup, thin, None) == []
    assert len(check_behaviour(setup, thin, None, complete=True)) == 2  # aim and position are missing


def test_practice_run_takes_a_name_or_a_persona():
    setup = tennis_setup(practice=True)
    run = {"type": "practice_run", "match_id": "m_001", "run_id": "p_001", "player": "forehand_lover", "rounds": 20,
           "behaviour": {"version": 0, "npcs": {"opponent": {"decisions": {}, "rules": []}}}}
    assert check_message(setup, run) == []
    run["player"] = {"name": "net_rusher", "about": "Comes in early.",
                     "plays": {"shot": {"side": {"forehand": 0.7, "backhand": 0.3}, "lands": {"left_short": 1}}}}
    assert check_message(setup, run) == []
    run["player"]["plays"]["shot"]["side"]["sideways"] = 0.1
    run["player"]["plays"]["shot"]["power"] = {"hard": 1}
    assert wheres(check_message(setup, run)) == [
        "practice_run.player.plays.shot.side.sideways", "practice_run.player.plays.shot.power",
    ]
    run["player"] = "nobody"
    assert wheres(check_message(setup, run)) == ["practice_run.player"]


def test_settings_in_an_update_are_checked():
    update = {
        "type": "strategy_update", "match_id": "c_001", "version": 2, "source": "full",
        "observations": ["Plays slow."], "plan": ["Spread out."], "changes": [],
        "settings": {"enemy_count": 5, "loadout": "rifles"},
        "behaviour": {"version": 2, "npcs": {"enemies": {"decisions": {"formation": {"spread_out": {"base": 1}}}, "rules": []}}},
    }
    assert check_message(CSGO_SETUP, update) == []
    update["settings"] = {"enemy_count": 9, "loadout": "tanks", "weather": "rain"}
    update["behaviour"]["version"] = 3
    assert wheres(check_message(CSGO_SETUP, update)) == [
        "strategy_update.settings.enemy_count", "strategy_update.settings.loadout",
        "strategy_update.settings.weather", "strategy_update.behaviour.version",
    ]
