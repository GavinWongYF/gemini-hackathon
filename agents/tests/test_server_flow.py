"""The server core, end to end, against fake parts and a scripted game."""
from __future__ import annotations

import asyncio
import json

import httpx
from fakes import (
    Client, FakeAdapter, FakeDesigner, FakeWatcher, fast_settings, frames, opponent_shot,
    player_shot, practice_result, round_end, running, tennis_setup,
)

from server.app import create_app
from server.contract import check_message


def build(tmp_path, watcher=None, designer=None, adapter=None, **options):
    settings = options.pop("settings", None) or fast_settings()
    return create_app(watcher, designer, adapter, real_parts=False, data_dir=tmp_path, settings=settings, **options)


async def play_round(game: Client, match_id: str, number: int, rest: bool = True) -> None:
    """One short point: four shots, one set of frames, then the result."""
    t = number * 10.0
    await game.send(player_shot(match_id, number, t + 1, side="forehand", lands="left_deep"))
    await game.send(opponent_shot(match_id, number, t + 2))
    await game.send(frames(match_id, number, t + 2.5))
    await game.send(player_shot(match_id, number, t + 3, side="forehand" if number % 2 else "backhand"))
    await game.send(opponent_shot(match_id, number, t + 4))
    await game.send(round_end(match_id, number, t + 5, winner="player" if number < 4 else "opponent", rest=rest))


async def test_five_rounds_of_tennis(tmp_path):
    watcher, designer, adapter = FakeWatcher(), FakeDesigner(), FakeAdapter(delay=0.03)
    app = build(tmp_path, watcher, designer, adapter, record=True)
    setup = tennis_setup()
    async with running(app) as host:
        async with Client(f"ws://{host}/watch") as viewer, Client(f"ws://{host}/ws") as game:
            await game.send(setup)
            ready = await game.until("ready")
            assert ready["behaviour"]["version"] == 1
            assert set(ready["values"]) == {"side_forehand", "side_backhand"}
            assert ready["values"]["side_forehand"] == {"label": "Picks forehand for side", "kind": "share"}

            for number in range(1, 6):
                await play_round(game, "m_001", number)
                await game.until("player_read")
                await game.until("strategy_update")
            await game.drain(0.3)
            seen = await viewer.drain(0.3)

            # Everything the server sent fits the contract.
            for message in game.got:
                assert check_message(setup, message) == [], message
            assert not [m for m in game.got if m["type"] == "error"]

            # The behaviour version only ever goes up.
            versions = [m["version"] for m in game.got if m["type"] == "strategy_update"]
            assert len(versions) >= 5 and versions == sorted(set(versions)) and versions[0] == 2
            assert all(m["version"] == m["behaviour"]["version"] for m in game.got if m["type"] == "strategy_update")

            # The slower parts ran one at a time, and only the routine rewrite ran.
            assert watcher.most_in_flight == 1 and adapter.most_in_flight == 1
            assert watcher.warmed == 1 and set(adapter.calls) == {"quick"}

            # The viewer saw every message in, every message out, and the traces.
            assert all(set(line) == {"dir", "t", "at", "match", "message"} for line in seen)
            assert [l["message"] for l in seen if l["dir"] == "in"] == game.sent
            assert [l["message"] for l in seen if l["dir"] == "out"] == game.got
            traces = [l["message"] for l in seen if l["dir"] == "trace"]
            measured = [t for t in traces if t["stage"] == "measures"]
            assert len(measured) == 5
            assert measured[-1]["data"]["rounds"] == 5 and measured[-1]["data"]["player_win_rate"] == 0.6
            top = measured[-1]["data"]["habits"][0]
            assert (top["field"], top["value"], top["share"], top["payoff"]) == ("from", "middle_deep", 1.0, 0.6)
            assert {"server", "designer", "measures"} <= {t["stage"] for t in traces}

            # A viewer who arrives late gets the match so far, with only the newest pictures.
            async with Client(f"ws://{host}/watch") as late:
                replay = await late.drain(0.3)
            assert [(l["dir"], l["message"]["type"]) for l in replay] == [(l["dir"], l["message"]["type"]) for l in seen]
            pictures = [l["message"]["views"]["court"]["data"] for l in replay if l["message"]["type"] == "frames"]
            assert pictures == ["", "", "", "", "QUJD"]

            async with httpx.AsyncClient() as http:
                health = (await http.get(f"http://{host}/health")).json()
            assert health["ok"] and health["matches"]["m_001"]["rounds"] == 5

    # The design was stored for next time, and the stream was recorded.
    assert len(list((tmp_path / "designs").glob("tennis-*.json"))) == 1
    lines = (tmp_path / "streams" / "m_001.jsonl").read_text().splitlines()
    assert json.loads(lines[0])["message"]["type"] == "setup"
    # The recording holds what the viewer saw, then one closing line that says the game left.
    assert len(lines) == len(seen) + 1 and json.loads(lines[-1])["message"]["data"] == {"game": "left"}


