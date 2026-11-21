"""A small client for the agent server, for games written in Python.

It opens the socket, sends `setup`, waits for `ready`, and keeps the latest
player values and the latest behaviour. A new behaviour is only swapped in
between rounds. `client.pick(...)` never waits on the network.

    client = Client(setup, on_practice_run=play_practice)
    await client.connect()
    client.start_round()                      # swaps in the newest behaviour
    option, by_rule = client.pick("opponent", "shot_type", ["topspin", "flat", "slice", "dropshot", "lob"], facts)
    await client.event("shot", round=1, by="player", data={...})
    await client.round_end(round=1, winner="player", how="winner", score={...})
"""
from __future__ import annotations

import asyncio
import inspect
import json
import time
from typing import Any, Awaitable, Callable

import websockets

from .pick import pick as _pick

Message = dict[str, Any]
PracticeHandler = Callable[[Message], "Message | Awaitable[Message]"]


class Client:
    def __init__(
        self,
        setup: Message,
        url: str = "ws://localhost:8000/ws",
        on_practice_run: PracticeHandler | None = None,
        on_message: Callable[[Message], None] | None = None,
    ) -> None:
        self.setup = setup
        self.match_id = setup["match_id"]
        self.url = url
        self.on_practice_run = on_practice_run
        self.on_message = on_message
        empty = {"version": 0, "npcs": {}}
        self.behaviour: Message = setup.get("default_behaviour") or empty  # what the NPCs use now
        self.pending: Message | None = None  # the newest strategy_update, not swapped in yet
        self.update: Message | None = None  # the last one swapped in, for the break screen
        self.values: dict[str, float] = {}
        self.labels: dict[str, str] = {}
        self.last_read: Message | None = None
        self.errors: list[Message] = []
        self._gap = True  # True between rounds
        self._ready = asyncio.Event()
        self._ws: Any = None
        self._reader: asyncio.Task | None = None
        self._t0 = time.monotonic()

    async def connect(self, ready_timeout: float = 90) -> bool:
        """Open the socket, send `setup` and wait for `ready`. False if it never came."""
        self._ws = await websockets.connect(self.url, max_size=None)
        self._t0 = time.monotonic()
        self._reader = asyncio.create_task(self._read())
        await self._send(self.setup)
        try:
            await asyncio.wait_for(self._ready.wait(), ready_timeout)
            return True
        except asyncio.TimeoutError:
            return False  # play on with the default behaviour

    async def close(self) -> None:
        if self._reader:
            self._reader.cancel()
        if self._ws:
            await self._ws.close()

    def t(self) -> float:
        """Seconds since the match started."""
        return round(time.monotonic() - self._t0, 2)

    # What the game sends.

    async def event(self, name: str, round: int, by: str, data: Message, *,
                    picked: Message | None = None, by_rule: list[str] | None = None,
                    t: float | None = None) -> None:
        msg = {"type": "event", "name": name, "round": round, "t": self._at(t), "by": by, "data": data}
        if picked is not None:
            msg["picked"] = picked
            msg["by_rule"] = by_rule or []
        await self._send(msg)

    async def frames(self, round: int, views: dict[str, Message], t: float | None = None) -> None:
        await self._send({"type": "frames", "round": round, "t": self._at(t), "views": views})

    async def round_end(self, round: int, winner: str, how: str, score: dict[str, int], *,
                        brk: bool = True, stats: Message | None = None, t: float | None = None) -> None:
        msg = {"type": "round_end", "round": round, "t": self._at(t), "winner": winner,
               "how": how, "score": score, "break": brk}
        if stats is not None:
            msg["stats"] = stats
        self._gap = True
        await self._send(msg)

    # Between rounds, and during play.

    def start_round(self) -> Message:
        """Swap in the newest behaviour. Returns the settings to apply this round."""
        self._gap = False
        if not self.pending:
            return {}
        self.update, self.pending = self.pending, None
        self.behaviour = self.update["behaviour"]
        return self.update.get("settings", {})

    def pick(self, npc: str, decision: str, legal: list[str], facts: Message | None = None) -> tuple[str, bool]:
        """The option to play, and whether a rule decided it. Never waits."""
        if self._gap:
            self.start_round()
        return _pick(npc, decision, legal, self.behaviour, self.values, facts or {})

    # What comes back.

    async def _read(self) -> None:
        async for raw in self._ws:
            msg = json.loads(raw)
            kind = msg.get("type")
            if kind == "ready":
                self.behaviour = msg["behaviour"]
                self._labels(msg.get("values", {}))
                self._ready.set()
            elif kind == "player_read":
                self.values = msg.get("values", {})
                self.last_read = msg
            elif kind == "strategy_update":
                self._labels(msg.get("new_values", {}))
                newest = self.pending or {"version": self.behaviour.get("version", 0)}
                if msg.get("version", 0) >= newest.get("version", 0):
                    self.pending = msg
            elif kind == "practice_run":
                asyncio.create_task(self._practice(msg))
            elif kind == "error":
                self.errors.append(msg)
            if self.on_message:
                self.on_message(msg)

    async def _practice(self, run: Message) -> None:
        if not self.on_practice_run:
            return
        result = self.on_practice_run(run)
        if inspect.isawaitable(result):
            result = await result
        player = run["player"]["name"] if isinstance(run["player"], dict) else run["player"]
        await self._send({"type": "practice_result", "run_id": run["run_id"], "player": player,
                          "rounds": run["rounds"], **result})

    def _labels(self, values: Message) -> None:
        self.labels.update({name: spec.get("label", name) for name, spec in values.items()})

    def _at(self, t: float | None) -> float:
        return self.t() if t is None else t

    async def _send(self, msg: Message) -> None:
        msg.setdefault("match_id", self.match_id)
        try:
            await self._ws.send(json.dumps(msg))
        except Exception:
            pass  # the game never stops for the network
