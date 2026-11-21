"""Round 1 checks on the stand-in game: lifecycle probes and a reading of recorded streams.

  python -m eval.round1 analyse data/streams/eval_*.jsonl
  python -m eval.round1 probe --url ws://localhost:8031/ws --out ../../tmp/e2e/probe.json

`analyse` reads the server's own recordings (--record) and reports the short
loop, the larger loop, local picks, settings and any usage numbers. `probe`
plays scripted pieces of a match over a raw socket: a reconnect mid-match, a
restart with the same match id, a malformed event and a clean match, and
reports every `error` the server sent.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import random
import statistics
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

import websockets

from sim.headless import SimModel, load_json

Message = dict[str, Any]
ROOT = Path(__file__).resolve().parent.parent


# Reading recorded streams ---------------------------------------------------------


def _rows(path: Path) -> list[Message]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def analyse(paths: list[Path]) -> dict[str, Any]:
    watcher_ms: list[float] = []
    adapter_ms: list[float] = []
    adapter_status: Counter = Counter()
    adapter_errors: list[str] = []
    picks = by_rule = 0
    updates = updates_with_changes = updates_with_why = 0
    speeds: list[float] = []
    tokens: Counter = Counter()
    errors: list[tuple[str, Message]] = []
    ready_seconds: list[float] = []
    for path in paths:
        rows = _rows(path)
        setup_t = None
        for row in rows:
            message = row.get("message", {})
            kind = message.get("type")
            if kind == "setup":
                setup_t = row.get("t")
            if kind == "ready" and setup_t is not None and row.get("t") is not None:
                ready_seconds.append(row["t"] - setup_t)
            if kind == "error":
                errors.append((path.name, message))
            if kind == "event" and message.get("picked"):
                picks += len(message["picked"])
                by_rule += len(message.get("by_rule") or [])
            if kind == "strategy_update":
                updates += 1
                updates_with_changes += 1 if message.get("changes") else 0
                updates_with_why += 1 if all(c.get("why") for c in message.get("changes") or []) and message.get("changes") else 0
                speed = (message.get("settings") or {}).get("opponent_speed")
                if isinstance(speed, (int, float)):
                    speeds.append(speed)
            if kind == "trace":
                stage, status, data = message.get("stage"), message.get("status"), message.get("data") or {}
                for key, value in data.items():
                    if "token" in key and isinstance(value, (int, float)):
                        tokens[f"{stage}.{key}"] += value
                    if key in ("usage", "cost", "dollars") :
                        tokens[f"{stage}.{key}"] += value if isinstance(value, (int, float)) else 0
                if stage == "watcher" and status == "done" and message.get("ms") is not None:
                    watcher_ms.append(message["ms"])
                if stage == "adapter" and status in ("done", "error"):
                    adapter_status[status] += 1
                    if message.get("ms") is not None:
                        adapter_ms.append(message["ms"])
                    if status == "error":
                        adapter_errors.append(message.get("about", "")[:160])

    def spread(values: list[float]) -> dict[str, Any]:
        if not values:
            return {"n": 0}
        ordered = sorted(values)
        return {"n": len(values), "median": round(statistics.median(ordered)), "p90": round(ordered[int(0.9 * (len(ordered) - 1))]),
                "max": round(ordered[-1])}

    return {
        "streams": len(paths),
        "setup_to_ready_seconds": spread(ready_seconds),
        "watcher_ms": spread(watcher_ms),
        "adapter_ms": spread(adapter_ms),
        "adapter_status": dict(adapter_status),
        "adapter_errors": adapter_errors[:8],
        "picks": picks,
        "picks_by_rule": by_rule,
        "share_by_rule": round(by_rule / picks, 3) if picks else None,
        "updates": updates,
        "updates_with_changes": updates_with_changes,
        "updates_where_every_change_says_why": updates_with_why,
        "opponent_speed_values": sorted(set(speeds)),
        "usage_totals": dict(tokens),
        "errors": [{"file": f, "about": m.get("about"), "where": m.get("where")} for f, m in errors[:10]],
    }


# Probing a live server ------------------------------------------------------------


class Probe:
    """A bare game over a raw socket, so each lifecycle step is explicit."""

    def __init__(self, url: str, setup: Message, model: SimModel, match_id: str, seed: int = 0):
        self.url, self.model, self.match_id = url, model, match_id
        self.setup = {**setup, "match_id": match_id, "mode": "live"}
        self.setup["practice"] = {**setup.get("practice", {}), "stand_in": True}
        self.rng = random.Random(seed)
        self.received: list[Message] = []
        self.ws: Any = None
        self.behaviour = setup.get("default_behaviour") or {"version": 0, "npcs": {}}
        self.round = 0

    async def connect(self) -> float:
        """Open the socket, send setup and return seconds until `ready` (or -1)."""
        self.ws = await websockets.connect(self.url, max_size=None)
        start = time.monotonic()
        await self.ws.send(json.dumps(self.setup))
        while True:
            try:
                raw = await asyncio.wait_for(self.ws.recv(), timeout=120)
            except asyncio.TimeoutError:
                return -1.0
            message = json.loads(raw)
            self.received.append(message)
            if message.get("type") == "practice_run":
                continue
            if message.get("type") == "ready":
                self.behaviour = message.get("behaviour") or self.behaviour
                return round(time.monotonic() - start, 2)

    async def send(self, message: Message) -> None:
        await self.ws.send(json.dumps({"match_id": self.match_id, **message}))

    async def drain(self, seconds: float) -> None:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            try:
                raw = await asyncio.wait_for(self.ws.recv(), timeout=max(0.05, end - time.monotonic()))
            except (asyncio.TimeoutError, websockets.ConnectionClosed):
                return
            message = json.loads(raw)
            self.received.append(message)
            if message.get("type") == "strategy_update" and message.get("behaviour"):
                self.behaviour = message["behaviour"]

    async def play(self, rounds: int, player: str = "forehand_lover") -> None:
        for _ in range(rounds):
            self.round += 1
            number = self.round

            async def emit(name: str, by: str, data: Message, picked: Any, by_rule: Any) -> None:
                event: Message = {"type": "event", "name": name, "round": number, "t": number * 5.0,
                                  "by": by, "data": data}
                if picked is not None:
                    event.update({"picked": picked, "by_rule": by_rule or []})
                await self.send(event)

            result = await self.model.play_round(player, self.behaviour, dict, self.rng, emit)
            await self.send({"type": "round_end", "round": number, "t": number * 5.0 + 4, "winner": result.winner,
                             "how": result.how, "stats": result.stats, "score": {"player": 0, "opponent": 0},
                             "break": True})
            await self.drain(1.0)

    def errors(self) -> list[Message]:
        return [m for m in self.received if m.get("type") == "error"]

    def count(self, kind: str) -> int:
        return sum(1 for m in self.received if m.get("type") == kind)


async def probe(url: str) -> dict[str, Any]:
    setup = load_json(ROOT / "examples/tennis/setup.json")
    model = SimModel(load_json(ROOT / "examples/tennis/sim.json"), setup)
    stamp = int(time.time())
    out: dict[str, Any] = {}

    # A clean match: no errors expected.
    clean = Probe(url, setup, model, f"r1_clean_{stamp}", seed=1)
    out["clean_ready_seconds"] = await clean.connect()
    await clean.play(4)
    await clean.drain(3)
    out["clean"] = {"errors": clean.errors(), "player_reads": clean.count("player_read"),
                    "updates": clean.count("strategy_update")}
    await clean.ws.close()

    # A reconnect mid-match with the same match id.
    again = Probe(url, setup, model, f"r1_reconnect_{stamp}", seed=2)
    await again.connect()
    await again.play(2)
    await again.ws.close()
    before = len(again.received)
    out["reconnect_ready_seconds"] = await again.connect()
    ready = again.received[-1]
    await again.play(2)
    await again.drain(3)
    out["reconnect"] = {"errors": again.errors(), "ready_version": (ready.get("behaviour") or {}).get("version"),
                        "messages_after_reconnect": Counter(m.get("type") for m in again.received[before:])}
    await again.ws.close()

    # A restart with the same match id after the match finished.
    redo = Probe(url, setup, model, f"r1_reconnect_{stamp}", seed=3)
    out["restart_same_id_ready_seconds"] = await redo.connect()
    await redo.play(1)
    await redo.drain(2)
    out["restart_same_id"] = {"errors": redo.errors(),
                              "ready_version": (redo.received[0].get("behaviour") or {}).get("version")
                              if redo.received and redo.received[0].get("type") == "ready" else None}
    await redo.ws.close()

    # Malformed messages: the server should say what is wrong and keep the socket open.
    bad = Probe(url, setup, model, f"r1_malformed_{stamp}", seed=4)
    await bad.connect()
    await bad.send({"type": "event", "name": "shot", "round": 1, "t": 1.0, "by": "player",
                    "data": {"side": "sideways", "spin_rate": 3}})
    await bad.send({"type": "event", "round": 1, "t": 1.1, "by": "player", "data": {}})
    await bad.send({"type": "no_such_message", "round": 1})
    await bad.ws.send("this is not json")
    await bad.drain(2)
    still_open = True
    try:
        await bad.play(1)
        await bad.drain(2)
    except websockets.ConnectionClosed:
        still_open = False
    out["malformed"] = {"errors": [{"about": e.get("about"), "where": e.get("where")} for e in bad.errors()],
                        "socket_stayed_open": still_open, "player_reads_after": bad.count("player_read")}
    await bad.ws.close()
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m eval.round1")
    sub = parser.add_subparsers(dest="command", required=True)
    a = sub.add_parser("analyse")
    a.add_argument("streams", nargs="+")
    p = sub.add_parser("probe")
    p.add_argument("--url", required=True)
    p.add_argument("--out", default=None)
    args = parser.parse_args(argv)
    if args.command == "analyse":
        result = analyse([Path(s) for s in args.streams])
    else:
        result = asyncio.run(probe(args.url))
        if args.out:
            Path(args.out).write_text(json.dumps(result, indent=2, default=str))
    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