async def test_bad_input_gets_an_error_and_the_match_carries_on(tmp_path):
    app = build(tmp_path, FakeWatcher(), FakeDesigner(), FakeAdapter())
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send_raw("{not json")
            assert (await game.until("error"))["where"] == "message"
            await game.send_raw("[1, 2]")
            assert (await game.until("error"))["where"] == "type"
            await game.send(player_shot("m_001", 1, 1.0))
            assert "Send `setup` first" in (await game.until("error"))["about"]

            broken = tennis_setup()
            del broken["npcs"]
            await game.send(broken)
            assert (await game.until("error"))["where"] == "setup.npcs"

            await game.send(tennis_setup())
            await game.until("ready")

            shot = player_shot("m_001", 1, 1.0)
            shot["data"]["spin"] = "topspin"
            await game.send(shot)
            assert await game.until("error") == {
                "type": "error", "match_id": "m_001",
                "about": "The event `shot` has a field that `setup` did not declare.",
                "where": "event.data.spin", "got": "topspin",
            }
            await game.send({"type": "event", "match_id": "m_001", "name": "serve", "round": 1, "by": "player"})
            assert (await game.until("error"))["where"] == "event.name"
            await game.send({"type": "dance", "match_id": "m_001"})
            assert (await game.until("error"))["where"] == "type"
            await game.send({"type": "ready", "match_id": "m_001", "values": {}, "behaviour": {"version": 1, "npcs": {}}})
            assert "goes the other way" in (await game.until("error"))["about"]
            await game.send({"type": "practice_result", "match_id": "m_001", "run_id": "p_404", "rounds": 1, "wins": {}})
            assert (await game.until("error"))["where"] == "practice_result.run_id"
            await game.send(round_end("m_001", "one", 5.0))
            assert (await game.until("error"))["where"] == "round_end.round"

            # After all that, the match still works.
            await play_round(game, "m_001", 1)
            await game.until("player_read")
            await game.until("strategy_update")
        session = app.state.sessions["m_001"]
        # The event with one extra field was kept, since the rest of it counts.
        assert len(session.match.events) == 5 and len(session.match.rounds) == 1


async def test_practice_then_live_reuses_the_stored_design(tmp_path):
    designer = FakeDesigner()
    app = build(tmp_path, FakeWatcher(), designer, FakeAdapter())
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            setup = tennis_setup("practice_1", mode="practice", practice=True)
            await game.send(setup)
            players = []
            while True:
                message = await game.next()
                assert check_message(setup, message) == [], message
                if message["type"] == "ready":
                    break
                assert message["type"] == "practice_run"
                players.append(message["player"])
                await game.send(practice_result(message))
            # One player the game named and one persona the designer wrote.
            assert "forehand_lover" in players and any(isinstance(p, dict) for p in players)
            assert message["behaviour"]["version"] == 1 and message["values"]
        assert designer.calls == 1 and designer.playtested

        stored = json.loads(next((tmp_path / "designs").glob("tennis-*.json")).read_text())
        assert sorted(m["player"] for m in stored["design"]["matchups"]) == ["forehand_lover", "leans_one_way"]

        # A live match of the same game gets `ready` straight from the store.
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup("live_1", mode="live"))
            ready = await game.until("ready", timeout=0.25)
            assert set(ready["values"]) == {"side_forehand", "side_backhand"}
        assert designer.calls == 1


async def test_a_live_game_does_not_wait_for_a_slow_design(tmp_path):
    designer = FakeDesigner(delay=0.5)
    app = build(tmp_path, FakeWatcher(), designer, FakeAdapter(), settings=fast_settings(ready_wait=0.1))
    setup = tennis_setup()
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(setup)
            ready = await game.until("ready", timeout=0.4)
            assert ready["values"] == {} and ready["behaviour"] == setup["default_behaviour"]
            update = await game.until("strategy_update")
            assert update["version"] == 1 and set(update["new_values"]) == {"side_forehand", "side_backhand"}
            assert check_message(setup, update) == []


