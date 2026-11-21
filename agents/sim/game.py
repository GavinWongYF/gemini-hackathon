"""The stand-in game: plays a match over the socket exactly as the contract says.

It sends `setup`, waits for `ready`, plays its rounds with a scripted player,
and picks every NPC move locally with `pick`. It never waits on the agents
during a round. A `strategy_update` can land at any moment. The newest one is
kept and swapped in at the next gap between rounds.
"""
from __future__ import annotations

import asyncio
import copy
import json
import random
import sys
import time
from dataclasses import dataclass, field
from typing import Any

import websockets

from .headless import SimModel, run_sync

Message = dict[str, Any]

# From this long, a break gives the agents time for a deeper rewrite.
LONG_BREAK_SECONDS = 60.0


@dataclass
class MatchLog:
    """Everything one match sent and received, for the proof run."""

    match_id: str
    player: str
    sent: list[Message] = field(default_factory=list)
    received: list[Message] = field(default_factory=list)
    versions: list[Any] = field(default_factory=list)   # the behaviour version each round was played with
    dropped: int = 0                                     # messages lost while the socket was down
    played: list[Message] = field(default_factory=list)  # every round_end, kept even if it could not be sent
    reconnects: int = 0

    @property
    def events(self) -> list[Message]:
        return [m for m in self.sent if m["type"] == "event"]

    @property
    def rounds(self) -> list[Message]:
        return self.played or [m for m in self.sent if m["type"] == "round_end"]

    @property
    def updates(self) -> list[Message]:
        return [m for m in self.received if m["type"] == "strategy_update"]


def uniform_behaviour(model: SimModel) -> Message:
    """Every option equally likely: the baseline when a game has no default."""
    npc = model.setup.get("npcs", {}).get(model.npc, {})
    decisions = {
        name: {option: {"base": 1.0} for option in spec.get("options", {})}
        for name, spec in npc.get("decisions", {}).items()
    }
    return {"version": 0, "npcs": {model.npc: {"decisions": decisions, "rules": []}}}


