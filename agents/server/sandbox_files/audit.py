"""The audit on the library. Runs after every file write and shell command.

It logs the call, then checks what the guard could not see: that each rule
set in /workspace/library/ is the same one evaluate.py tested, by comparing
its fingerprint with the one saved in /workspace/tests/. It cannot undo a
save. It writes one line per call to /workspace/hook_log/audit.jsonl, and the
server reads the last line after the run.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time

LIBRARY = "/workspace/library"
TESTS = "/workspace/tests"
LOG = "/workspace/hook_log/audit.jsonl"


def fingerprint(behaviour: dict) -> str:
    text = json.dumps(behaviour.get("npcs"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def state(name: str) -> str:
    """"tested", "untested", "failed" or "changed" for one library entry."""
    try:
        with open(os.path.join(LIBRARY, name + ".json")) as handle:
            saved = fingerprint(json.load(handle))
    except (OSError, ValueError, AttributeError):
        return "unreadable"
    try:
        with open(os.path.join(TESTS, name + ".json")) as handle:
            test = json.load(handle)
    except (OSError, ValueError):
        return "untested"
    if test.get("passed") is not True:
        return "failed"
    return "tested" if test.get("fingerprint") == saved else "changed"


def main() -> None:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except ValueError:
        payload = {}
    call = payload.get("tool_call") or {}
    try:
        names = sorted(name[:-5] for name in os.listdir(LIBRARY) if name.endswith(".json"))
    except OSError:
        names = []
    library = {name: state(name) for name in names}
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a") as handle:
            handle.write(json.dumps({
                "t": round(time.time(), 2), "tool": call.get("name"), "keys": sorted(payload),
                "args": {key: str(value)[:300] for key, value in (call.get("args") or {}).items()},
                "library": library,
                "flagged": sorted(name for name, found in library.items() if found != "tested"),
            }) + "\n")
    except OSError:
        pass


if __name__ == "__main__":
    main()
