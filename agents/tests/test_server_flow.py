"""The server core, end to end, against fake parts and a scripted game."""
from __future__ import annotations

import asyncio
import json
import time

import httpx
from fakes import (
    Client, FakeAdapter, FakeDesigner, FakeWatcher, fast_settings, frames, opponent_shot,
    player_shot, practice_result, round_end, running, tennis_setup,
)

from server.app import create_app
from server.contract import check_message


def one_at_a_time(**changes):
    """The pacing most tests here use: one look in flight, and no wait between updates."""
    return fast_settings(**{"parallel": 1, "update_gap": 0.0, "stop_on_change": False, **changes})


def two_at_a_time(**changes):
    """Two looks in flight, for a game that does not stop when a change arrives."""
    return fast_settings(**{"parallel": 2, "stop_on_change": False, **changes})


class TimedAdapter(FakeAdapter):
    """A fake adapter whose looks each take a set time. Look n's update says "look n"."""

    def __init__(self, delays, instead=None):
        super().__init__()
        self.delays = list(delays)
        self.instead = instead or {}     # look number -> what to hand back in place of an update
        self.starts: list[float] = []
        self.flying = self.most = 0

    async def adapt(self, match, source):
        number = len(self.starts) + 1
        self.starts.append(time.monotonic())
        self.flying += 1
        self.most = max(self.most, self.flying)
        try:
            await asyncio.sleep(self.delays[min(number, len(self.delays)) - 1])
            if number in self.instead:
                return self.instead[number]
            update = await super().adapt(match, source)
            update["observations"] = [f"look {number}"]
            return update
        finally:
            self.flying -= 1


def build(tmp_path, watcher=None, designer=None, adapter=None, **options):
    settings = options.pop("settings", None) or one_at_a_time()
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

            # After all that, the match still works. The read and the update can come in either order.
            before = len(game.got)
            await play_round(game, "m_001", 1)
            await game.drain(0.5)
            assert {"player_read", "strategy_update"} <= {m["type"] for m in game.got[before:]}
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
    app = build(tmp_path, FakeWatcher(), designer, FakeAdapter(), settings=one_at_a_time(ready_wait=0.1))
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
    app = build(tmp_path, None, FakeDesigner(), adapter, settings=one_at_a_time(first_adapt_delay=0.2))
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


# ------------------------------------------------------------------ pace: reads, the first look, two looks at once

async def test_the_first_look_starts_after_a_few_player_events(tmp_path):
    adapter = TimedAdapter([0.05])
    app = build(tmp_path, None, FakeDesigner(), adapter, settings=one_at_a_time(first_adapt_events=3, first_adapt_delay=5.0))
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup())
            await game.until("ready")
            await game.send(player_shot("m_001", 1, 1.0))
            await game.send(opponent_shot("m_001", 1, 1.5))
            await game.send(player_shot("m_001", 1, 2.0))
            await game.drain(0.2)
            assert adapter.starts == []                  # two player events are not enough, and the delay is far off
            await game.send(player_shot("m_001", 1, 3.0))
            assert (await game.until("strategy_update", timeout=1.0))["observations"] == ["look 1"]


async def test_two_looks_overlap_and_land_in_the_order_they_started(tmp_path):
    adapter = TimedAdapter([0.6, 0.1])     # the second look comes back long before the first
    settings = two_at_a_time(stagger=0.15, update_gap=0.25, first_adapt_events=1)
    app = build(tmp_path, None, FakeDesigner(), adapter, settings=settings)
    setup = tennis_setup()
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(setup)
            await game.until("ready")
            await game.send(player_shot("m_001", 1, 1.0))      # look 1 starts
            await asyncio.sleep(0.05)
            await game.send(player_shot("m_001", 1, 2.0))      # news, but look 1 is too young: look 2 waits for the stagger
            await asyncio.sleep(0.05)
            assert len(adapter.starts) == 1
            first = await game.until("strategy_update", timeout=2.0)
            landed_first = time.monotonic()
            second = await game.until("strategy_update", timeout=2.0)
            gap = time.monotonic() - landed_first
            assert [first["observations"], second["observations"]] == [["look 1"], ["look 2"]]
            assert second["version"] == first["version"] + 1
            assert check_message(setup, first) == [] and check_message(setup, second) == []
            assert adapter.most == 2 and len(adapter.starts) == 2
            assert 0.13 <= adapter.starts[1] - adapter.starts[0] < 0.5     # the stagger, not the first look's 0.6 seconds
            assert gap >= 0.2                                               # never two updates close together
            assert await game.drain(0.3) == []                              # no news since look 2 started


