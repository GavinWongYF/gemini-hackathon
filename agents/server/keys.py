"""Which API key is in use, and what happens when its credit runs out.

The key comes from the first place that has one:

    1. the environment (GEMINI_API_KEY)
    2. agents/.env
    3. the repo's .env, one folder up

A different key found in a .env file is kept as a fallback. When a call
fails because the active key has no credit left (HTTP 402), the process
moves to the fallback once, for good, and the call is tried once more.

A key's value never leaves this file except through `active_key`. Nothing
here prints a key, part of a key, or its length.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Awaitable, Callable, TypeVar

T = TypeVar("T")

ENV_NAME = "GEMINI_API_KEY"
FROM_ENVIRONMENT = "the environment"
AGENTS = Path(__file__).resolve().parent.parent
ENV_FILES: list[tuple[Path, str]] = [
    (AGENTS / ".env", "agents/.env"),
    (AGENTS.parent / ".env", "the repo's .env"),
]

_loaded = False
_file_keys: list[tuple[str, str]] = []      # (key, where it came from), for every .env file that has one
_moved_to: tuple[str, str] | None = None    # set once the first key has run out
_generation = 0                             # goes up when the key changes, so cached clients rebuild
_listeners: list[Callable[[str], None]] = []


def looks_unfilled(value: str) -> bool:
    """Whether a key is missing, or still the placeholder line from .env.example."""
    low = value.lower()
    return not value or "your_" in low or low.endswith("_here") or "<" in value or " " in value


def _key_in(path: Path) -> str:
    """The key written in one .env file, or "" if the file or a filled-in line is missing."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    for line in lines:
        line = line.strip().removeprefix("export ").strip()
        name, found, value = line.partition("=")
        if found and name.strip() == ENV_NAME:
            value = value.strip().strip("\"'")
            return "" if looks_unfilled(value) else value
    return ""


def load(files: list[tuple[Path, str]] | None = None) -> None:
    """Read the .env files once. The environment itself is read on every call."""
    global _loaded, _file_keys
    _file_keys = [(key, source) for path, source in (files or ENV_FILES) if (key := _key_in(path))]
    _loaded = True


def reset() -> None:
    """Forget everything, as at the start of a process. For tests."""
    global _loaded, _file_keys, _moved_to, _generation
    _loaded, _file_keys, _moved_to, _generation = False, [], None, 0
    _listeners.clear()


def _current() -> tuple[str, str]:
    """The key in use and where it came from. Both are "" when there is no key."""
    if not _loaded:
        load()
    if _moved_to is not None:
        return _moved_to
    from_environment = os.environ.get(ENV_NAME, "")
    if not looks_unfilled(from_environment):
        return from_environment, FROM_ENVIRONMENT
    return _file_keys[0] if _file_keys else ("", "")


def _fallback() -> tuple[str, str] | None:
    """The key to move to if the active one runs out, or None."""
    if _moved_to is not None:
        return None
    active, _ = _current()
    for key, source in _file_keys:
        if active and key != active:
            return key, source
    return None


def active_key() -> str:
    """The key every client should be built with right now."""
    key, _ = _current()
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.")
    return key


def source() -> str:
    """Where the active key came from, in words. "" when there is no key."""
    return _current()[1]


def generation() -> int:
    """A number that changes when the key does. A cached client made under an older number is stale."""
    return _generation


def start_line() -> str:
    """One line for the start of a run: where the key came from. Never the key."""
    where = source()
    if not where:
        return ("No GEMINI_API_KEY found. Set it in the environment, or put it in the .env file "
                "one folder above this one. Until then no model is called.")
    line = f"The API key in use comes from {where}."
    fallback = _fallback()
    if fallback is not None:
        line += f" If its credit runs out, the server moves to the key from {fallback[1]}."
    return line


def on_notice(listener: Callable[[str], None]) -> None:
    """Be told, in one plain line, when the key changes."""
    _listeners.append(listener)


def _announce(line: str) -> None:
    print(f"[server] {line}", flush=True)
    for listener in list(_listeners):
        try:
            listener(line)
        except Exception:
            pass


def out_of_credit(error: Any) -> bool:
    """Is this an HTTP 402 from the API, by its status code or by its text?"""
    seen = 0
    while error is not None and seen < 5:
        for name in ("code", "status_code", "status"):
            if getattr(error, name, None) == 402:
                return True
        if re.search(r"\b402\b", str(error)[:300]):
            return True
        error = getattr(error, "__cause__", None)
        seen += 1
    return False


def move_to_fallback() -> bool:
    """Move to the fallback key for the rest of the process. False when there is none."""
    global _moved_to, _generation
    fallback = _fallback()
    if fallback is None:
        return False
    _moved_to = fallback
    _generation += 1
    _announce(f"The first key ran out of credit. Moved to the key from {fallback[1]}.")
    return True


def moved_on(since: int) -> bool:
    """After a 402: is there a newer key to retry with than the one a call started on?

    True when another call already moved the process on, or when this one
    just did. False when there is nothing left to move to.
    """
    return _generation != since or move_to_fallback()


async def with_fallback(call: Callable[[], Awaitable[T]]) -> T:
    """Run `call()`. If it fails for lack of credit and another key is waiting,
    move to that key and run `call()` exactly once more.

    `call` must build its client when it runs, so the retry uses the new key.
    """
    began = _generation
    try:
        return await call()
    except Exception as error:
        if not out_of_credit(error) or not moved_on(began):
            raise
    return await call()