async def test_without_a_default_every_option_starts_equal(tmp_path):
    app = build(tmp_path)  # no parts at all
    setup = tennis_setup()
    del setup["default_behaviour"]
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game, Client(f"ws://{host}/watch") as viewer:
            await game.send(setup)
            ready = await game.until("ready")
            assert ready["values"] == {}
            assert ready["behaviour"]["npcs"]["opponent"]["decisions"]["shot_type"] == {
                "flat": {"base": 1}, "lob": {"base": 1}, "drop": {"base": 1},
            }
            assert check_message(setup, ready) == []
            await play_round(game, "m_001", 1)
            assert await game.drain(0.2) == []       # no parts, so nothing more to say
            seen = await viewer.drain(0.2)
            assert [l["message"]["stage"] for l in seen if l["dir"] == "trace"] == ["server", "measures"]


async def test_reconnect_picks_up_where_it_was(tmp_path):
    app = build(tmp_path, FakeWatcher(), FakeDesigner(), FakeAdapter())
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup())
            await game.until("ready")
            for number in (1, 2):
                await play_round(game, "m_001", number)
                await game.until("strategy_update")
            await game.drain(0.2)
            version = [m for m in game.got if m["type"] == "strategy_update"][-1]["version"]
        await asyncio.sleep(0.05)
        assert app.state.sessions["m_001"].socket is None

        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup())
            ready = await game.until("ready")
            assert ready["behaviour"]["version"] == version and ready["values"]
            await play_round(game, "m_001", 3)
            assert (await game.until("strategy_update"))["version"] == version + 1
        match = app.state.sessions["m_001"].match
        assert [r["round"] for r in match.rounds] == [1, 2, 3]


async def test_the_same_id_from_round_one_again_is_a_new_match(tmp_path):
    app = build(tmp_path, FakeWatcher(), FakeDesigner(), FakeAdapter())
    setup = tennis_setup()
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(setup)
            await game.until("ready")
            for number in (1, 2):
                await play_round(game, "m_001", number)
                await game.until("strategy_update")
            await game.drain(0.2)
            version = [m for m in game.got if m["type"] == "strategy_update"][-1]["version"]

        # The game was stopped part way and started again, with the same id.
        async with Client(f"ws://{host}/ws") as game, Client(f"ws://{host}/watch") as viewer:
            await game.send(setup)
            assert (await game.until("ready"))["behaviour"]["version"] == version
            await game.send(player_shot("m_001", 1, 1.0))
            back = await game.until("strategy_update")
            assert back["version"] == version + 1 and check_message(setup, back) == []
            assert back["behaviour"]["npcs"]["opponent"]["rules"] == []      # the starting behaviour again
            match = app.state.sessions["m_001"].match
            assert match.rounds == [] and len(match.events) == 1 and match.updates == []
            await game.send(round_end("m_001", 1, 5.0))
            await game.drain(0.2)
            seen = await viewer.drain(0.2)
            measured = [l["message"] for l in seen if l["message"].get("stage") == "measures"]
            assert measured[-1]["data"]["rounds"] == 1

        # A late viewer's replay holds only the new match.
        async with Client(f"ws://{host}/watch") as late:
            replay = await late.drain(0.2)
        assert replay[0]["message"]["type"] == "setup"
        assert sum(1 for l in replay if l["message"]["type"] == "round_end") == 1


async def test_no_adapt_is_the_unchanged_baseline(tmp_path):
    watcher, designer, adapter = FakeWatcher(), FakeDesigner(), FakeAdapter()
    app = build(tmp_path, watcher, designer, adapter, adapt=False)
    setup = tennis_setup()
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game, Client(f"ws://{host}/watch") as viewer:
            await game.send(setup)
            ready = await game.until("ready")
            assert ready["values"] == {} and ready["behaviour"] == setup["default_behaviour"]
            for number in (1, 2):
                await play_round(game, "m_001", number)
            assert await game.drain(0.3) == []
            seen = await viewer.drain(0.2)
            assert sum(1 for l in seen if l["message"].get("stage") == "measures") == 2
    assert designer.calls == 0 and watcher.reads == 0 and adapter.calls == []