async def test_no_second_look_without_news(tmp_path):
    adapter = TimedAdapter([0.5])
    app = build(tmp_path, None, FakeDesigner(), adapter, settings=two_at_a_time(stagger=0.1, first_adapt_events=1))
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup())
            await game.until("ready")
            await game.send(player_shot("m_001", 1, 1.0))
            await game.send(opponent_shot("m_001", 1, 2.0))    # the opponent's shot is not news about the player
            await game.send(frames("m_001", 1, 2.5))
            await game.until("strategy_update", timeout=2.0)
            await game.drain(0.3)
            assert len(adapter.starts) == 1 and adapter.most == 1
            await game.send(round_end("m_001", 1, 5.0, winner="opponent"))   # any finished round is news
            await game.until("strategy_update", timeout=2.0)
            assert len(adapter.starts) == 2


async def test_no_look_starts_after_the_game_has_left(tmp_path):
    adapter = TimedAdapter([0.4])
    app = build(tmp_path, None, FakeDesigner(), adapter, settings=two_at_a_time(stagger=0.2, first_adapt_events=1))
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup())
            await game.until("ready")
            await game.send(player_shot("m_001", 1, 1.0))      # look 1 starts
            await asyncio.sleep(0.05)
            await game.send(player_shot("m_001", 1, 2.0))      # news: look 2 is due once the stagger has passed
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.8)                               # the game has gone before the stagger passed
        assert len(adapter.starts) == 1
        assert app.state.sessions["m_001"].match.behaviour["version"] == 2   # look 1 still landed


async def test_an_adapter_that_is_waiting_gets_a_look_when_the_next_round_ends(tmp_path):
    class WaitingAdapter(TimedAdapter):
        """Says it is holding a ready step for the match, as the real adapter can."""

        def waiting(self, match_id):
            return match_id == "m_001" and len(self.starts) == 1

    # The first look hands back nothing. With a step held, the long rest is skipped at the next round end.
    adapter = WaitingAdapter([0.02], instead={1: None})
    app = build(tmp_path, None, FakeDesigner(), adapter, settings=one_at_a_time(rest=30.0, first_adapt_events=1))
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup())
            await game.until("ready")
            await game.send(player_shot("m_001", 1, 1.0))
            await game.drain(0.15)
            assert len(adapter.starts) == 1 and [m["type"] for m in game.got] == ["ready"]
            await game.send(player_shot("m_001", 1, 2.0))
            await game.drain(0.1)
            assert len(adapter.starts) == 1                      # a new event alone does not start it
            await game.send(round_end("m_001", 1, 5.0))
            assert (await game.until("strategy_update", timeout=1.0))["observations"] == ["look 2"]

    # An adapter with no `waiting` rests after a look that changed nothing.
    adapter = TimedAdapter([0.02], instead={1: None})
    app = build(tmp_path, None, FakeDesigner(), adapter, settings=one_at_a_time(rest=30.0, first_adapt_events=1))
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup())
            await game.until("ready")
            await game.send(player_shot("m_001", 1, 1.0))
            await game.drain(0.15)
            await game.send(round_end("m_001", 1, 5.0))
            await game.drain(0.3)
            assert len(adapter.starts) == 1


