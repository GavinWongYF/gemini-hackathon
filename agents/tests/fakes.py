"""Stand-ins for the tests: fake parts, a scripted game and a server on a free port.

Nothing here calls a model. The fake designer, watcher and adapter build
their answers from `setup` alone, so they work for any game.
"""
from __future__ import annotations

import asyncio
import contextlib
import copy
import json
import socket
from typing import Any, AsyncIterator

import uvicorn
import websockets

from server.interfaces import Design, MatchState, Matchup, Message, ValueSpec, trace_message
from server.session import Settings, baseline_behaviour

# Fast pacing, so a whole match fits in a test.
FAST = dict(ready_wait=0.3, practice_timeout=2.0, read_gap=0.02, first_adapt_delay=0.05, grace=0.0)


def fast_settings(**changes: Any) -> Settings:
    return Settings(**{**FAST, **changes})


# ------------------------------------------------------------------ a game

TENNIS_SETUP: Message = {
    "type": "setup",
    "match_id": "m_001",
    "game": "tennis",
    "about": "One human player with a racket controller plays single points against one AI opponent. "
             "The player is at the bottom of the screen and the opponent is at the top.",
    "mode": "live",
    "goal": "Start beatable. Work out what this player relies on to win points and take it away, "
            "one habit at a time, until the player wins about half the points.",
    "plan": {"rounds": 5, "break_every": 1, "break_seconds": 3, "update_seconds": 20},
    "lists": {
        "zone": ["left_short", "middle_short", "right_short", "left_deep", "middle_deep", "right_deep"],
        "shot_type": ["flat", "lob", "drop"],
    },
    "npcs": {
        "opponent": {
            "about": "The AI on the other side of the net.",
            "decisions": {
                "shot_type": {
                    "when": "Each time it hits the ball.",
                    "options": {"flat": "Fast and low.", "lob": "High and deep.", "drop": "Soft and short."},
                },
                "aim": {
                    "when": "Each time it hits the ball.",
                    "options": {
                        "left_deep": "Deep to the left.", "middle_deep": "Deep down the middle.",
                        "right_deep": "Deep to the right.", "left_short": "Short to the left.",
                        "right_short": "Short to the right.",
                    },
                },
                "position": {
                    "when": "Right after it hits the ball.",
                    "options": {
                        "middle_deep": "Wait at the middle of the baseline.", "left_deep": "Wait on the left.",
                        "right_deep": "Wait on the right.", "middle_short": "Come up to the net.",
                    },
                },
            },
        },
    },
    "events": {
        "shot": {
            "about": "Either side hit the ball.",
            "fields": {
                "rally": "number",
                "side": ["forehand", "backhand"],
                "shot_type": "shot_type",
                "power": {"min": 0, "max": 1, "about": "How hard the swing was."},
                "from": "zone",
                "lands": "zone",
                "result": ["in", "out", "net"],
            },
        },
    },
    "facts": {
        "player_position": "zone",
        "player_last_side": ["forehand", "backhand"],
        "rally_length": "number",
    },
    "views": {
        "court": "The game screen, with both halves of the court.",
        "player_cam": "A webcam on the player.",
    },
    "settings": {},
    "default_behaviour": {
        "version": 0,
        "npcs": {
            "opponent": {
                "decisions": {
                    "shot_type": {"flat": {"base": 0.5}, "lob": {"base": 0.25}, "drop": {"base": 0.25}},
                    "aim": {
                        "left_deep": {"base": 0.25}, "middle_deep": {"base": 0.3}, "right_deep": {"base": 0.25},
                        "left_short": {"base": 0.1}, "right_short": {"base": 0.1},
                    },
                    "position": {
                        "middle_deep": {"base": 0.7}, "left_deep": {"base": 0.1},
                        "right_deep": {"base": 0.1}, "middle_short": {"base": 0.1},
                    },
                },
                "rules": [],
            },
        },
    },
}

PRACTICE = {
    "players": {
        "forehand_lover": {"about": "Hits about 70% forehands, mostly cross-court."},
        "even": {"about": "No clear habit."},
    },
}


def tennis_setup(match_id: str = "m_001", mode: str = "live", practice: bool = False, **plan: Any) -> Message:
    """A fresh copy of the tennis `setup`, ready to change."""
    setup = copy.deepcopy(TENNIS_SETUP)
    setup["match_id"] = match_id
    setup["mode"] = mode
    setup["plan"].update(plan)
    if practice:
        setup["practice"] = copy.deepcopy(PRACTICE)
    return setup


def player_shot(match_id: str, round_number: int, t: float, side: str = "forehand", lands: str = "left_deep") -> Message:
    return {
        "type": "event", "match_id": match_id, "name": "shot", "round": round_number, "t": t, "by": "player",
        "data": {"rally": 1, "side": side, "shot_type": "flat", "power": 0.6, "from": "middle_deep", "lands": lands, "result": "in"},
    }


