"""The stand-in game against a tiny fake agent server."""
from __future__ import annotations

import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable

from websockets.asyncio.server import ServerConnection, serve

from sim.fake_server import handle
from sim.game import SimGame
from sim.headless import SimModel, load_json, play

ROOT = Path(__file__).resolve().parent.parent
TENNIS_SETUP = ROOT / "examples" / "tennis" / "setup.json"
TENNIS_SIM = ROOT / "examples" / "tennis" / "sim.json"
CSGO_SETUP = ROOT / "examples" / "csgo" / "setup.json"
CSGO_SIM = ROOT / "examples" / "csgo" / "sim.json"


def tennis() -> tuple[dict[str, Any], SimModel]:
    setup = load_json(TENNIS_SETUP)
    return setup, SimModel(load_json(TENNIS_SIM), setup)


@asynccontextmanager
async def server(handler: Callable[[ServerConnection], Awaitable[None]]) -> AsyncIterator[str]:
    """Start a server on a free port and yield its /ws address."""
    async with serve(handler, "localhost", 0) as running:
        port = next(iter(running.sockets)).getsockname()[1]
        yield f"ws://localhost:{port}/ws"


async def test_live_match_plays_every_round() -> None:
    setup, model = tennis()
    async with server(lambda ws: handle(ws, adapt=True)) as url:
        log = await SimGame(setup, model, url, player="forehand_lover", rounds=6, seed=3).run()
    sent_setup = log.sent[0]
    assert sent_setup["type"] == "setup" and sent_setup["mode"] == "live"
    assert sent_setup["practice"]["stand_in"] is True
    assert set(sent_setup["practice"]["players"]) == {"forehand_lover", "baseline_grinder", "even"}
    assert [r["round"] for r in log.rounds] == [1, 2, 3, 4, 5, 6]
    assert log.rounds[-1]["break"] is False
    assert sum(log.rounds[-1]["score"].values()) == 6
    npc_shots = [e for e in log.events if e["by"] == "opponent" and e["name"] == "shot"]
    assert npc_shots and all(set(e["picked"]) == {"shot_type", "aim", "position"} for e in npc_shots)
    moves = [e for e in log.events if e["name"] == "anticipate"]
    assert moves and all(set(e["picked"]) == {"anticipate"} and e["data"]["move"] == e["picked"]["anticipate"]
                         for e in moves)
    assert sent_setup["practice"]["stand_in"] is True
    player_events = [e for e in log.events if e["by"] == "player" and e["name"] == "shot"]
    assert all(e["data"]["result"] in ("in", "out", "net") for e in player_events)
    # The human can only hit the shots the game lists for the player.
    assert {e["data"]["shot_type"] for e in player_events} <= set(setup["lists"]["human_shot_type"])
    assert all(e["data"]["arm_zone"] in setup["lists"]["arm_zone"] for e in player_events)
    assert any(m["type"] == "player_read" for m in log.received)
    assert log.updates, "the adapting fake should send strategy updates"
    assert log.versions[0] == 1 and max(log.versions) > 1


async def test_practice_mode_answers_runs_then_plays() -> None:
    setup, model = tennis()
    async with server(lambda ws: handle(ws, adapt=True)) as url:
        log = await SimGame(setup, model, url, mode="practice", player="even", rounds=2, seed=1).run()
    results = [m for m in log.sent if m["type"] == "practice_result"]
    assert {r["player"] for r in results} == {"forehand_lover", "baseline_grinder", "even"}
    assert all(sum(r["wins"].values()) == r["rounds"] == 10 for r in results)
    assert all(set(r["wins"]) == {"player", "opponent"} for r in results)
    # No events were sent for the practice rounds, only for the two live ones.
    assert {e["round"] for e in log.events} == {1, 2}