async def test_pictures_move_the_read_during_a_rally_and_reads_are_counted(tmp_path):
    watcher = FakeWatcher()
    settings = one_at_a_time(read_gap=0.02, frame_gap=0.05, rally_seconds=0.3, report_every=0.5)
    app = build(tmp_path, watcher, FakeDesigner(), None, settings=settings)
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game, Client(f"ws://{host}/watch") as viewer:
            await game.send(tennis_setup())
            await game.until("ready")
            await game.send(player_shot("m_001", 1, 1.0))
            await game.until("player_read")
            assert watcher.reads == 1
            for step in range(3):                       # pictures between shots, while the rally is on
                await asyncio.sleep(0.07)
                await game.send(frames("m_001", 1, 1.1 + step / 10))
            await game.drain(0.1)
            in_rally = watcher.reads
            assert in_rally >= 3 and watcher.most_in_flight == 1
            await asyncio.sleep(0.35)                   # the rally is over, and the player is not idle for long enough
            await game.send(frames("m_001", 1, 2.0))
            await game.drain(0.1)
            assert watcher.reads == in_rally
            report = await viewer.until(lambda line: "reads_started" in (line["message"].get("data") or {}), timeout=2.0)
            data = report["message"]["data"]
            assert report["message"]["stage"] == "server" and data["reads_started"] == in_rally
            assert data["reads_answered"] == in_rally and data["median_ms"] >= 10 and data["reads_per_second"] > 0


async def test_pictures_stop_starting_reads_when_nobody_is_playing(tmp_path):
    watcher = FakeWatcher()
    settings = one_at_a_time(read_gap=0.02, frame_gap=0.02, rally_seconds=0.1, away_seconds=0.25)
    app = build(tmp_path, watcher, FakeDesigner(), None, settings=settings)
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game, Client(f"ws://{host}/watch") as viewer:
            await game.send(tennis_setup())
            await game.until("ready")
            await game.send(player_shot("m_001", 1, 1.0))
            await game.until("player_read")
            await asyncio.sleep(0.3)                         # nobody has played for longer than the limit
            before = watcher.reads
            for step in range(3):
                await game.send(opponent_shot("m_001", 1, 2.0 + step))   # the opponent playing on does not count
                await game.send(frames("m_001", 1, 2.5 + step))
            await game.drain(0.15)
            assert watcher.reads == before
            seen = await viewer.drain(0.1)
            paused = [l["message"]["about"] for l in seen if "reads are paused" in l["message"].get("about", "")]
            assert paused == ["No one has played for 0.25 seconds, so reads are paused."]     # said once
            await game.send(player_shot("m_001", 1, 6.0))    # the player is back, so reads start again
            await game.until("player_read")
            assert watcher.reads == before + 1
            assert app.state.sessions["m_001"]._reads_paused is False


# ------------------------------------------------------------------ a game that stops at every change

# Everything here runs twenty times faster than a real match: 0.05 stands for one second.
# These settings let a look start at the first player event after a change (look_after_resume off). A test
# that wants the default, where the look waits for a later round, says so.
STOPPING = dict(
    parallel=2, stagger=0.4, update_gap=0.0, first_adapt_events=3, first_adapt_delay=0.3,
    play_gap=0.15, resume_play=0.1, min_play=0.5, look_after_resume=False,
)


async def play_with_stops(game, match_id, seconds, stop=0.3, step=0.05, new_round_after_stop=False):
    """Send a player event every `step`. Whenever a change arrives, stop for `stop`, as the game does.

    With `new_round_after_stop` the point ends at each stop, and play picks up in the next round.
    """
    end = time.monotonic() + seconds
    number, round_number = 0, 1
    while time.monotonic() < end:
        number += 1
        await game.send(player_shot(match_id, round_number, float(number)))
        got = await game.drain(step)
        if any(m["type"] == "strategy_update" and m.get("changes") for m in got):
            if new_round_after_stop:
                await game.send(round_end(match_id, round_number, float(number)))
                round_number += 1
            await game.drain(stop)


