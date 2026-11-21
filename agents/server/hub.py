"""The viewer stream.

Everything that happens in a match goes through here: each message in, each
message out and each trace. Every `/watch` client gets it as one line,

    {"dir": "in" | "out" | "trace", "t": seconds since the match started,
     "at": clock time in seconds, "match": match id, "message": {...}}

and a client that connects late first gets the matches still going so far.
With recording on, the same lines are written to data/streams/<match_id>.jsonl.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path
from typing import Any, TextIO

Message = dict[str, Any]
Line = dict[str, Any]

# A viewer that names no match first gets every match that spoke this recently.
RECENT_SECONDS = 120.0


def _keep_earlier(path: Path) -> None:
    """Move an earlier recording out of the way, so a restart or a reused match id never wipes it.

    The newest recording always has the plain name. Earlier ones become
    <name>.earlier-1.jsonl, <name>.earlier-2.jsonl and so on, oldest first.
    """
    if not path.exists() or path.stat().st_size == 0:
        return
    number = 1
    while (kept := path.with_name(f"{path.stem}.earlier-{number}.jsonl")).exists():
        number += 1
    path.rename(kept)


def _file_name(match_id: str) -> str:
    """A match id made safe to use as a file name."""
    return re.sub(r"[^A-Za-z0-9_.-]", "_", match_id)[:80] or "match"


class Hub:
    def __init__(self, record_dir: Path | None = None) -> None:
        self.history: dict[str, list[Line]] = {}      # match_id -> every line so far
        self.latest: str | None = None                # the match that spoke last
        self._viewers: dict[asyncio.Queue[Line], str | None] = {}
        self._last_frames: dict[str, int] = {}        # match_id -> index of its newest `frames` line
        self._record_dir = record_dir
        self._files: dict[str, TextIO] = {}

    def publish(self, match_id: str, direction: str, t: float, message: Message) -> None:
        """Add one line to a match and hand it to everyone watching. Never waits."""
        line: Line = {"dir": direction, "t": round(max(t, 0.0), 3), "at": round(time.time(), 3),
                      "match": match_id, "message": message}
        lines = self.history.setdefault(match_id, [])
        if message.get("type") == "frames":
            self._drop_old_pictures(match_id, lines)
            self._last_frames[match_id] = len(lines)
        lines.append(line)
        self.latest = match_id
        self._record(match_id, line)
        for queue, wanted in self._viewers.items():
            if wanted is None or wanted == match_id:
                queue.put_nowait(line)

    def join(self, match_id: str | None = None) -> asyncio.Queue[Line]:
        """Start watching. The queue is filled with the match so far.

        With no match_id the viewer gets every match that spoke in the last
        two minutes, the one that spoke last at the end, then every match
        live. Each line's `at` says when it happened, so a viewer that sits
        in a game's own page can tell which match began as it connected.
        """
        queue: asyncio.Queue[Line] = asyncio.Queue()
        if match_id:
            wanted = [match_id]
        else:
            now = time.time()
            recent = [(lines[-1].get("at", 0.0), key) for key, lines in self.history.items()
                      if lines and key != self.latest and now - lines[-1].get("at", 0.0) <= RECENT_SECONDS]
            wanted = [key for _, key in sorted(recent)] + ([self.latest] if self.latest else [])
        for key in wanted:
            for line in self.history.get(key, []):
                queue.put_nowait(line)
        self._viewers[queue] = match_id
        return queue

    def leave(self, queue: asyncio.Queue[Line]) -> None:
        self._viewers.pop(queue, None)

    def reset(self, match_id: str) -> None:
        """Forget a match, so a new one can reuse its id."""
        self.history.pop(match_id, None)
        self._last_frames.pop(match_id, None)
        handle = self._files.pop(match_id, None)
        if handle:
            handle.close()

    def close(self) -> None:
        for handle in self._files.values():
            handle.close()
        self._files.clear()

    def _drop_old_pictures(self, match_id: str, lines: list[Line]) -> None:
        """Keep the picture data of only the newest `frames` in the replay.

        Live viewers and the recording still get every picture. This only
        keeps the replay for a late viewer small.
        """
        index = self._last_frames.get(match_id)
        if index is None or index >= len(lines):
            return
        old = lines[index]["message"]
        views = old.get("views") if isinstance(old.get("views"), dict) else {}
        thin = {
            name: {**picture, "data": ""} if isinstance(picture, dict) else picture
            for name, picture in views.items()
        }
        lines[index] = {**lines[index], "message": {**old, "views": thin}}

    def _record(self, match_id: str, line: Line) -> None:
        if self._record_dir is None:
            return
        try:
            handle = self._files.get(match_id)
            if handle is None:
                self._record_dir.mkdir(parents=True, exist_ok=True)
                path = self._record_dir / f"{_file_name(match_id)}.jsonl"
                _keep_earlier(path)
                handle = open(path, "w", encoding="utf-8")
                self._files[match_id] = handle
            handle.write(json.dumps(line) + "\n")
            handle.flush()
        except OSError as problem:
            print(f"[server] Could not record the stream for {match_id}: {problem}")
            self._record_dir = None