async def test_practice_run_accepts_a_persona_object() -> None:
    setup, model = tennis()
    persona = {"name": "lefty", "about": "Always goes left.", "plays": {"shot": {"lands": {"left_deep": 1.0}}}}
    replies: list[dict[str, Any]] = []

    async def agents(ws: ServerConnection) -> None:
        message = json.loads(await ws.recv())
        await ws.send(json.dumps({"type": "practice_run", "match_id": message["match_id"], "run_id": "p_1",
                                  "player": persona, "rounds": 30, "behaviour": setup["default_behaviour"]}))
        replies.append(json.loads(await ws.recv()))
        await ws.send(json.dumps({"type": "ready", "match_id": message["match_id"], "values": {},
                                  "behaviour": setup["default_behaviour"]}))
        async for _ in ws:
            pass

    async with server(agents) as url:
        await SimGame(setup, model, url, mode="practice", rounds=0).run()
    assert replies[0]["type"] == "practice_result"
    assert replies[0]["player"] == "lefty" and replies[0]["run_id"] == "p_1"
    assert sum(replies[0]["wins"].values()) == 30


async def test_update_mid_round_waits_for_the_gap() -> None:
    setup, model = tennis()

    def only(option: str, version: int) -> dict[str, Any]:
        behaviour = json.loads(json.dumps(setup["default_behaviour"]))
        behaviour["version"] = version
        for name, spec in behaviour["npcs"]["opponent"]["decisions"]["position"].items():
            spec["base"] = 1.0 if name == option else 0.0
        return behaviour

    async def agents(ws: ServerConnection) -> None:
        message = json.loads(await ws.recv())
        match_id = message["match_id"]
        await ws.send(json.dumps({"type": "ready", "match_id": match_id, "values": {},
                                  "behaviour": only("middle_deep", 1)}))
        sent = False
        async for raw in ws:
            event = json.loads(raw)
            if event.get("type") == "event" and event.get("by") == "player" and not sent:
                sent = True  # lands in the middle of round 1
                await ws.send(json.dumps({"type": "strategy_update", "match_id": match_id, "version": 2,
                                          "source": "full", "behaviour": only("left_deep", 2)}))

    async with server(agents) as url:
        # A slow pretend exchange gives the update time to land mid-round.
        game = SimGame(setup, model, url, player="even", rounds=2, seed=5, speed="real",
                       exchange_seconds=0.05, break_seconds=0.05)
        game.model.round_spec = {**game.model.round_spec, "max_exchanges": 4}
        log = await game.run()
    picks = {(e["round"], e["picked"]["position"]) for e in log.events
             if e["by"] == "opponent" and e["name"] == "shot"}
    assert {p for r, p in picks if r == 1} == {"middle_deep"}
    assert {p for r, p in picks if r == 2} == {"left_deep"}
    assert log.versions == [1, 2]


async def test_csgo_match_uses_round_start_and_kills() -> None:
    setup = load_json(CSGO_SETUP)
    model = SimModel(load_json(CSGO_SIM), setup)
    async with server(lambda ws: handle(ws, adapt=False)) as url:
        log = await SimGame(setup, model, url, player="camper", rounds=4, seed=2).run()
    starts = [e for e in log.events if e["name"] == "round_start"]
    assert len(starts) == 4 and all("formation" in e["picked"] for e in starts)
    kills = [e for e in log.events if e["name"] == "kill"]
    assert len(kills) == 4
    assert {k["by"] for k in kills} <= {"player", "enemies"}
    assert all(r["winner"] in ("player", "enemies") for r in log.rounds)
    assert log.sent[0]["plan"]["break_every"] == 3  # one long break in a six-round match
    assert log.rounds[2]["break"] is True and log.rounds[0]["break"] is False


def _only(setup: dict[str, Any], decision: str, option: str) -> dict[str, Any]:
    behaviour = json.loads(json.dumps(setup["default_behaviour"]))
    for name, spec in behaviour["npcs"]["opponent"]["decisions"][decision].items():
        spec["base"] = 1.0 if name == option else 0.0
    return behaviour


def test_headless_counters_pay_only_against_habits() -> None:
    """Each habit has a counter worth about a quarter more than the default,
    one of them a shot type, and the even player has none."""
    setup, model = tennis()

    def rate(player: str, behaviour: dict[str, Any]) -> float:
        return play(setup, model, behaviour, player, 4000, seed=7)["wins"]["player"] / 4000

    default = {p: rate(p, setup["default_behaviour"]) for p in ("forehand_lover", "baseline_grinder", "even")}
    assert rate("forehand_lover", _only(setup, "position", "left_deep")) < default["forehand_lover"] * 0.85
    assert rate("forehand_lover", _only(setup, "shot_type", "slice")) < default["forehand_lover"] * 0.92
    assert rate("baseline_grinder", _only(setup, "shot_type", "dropshot")) < default["baseline_grinder"] * 0.75
    for decision, option in (("position", "left_deep"), ("shot_type", "lob"), ("shot_type", "slice"),
                             ("shot_type", "dropshot"), ("position", "middle_short")):
        assert rate("even", _only(setup, decision, option)) > default["even"] - 0.05


