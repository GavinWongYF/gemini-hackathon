"""One match, from `setup` to the last round.

A session keeps the match's state, answers the game, and runs the three
slower parts in the background so the socket loop never waits on a model:

    the designer  once per game, before `ready` (or after it, in a live match)
    the watcher   at most one read in flight, paced, after player events and fresh pictures
    the adapter   one or two looks in flight, staggered, their results applied in the order they started

A session outlives its socket. When the game reconnects and sends `setup`
again with the same `match_id`, it picks up where it was.
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import statistics
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
    # The first look starts once the player has done this many things, or after the delay above.
    first_adapt_events: int = field(default_factory=lambda: config.ADAPTER_FIRST_EVENTS)
    # In a rally, fresh pictures ask for a read once the last one started this long ago.
    frame_gap: float = field(default_factory=lambda: config.WATCH_FRAME_INTERVAL_SECONDS)
    rally_seconds: float = field(default_factory=lambda: config.WATCH_RALLY_SECONDS)
    # Pictures stop starting reads once no player event has come in for this long.
    away_seconds: float = field(default_factory=lambda: config.WATCH_AWAY_SECONDS)
    report_every: float = field(default_factory=lambda: config.WATCH_REPORT_SECONDS)
    # How many looks can be in flight, and how far apart they start.
    parallel: int = field(default_factory=lambda: config.ADAPTER_PARALLEL)
    stagger: float = field(default_factory=lambda: config.ADAPTER_STAGGER_SECONDS)
    # After a look that changed nothing, the next one waits this long. Only when none is in flight.
    rest: float = field(default_factory=lambda: config.ADAPTER_REST_SECONDS)
    # Two updates never reach the game closer together than this.
    update_gap: float = field(default_factory=lambda: config.ADAPTER_UPDATE_GAP_SECONDS)
    # The play clock: a gap between two events longer than this is a pause and adds nothing.
    play_gap: float = field(default_factory=lambda: config.PLAY_GAP_SECONDS)
    # After an update that changes something: how much play before the next look, and before the next such update.
    resume_play: float = field(default_factory=lambda: config.ADAPTER_RESUME_PLAY_SECONDS)
    min_play: float = field(default_factory=lambda: config.UPDATE_MIN_PLAY_SECONDS)
    # A look's result is only sent when the game spoke this recently. Otherwise it waits for the next event.
    send_window: float = field(default_factory=lambda: config.SEND_WHILE_PLAYING_SECONDS)
    # True: after a change, the next look waits for a player event in a later round, the sign that play resumed.
    look_after_resume: bool = field(default_factory=lambda: config.ADAPTER_LOOK_AFTER_RESUME)
    # False for a game that does not stop on a change: nothing is dropped or held for the play clock.
    stop_on_change: bool = field(default_factory=lambda: config.UPDATES_STOP_PLAY)
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


def value_entry(value: ValueSpec) -> dict[str, Any]:
    """How one tracked value is described to the game and the screens.

    `event` and `field` say what it counts, by the names the game declared.
    Both are left out for a value that does not count one field.
    """
    entry: dict[str, Any] = {"label": value.about, "kind": value.kind}
    counts = value.counts if isinstance(value.counts, dict) else None
    if counts and isinstance(counts.get("event"), str) and isinstance(counts.get("field"), str):
        entry["event"], entry["field"] = counts["event"], counts["field"]
    return entry


def is_real(update: Any) -> bool:
    """Does this update change anything? One that does stops the game. A holding update does not."""
    return isinstance(update, dict) and bool(update.get("changes")) and not update.get("holding")


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
        self._last_event_at = float("-inf")      # when the game last reported an event, by anyone
        self._reads_paused = False               # nobody has played for a while, so pictures start no reads
        self._reads_started = 0                  # in the window the next report covers
        self._reads_answered = 0
        self._read_ms: list[float] = []
        self._reporting: asyncio.Task[Any] | None = None
        # the adapter
        self._looks: dict[int, dict[str, Any]] = {}   # start number -> a look whose result has not been applied yet
        self._look_number = 0                    # how many looks have started
        self._returned: dict[int, Any] = {}      # start number -> a result waiting for its turn
        self._next_to_land = 1                   # results are applied in the order the looks started
        self._landing = asyncio.Lock()
        self._last_update_at = float("-inf")     # when the last update went to the game
        self._ask_at_round_end = False           # the adapter is holding a step for the end of the next round
        self._stagger_timer: asyncio.TimerHandle | None = None
        # the play clock, and the updates that change something (each one stops the game)
        self.play_seconds = 0.0                  # how long the game has really been played
        self._last_play_at: float | None = None  # when the last `event` or `round_end` came in
        self._play_moved = asyncio.Event()
        self.real_updates = 0                    # how many updates with changes have been sent
        self._last_real_play = 0.0               # the play clock at the last one, or 0 for the first event
        self._last_real_wall: float | None = None
        self._drop_through = 0                   # results of looks up to this number are too old to send
        self._events_at_real: int | None = None  # player events seen when the last one went out, until play resumes
        self._holding_real = False               # one is ready and waiting for the play clock
        self._highest_round = 0                  # the highest round number the game has reported
        self._player_round = 0                   # the highest round the player has done anything in
        self._round_at_real = 0                  # the highest round seen when the last change went out
        self._last_real_kept = False             # the last change was a step the adapter had kept ready
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
            "values": {value.name: value_entry(value) for value in match.design.values},
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
            "new_values": {value.name: value_entry(value) for value in design.values},
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
        if kind in ("event", "round_end"):
            self._tick_play()
            number = message.get("round")
            if isinstance(number, (int, float)) and not isinstance(number, bool):
                self._highest_round = max(self._highest_round, number)
                if kind == "event" and message.get("by") == "player":
                    self._player_round = max(self._player_round, number)
        if kind in ("event", "round_end") and self._back:
            self._back = False
            if message.get("round") == 1 and self.match.rounds:
                await self._start_over()
        if kind == "event":
            self._on_event(message)
        elif kind == "frames":
            if isinstance(message.get("views"), dict):
                self.match.frames = message
                now = time.monotonic()
                quiet_for = now - self._last_player_at
                if quiet_for >= self.settings.away_seconds:
                    # Nobody is playing. A tab left open must not pay for reads forever.
                    if not self._reads_paused:
                        self._reads_paused = True
                        self.trace(trace_message(
                            "server", "done",
                            f"No one has played for {self.settings.away_seconds:g} seconds, so reads are paused.",
                        ))
                elif quiet_for >= config.WATCH_IDLE_SECONDS:
                    # A player who has done nothing for a little while still gets read, from the pictures alone.
                    self._want_read()
                elif quiet_for <= self.settings.rally_seconds and now - self._last_read >= self.settings.frame_gap:
                    # The player is in a rally, so the pictures move the read between their own events.
                    self._want_read()
        elif kind == "round_end":
            self._on_round_end(message)

    def _tick_play(self) -> None:
        """Move the play clock. Time between two events counts as play unless the gap is a pause."""
        now = time.monotonic()
        if self._last_play_at is not None and now - self._last_play_at < self.settings.play_gap:
            self.play_seconds += now - self._last_play_at
        self._last_play_at = now
        self._play_moved.set()   # wakes a result that is waiting for the game to speak, or for the play clock
        if self.match is not None:
            self.match.play_seconds = self.play_seconds   # the adapter measures its own waits in play time

    async def _start_over(self) -> None:
        """The game came back and is playing round 1 again: a new match under the same id.

        Everything counted so far is dropped. The design is kept. If the old
        match had changed the behaviour, the starting one is sent again, with
        a version that still goes up.
        """
        old = self.match
        assert old is not None and self.setup is not None
        for task in [self._watching, *(look.get("task") for look in self._looks.values())]:
            if task is not None and not task.done():
                task.cancel()
        self._watching = None
        self._looks, self._returned = {}, {}
        self._look_number, self._next_to_land = 0, 1
        self._ask_at_round_end = False
        self._adapt_not_before = 0.0
        self._full_wanted = self._read_wanted = False
        self.play_seconds, self._last_play_at = 0.0, time.monotonic()
        self.real_updates, self._last_real_play, self._last_real_wall = 0, 0.0, None
        self._drop_through, self._events_at_real, self._holding_real = 0, None, False
        self._highest_round = self._player_round = self._round_at_real = 0
        self._last_real_kept = False
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
        self._last_event_at = time.monotonic()
        if self._play_began is None:
            self._play_began = time.monotonic()
            asyncio.get_running_loop().call_later(self.settings.first_adapt_delay + 0.01, self._maybe_adapt)
        if message.get("by") == "player":
            self._player_events += 1
            self._last_player_at = time.monotonic()
            self._reads_paused = False
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
                data={**summary, "play_seconds": round(self.play_seconds, 1)},
            ))
        if message.get("break") is True and self._break_allows_deeper():
            self._full_wanted = True
        if self._ask_at_round_end:
            # The adapter was holding a step for the end of a round. Look now, with no rest.
            self._ask_at_round_end = False
            self._adapt_not_before = 0.0
        if self.play_seconds - self._last_real_play >= self.settings.min_play:
            # A round just finished and the last change is old enough for another. Nothing here may delay
            # the look: no rest after an empty look, and no wait for play to pick up after the last change.
            self._adapt_not_before = 0.0
            if not (self._needs_later_round() and number <= self._round_at_real):
                self._events_at_real = None
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
            began = self._last_read = time.monotonic()
            self._reads_started += 1
            if self._reporting is None or self._reporting.done():
                self._reporting = self._spawn(self._report_reads())
            try:
                read = await self.parts.watcher.read(self.match)  # type: ignore[union-attr]
            except Exception as problem:
                self.trace(trace_message("watcher", "error", f"The watcher failed: {type(problem).__name__}: {problem}"))
                continue
            self._reads_answered += 1
            self._read_ms.append((time.monotonic() - began) * 1000)
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

    async def _report_reads(self) -> None:
        """Every few seconds, say how many reads started, how many came back and how fast.

        Stops after a window with no reads. The next read starts it again.
        """
        every = self.settings.report_every
        while True:
            await asyncio.sleep(every)
            started, answered, took = self._reads_started, self._reads_answered, self._read_ms
            self._reads_started, self._reads_answered, self._read_ms = 0, 0, []
            if started == 0 and answered == 0:
                return
            median = round(statistics.median(took)) if took else None
            speed = "" if median is None else f", median {median} ms"
            self.trace(trace_message(
                "server", "done",
                f"Reads in the last {every:g} seconds: {started} started, {answered} answered{speed}.",
                data={
                    "window_seconds": every, "reads_started": started, "reads_answered": answered,
                    "median_ms": median, "reads_per_second": round(answered / every, 2) if every > 0 else None,
                    "play_seconds": round(self.play_seconds, 1),
                },
            ))

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
        """Start the next look if it is time and there is something new to go on.

        The first look starts once the player has done a few things, or a
        set time after play begins. After that, up to `parallel` looks can be
        in flight: a second one starts only when the one in flight is old
        enough and there is news since it started. A long break can ask for
        one deeper look, which waits for the others to land and runs alone.
        """
        if self.parts.adapter is None or not self.settings.adapt or not self.settings.larger_loop or self.match is None:
            return
        if self.socket is None:
            return  # the game has gone. A look now would be a paid call for nobody.
        if any(look["source"] == "full" for look in self._looks.values()):
            return  # a deeper look runs alone
        if self._holding_real:
            return  # a change is ready and goes out as soon as the play clock allows. Nothing new until then.
        if self._events_at_real is not None:
            # A change just stopped the game. Look again only once the player is playing on.
            if (self._player_events <= self._events_at_real
                    or self.play_seconds - self._last_real_play < self.settings.resume_play):
                return
            if self._needs_later_round() and self._player_round <= self._round_at_real:
                return  # the game stops at the end of the point, so only a later round shows that play resumed
            self._events_at_real = None
        now = time.monotonic()
        if self._full_wanted:
            if self._looks:
                return  # it starts once the looks in flight have landed
            self._full_wanted = False
            seconds = float(self._plan().get("break_seconds", 0))
            self._start_look("full", self.settings.patience * seconds + self.settings.grace)
            return
        if len(self._looks) >= max(1, self.settings.parallel):
            return
        if self._ask_at_round_end:
            return  # the adapter is holding a step it can only send after a round ends, so wait for that
        rounds = self._rounds_played()
        if self._player_events == self._adapted_on and rounds == self._adapted_rounds:
            return  # no new player event and no round they played in ended since the last look started
        if self._player_events == 0 and rounds == 0:
            return  # nothing to go on yet
        if not self._first_look_due(now):
            return
        if self._looks:
            wait = max(look["started"] for look in self._looks.values()) + self.settings.stagger - now
            if wait > 0:
                self._look_again_in(wait)
                return
        elif now < self._adapt_not_before:
            return  # the last look decided to wait, so give play a moment before looking again
        self._start_look("quick", self.settings.patience * self._update_seconds() + self.settings.grace)

    def _needs_later_round(self) -> bool:
        """Must the next look wait until the player is playing a later round than the last change saw?

        Always after a step the adapter had kept ready: never two kept steps
        in a row, so the next change has to come from a look that saw this
        one played. After any other change, the setting decides.
        """
        return self.settings.look_after_resume or self._last_real_kept

    def _first_look_due(self, now: float) -> bool:
        """The first look waits for a few player events, or for a set time after play began."""
        if self._look_number > 0:
            return True
        if self._player_events >= self.settings.first_adapt_events:
            return True
        return self._play_began is not None and now - self._play_began >= self.settings.first_adapt_delay

    def _look_again_in(self, seconds: float) -> None:
        """Come back to `_maybe_adapt` when the stagger has passed. One timer at a time."""
        loop = asyncio.get_running_loop()
        timer = self._stagger_timer
        if timer is not None and not timer.cancelled() and timer.when() > loop.time():
            return
        self._stagger_timer = loop.call_later(seconds + 0.01, self._maybe_adapt)

    def _start_look(self, source: str, timeout: float) -> None:
        self._adapted_on = self._player_events
        self._adapted_rounds = self._rounds_played()
        self._look_number += 1
        number = self._look_number
        self._looks[number] = {"source": source, "started": time.monotonic()}
        self._looks[number]["task"] = self._spawn(self._adapt(number, source, timeout))

    def _rounds_played(self) -> int:
        """How many rounds have finished. Every one is news, also a round lost without the player reaching the ball."""
        return len(self.match.rounds) if self.match is not None else 0

    async def _adapt(self, number: int, source: str, timeout: float) -> None:
        """Run look `number`, then apply its result when every earlier look has had its turn."""
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
        if update is None and self._adapter_is_waiting():
            # The adapter is keeping a step ready for after the player's next round. No rest:
            # the next round they play in starts a look the moment it ends.
            self._ask_at_round_end = True
        elif update is None and source == "quick":
            self._adapt_not_before = time.monotonic() + self.settings.rest
        self._returned[number] = update
        self._play_moved.set()   # a result that is waiting for play may now have a newer one behind it
        await self._land_in_order()
        # Straight on to the next one, if the player has done anything since.
        asyncio.get_running_loop().call_soon(self._maybe_adapt)

    def _adapter_is_waiting(self) -> bool:
        """Is the adapter holding a ready step for this match? An adapter without `waiting` never is."""
        waiting = getattr(self.parts.adapter, "waiting", None)
        if not callable(waiting):
            return False
        try:
            return bool(waiting(self.match_id))
        except Exception:
            return False

    async def _land_in_order(self) -> None:
        """Apply the results that are ready, in the order their looks started.

        A look that came back before an earlier one waits here until that one
        has come back or failed. A result from a look that started before the
        last change went out is dropped: it was written for the old behaviour
        and would stop the game again. A change that is ready too soon after
        the last one waits for the play clock. Two updates of any kind never
        go out inside `update_gap`.
        """
        async with self._landing:
            while self._next_to_land in self._returned:
                number = self._next_to_land
                update = self._returned.pop(number)
                if update is not None and number <= self._drop_through:
                    self.trace(trace_message(
                        "server", "done", "A newer change is already in, so this one is dropped.",
                        data={"look": number, "play_seconds": round(self.play_seconds, 1)},
                    ))
                    update = None
                if update is not None:
                    real = is_real(update)
                    try:
                        wait = self._last_update_at + self.settings.update_gap - time.monotonic()
                        if wait > 0:
                            await asyncio.sleep(wait)
                        if not await self._wait_to_send(number, real):
                            self.trace(trace_message(
                                "server", "done", "A newer result is ready, so the one that was waiting for play is dropped.",
                                data={"look": number, "play_seconds": round(self.play_seconds, 1)},
                            ))
                        elif await self._send_update(update) and real:
                            self._after_real_update(update)
                    except Exception as problem:
                        self.trace(trace_message("adapter", "error", f"Could not apply look {number}: {type(problem).__name__}: {problem}"))
                self._looks.pop(number, None)
                self._next_to_land = number + 1

    async def _wait_to_send(self, number: int, real: bool) -> bool:
        """Wait until look `number`'s result may go to the game. False when a newer result replaced it.

        Two things can hold it. A change waits for the play clock to reach
        the floor since the last change. And any update waits for the game
        to speak: a stopped game sends no `event` or `round_end`, and an
        update sent then would go live on resume with nothing shown.
        """
        try:
            while True:
                floor_met = (not (real and self.settings.stop_on_change)
                             or self.play_seconds >= self._last_real_play + self.settings.min_play)
                window = self.settings.send_window
                playing = window <= 0 or (
                    self._last_play_at is not None and time.monotonic() - self._last_play_at <= window
                )
                if floor_met and playing:
                    return True
                if any(later > number and result is not None for later, result in self._returned.items()):
                    return False  # it has to wait, and a newer result is already here
                self._holding_real = not floor_met   # a change waiting for the clock keeps new looks from starting
                self._play_moved.clear()
                await self._play_moved.wait()
        finally:
            self._holding_real = False

    def _after_real_update(self, update: Message) -> None:
        """A change just went to the game, which stops play. Start the count to the next one."""
        now = time.monotonic()
        since_wall = now - (self._last_real_wall if self._last_real_wall is not None else self._play_began or now)
        since_play = self.play_seconds - self._last_real_play
        self.real_updates += 1
        self._last_real_play, self._last_real_wall = self.play_seconds, now
        if self.settings.stop_on_change:
            self._drop_through = self._look_number     # every look started so far was written for the old behaviour
            self._events_at_real = self._player_events
            self._round_at_real = self._highest_round
            self._last_real_kept = bool(update.get("kept"))
            self._adapt_not_before = 0.0
        self.trace(trace_message(
            "server", "done",
            f"Change {self.real_updates} went out after {since_play:.0f} seconds of play.",
            data={
                "play_seconds_since_last_change": round(since_play, 1),
                "wall_seconds_since_last_change": round(since_wall, 1),
                "real_updates": self.real_updates,
                "play_seconds": round(self.play_seconds, 1),
            },
        ))

    async def _send_update(self, update: Message) -> bool:
        """Check a `strategy_update`, make its version go up, and send it. False when it was held back."""
        match = self.match
        assert match is not None
        if not isinstance(update, dict) or not isinstance(update.get("behaviour"), dict):
            self.trace(trace_message("adapter", "error", "Held back an update with no behaviour in it."))
            return False
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
            return False

        tracked = set(self._value_names())
        for name, spec in new_values.items():
            if name not in tracked:
                match.design.values.append(ValueSpec(name=name, about=spec.get("label", name), question=spec.get("question", {})))
        known = {value.name: value for value in match.design.values if value.counts}
        if any(name in known for name in new_values):
            update["new_values"] = {
                name: {**value_entry(known[name]), **spec} if name in known else spec for name, spec in new_values.items()
            }
        match.behaviour = update["behaviour"]
        match.updates.append(update)
        self._last_update_at = time.monotonic()
        await self.send(update)
        return True