async def test_rewrites_run_back_to_back_and_never_overlap(tmp_path):
    adapter = FakeAdapter(delay=0.15)
    app = build(tmp_path, None, FakeDesigner(), adapter, settings=fast_settings(first_adapt_delay=0.2))
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup())
            await game.until("ready")
            await game.send(player_shot("m_001", 1, 1.0))
            await asyncio.sleep(0.1)
            assert adapter.calls == []                 # too early: the first one waits for its delay
            first = await game.until("strategy_update")
            assert await game.drain(0.3) == []         # nothing new from the player, so no second call
            assert adapter.calls == ["quick"]

            # A burst of events while one rewrite runs leads to exactly one more.
            await game.send(player_shot("m_001", 1, 2.0))
            await asyncio.sleep(0.05)
            for t in (3.0, 4.0, 5.0):
                await game.send(player_shot("m_001", 1, t))
            second = await game.until("strategy_update")   # mid-round: it is sent the moment it lands
            third = await game.until("strategy_update")
            assert await game.drain(0.3) == []
            assert adapter.calls == ["quick"] * 3 and adapter.most_in_flight == 1
            assert [first["version"], second["version"], third["version"]] == [2, 3, 4]


async def test_a_slow_or_broken_rewrite_keeps_the_current_behaviour(tmp_path):
    for adapter, reason in ((FakeAdapter(delay=1.0), "took longer than"), (FakeAdapter(broken=True), "does not fit the contract")):
        app = build(tmp_path, None, FakeDesigner(), adapter)
        setup = tennis_setup(update_seconds=0.2)   # so a rewrite gets 0.25 seconds
        async with running(app) as host:
            async with Client(f"ws://{host}/ws") as game, Client(f"ws://{host}/watch") as viewer:
                await game.send(setup)
                await game.until("ready")
                await game.send(player_shot("m_001", 1, 1.0))
                failed = await viewer.until(lambda l: l["message"].get("status") == "error", timeout=2)
                assert failed["message"]["stage"] == "adapter" and reason in failed["message"]["about"]
                assert [m["type"] for m in game.got] == ["ready"]
                assert app.state.sessions["m_001"].match.behaviour["version"] == 1


async def test_a_long_break_gets_a_deeper_rewrite(tmp_path):
    adapter = FakeAdapter(delay=0.05)
    app = build(tmp_path, None, FakeDesigner(), adapter)
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup(break_seconds=90, update_seconds=5))   # deep at a break, fast in play
            await game.until("ready")
            await play_round(game, "m_001", 1, rest=False)
            assert (await game.until("strategy_update"))["source"] == "quick"
            await game.drain(0.2)
            await play_round(game, "m_001", 2, rest=True)
            await game.drain(0.4)
            assert "full" in adapter.calls and adapter.most_in_flight == 1

    # A short break asks for nothing extra.
    adapter = FakeAdapter(delay=0.05)
    app = build(tmp_path, None, FakeDesigner(), adapter)
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup("m_002"))
            await game.until("ready")
            await play_round(game, "m_002", 1, rest=True)
            await game.drain(0.4)
            assert adapter.calls and set(adapter.calls) == {"quick"}


async def test_a_failing_part_never_stops_the_match(tmp_path):
    app = build(tmp_path, FakeWatcher(fail=True), FakeDesigner(fail=True), None)
    setup = tennis_setup()
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game, Client(f"ws://{host}/watch") as viewer:
            await game.send(setup)
            ready = await game.until("ready")
            assert ready["behaviour"] == setup["default_behaviour"]
            await play_round(game, "m_001", 1)
            await game.drain(0.2)
            seen = await viewer.drain(0.2)
            failed = {l["message"]["stage"] for l in seen if l["message"].get("status") == "error"}
            assert failed == {"designer", "watcher"}
            assert [m["type"] for m in game.got] == ["ready"]


async def test_the_second_screen_is_served_when_it_exists(tmp_path):
    (tmp_path / "screen").mkdir()
    (tmp_path / "screen" / "index.html").write_text("<h1>second screen</h1>")
    app = build(tmp_path, screen_dir=tmp_path / "screen")
    async with running(app) as host:
        async with httpx.AsyncClient() as http:
            assert "second screen" in (await http.get(f"http://{host}/screen/")).text
    app = build(tmp_path, screen_dir=tmp_path / "nothing_here")
    async with running(app) as host:
        async with httpx.AsyncClient() as http:
            assert (await http.get(f"http://{host}/screen/")).status_code == 404
            assert (await http.get(f"http://{host}/health")).json()["parts"] == {
                "watcher": False, "designer": False, "adapter": False,
            }