def cadence(lines):
    """The data of every "a change went out" trace, and how many results were dropped."""
    changes = [l["message"]["data"] for l in lines if "play_seconds_since_last_change" in (l["message"].get("data") or {})]
    dropped = sum(1 for l in lines if l["message"].get("about") == "A newer change is already in, so this one is dropped.")
    return changes, dropped


async def test_one_change_per_stretch_of_play_and_the_look_in_flight_is_dropped(tmp_path):
    adapter = TimedAdapter([0.45])                     # stands for a 9 second look that always changes something
    app = build(tmp_path, None, FakeDesigner(), adapter, settings=fast_settings(**STOPPING))
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup(rounds=999))
            await game.until("ready")
            await play_with_stops(game, "m_001", 3.6)
            await game.drain(0.6)
            session = app.state.sessions["m_001"]
            changes, dropped = cadence(app.state.hub.history["m_001"])
            real = [m for m in game.got if m["type"] == "strategy_update" and m.get("changes")]

            assert len(changes) >= 3 and len(real) == len(changes) == session.real_updates
            assert [c["real_updates"] for c in changes] == list(range(1, len(changes) + 1))
            # Never a change inside the minimum of play since the last one, and never a long wait for one.
            assert all(0.5 <= c["play_seconds_since_last_change"] <= 1.0 for c in changes), changes
            # Each one stopped the game, so in wall time they are a stop plus that play apart.
            assert all(c["wall_seconds_since_last_change"] >= 0.75 for c in changes[1:]), changes
            # The second look of each pair was still in flight when the change went out. Its result never reached the game.
            assert dropped >= 2 and len(adapter.starts) >= len(changes) + dropped
            assert [m["version"] for m in real] == sorted({m["version"] for m in real})
            assert session.play_seconds < 3.6 - 0.3 * (len(changes) - 1)       # the stops did not count as play


async def test_holding_updates_are_not_held_and_do_not_count_as_changes(tmp_path):
    class HoldsEveryOtherTime(TimedAdapter):
        async def adapt(self, match, source):
            number = len(self.starts) + 1
            update = await super().adapt(match, source)
            if number % 2 == 1:
                update["changes"], update["holding"] = [], True
            return update

    adapter = HoldsEveryOtherTime([0.45])
    app = build(tmp_path, None, FakeDesigner(), adapter, settings=fast_settings(**STOPPING))
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup(rounds=999))
            await game.until("ready")
            await play_with_stops(game, "m_001", 4.0)
            await game.drain(0.6)
            changes, _ = cadence(app.state.hub.history["m_001"])
            updates = [m for m in game.got if m["type"] == "strategy_update"]
            real = [m for m in updates if m.get("changes")]
            holding = [m for m in updates if m.get("holding")]

            assert len(real) >= 2 and len(real) == len(changes) and len(holding) >= 1
            assert updates[0].get("holding") is True          # the first look held, and that went straight out
            assert all(c["play_seconds_since_last_change"] >= 0.5 for c in changes), changes
            assert all(c["wall_seconds_since_last_change"] >= 0.75 for c in changes[1:]), changes


async def test_a_change_that_is_ready_too_soon_waits_for_the_play_clock(tmp_path):
    adapter = TimedAdapter([0.05])                     # a look that comes back at once
    settings = fast_settings(**{**STOPPING, "parallel": 1, "first_adapt_events": 1})
    app = build(tmp_path, None, FakeDesigner(), adapter, settings=settings)
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup(rounds=999))
            await game.until("ready")
            for number in range(1, 5):                 # 0.15 of play: far too soon for a change
                await game.send(player_shot("m_001", 1, float(number)))
                await asyncio.sleep(0.05)
            session = app.state.sessions["m_001"]
            assert len(adapter.starts) == 1 and session._holding_real and session.real_updates == 0
            await game.drain(0.4)                      # a stop: the clock does not move, so it stays held
            assert session.real_updates == 0 and len(adapter.starts) == 1
            for number in range(5, 16):                # play on until the clock allows it
                await game.send(player_shot("m_001", 1, float(number)))
                await asyncio.sleep(0.05)
            update = await game.until("strategy_update", timeout=1.0)
            assert update["observations"] == ["look 1"] and session.real_updates == 1
            assert 0.5 <= session._last_real_play <= 0.65