def opponent_shot(match_id: str, round_number: int, t: float) -> Message:
    return {
        "type": "event", "match_id": match_id, "name": "shot", "round": round_number, "t": t, "by": "opponent",
        "picked": {"shot_type": "lob", "aim": "left_deep", "position": "middle_deep"}, "by_rule": [],
        "data": {"shot_type": "lob", "lands": "right_deep", "result": "in"},
    }


def frames(match_id: str, round_number: int, t: float) -> Message:
    picture = {"mime_type": "image/jpeg", "data": "QUJD"}
    return {"type": "frames", "match_id": match_id, "round": round_number, "t": t,
            "views": {"court": picture, "player_cam": dict(picture)}}


def round_end(match_id: str, round_number: int, t: float, winner: str = "player", rest: bool = True) -> Message:
    return {
        "type": "round_end", "match_id": match_id, "round": round_number, "t": t, "winner": winner,
        "how": "winner", "stats": {"rally_length": 4}, "score": {"player": round_number, "opponent": 0}, "break": rest,
    }


def practice_result(run: Message) -> Message:
    """What a game with a no-screen mode would send back for one `practice_run`."""
    player = run["player"]
    return {
        "type": "practice_result", "match_id": run["match_id"], "run_id": run["run_id"],
        "player": player["name"] if isinstance(player, dict) else player,
        "rounds": run["rounds"], "wins": {"player": run["rounds"] - 1, "opponent": 1},
        "stats": {"average_exchanges": 4.0},
    }


# ---------------------------------------------------------------- the parts

def _first(mapping: dict[str, Any]) -> str:
    return next(iter(mapping))


def _named_field(setup: Message) -> tuple[str, str, list[str]]:
    """The first event field that takes a list of names: (event, field, names)."""
    for event_name, event in setup["events"].items():
        for field_name, spec in event.get("fields", {}).items():
            names = spec if isinstance(spec, list) else setup.get("lists", {}).get(spec) if isinstance(spec, str) else None
            if isinstance(names, list):
                return event_name, field_name, names
    raise ValueError("this setup has no event field that takes a list of names")


class FakeDesigner:
    """Tracks one value per name of the first named field, and playtests if it can."""

    def __init__(self, delay: float = 0.0, fail: bool = False) -> None:
        self.delay = delay
        self.fail = fail
        self.calls = 0
        self.playtested = False

    async def design(self, setup: Message, playtest: Any, trace: Any) -> Design:
        self.calls += 1
        trace(trace_message("designer", "start", "Reading the setup."))
        await asyncio.sleep(self.delay)
        if self.fail:
            raise RuntimeError("the designer broke")
        event_name, field_name, names = _named_field(setup)
        values = [
            ValueSpec(
                name=f"{field_name}_{name}",
                about=f"Picks {name} for {field_name}",
                question={"event": event_name, "field": field_name, "value": name},
            )
            for name in names
        ]
        behaviour = baseline_behaviour(setup)
        behaviour["version"] = 1
        npc = _first(behaviour["npcs"])
        decision = _first(setup["npcs"][npc]["decisions"])
        option = _first(setup["npcs"][npc]["decisions"][decision]["options"])
        behaviour["npcs"][npc].setdefault("decisions", {}).setdefault(decision, {}).setdefault(option, {"base": 1})
        behaviour["npcs"][npc]["decisions"][decision][option]["when"] = {values[0].name: 0.5}

        matchups: list[Matchup] = []
        if playtest is not None:
            self.playtested = True
            one_option = {"version": 0, "npcs": {npc: {"decisions": {decision: {option: {"base": 1}}}, "rules": []}}}
            # One player the game named, and one persona written here.
            players: list[Any] = list((setup.get("practice") or {}).get("players", {}))[:1]
            players.append({"name": "leans_one_way", "about": "Leans on one choice.",
                            "plays": {event_name: {field_name: {names[0]: 0.8, names[-1]: 0.2}}}})
            results = await asyncio.gather(*(playtest.run(one_option, player, 4) for player in players))
            for result in results:
                matchups.append(Matchup(
                    player=result["player"], npc=npc, decision=decision, option=option,
                    rounds=result["rounds"], npc_wins=result["wins"].get(npc, 0), stats=result.get("stats", {}),
                ))
        trace(trace_message("designer", "done", f"Tracking {len(values)} values."))
        return Design(values=values, behaviour=behaviour, matchups=matchups, notes=["A fake design, built from the setup."])


