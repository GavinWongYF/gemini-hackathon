"""Keeps each game's design on disk, so a game is only designed once.

A design is stored under the game's name plus a hash of its `setup`. The
parts of `setup` that change from match to match (`match_id`, `mode`, `plan`
and the `practice` block) are left out of the hash, so a practice session
and a later live match of the same game share one design.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .interfaces import Design, Matchup, ValueSpec

Message = dict[str, Any]

# What can differ between two runs of one game. A practice run with no screen
# sends no pictures, so `views` is left out too.
NOT_PART_OF_THE_GAME = ("type", "match_id", "mode", "plan", "practice", "views")


def design_key(setup: Message) -> str:
    """The name a game's design is stored under."""
    game = re.sub(r"[^a-z0-9]+", "_", str(setup.get("game", "game")).lower()).strip("_") or "game"
    core = {key: value for key, value in setup.items() if key not in NOT_PART_OF_THE_GAME}
    practice = setup.get("practice")
    if isinstance(practice, dict) and practice.get("stand_in"):
        # What a stand-in teaches is about the stand-in. It never shares a
        # stored design with the real game, even when their setups match.
        core["stand_in"] = True
    digest = hashlib.sha256(json.dumps(core, sort_keys=True).encode("utf-8")).hexdigest()
    return f"{game}-{digest[:12]}"


def design_path(folder: Path, setup: Message) -> Path:
    return folder / f"{design_key(setup)}.json"


def save_design(folder: Path, setup: Message, design: Design) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = design_path(folder, setup)
    if not design.matchups:
        kept = load_design(folder, setup)
        if kept is not None and kept.matchups:
            return path  # a playtested design is never replaced by one with no playtest
    record = {
        "game": setup.get("game"),
        "key": design_key(setup),
        "saved_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "design": asdict(design),
    }
    path.write_text(json.dumps(record, indent=2), encoding="utf-8")
    return path


def load_design(folder: Path, setup: Message) -> Design | None:
    """The stored design for this game, or None if there isn't a usable one."""
    path = design_path(folder, setup)
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))["design"]
        return Design(
            values=[ValueSpec(**value) for value in raw["values"]],
            behaviour=raw["behaviour"],
            matchups=[Matchup(**matchup) for matchup in raw.get("matchups", [])],
            notes=list(raw.get("notes", [])),
            timings=dict(raw.get("timings", {})),
            personas=list(raw.get("personas", [])),
            dials=list(raw.get("dials", [])),
        )
    except (OSError, ValueError, KeyError, TypeError) as problem:
        print(f"[server] Ignoring the stored design at {path}: {problem}")
        return None