def test_headless_persona_spreads_missing_fields_evenly() -> None:
    setup, model = tennis()
    persona = model.persona({"name": "p", "plays": {"shot": {"side": {"backhand": 1.0}}}})
    import random

    rng = random.Random(0)
    plays = [model.draw(persona, "shot", rng) for _ in range(600)]
    assert {p["side"] for p in plays} == {"backhand"}
    # Left out, so spread evenly, but only over the shots a player can hit.
    assert {p["shot_type"] for p in plays} == set(setup["lists"]["human_shot_type"])
    lands = {p["lands"] for p in plays}
    assert lands == set(setup["lists"]["zone"])
    assert all(0 <= p["power"] <= 1 for p in plays)


async def test_practice_mode_keeps_answering_until_ready() -> None:
    """Slow practice runs keep the wait alive, and the views stay declared."""
    setup, model = tennis()
    import asyncio

    async def agents(ws: ServerConnection) -> None:
        message = json.loads(await ws.recv())
        assert message["views"] == setup["views"]
        for index in range(3):
            await asyncio.sleep(0.4)  # each gap is longer than half the timeout
            await ws.send(json.dumps({"type": "practice_run", "match_id": message["match_id"],
                                      "run_id": f"p_{index}", "player": "even", "rounds": 5,
                                      "behaviour": setup["default_behaviour"]}))
            await ws.recv()
        await ws.send(json.dumps({"type": "ready", "match_id": message["match_id"], "values": {},
                                  "behaviour": setup["default_behaviour"]}))
        async for _ in ws:
            pass

    async with server(agents) as url:
        log = await SimGame(setup, model, url, mode="practice", ready_timeout=0.7).run()
    assert sum(1 for m in log.sent if m["type"] == "practice_result") == 3
    assert any(m["type"] == "ready" for m in log.received)


async def test_practice_mode_stops_when_nothing_comes() -> None:
    setup, model = tennis()

    async def silent(ws: ServerConnection) -> None:
        async for _ in ws:
            pass

    async with server(silent) as url:
        log = await SimGame(setup, model, url, mode="practice", rounds=3, ready_timeout=0.3).run()
    assert log.rounds == []


async def test_live_match_sends_the_real_games_fields_and_passes_the_contract() -> None:
    from server import contract

    setup, model = tennis()
    async with server(lambda ws: handle(ws, adapt=True)) as url:
        log = await SimGame(setup, model, url, player="forehand_lover", rounds=30, seed=11).run()
    sent_setup = log.sent[0]
    assert contract.check_setup(sent_setup) == []
    for message in log.sent[1:]:
        assert contract.check_message(sent_setup, message) == [], message

    shots = [e for e in log.events if e["by"] == "player" and e["name"] == "shot"]
    assert shots and all({"confidence", "timing", "quality"} <= set(e["data"]) for e in shots)
    # Power and spin fit the shot type, as the real game reports them.
    for shot in shots:
        data = shot["data"]
        if data["shot_type"] == "dropshot":
            assert 0.14 <= data["power"] <= 0.4
        if data["shot_type"] == "slice":
            assert data["rotation"] < -0.25
        if data["shot_type"] == "topspin":
            assert data["rotation"] > 0.2 and data["power"] >= 0.5
    misses = [e for e in log.events if e["name"] == "missed_swing"]
    assert misses, "some lost points should be a swing and a miss"
    assert all(e["by"] == "player" and e["data"]["reason"] in ("unreachable", "too_early", "too_late") for e in misses)
    assert all("result" not in e["data"] for e in misses)
    assert any(r["how"] == "missed_swing" and r["winner"] == "opponent" for r in log.rounds)
    late = [e["data"]["quality"] for e in shots if e["data"]["timing"] == "late"]
    on_time = [e["data"]["quality"] for e in shots if e["data"]["timing"] == "on_time"]
    assert late and on_time and max(late) < min(on_time)


