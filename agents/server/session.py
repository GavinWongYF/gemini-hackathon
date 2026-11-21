"""One match, from `setup` to the last round.

A session keeps the match's state, answers the game, and runs the three
slower parts in the background so the socket loop never waits on a model:

    the designer  once per game, before `ready` (or after it, in a live match)
    the watcher   at most one read in flight, paced, after player events
    the adapter   at most one rewrite in flight, started on a clock

A session outlives its socket. When the game reconnects and sends `setup`
again with the same `match_id`, it picks up where it was.
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import config, measures
from .contract import check_behaviour, check_message, npc_ids, option_names
from .hub import Hub
from .interfaces import (
    Adapter, Behaviour, Design, Designer, MatchState, Message, PracticeRefused, ValueSpec, Watcher, trace_message,
)
from .store import load_design, save_design

MAX_ERRORS_PER_MESSAGE = 5
MAX_EARLY_MESSAGES = 500   # how much play is kept if a game starts before `ready`


@dataclass
class Settings:
    """How the server paces itself. Tests pass smaller numbers."""

    # A live game must not wait long for `ready`. After this many seconds it
    # gets `ready` with its default behaviour, and the design follows later.
    ready_wait: float = field(default_factory=lambda: float(os.environ.get("NPC_READY_WAIT_SECONDS", "3")))
    # How long the game has to answer one `practice_run`.
    practice_timeout: float = field(default_factory=lambda: float(os.environ.get("NPC_PRACTICE_TIMEOUT_SECONDS", "120")))
    read_gap: float = field(default_factory=lambda: config.WATCH_MIN_INTERVAL_SECONDS)
    first_adapt_delay: float = field(default_factory=lambda: config.ADAPTER_FIRST_DELAY_SECONDS)
    # How much longer than the game said it can wait a rewrite may take before it is dropped.
    patience: float = 1.25
    # The adapter keeps to the same limit itself. This much slack lets an answer that lands right on it through.
    grace: float = 1.0
    adapt: bool = True              # False: the unchanged baseline, no `strategy_update` ever
    # Either loop can be turned off on its own, to measure what each one earns.
    short_loop: bool = field(default_factory=lambda: os.environ.get("NPC_SHORT_LOOP", "1") not in ("0", "false", "no"))
    larger_loop: bool = field(default_factory=lambda: os.environ.get("NPC_LARGER_LOOP", "1") not in ("0", "false", "no"))
    reuse_designs: bool = True      # False: design every game again, even if one is stored
    designs_dir: Path = Path("data/designs")


@dataclass
class Parts:
    """The three slower parts. Any of them can be missing."""

    watcher: Watcher | None = None
    designer: Designer | None = None
    adapter: Adapter | None = None


def starting_behaviour(setup: Message, design: Design) -> Behaviour:
    """The behaviour a match opens with.

    The game's own default when it has one, so the NPCs start beatable and
    get better only through changes the larger loop makes and explains.
    """
    if config.START_ON_GAME_DEFAULT and isinstance(setup.get("default_behaviour"), dict):
        return {**copy.deepcopy(setup["default_behaviour"]), "version": design.behaviour.get("version", 0)}
    return design.behaviour


def baseline_behaviour(setup: Message) -> Behaviour:
    """The behaviour a game has before anything is designed for it.

    The game's own `default_behaviour`, or every option equally likely.
    """
    default = setup.get("default_behaviour")
    if isinstance(default, dict):
        return copy.deepcopy(default)
    return {
        "version": 0,
        "npcs": {
            npc: {
                "decisions": {
                    decision: {option: {"base": 1} for option in option_names(setup, npc, decision) or []}
                    for decision in (setup["npcs"][npc].get("decisions") or {})
                },
                "rules": [],
            }
            for npc in npc_ids(setup)
        },
    }


class SocketPlaytest:
    """Runs practice rounds by asking the game over its own socket."""

    def __init__(self, session: "Session") -> None:
        self._session = session

    async def run(self, behaviour: Behaviour, player: Any, rounds: int) -> Message:
        """Send one `practice_run` and wait for the `practice_result` with its `run_id`.

        `player` is passed through as given: a name from `setup`, or a persona.
        """
        session = self._session
        session.runs += 1
        run_id = f"p_{session.runs:03d}"
        answer: asyncio.Future[Message] = asyncio.get_running_loop().create_future()
        session.practice[run_id] = answer
        try:
            await session.send({
                "type": "practice_run",
                "match_id": session.match_id,
                "run_id": run_id,
                "player": player,
                "rounds": rounds,
                "behaviour": behaviour,
            })
            return await asyncio.wait_for(answer, session.settings.practice_timeout)
        finally:
            session.practice.pop(run_id, None)


class Session:
    def __init__(self, match_id: str, parts: Parts, settings: Settings, hub: Hub) -> None:
        self.match_id = match_id
        self.parts = parts
        self.settings = settings
        self.hub = hub
        self.setup: Message | None = None
        self.match: MatchState | None = None
        self.socket: Any = None                 # the game's WebSocket, or None while it is away
        self.started = time.monotonic()
        self.practice: dict[str, asyncio.Future[Message]] = {}  # run_id -> who is waiting
        self.runs = 0
        self._send_lock = asyncio.Lock()
        self._tasks: set[asyncio.Task[Any]] = set()
        self._preparing: asyncio.Task[Any] | None = None
        self._early: list[Message] = []          # what the game sent before `ready`
        # the watcher
        self._watching: asyncio.Task[Any] | None = None
        self._read_wanted = False
        self._last_read = float("-inf")
        # the adapter
        self._adapting: asyncio.Task[Any] | None = None
        self._full_wanted = False                # a break asked for a deeper rewrite
        self._player_events = 0                  # how many player events have come in
        self._adapted_on = 0                     # how many there were when the last rewrite started
        self._adapted_rounds = 0                 # how many rounds had ended when the last rewrite started
        self._last_player_at = time.monotonic()  # when the player last did something, or when the match began
        self._adapt_not_before = 0.0            # no routine rewrite starts before this moment
        self._play_began: float | None = None    # when the first event came in
        self._back = False                       # the game just reconnected, and has not reported a round yet

    # ------------------------------------------------------------ plumbing

    def now(self) -> float:
        """Seconds since this match started."""
        return time.monotonic() - self.started

    def trace(self, message: Message) -> None:
        """Tell the viewers what one of the parts just did."""
        self.hub.publish(self.match_id, "trace", self.now(), message)

    def heard(self, message: Message) -> None:
        self.hub.publish(self.match_id, "in", self.now(), message)

    async def send(self, message: Message) -> None:
        """Send one message to the game, and show it to the viewers."""
        self.hub.publish(self.match_id, "out", self.now(), message)
        async with self._send_lock:
            if self.socket is None:
                return
            try:
                await self.socket.send_text(json.dumps(message))
            except Exception:  # the game went away. It will reconnect.
                self.socket = None

    async def error(self, problem: dict[str, Any]) -> None:
        await self.send({"type": "error", "match_id": self.match_id, **problem})

    def _spawn(self, work: Any) -> asyncio.Task[Any]:
        task = asyncio.get_running_loop().create_task(work)
        self._tasks.add(task)
        task.add_done_callback(self._finished)
        return task

    def _finished(self, task: asyncio.Task[Any]) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            problem = task.exception()
            self.trace(trace_message("server", "error", f"A background job stopped: {type(problem).__name__}: {problem}"))

    def close(self) -> None:
        for task in list(self._tasks):
            task.cancel()

    def finished(self) -> bool:
        """Has this match played every round it planned?"""
        plan = (self.setup or {}).get("plan")
        planned = plan.get("rounds") if isinstance(plan, dict) else None
        return bool(self.match and isinstance(planned, (int, float)) and len(self.match.rounds) >= planned)

    def _value_names(self) -> list[str]:
        return [value.name for value in self.match.design.values] if self.match else []

    # --------------------------------------------------------------- setup

    async def on_setup(self, socket: Any, setup: Message) -> None:
        """A checked `setup` arrived, on a new socket or an old one."""
        self.socket = socket
        self.heard(setup)
        if self.match is not None:
            # The game is back. Hand it what it should be playing with now.
            self.trace(trace_message(
                "server", "done",
                f"The game reconnected to {self.match_id}. It picks up at behaviour version {self.match.behaviour.get('version')}.",
            ))
            self._back = True
            await self._send_ready()
            return
        if self._preparing is not None and not self._preparing.done():
            return  # still getting ready. `ready` goes to the new socket when it is done.
        self.setup = setup
        self._preparing = self._spawn(self._prepare(setup))
        self._warm_watcher()
        self._prepare_adapter(setup)

    def _prepare_adapter(self, setup: Message) -> None:
        """Let the adapter start anything slow now, in the background. It never delays `ready`."""
        prepare = getattr(self.parts.adapter, "prepare", None)
        if not callable(prepare) or not self.settings.adapt or setup.get("mode", "live") == "practice":
            return
        try:
            prepare(setup, self.trace)
        except Exception as problem:
            self.trace(trace_message("adapter", "error", f"The adapter could not get ready: {type(problem).__name__}: {problem}"))

    def _warm_watcher(self) -> None:
        """Let the watcher get ready now, so its first read of the match is fast."""
        warm = getattr(self.parts.watcher, "warm", None)
        if not callable(warm) or not self.settings.adapt:
            return

        async def run() -> None:
            try:
                await warm()
            except Exception as problem:
                self.trace(trace_message("watcher", "error", f"The watcher could not warm up: {type(problem).__name__}: {problem}"))

        self._spawn(run())

    async def _prepare(self, setup: Message) -> None:
        """Get a design for this game and send `ready`."""
        mode = setup.get("mode", "live")
        can_practise = mode == "practice" and isinstance(setup.get("practice"), dict)
        self.trace(trace_message("server", "start", f"Got the setup for `{setup.get('game')}`, in {mode} mode."))

        design: Design | None = None
        late: asyncio.Task[Design | None] | None = None
        playtest: SocketPlaytest | None = None
        if not self.settings.adapt:
            self.trace(trace_message("server", "done", "Adapting is off. This match plays the unchanged baseline."))
        else:
            stored = load_design(self.settings.designs_dir, setup)
            if stored is not None and not self.settings.reuse_designs and (mode == "practice" or not stored.matchups):
                # Asked to design again. A live match still keeps a playtested
                # design, because it cannot run a playtest of its own.
                stored = None
            if stored is not None and can_practise and not stored.matchups and self.parts.designer is not None:
                stored = None  # designed without a playtest. This game can run one, so do it properly.
            if stored is not None:
                design = stored
                self.trace(trace_message(
                    "server", "done",
                    f"Using the stored design for `{setup.get('game')}`: {len(stored.values)} values, {len(stored.matchups)} playtest results.",
                ))
            elif self.parts.designer is not None:
                playtest = SocketPlaytest(self) if can_practise else None
                job = self._spawn(self._design(setup, playtest))
                if mode == "practice":
                    design = await job
                else:
                    done, _ = await asyncio.wait({job}, timeout=self.settings.ready_wait)
                    if done:
                        design = job.result()
                    else:
                        late = job
                        self.trace(trace_message(
                            "server", "done",
                            "The design is not ready yet. The game starts on its default and the design follows.",
                        ))

        first = design or self._quick_design(setup) or Design(values=[], behaviour=baseline_behaviour(setup))
        self.match = MatchState(
            match_id=self.match_id,
            setup=setup,
            design=first,
            behaviour=starting_behaviour(setup, first),
            started=self.started,
            trace=self.trace,
        )
        await self._send_ready()
        await self._take_early()

        if late is not None:
            design = await late
            if design is not None:
                await self._deliver_late_design(design)
        await self._finish_design(setup, playtest, deliver=mode != "practice")
        if mode == "practice":
            await self._end_practice()

    async def _end_practice(self) -> None:
        """A practice session is over once its design is stored. Closing the
        socket tells the game's practice runner it can stop."""
        socket = self.socket
        close = getattr(socket, "close", None)
        if socket is None or not callable(close):
            return
        self.trace(trace_message("server", "done", "Practice is finished and the design is stored. Closing the socket."))
        try:
            await close(code=1000)
        except Exception:
            pass  # the game had already gone

    def _quick_design(self, setup: Message) -> Design | None:
        """A design built in code at once, so `ready` carries questions while the full design is on its way."""
        quick = getattr(self.parts.designer, "quick", None)
        if not callable(quick) or not self.settings.adapt:
            return None
        try:
            design = quick(setup)
        except Exception as problem:
            self.trace(trace_message("designer", "error", f"The quick design failed: {type(problem).__name__}: {problem}"))
            return None
        if check_behaviour(setup, design.behaviour, [value.name for value in design.values]):
            return None
        self.trace(trace_message(
            "designer", "done",
            f"Starting on {len(design.values)} values built in code. The designed ones follow.",
        ))
        return design

    async def _finish_design(self, setup: Message, playtest: SocketPlaytest | None, deliver: bool) -> None:
        """The designer's model can answer after its design went out. Store the fuller design
        when it does, so the next match starts with it, and bring it into a live match."""
        finish = getattr(self.parts.designer, "finish", None)
        if not callable(finish) or not self.settings.adapt:
            return
        try:
            design = await finish(setup, playtest, self.trace)
        except Exception as problem:
            self.trace(trace_message("designer", "error", f"The late design failed: {type(problem).__name__}: {problem}"))
            return
        if design is None:
            return
        problems = check_behaviour(setup, design.behaviour, [value.name for value in design.values])
        if problems:
            self.trace(trace_message(
                "designer", "error",
                f"The late design does not fit `setup`: {problems[0]['about']}",
                data={"problems": problems},
            ))
            return
        try:
            path = save_design(self.settings.designs_dir, setup, design)
            stored = f" Stored as {path.name}."
        except OSError as problem:
            stored = f" It could not be stored: {problem}."
        self.trace(trace_message(
            "server", "done",
            f"The design model answered late: {len(design.values)} values and {len(design.matchups)} playtest results.{stored}",
        ))
        if deliver and self.match is not None:
            await self._deliver_late_design(design)

    async def _design(self, setup: Message, playtest: SocketPlaytest | None) -> Design | None:
        """Run the designer. Returns None, with a trace, if it fails."""
        began = time.monotonic()
        try:
            design = await self.parts.designer.design(setup, playtest, self.trace)  # type: ignore[union-attr]
        except Exception as problem:
            self.trace(trace_message("designer", "error", f"The designer failed: {type(problem).__name__}: {problem}"))
            return None
        names = [value.name for value in design.values]
        problems = check_behaviour(setup, design.behaviour, names)
        if problems:
            self.trace(trace_message(
                "designer", "error",
                f"The designed behaviour does not fit `setup`: {problems[0]['about']}",
                data={"problems": problems},
            ))
            return None
        try:
            path = save_design(self.settings.designs_dir, setup, design)
            stored = f" Stored as {path.name}."
        except OSError as problem:
            stored = f" It could not be stored: {problem}."
        self.trace(trace_message(
            "server", "done",
            f"The design is ready: {len(design.values)} values and {len(design.matchups)} playtest results.{stored}",
            ms=(time.monotonic() - began) * 1000,
        ))
        return design

    async def _send_ready(self) -> None:
        match = self.match
        assert match is not None
        await self.send({
            "type": "ready",
            "match_id": self.match_id,
            "values": {value.name: {"label": value.about, "kind": value.kind} for value in match.design.values},
            "behaviour": match.behaviour,
        })

    async def _deliver_late_design(self, design: Design) -> None:
        """The design finished after `ready`. Send it as a `strategy_update`."""
        match = self.match
        assert match is not None
        version = int(match.behaviour.get("version", 0)) + 1
        if match.updates or starting_behaviour(match.setup, design) is not design.behaviour:
            # The larger loop has already changed the NPCs, or the match opened
            # on the game's own default. Keep the behaviour in play and only
            # start tracking the new values.
            behaviour = {**match.behaviour, "version": version}
            plan = "Keep the behaviour already in play and start tracking the values listed."
        else:
            behaviour = {**design.behaviour, "version": version}
            plan = "Start from the designed behaviour and track the values listed."
        match.design = design
        update: Message = {
            "type": "strategy_update",
            "match_id": self.match_id,
            "version": version,
            "source": "full",
            "observations": design.notes[:4] or ["The design for this game is ready."],
            "plan": [plan],
            "changes": [],
            "new_values": {value.name: {"label": value.about, "kind": value.kind} for value in design.values},
            "behaviour": behaviour,
        }
        match.behaviour = behaviour
        match.updates.append(update)
        await self.send(update)

    # ------------------------------------------------------------ messages

    async def on_message(self, message: Message) -> None:
        """Any message after `setup`. Returns quickly: slow work goes to the background."""
        self.heard(message)
        setup = self.setup or {}
        kind = message.get("type")

        if kind == "practice_result":
            await self._on_practice_result(message)
            return
        if kind == "error":
            self._on_game_error(message)
            return

        problems = check_message(setup, message)
        for problem in problems[:MAX_ERRORS_PER_MESSAGE]:
            await self.error(problem)
        if kind not in ("event", "frames", "round_end"):
            if not problems:
                await self.error({
                    "about": f"The game does not send `{kind}`. That message goes the other way.",
                    "where": "type", "got": kind,
                })
            return
        if message.get("match_id") != self.match_id:
            return
        if self.match is None:
            # Play began before `ready`. Keep what arrives and take it in, in
            # order, as soon as the match is set up.
            if not problems:
                self._hold_early(message)
            return
        await self._take(message)

    def _hold_early(self, message: Message) -> None:
        if message.get("type") == "frames":
            self._early = [held for held in self._early if held.get("type") != "frames"]
        if len(self._early) < MAX_EARLY_MESSAGES:
            self._early.append(message)

    async def _take_early(self) -> None:
        """Take in what the game sent before `ready`, oldest first."""
        early, self._early = self._early, []
        if not early or self.match is None:
            return
        self.trace(trace_message(
            "server", "done",
            f"Play began before `ready`. Took in the {len(early)} messages that arrived early.",
        ))
        for message in early:
            await self._take(message)

    async def _take(self, message: Message) -> None:
        """One checked `event`, `frames` or `round_end` for a match that is set up."""
        assert self.match is not None
        kind = message.get("type")
        if kind in ("event", "round_end") and self._back:
            self._back = False
            if message.get("round") == 1 and self.match.rounds:
                await self._start_over()
        if kind == "event":
            self._on_event(message)
        elif kind == "frames":
            if isinstance(message.get("views"), dict):
                self.match.frames = message
                # A player who has done nothing for a while still gets read, from the pictures alone.
                if time.monotonic() - self._last_player_at >= config.WATCH_IDLE_SECONDS:
                    self._want_read()
        elif kind == "round_end":
            self._on_round_end(message)

    async def _start_over(self) -> None:
        """The game came back and is playing round 1 again: a new match under the same id.

        Everything counted so far is dropped. The design is kept. If the old
        match had changed the behaviour, the starting one is sent again, with
        a version that still goes up.
        """
        old = self.match
        assert old is not None and self.setup is not None
        for task in (self._adapting, self._watching):
            if task is not None and not task.done():
                task.cancel()
        self._adapting = self._watching = None
        self._full_wanted = self._read_wanted = False
        self._player_events = self._adapted_on = 0
        self._adapted_rounds = 0
        self._last_player_at = time.monotonic()
        self._play_began = None

        start = starting_behaviour(self.setup, old.design)
        changed = old.behaviour != start
        version = int(old.behaviour.get("version", 0)) + 1 if changed else start.get("version", 0)
        behaviour = {**copy.deepcopy(start), "version": version}
        self.hub.reset(self.match_id)
        self.started = time.monotonic()
        self.match = MatchState(
            match_id=self.match_id, setup=self.setup, design=old.design, behaviour=behaviour,
            started=self.started, trace=self.trace,
        )
        self.heard(self.setup)
        self.trace(trace_message(
            "server", "done",
            f"The game is playing `{self.match_id}` from round 1 again, so this is a new match. The counts start over.",
        ))
        if changed:
            await self.send({
                "type": "strategy_update",
                "match_id": self.match_id,
                "version": version,
                "source": "quick",
                "observations": ["A new match has started, so nothing is known about this player yet."],
                "plan": ["Go back to the starting behaviour."],
                "changes": [],
                "behaviour": behaviour,
            })

    def _on_event(self, message: Message) -> None:
        match = self.match
        assert match is not None
        # Keep any event we can count, even if one field was off. The game was told.
        if message.get("name") not in match.setup.get("events", {}):
            return
        if not isinstance(message.get("data") or {}, dict):
            return
        match.events.append(message)
        if self._play_began is None:
            self._play_began = time.monotonic()
            asyncio.get_running_loop().call_later(self.settings.first_adapt_delay + 0.01, self._maybe_adapt)
        if message.get("by") == "player":
            self._player_events += 1
            self._last_player_at = time.monotonic()
            self._want_read()
            self._maybe_adapt()

    def _on_round_end(self, message: Message) -> None:
        match = self.match
        assert match is not None
        number = message.get("round")
        if not isinstance(number, (int, float)) or isinstance(number, bool):
            return
        match.rounds = [r for r in match.rounds if r.get("round") != number] + [message]
        try:
            summary = measures.summary(match.setup, match.events, match.rounds)
        except Exception as problem:
            self.trace(trace_message("measures", "error", f"Could not measure round {number}: {problem}"))
        else:
            rate = summary.get("player_win_rate")
            share = "none" if rate is None else f"{rate:.0%}"
            habits = summary.get("habits") or []
            top = f" Top habit: {habits[0]['field']} = {habits[0]['value']}." if habits else ""
            self.trace(trace_message(
                "measures", "done",
                f"After round {number} the player has won {share} of the rounds.{top}",
                data=summary,
            ))
        if message.get("break") is True and self._break_allows_deeper():
            self._full_wanted = True
        self._maybe_adapt()

    def _on_game_error(self, message: Message) -> None:
        """The game could not do something we asked. A practice run that is
        waiting fails now, so the playtest moves on instead of timing out."""
        about = str(message.get("about") or "The game reported a problem.")
        self.trace(trace_message(
            "server", "error", f"The game reported: {about}",
            data={"where": message.get("where"), "got": message.get("got")},
        ))
        run_id = message.get("run_id")
        waiting = self.practice.get(run_id) if isinstance(run_id, str) else None
        if waiting is None and self.practice and str(message.get("where") or "").startswith("practice_run"):
            waiting = next(iter(self.practice.values()))  # the oldest run still waiting
        if waiting is not None and not waiting.done():
            waiting.set_exception(PracticeRefused(about))

    async def _on_practice_result(self, message: Message) -> None:
        for problem in check_message(self.setup or {}, message)[:MAX_ERRORS_PER_MESSAGE]:
            await self.error(problem)
        waiting = self.practice.get(message.get("run_id"))  # type: ignore[arg-type]
        if waiting is None:
            await self.error({
                "about": "No practice run is waiting for this `run_id`.",
                "where": "practice_result.run_id", "got": message.get("run_id"),
            })
        elif not waiting.done():
            waiting.set_result(message)

    # --------------------------------------------------------- the watcher

    def _want_read(self) -> None:
        if self.parts.watcher is None or not self.settings.adapt or not self.settings.short_loop:
            return
        self._read_wanted = True
        if self._watching is None or self._watching.done():
            self._watching = self._spawn(self._watch())

    async def _watch(self) -> None:
        """Read the player, one read at a time, no faster than the pace allows."""
        while self._read_wanted and self.match is not None:
            wait = self._last_read + self.settings.read_gap - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            self._read_wanted = False
            self._last_read = time.monotonic()
            try:
                read = await self.parts.watcher.read(self.match)  # type: ignore[union-attr]
            except Exception as problem:
                self.trace(trace_message("watcher", "error", f"The watcher failed: {type(problem).__name__}: {problem}"))
                continue
            if read is None:
                continue
            problems = check_message(self.match.setup, read)
            known = set(self._value_names())
            for name in read.get("values", {}) if isinstance(read.get("values"), dict) else {}:
                if name not in known:
                    problems.append({
                        "about": f"`{name}` is not a value this match tracks.",
                        "where": f"player_read.values.{name}", "got": name,
                    })
            if problems:
                self.trace(trace_message(
                    "watcher", "error",
                    f"Held back a player read that does not fit the contract: {problems[0]['about']}",
                    data={"problems": problems},
                ))
                continue
            await self.send(read)

    # --------------------------------------------------------- the adapter

    def _plan(self) -> dict[str, Any]:
        plan = (self.setup or {}).get("plan")
        return plan if isinstance(plan, dict) else {}

    def _update_seconds(self) -> float:
        """How long the game said it can wait for a routine update."""
        seconds = self._plan().get("update_seconds", config.DEFAULT_UPDATE_SECONDS)
        return float(seconds) if isinstance(seconds, (int, float)) and seconds > 0 else config.DEFAULT_UPDATE_SECONDS

    def _break_allows_deeper(self) -> bool:
        """Is a break long enough for a deeper rewrite than the routine one?"""
        plan = self._plan()
        seconds = plan.get("break_seconds")
        if not isinstance(seconds, (int, float)) or isinstance(seconds, bool):
            return False
        depth = [name for _, name in config.WRITER_TIERS]
        at_break = config.writer_for(seconds, plan.get("writer"))
        routine = config.writer_for(self._update_seconds(), plan.get("writer"))
        return depth.index(at_break) > depth.index(routine)

    def _maybe_adapt(self) -> None:
        """Start the next rewrite if it is time and there is something new to go on.

        The routine loop: the first rewrite starts a set time after play
        begins, and each later one starts as soon as the last has landed.
        A long break can ask for one deeper rewrite, which goes first and
        holds the routine loop until it returns. Never two at once.
        """
        if self.parts.adapter is None or not self.settings.adapt or not self.settings.larger_loop or self.match is None:
            return
        if self._adapting is not None and not self._adapting.done():
            return
        if self.socket is None:
            return  # the game has gone. A look now would be a paid call for nobody.
        if self._full_wanted:
            self._full_wanted = False
            self._adapted_on = self._player_events
            self._adapted_rounds = self._rounds_played()
            seconds = float(self._plan().get("break_seconds", 0))
            self._adapting = self._spawn(self._adapt("full", self.settings.patience * seconds + self.settings.grace))
            return
        rounds = self._rounds_played()
        if self._player_events == self._adapted_on and rounds == self._adapted_rounds:
            return  # no new player event and no round they played in ended since the last rewrite started
        if self._player_events == 0 and rounds == 0:
            return  # nothing to go on yet
        if self._play_began is None or time.monotonic() - self._play_began < self.settings.first_adapt_delay:
            return
        if time.monotonic() < self._adapt_not_before:
            return  # the last look decided to wait, so give play a moment before looking again
        self._adapted_on = self._player_events
        self._adapted_rounds = rounds
        timeout = self.settings.patience * self._update_seconds() + self.settings.grace
        self._adapting = self._spawn(self._adapt("quick", timeout))

    def _rounds_played(self) -> int:
        """Finished rounds in which the player did anything at all.

        A round with no player event is a round the player was away for. It
        is no news about how they play, so it never starts a look on its own.
        """
        if self.match is None:
            return 0
        acted = {event.get("round") for event in self.match.events if event.get("by") == "player"}
        return sum(1 for r in self.match.rounds if r.get("round") in acted)

    async def _adapt(self, source: str, timeout: float) -> None:
        match = self.match
        assert match is not None
        began = time.monotonic()
        try:
            update = await asyncio.wait_for(self.parts.adapter.adapt(match, source), timeout)  # type: ignore[union-attr]
        except asyncio.TimeoutError:
            self.trace(trace_message(
                "adapter", "error",
                f"The {source} rewrite took longer than {timeout - self.settings.grace:g} seconds. The current behaviour stays.",
                ms=(time.monotonic() - began) * 1000,
            ))
            update = None
        except Exception as problem:
            self.trace(trace_message("adapter", "error", f"The adapter failed: {type(problem).__name__}: {problem}"))
            update = None
        if update is not None:
            await self._send_update(update)
        elif source == "quick":
            self._adapt_not_before = time.monotonic() + config.ADAPTER_REST_SECONDS
        # Straight on to the next one, if the player has done anything since.
        asyncio.get_running_loop().call_soon(self._maybe_adapt)

    async def _send_update(self, update: Message) -> None:
        """Check a `strategy_update`, make its version go up, and send it."""
        match = self.match
        assert match is not None
        if not isinstance(update, dict) or not isinstance(update.get("behaviour"), dict):
            self.trace(trace_message("adapter", "error", "Held back an update with no behaviour in it."))
            return
        update = {"match_id": self.match_id, **update, "type": "strategy_update"}
        current = match.behaviour.get("version", 0)
        version = update.get("version")
        if not isinstance(version, (int, float)) or isinstance(version, bool) or version <= current:
            version = int(current) + 1
        update["version"] = version
        update["behaviour"] = {**update["behaviour"], "version": version}

        new_values = update.get("new_values") if isinstance(update.get("new_values"), dict) else {}
        names = set(self._value_names()) | set(new_values)
        problems = check_message(match.setup, update) + check_behaviour(
            match.setup, update["behaviour"], names, where="strategy_update.behaviour",
        )
        if problems:
            self.trace(trace_message(
                "adapter", "error",
                f"Held back an update that does not fit the contract: {problems[0]['about']}",
                data={"problems": problems},
            ))
            return

        tracked = set(self._value_names())
        for name, spec in new_values.items():
            if name not in tracked:
                match.design.values.append(ValueSpec(name=name, about=spec.get("label", name), question=spec.get("question", {})))
        match.behaviour = update["behaviour"]
        match.updates.append(update)
        await self.send(update)