async def test_one_look_at_a_time_gives_one_look_and_one_change_per_stretch_of_play(tmp_path):
    adapter = TimedAdapter([0.45])
    app = build(tmp_path, None, FakeDesigner(), adapter, settings=fast_settings(**{**STOPPING, "parallel": 1}))
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup(rounds=999))
            await game.until("ready")
            await play_with_stops(game, "m_001", 3.6)
            await game.drain(0.6)
            changes, dropped = cadence(app.state.hub.history["m_001"])
            assert len(changes) >= 3 and dropped == 0 and adapter.most == 1
            assert len(changes) <= len(adapter.starts) <= len(changes) + 1          # one look for each change
            assert all(0.5 <= c["play_seconds_since_last_change"] <= 1.0 for c in changes), changes


async def test_one_look_at_a_time_is_the_default():
    from server.session import Settings

    assert Settings().parallel == 1


async def test_nothing_delays_a_look_when_a_round_ends_and_the_last_change_is_old_enough(tmp_path):
    for min_play, looks_after_round_end in ((0.2, 2), (5.0, 1)):
        adapter = TimedAdapter([0.02], instead={1: None})          # the first look changes nothing, so a long rest begins
        settings = fast_settings(**{**STOPPING, "parallel": 1, "first_adapt_events": 1, "rest": 30.0, "min_play": min_play})
        app = build(tmp_path, None, FakeDesigner(), adapter, settings=settings)
        async with running(app) as host:
            async with Client(f"ws://{host}/ws") as game:
                await game.send(tennis_setup(rounds=999))
                await game.until("ready")
                for number in range(1, 8):                         # 0.3 of play
                    await game.send(player_shot("m_001", 1, float(number)))
                    await asyncio.sleep(0.05)
                assert len(adapter.starts) == 1                    # resting: more events alone start nothing
                await game.send(round_end("m_001", 1, 9.0))
                await game.drain(0.2)
                # With the last change old enough, the round end starts a look at once. Otherwise the rest holds.
                assert len(adapter.starts) == looks_after_round_end, min_play


async def test_values_say_what_they_count_and_the_match_carries_the_play_clock(tmp_path):
    class CountingDesigner(FakeDesigner):
        async def design(self, setup, playtest, trace):
            design = await super().design(setup, playtest, trace)
            design.values[0].counts = {"event": "shot", "field": "side", "values": ["forehand"]}
            design.values[1].counts = None
            design.values[1].kind = "camera"
            return design

    setup = tennis_setup()
    for wait, where in ((0.3, "values"), (0.05, "new_values")):       # in `ready`, and when the design lands late
        designer = CountingDesigner(delay=0.0 if where == "values" else 0.3)
        app = build(tmp_path / where, None, designer, None, settings=one_at_a_time(ready_wait=wait))
        async with running(app) as host:
            async with Client(f"ws://{host}/ws") as game:
                await game.send(setup)
                message = await game.until("ready")
                if where == "new_values":
                    assert message["values"] == {}
                    message = await game.until("strategy_update")
                assert check_message(setup, message) == []
                counted, uncounted = message[where]["side_forehand"], message[where]["side_backhand"]
                assert counted == {"label": "Picks forehand for side", "kind": "share", "event": "shot", "field": "side"}
                assert uncounted == {"label": "Picks backhand for side", "kind": "camera"}

                for number in range(1, 5):
                    await game.send(player_shot("m_001", 1, float(number)))
                    await asyncio.sleep(0.05)
                await game.send(round_end("m_001", 1, 5.0))
                await game.drain(0.05)
                session = app.state.sessions["m_001"]
                assert session.match.play_seconds == session.play_seconds and 0.15 <= session.play_seconds <= 0.4


