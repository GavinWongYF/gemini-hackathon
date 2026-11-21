"""Shared shapes for the agent server.

Every part of the server builds against this file: the socket core, the
watcher (the fast read of the player), the designer (once per game) and the
adapter (a new behaviour between rounds). Messages are plain dicts in exactly
the shape docs/api.md describes, so nothing here knows which game is on the
other end of the socket.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

Message = dict[str, Any]    # one message from docs/api.md, as it travels on the socket
Behaviour = dict[str, Any]  # {"version": n, "npcs": {npc_id: {"decisions": {...}, "rules": [...]}}}
Trace = Callable[[Message], None]


def _no_trace(message: Message) -> None:
    return None


@dataclass
class ValueSpec:
    """One thing we track about the player, always scaled 0 to 1."""

    name: str                 # snake_case, unique within a match
    about: str                # one plain line, shown to people
    question: dict[str, Any]  # the Decisions API question that reads it
    # What the value counts, when it can be counted from the player's own events:
    # {"event": name, "field": name, "values": [options]}. The value is then the
    # share of that event's `field` that falls on `values`. None when it cannot be counted.
    counts: dict[str, Any] | None = None
    # What sort of read this is, so a screen can show a spread of different ones:
    # "share" (how often the player picks something), "level" (how big a number
    # they report is), "tell" (an early sign), "camera" (only the pictures show
    # it) or "likeness" (how alike the player is to one practice player).
    kind: str = "share"


@dataclass
class Matchup:
    """One playtest result: how an NPC option did against one kind of player."""

    player: str    # a scripted player named in setup["practice"]["players"]
    npc: str
    decision: str
    option: str
    rounds: int
    npc_wins: int
    stats: dict[str, Any] = field(default_factory=dict)


@dataclass
class Design:
    """What the designer makes once per game, from `setup` alone."""

    values: list[ValueSpec]
    behaviour: Behaviour                                    # the first behaviour, version 1
    matchups: list[Matchup] = field(default_factory=list)   # empty if the game has no practice mode
    notes: list[str] = field(default_factory=list)          # short lines for the second screen
    timings: dict[str, float] = field(default_factory=dict) # what setup measured, e.g. seconds per practice round
    personas: list[dict[str, Any]] = field(default_factory=list)  # player personas written at setup: {"name", "about", "plays"}
    dials: list[dict[str, Any]] = field(default_factory=list)     # settings the fairness check may move: {"setting", "harder": "up" or "down"}


@dataclass
class PlayerState:
    """The running read of the player. Every watcher read updates it in place."""

    values: dict[str, float] = field(default_factory=dict)      # name -> 0..1
    confidence: dict[str, float] = field(default_factory=dict)  # name -> 0..1
    reads: int = 0
    memory: dict[str, Any] = field(default_factory=dict)        # the watcher's own carry-over


@dataclass
class MatchState:
    """Everything the server knows about one match."""

    match_id: str
    setup: Message
    design: Design
    behaviour: Behaviour                                     # the latest behaviour sent to the game
    player: PlayerState = field(default_factory=PlayerState)
    events: list[Message] = field(default_factory=list)      # every `event`, oldest first
    frames: Message | None = None                            # the latest `frames`
    rounds: list[Message] = field(default_factory=list)      # every `round_end`, oldest first
    updates: list[Message] = field(default_factory=list)     # every `strategy_update` sent
    started: float = field(default_factory=time.monotonic)
    # Seconds of actual play so far. The session keeps it current. It stands still
    # while the game is paused or nobody is playing, so waits measured against it
    # do not run out while people read a pause screen.
    play_seconds: float = 0.0
    trace: Trace = _no_trace                                 # tells the viewers what just happened


class PracticeRefused(Exception):
    """The game said it cannot play a practice run, for example against a player it does not know."""


class Playtest(Protocol):
    """Runs practice rounds through the game's no-screen mode."""

    async def run(self, behaviour: Behaviour, player: str, rounds: int) -> Message:
        """Ask the game to play `rounds` practice rounds against one scripted
        player, using `behaviour`. Returns the game's `practice_result`."""
        ...


class Designer(Protocol):
    """Runs once per game. Slow is fine: its result is stored and reused."""

    async def design(self, setup: Message, playtest: Playtest | None, trace: Trace) -> Design:
        ...


class Watcher(Protocol):
    """The fast loop. Never raises, and the game never waits on it."""

    async def read(self, match: MatchState) -> Message | None:
        """Read the player from recent events and the latest frames. Updates
        `match.player` in place and returns a `player_read` message, or None
        when there is nothing new to say."""
        ...


class Adapter(Protocol):
    """The larger loop. It runs while play goes on, and the game swaps its
    result in at the next gap between rounds."""

    async def adapt(self, match: MatchState, source: str) -> Message | None:
        """Write the next behaviour. `source` is "quick" for a routine update
        during play or "full" for a deeper one at a break. Returns a
        `strategy_update` that already passes the contract check, or None to
        keep the current behaviour."""
        ...


Facts = dict[str, Any]
"""What every rule writer is given. The adapter builds it in code.

    {
      "setup":         the game's `setup` message,
      "goal":          setup["goal"],
      "behaviour":     the behaviour in play now,
      "values":        {name: 0..1},
      "confidence":    {name: 0..1},
      "value_about":   {name: one plain line},
      "measures":      measures.summary(...): habits, payoffs, the player's share of rounds,
      "recent_rounds": the last few `round_end` messages,
      "personas":      the player personas written at setup,
      "matchups":      [Matchup rows as dicts], empty when the game was never playtested,
      "counters":      options that beat the baseline, best first, each
                       {"npc", "decision", "option", "edge", "against", "likeness"},
      "earlier":       earlier updates, each {"version", "changes"},
      "max_candidates": how many rule sets a writer may try, or None,
    }
"""

Proposal = dict[str, Any]
"""What a rule writer hands back. The adapter checks it before anything is sent.

    {
      "behaviour":    the whole new behaviour,
      "observations": up to 3 short lines on how this player plays,
      "plan":         up to 3 short lines on what the NPCs will change,
      "changes":      [{"where", "from", "to", "why", "expect"}],
      "tested":       optional: what the writer measured before choosing,
    }
"""


class RuleWriter(Protocol):
    """Writes the next rules for the larger loop.

    Writers differ in how long they take and how much they check. The adapter
    picks one from how long the game says it can wait (see config.writer_for),
    so a quick game gets one fast model call and a game with long breaks gets
    a managed agent that writes several rule sets and tests them first.
    """

    name: str

    async def write(self, facts: Facts, budget_seconds: float, trace: Trace) -> Proposal | None:
        """Return a proposal inside the budget, or None to keep the current rules."""
        ...


def trace_message(
    stage: str,
    status: str,
    about: str,
    *,
    model: str | None = None,
    ms: float | None = None,
    data: dict[str, Any] | None = None,
) -> Message:
    """Build one trace line for the viewers.

    stage:  "server", "designer", "playtest", "watcher", "adapter" or "measures"
    status: "start", "step", "done" or "error". A "step" is one thing a long
            run did on the way, such as a rule set written, tested, blocked or approved.
    about:  one plain sentence a person can read on the second screen
    """
    message: Message = {"type": "trace", "stage": stage, "status": status, "about": about}
    if model is not None:
        message["model"] = model
    if ms is not None:
        message["ms"] = round(ms)
    if data is not None:
        message["data"] = data
    return message