class FakeWatcher:
    """Reads each value as the share of the player's events that match it."""

    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.reads = 0
        self.warmed = 0
        self.in_flight = 0
        self.most_in_flight = 0

    async def warm(self) -> None:
        self.warmed += 1

    async def read(self, match: MatchState) -> Message | None:
        self.reads += 1
        self.in_flight += 1
        self.most_in_flight = max(self.most_in_flight, self.in_flight)
        try:
            await asyncio.sleep(0.01)
            if self.fail:
                raise RuntimeError("the watcher broke")
            mine = [event for event in match.events if event.get("by") == "player"]
            if not mine or not match.design.values:
                return None
            for spec in match.design.values:
                question = spec.question
                hits = sum(1 for e in mine if (e.get("data") or {}).get(question.get("field")) == question.get("value"))
                match.player.values[spec.name] = round(hits / len(mine), 3)
            match.player.reads += 1
            return {
                "type": "player_read", "match_id": match.match_id, "round": mine[-1].get("round", 1),
                "t": mine[-1].get("t", 0), "values": dict(match.player.values),
                "based_on_events": len(mine), "why": f"Counted {len(mine)} player events.",
            }
        finally:
            self.in_flight -= 1


class FakeAdapter:
    """Leans a little harder on one option each time, and installs one rule."""

    def __init__(self, delay: float = 0.0, broken: bool = False) -> None:
        self.delay = delay
        self.broken = broken          # True: answers with an option the game never declared
        self.calls: list[str] = []
        self.in_flight = 0
        self.most_in_flight = 0

    async def adapt(self, match: MatchState, source: str) -> Message | None:
        self.calls.append(source)
        self.in_flight += 1
        self.most_in_flight = max(self.most_in_flight, self.in_flight)
        try:
            await asyncio.sleep(self.delay)
            setup = match.setup
            behaviour = copy.deepcopy(match.behaviour)
            version = behaviour.get("version", 0) + 1
            behaviour["version"] = version
            npc = _first(setup["npcs"])
            decision = _first(setup["npcs"][npc]["decisions"])
            options = list(setup["npcs"][npc]["decisions"][decision]["options"])
            entry = behaviour["npcs"].setdefault(npc, {"decisions": {}, "rules": []})
            option = entry.setdefault("decisions", {}).setdefault(decision, {}).setdefault(options[-1], {"base": 0})
            before = copy.deepcopy(option)
            option["base"] = round(option.get("base", 0) + 0.1, 3)
            if self.broken:
                entry["decisions"][decision]["moonball"] = {"base": 1}
            fact = _first(setup["facts"])
            allowed = setup["facts"][fact]
            allowed = allowed if isinstance(allowed, list) else setup["lists"][allowed]
            entry["rules"] = [{
                "if": [{"fact": fact, "in": allowed[:2]}],
                "do": {decision: options[-1]},
                "why": "The player keeps winning from there.",
            }]
            return {
                "type": "strategy_update", "match_id": match.match_id, "version": version, "source": source,
                "observations": [f"Seen {len(match.events)} events so far."],
                "plan": [f"Play {options[-1]} more often."],
                "changes": [{
                    "where": f"{npc}.{decision}.{options[-1]}", "from": before, "to": option,
                    "why": "It answers the player's favourite play.", "expect": "The favourite play should pay less.",
                }],
                "behaviour": behaviour,
            }
        finally:
            self.in_flight -= 1


# ------------------------------------------------------- a server and clients

def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@contextlib.asynccontextmanager
async def running(app: Any) -> AsyncIterator[str]:
    """Serve `app` on a free port for the length of the block. Yields "127.0.0.1:<port>"."""
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        if task.done():
            task.result()
        await asyncio.sleep(0.01)
    try:
        yield f"127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await task


class Client:
    """A scripted socket client. Keeps everything it is sent, in order."""

    def __init__(self, url: str) -> None:
        self.url = url
        self.got: list[Message] = []
        self.sent: list[Message] = []
        self._socket: Any = None

    async def __aenter__(self) -> "Client":
        self._socket = await websockets.connect(self.url, max_size=None)
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self._socket.close()

    async def send(self, message: Message) -> None:
        self.sent.append(message)
        await self._socket.send(json.dumps(message))

    async def send_raw(self, text: str) -> None:
        await self._socket.send(text)

    async def next(self, timeout: float = 2.0) -> Message:
        message = json.loads(await asyncio.wait_for(self._socket.recv(), timeout))
        self.got.append(message)
        return message

    async def until(self, wanted: Any, timeout: float = 2.0) -> Message:
        """Read until a message passes `wanted`: a type name, or a function of the message."""
        test = wanted if callable(wanted) else (lambda m: _kind(m) == wanted)
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            left = deadline - asyncio.get_running_loop().time()
            if left <= 0:
                raise AssertionError(f"never got {wanted!r}. Got: {[_kind(m) for m in self.got]}")
            try:
                message = await self.next(left)
            except asyncio.TimeoutError:
                continue
            if test(message):
                return message

    async def drain(self, seconds: float = 0.2) -> list[Message]:
        """Read whatever arrives in the next `seconds`."""
        start = len(self.got)
        deadline = asyncio.get_running_loop().time() + seconds
        while (left := deadline - asyncio.get_running_loop().time()) > 0:
            try:
                await self.next(left)
            except asyncio.TimeoutError:
                break
        return self.got[start:]


def _kind(line: Message) -> str:
    """The type of a game message, or of the message inside a viewer line."""
    return line["message"].get("type") if "dir" in line and "message" in line else line.get("type")