async def test_after_a_change_the_next_look_starts_at_the_first_player_event(tmp_path):
    from server.session import Settings

    assert Settings().resume_play == 0
    adapter = TimedAdapter([0.05, 0.6])
    settings = fast_settings(**{**STOPPING, "parallel": 1, "first_adapt_events": 1, "min_play": 0.2, "resume_play": 0.0})
    app = build(tmp_path, None, FakeDesigner(), adapter, settings=settings)
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup(rounds=999))
            await game.until("ready")
            for number in range(1, 20):
                await game.send(player_shot("m_001", 1, float(number)))
                if any(m["type"] == "strategy_update" for m in await game.drain(0.05)):
                    break
            session = app.state.sessions["m_001"]
            assert session.real_updates == 1 and len(adapter.starts) == 1
            await game.drain(0.3)                                    # the game has stopped. Pictures alone start nothing.
            await game.send(frames("m_001", 1, 30.0))
            await game.drain(0.05)
            assert len(adapter.starts) == 1
            await game.send(player_shot("m_001", 1, 31.0))           # the first player event after the change
            await game.drain(0.05)
            assert len(adapter.starts) == 2                          # the look is under way, with no play needed first


async def test_look_after_resume_waits_for_a_player_event_in_a_later_round(tmp_path):
    from server.session import Settings

    assert Settings().look_after_resume is True          # the default: no look runs while the game is stopped
    adapter = TimedAdapter([0.05, 0.6])
    settings = fast_settings(**{
        **STOPPING, "parallel": 1, "first_adapt_events": 1, "min_play": 0.2, "resume_play": 0.0, "look_after_resume": True,
    })
    app = build(tmp_path, None, FakeDesigner(), adapter, settings=settings)
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup(rounds=999))
            await game.until("ready")
            for number in range(1, 20):
                await game.send(player_shot("m_001", 1, float(number)))
                if any(m["type"] == "strategy_update" for m in await game.drain(0.05)):
                    break
            session = app.state.sessions["m_001"]
            assert session.real_updates == 1 and len(adapter.starts) == 1
            await game.send(player_shot("m_001", 1, 30.0))           # the point in progress plays on: not yet
            await game.send(opponent_shot("m_001", 2, 31.0))         # the opponent serving the next point: not yet
            await game.drain(0.05)
            assert len(adapter.starts) == 1
            await game.send(player_shot("m_001", 2, 32.0))           # the player is playing a later round: play has resumed
            await game.drain(0.05)
            assert len(adapter.starts) == 2


async def test_after_a_kept_step_the_next_look_waits_for_a_later_round_whatever_the_switch_says(tmp_path):
    class KeptFirst(TimedAdapter):
        """Its first change is one it had kept ready, marked as the real adapter marks it."""

        async def adapt(self, match, source):
            number = len(self.starts) + 1
            update = await super().adapt(match, source)
            if number == 1:
                update["kept"] = True
            return update

    adapter = KeptFirst([0.05, 0.05, 0.6])
    settings = fast_settings(**{
        **STOPPING, "parallel": 1, "first_adapt_events": 1, "min_play": 0.2, "resume_play": 0.0, "look_after_resume": False,
    })
    app = build(tmp_path, None, FakeDesigner(), adapter, settings=settings)
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup(rounds=999))
            await game.until("ready")

            async def play(round_number, start):
                """Player events in one round until a change arrives. Returns that change."""
                for number in range(start, start + 20):
                    await game.send(player_shot("m_001", round_number, float(number)))
                    for message in await game.drain(0.05):
                        if message["type"] == "strategy_update":
                            return message
                raise AssertionError("no change arrived")

            first = await play(1, 1)
            assert first["kept"] is True and len(adapter.starts) == 1
            await game.send(player_shot("m_001", 1, 30.0))           # the same round plays on: no look yet
            await game.drain(0.05)
            assert len(adapter.starts) == 1
            second = await play(2, 40)                               # a later round: the look saw the kept step played
            assert "kept" not in second and len(adapter.starts) == 2
            await game.send(player_shot("m_001", 2, 80.0))           # after a change that was not kept, the switch decides:
            await game.drain(0.05)
            assert len(adapter.starts) == 3                          # it is off, so the first player event starts a look