class SimGame:
    def __init__(
        self,
        setup: Message,
        model: SimModel,
        url: str,
        *,
        mode: str = "live",
        player: str = "even",
        rounds: int | None = None,
        seed: int = 0,
        speed: str = "fast",
        match_id: str | None = None,
        break_seconds: float | None = None,
        exchange_seconds: float | None = None,
        hold_every: int = 0,
        hold_seconds: float = 0.0,
        wait_at_breaks: bool = False,
        switch_to: str | None = None,
        switch_at: int | None = None,
        ready_timeout: float = 300.0,
        frames: bool = False,
        quiet: bool = True,
    ):
        # The stand-in's own pacing (sim.json "plan") wins over the setup file's.
        plan = {**setup.get("plan", {}), **model.spec.get("plan", {})}
        pacing = model.spec.get("pacing", {})
        self.model = model
        self.url = url
        self.mode = mode
        self.player = player
        self.speed = speed
        self.rng = random.Random(seed)
        self.seed = seed
        self.rounds = rounds if rounds is not None else int(plan.get("rounds", 5))
        if mode == "practice" and rounds is None:
            self.rounds = 0
        # 0 means the game never breaks by itself: an open-ended match with no checkpoints.
        self.break_every = max(0, int(plan.get("break_every", 1)))
        self.break_seconds = float(break_seconds if break_seconds is not None else plan.get("break_seconds", 10))
        self.update_seconds = float(plan.get("update_seconds", 20))
        self.gap_seconds = float(pacing.get("gap_seconds", 1))
        self.exchange_seconds = float(
            exchange_seconds if exchange_seconds is not None else pacing.get("exchange_seconds", 1.5)
        )
        self.wait_at_breaks = wait_at_breaks
        # A player who changes style partway through: from round `switch_at` on,
        # the scripted player `switch_to` plays instead.
        self.switch_to = switch_to
        self.switch_at = switch_at if switch_at is not None else (self.rounds // 2 + 1)
        self.hold_every = hold_every
        self.hold_seconds = hold_seconds
        self.ready_timeout = ready_timeout
        self.frames = frames
        self.quiet = quiet
        self.match_id = match_id or f"sim_{model.spec.get('game', 'game')}_{player}_{seed}_{int(time.time())}"

        self.setup = copy.deepcopy(setup)
        self.setup.update({"type": "setup", "match_id": self.match_id, "mode": mode})
        self.setup["plan"] = {**plan, "rounds": self.rounds, "break_every": self.break_every,
                              "break_seconds": self.break_seconds, "update_seconds": self.update_seconds}
        if "practice" not in self.setup:
            self.setup["practice"] = model.practice_block()
        else:
            # Results learned on this stand-in are provisional, so say so.
            self.setup["practice"] = {**self.setup["practice"], "stand_in": True}
        # The views stay declared even without --frames, so this setup reads
        # as the same game in every mode. Frames are just never sent.

        self.behaviour: Message = setup.get("default_behaviour") or uniform_behaviour(model)
        self.newest: Message | None = None   # the newest behaviour not yet swapped in
        self.values: dict[str, float] = {}
        self.log = MatchLog(self.match_id, player)
        self._ws: Any = None
        self._send_lock = asyncio.Lock()
        self._ready = asyncio.Event()
        self._update_arrived = asyncio.Event()
        self._last_source: str | None = None
        self._started = time.monotonic()
        self._clock = 0.0
        self._practice_count = 0
        self._last_activity = time.monotonic()
        self._round = 0

    # Clock and sending -------------------------------------------------------

    def now(self) -> float:
        """Seconds since the match started. Fast mode keeps a pretend clock."""
        if self.speed == "real":
            return round(time.monotonic() - self._started, 2)
        return round(self._clock, 2)

    async def send(self, message: Message) -> None:
        """Send one message. While the socket is down the game keeps playing,
        and the message is counted as dropped instead of sent."""
        message = {"match_id": self.match_id, **message}
        try:
            async with self._send_lock:
                await self._ws.send(json.dumps(message))
        except websockets.ConnectionClosed:
            self.log.dropped += 1
            return
        self.log.sent.append(message)

    def say(self, line: str) -> None:
        if not self.quiet:
            print(line, file=sys.stderr, flush=True)

    # Reading the socket --------------------------------------------------------

    async def _reader(self) -> None:
        try:
            async for raw in self._ws:
                try:
                    message = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                self.log.received.append(message)
                kind = message.get("type")
                if kind == "ready":
                    self.behaviour = message.get("behaviour") or self.behaviour
                    self._ready.set()
                    self.say(f"ready: values {list((message.get('values') or {}).keys())}")
                elif kind == "player_read":
                    self.values = dict(message.get("values") or {})
                elif kind == "strategy_update":
                    if message.get("behaviour"):
                        self.newest = message["behaviour"]
                        self._last_source = message.get("source")
                        self._update_arrived.set()
                        self.say(f"strategy_update v{message.get('version')} ({message.get('source')}) kept for the next gap")
                elif kind == "practice_run":
                    await self.send(self.practice(message))
                elif kind == "error":
                    self.say(f"agents reported an error: {message.get('about')} at {message.get('where')}")
        except websockets.ConnectionClosed:
            pass

    # Practice runs -----------------------------------------------------------

    def practice(self, run: Message) -> Message:
        """Answer one `practice_run`: play the rounds with no events, as fast as possible."""
        player = run.get("player")
        rounds = int(run.get("rounds", 10))
        behaviour = run.get("behaviour") or uniform_behaviour(self.model)
        self._practice_count += 1
        self._last_activity = time.monotonic()
        rng = random.Random(f"{self.seed}-{self._practice_count}-{run.get('run_id')}")
        reply: Message = {"type": "practice_result", "run_id": run.get("run_id"), "rounds": rounds}
        try:
            persona = self.model.persona(player)
        except (KeyError, TypeError) as problem:
            reply.update({"player": player, "wins": {"player": 0, self.model.npc: 0},
                          "stats": {"error": str(problem)}})
            return reply
        wins = {"player": 0, self.model.npc: 0}
        exchanges = 0
        for _ in range(rounds):
            result = run_sync(self.model.play_round(persona, behaviour, dict, rng))
            wins[result.winner] = wins.get(result.winner, 0) + 1
            exchanges += result.exchanges
        reply.update({"player": persona["name"], "wins": wins,
                      "stats": {"average_exchanges": round(exchanges / rounds, 2) if rounds else 0}})
        return reply

    # The match ---------------------------------------------------------------

    async def _emit(self, name: str, by: str, data: dict[str, Any],
                    picked: dict[str, str] | None, by_rule: list[str] | None) -> None:
        message: Message = {"type": "event", "name": name, "round": self._round, "t": self.now(),
                            "by": by, "data": data}
        if picked is not None:
            message["picked"] = picked
            message["by_rule"] = by_rule or []
        await self.send(message)

    async def _pause(self) -> None:
        if self.speed == "real":
            if self.frames:
                await self.send(self._frame())
            await asyncio.sleep(self.exchange_seconds)
        else:
            self._clock += self.exchange_seconds
            await asyncio.sleep(0)

    def _frame(self) -> Message:
        from .frames import draw_frame  # Pillow is only needed with --frames
        views = {name: draw_frame(self.log.events[-6:], self.model.npc) for name in self.setup.get("views", {})}
        return {"type": "frames", "round": self._round, "t": self.now(), "views": views}

    async def _gap(self, round_number: int) -> None:
        """The gap between rounds. Every `break_every` rounds it is a break.

        Real speed sleeps for the gap or the break. Fast speed only moves its
        pretend clock, unless it is told to hold the match open for an update:
        every `hold_every` rounds it waits up to `hold_seconds` for any new
        behaviour, and with `wait_at_breaks` a break waits up to its full
        length for an update (on a long break, a deeper one, not "quick")."""
        is_break = self.break_every > 0 and round_number % self.break_every == 0
        if self.speed == "real":
            await asyncio.sleep(self.break_seconds if is_break else self.gap_seconds)
            return
        self._clock += self.break_seconds if is_break else self.gap_seconds
        if is_break and self.wait_at_breaks and self.break_seconds > 0:
            # A long break is where the agents run a deeper rewrite, so wait for
            # that one. A short break ends with the first update.
            long_break = self.break_seconds >= LONG_BREAK_SECONDS
            landed = self.newest is not None and (not long_break or self._last_source != "quick")
            if not landed:
                await self._wait_for_update(self.break_seconds, want_deep=long_break)
        holding = self.hold_every and round_number % self.hold_every == 0 and self.hold_seconds > 0
        if holding and self.newest is None:
            await self._wait_for_update(self.hold_seconds, want_deep=False)
        await asyncio.sleep(0)

    async def _wait_for_update(self, seconds: float, want_deep: bool) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + seconds
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                self.say(f"no new behaviour within {seconds}s, carrying on")
                return
            self._update_arrived.clear()
            try:
                await asyncio.wait_for(self._update_arrived.wait(), timeout=remaining)
            except asyncio.TimeoutError:
                self.say(f"no new behaviour within {seconds}s, carrying on")
                return
            if not want_deep or self._last_source != "quick":
                return

    async def run(self) -> MatchLog:
        self._ws = await websockets.connect(self.url, max_size=None)
        self._started = time.monotonic()
        self._reader_task = asyncio.create_task(self._reader())
        await self.send(self.setup)
        got_ready = await self._wait_for_ready(self._reader_task)
        if got_ready and self.mode == "practice":
            # The agents close the socket once a practice session is over; rejoin
            # as a live game before the first point instead of losing it.
            await asyncio.wait([self._reader_task], timeout=2)
            if self._reader_task.done():
                await self._reconnect()
        if got_ready or self.mode == "live":
            await self._play()
        self._reader_task.cancel()
        await self._ws.close()
        return self.log

    async def _reconnect(self) -> None:
        """The contract: if the socket drops, keep playing, reconnect and send
        `setup` again with the same match id."""
        try:
            ws = await asyncio.wait_for(websockets.connect(self.url, max_size=None), timeout=2)
        except (OSError, asyncio.TimeoutError, websockets.InvalidHandshake):
            self.say("the agents are still away, playing on with the current behaviour")
            return
        self._ws = ws
        self.log.reconnects += 1
        self._reader_task = asyncio.create_task(self._reader())
        # A practice session ends once `ready` arrives and the agents close the
        # socket; the match itself then runs live, so come back as a live game.
        if self.setup.get("mode") == "practice" and self._ready.is_set():
            self.setup = {**self.setup, "mode": "live"}
        await self.send(self.setup)
        self.say(f"reconnected and sent setup again ({self.setup.get('mode')})")

    async def _wait_for_ready(self, reader: asyncio.Task) -> bool:
        """Wait for `ready`, answering practice runs meanwhile. Gives up after
        `ready_timeout` seconds with no `ready` and no `practice_run`."""
        self._last_activity = time.monotonic()
        while not self._ready.is_set():
            if reader.done():
                self.say("the agents closed the socket before ready")
                return False
            quiet_for = time.monotonic() - self._last_activity
            if quiet_for >= self.ready_timeout:
                if self.mode == "live":
                    self.say(f"no ready within {self.ready_timeout:.0f}s, starting with the default behaviour")
                else:
                    self.say(f"no ready or practice run within {self.ready_timeout:.0f}s, stopping")
                return False
            try:
                await asyncio.wait_for(self._ready.wait(), timeout=min(15.0, self.ready_timeout - quiet_for))
            except asyncio.TimeoutError:
                waited = time.monotonic() - self._started
                print(f"[sim] still waiting for ready after {waited:.0f}s, "
                      f"{self._practice_count} practice runs answered", file=sys.stderr, flush=True)
        return True

    async def _play(self) -> None:
        score = {"player": 0, self.model.npc: 0}
        for round_number in range(1, self.rounds + 1):
            if self._reader_task.done():
                await self._reconnect()
            if self.newest is not None:
                self.behaviour, self.newest = self.newest, None
            self._round = round_number
            self.log.versions.append(self.behaviour.get("version"))
            playing = self.switch_to if self.switch_to and round_number >= self.switch_at else self.player
            result = await self.model.play_round(
                playing, self.behaviour, lambda: self.values, self.rng, self._emit, self._pause
            )
            score[result.winner] = score.get(result.winner, 0) + 1
            last = round_number == self.rounds
            is_break = not last and self.break_every > 0 and round_number % self.break_every == 0
            round_end = {
                "type": "round_end", "round": round_number, "t": self.now(), "winner": result.winner,
                "how": result.how, "stats": result.stats, "score": dict(score), "break": is_break,
            }
            self.log.played.append({"match_id": self.match_id, **round_end})
            await self.send(round_end)
            self.say(f"round {round_number}: {result.winner} ({result.how}, {result.exchanges} exchanges) "
                     f"score {score} behaviour v{self.behaviour.get('version')}")
            if not last:
                await self._gap(round_number)
        await asyncio.sleep(0.05)