async def test_swing_start_and_anticipate_come_before_each_player_play() -> None:
    from server import contract

    setup, model = tennis()
    async with server(lambda ws: handle(ws, adapt=False)) as url:
        log = await SimGame(setup, model, url, player="baseline_grinder", rounds=10, seed=4).run()
    names = [(e["by"], e["name"]) for e in log.events]
    for index, (by, name) in enumerate(names):
        if by == "player" and name in ("shot", "missed_swing"):
            assert names[index - 2:index] == [("player", "swing_start"), ("opponent", "anticipate")]
    starts = [e for e in log.events if e["name"] == "swing_start"]
    assert starts and all(set(e["data"]) == {"early_guess", "confidence", "backswing", "initial_speed", "side", "arm_zone"}
                          for e in starts)
    for message in log.sent[1:]:
        assert contract.check_message(log.sent[0], message) == [], message


def test_early_sign_is_honest_for_one_player_and_disguised_for_another() -> None:
    import random

    setup, model = tennis()
    rng = random.Random(3)

    def honesty(player: str) -> tuple[float, float]:
        persona = model.persona(player)
        same_guess = same_side = 0
        for _ in range(3000):
            play = model.draw(persona, "shot", rng)
            tell = model.tell(persona, play, {}, rng)
            same_guess += tell["early_guess"] == play["shot_type"]
            same_side += tell["side"] == play["side"]
        return same_guess / 3000, same_side / 3000

    honest, disguised, unnamed = honesty("forehand_lover"), honesty("baseline_grinder"), honesty("even")
    assert abs(honest[0] - 0.9) < 0.03 and abs(disguised[0] - 0.4) < 0.03 and abs(unnamed[0] - 0.78) < 0.03
    assert all(abs(side - 0.92) < 0.03 for _, side in (honest, disguised, unnamed))
    # A dropshot shown at the start of the swing starts slow with a small backswing.
    persona = model.persona("even")
    for _ in range(300):
        tell = model.tell(persona, model.draw(persona, "shot", rng), {}, rng)
        if tell["early_guess"] == "dropshot":
            assert tell["backswing"] <= 0.3 and tell["initial_speed"] <= 0.3


async def test_the_game_plays_on_and_reconnects_when_the_agents_drop() -> None:
    setup, model = tennis()
    setups: list[str] = []

    async def agents(ws: ServerConnection) -> None:
        message = json.loads(await ws.recv())
        setups.append(message["match_id"])
        await ws.send(json.dumps({"type": "ready", "match_id": message["match_id"], "values": {},
                                  "behaviour": setup["default_behaviour"]}))
        if len(setups) == 1:
            async for raw in ws:
                if json.loads(raw).get("type") == "round_end":
                    await ws.close()  # the agents go away after the first round
                    return
        async for _ in ws:
            pass

    async with server(agents) as url:
        log = await SimGame(setup, model, url, player="even", rounds=4, seed=2).run()
    assert len(setups) >= 2 and len(set(setups)) == 1   # setup again, same match id
    assert log.reconnects >= 1
    assert len(log.versions) == 4                        # every round was played


async def test_after_a_practice_session_closes_the_game_rejoins_live_before_the_first_point() -> None:
    setup, model = tennis()
    modes: list[str] = []
    events_on: list[int] = []

    async def agents(ws: ServerConnection) -> None:
        message = json.loads(await ws.recv())
        modes.append(message["mode"])
        await ws.send(json.dumps({"type": "ready", "match_id": message["match_id"], "values": {},
                                  "behaviour": setup["default_behaviour"]}))
        if message["mode"] == "practice":
            await ws.close()  # the practice session is over
            return
        count = 0
        async for raw in ws:
            count += json.loads(raw).get("type") == "event"
        events_on.append(count)

    async with server(agents) as url:
        log = await SimGame(setup, model, url, mode="practice", player="even", rounds=3, seed=4).run()
    assert modes == ["practice", "live"]
    assert log.dropped == 0 and len(log.rounds) == 3