# ------------------------------------------------------------------ a game stopped by hand

async def test_a_result_that_lands_while_the_game_is_stopped_waits_for_play(tmp_path):
    adapter = TimedAdapter([0.3])
    settings = one_at_a_time(first_adapt_events=1, send_window=0.15)
    app = build(tmp_path, None, FakeDesigner(), adapter, settings=settings)
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game, Client(f"ws://{host}/watch") as viewer:
            await game.send(tennis_setup(rounds=999))
            await game.until("ready")
            await game.send(player_shot("m_001", 1, 1.0))            # a look starts, then a person stops the game
            await game.send(frames("m_001", 1, 1.2))                 # pictures are not a sign of play
            assert await game.drain(0.7) == []                       # the look came back at 0.3, and nothing was sent
            assert len(adapter.starts) == 1 and app.state.sessions["m_001"].match.behaviour["version"] == 1
            await game.send(opponent_shot("m_001", 1, 9.0))          # play picks up: any event will do
            update = await game.until("strategy_update", timeout=1.0)
            assert update["observations"] == ["look 1"]
            sent = [l for l in await viewer.drain(0.1) if l["dir"] == "out" and l["message"]["type"] == "strategy_update"]
            assert len(sent) == 1


async def test_a_newer_result_replaces_one_that_is_waiting_for_play(tmp_path):
    adapter = TimedAdapter([0.2, 0.35])
    settings = two_at_a_time(stagger=0.05, first_adapt_events=1, update_gap=0.0, send_window=0.1)
    app = build(tmp_path, None, FakeDesigner(), adapter, settings=settings)
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup(rounds=999))
            await game.until("ready")
            await game.send(player_shot("m_001", 1, 1.0))            # look 1
            await asyncio.sleep(0.07)
            await game.send(player_shot("m_001", 1, 2.0))            # look 2, then the game is stopped
            assert await game.drain(0.7) == [] and len(adapter.starts) == 2
            await game.send(player_shot("m_001", 1, 9.0))
            got = await game.drain(0.3)
            assert [m["observations"] for m in got if m["type"] == "strategy_update"] == [["look 2"]]
            abouts = [l["message"].get("about") for l in app.state.hub.history["m_001"]]
            assert "A newer result is ready, so the one that was waiting for play is dropped." in abouts


async def test_with_looks_after_the_resume_there_is_still_one_change_per_stretch_of_play(tmp_path):
    adapter = TimedAdapter([0.45])
    settings = fast_settings(**{**STOPPING, "parallel": 1, "resume_play": 0.0, "look_after_resume": True})
    app = build(tmp_path, None, FakeDesigner(), adapter, settings=settings)
    async with running(app) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup(rounds=999))
            await game.until("ready")
            await play_with_stops(game, "m_001", 3.6, new_round_after_stop=True)
            await game.drain(0.6)
            changes, dropped = cadence(app.state.hub.history["m_001"])
            assert len(changes) >= 3 and dropped == 0 and adapter.most == 1
            assert len(changes) <= len(adapter.starts) <= len(changes) + 1
            # Each look started after the resume, so a change needs at least the look's own time in play.
            assert all(0.4 <= c["play_seconds_since_last_change"] <= 1.0 for c in changes[1:]), changes
            assert all(c["wall_seconds_since_last_change"] >= 0.7 for c in changes[1:]), changes
