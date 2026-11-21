"""Replay one recorded stream against a running server and save what comes back.

    python -m eval.replay STREAM [--url ws://localhost:8000/ws] [--speed 1]
                          [--match-id ID] [--out FILE] [noise options]

The `in` messages of STREAM are sent with their original timing (divided by
--speed) under a new match id. Every message the server sends back is saved,
and when the server records streams, its traces for the new match are added.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path

import websockets

from eval.replay.noise import Noise, apply

HERE = Path(__file__).resolve().parents[2]  # agents/


def load_inputs(path: Path) -> list[tuple[float, dict]]:
    items = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("dir") == "in":
            items.append((float(row.get("t") or 0), row["message"]))
    items.sort(key=lambda pair: pair[0])
    return items


def slim(message: dict) -> dict:
    """A copy without image bytes, for the saved file."""
    if message.get("type") != "frames":
        return message
    out = dict(message)
    out["views"] = {
        name: {k: (f"<{len(v)} chars>" if k == "data" else v) for k, v in (view or {}).items()}
        for name, view in (message.get("views") or {}).items()
    }
    return out


async def replay(items, url: str, match_id: str, speed: float, tail: float) -> tuple[list[dict], list[dict]]:
    sent: list[dict] = []
    got: list[dict] = []
    async with websockets.connect(url, max_size=None) as ws:
        start = time.monotonic()

        async def reader():
            try:
                async for raw in ws:
                    got.append({"dir": "out", "t": round(time.monotonic() - start, 3), "message": json.loads(raw)})
            except websockets.ConnectionClosed:
                pass

        task = asyncio.create_task(reader())
        base = items[0][0] if items else 0.0
        for send_t, message in items:
            message = dict(message)
            message["match_id"] = match_id
            due = (send_t - base) / speed
            wait = due - (time.monotonic() - start)
            if wait > 0:
                await asyncio.sleep(wait)
            await ws.send(json.dumps(message))
            sent.append({"dir": "in", "t": round(time.monotonic() - start, 3), "message": slim(message)})
        await asyncio.sleep(tail)
        task.cancel()
    return sent, got


def server_traces(streams_dir: Path, match_id: str) -> list[dict]:
    path = streams_dir / f"{match_id}.jsonl"
    if not path.exists():
        return []
    rows = []
    for line in path.read_text().splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("dir") == "trace":
            rows.append(row)
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m eval.replay", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stream", type=Path)
    ap.add_argument("--url", default="ws://localhost:8000/ws")
    ap.add_argument("--speed", type=float, default=1.0, help="2 sends twice as fast as recorded")
    ap.add_argument("--match-id", default=None)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--tail", type=float, default=6.0, help="seconds to keep listening after the last message")
    ap.add_argument("--streams-dir", type=Path, default=HERE / "data" / "streams",
                    help="where the server records streams, to pick up its traces")
    ap.add_argument("--wrong-labels", type=float, default=0.0)
    ap.add_argument("--confidence-drop", type=float, default=0.0)
    ap.add_argument("--missed-swings", type=float, default=0.0)
    ap.add_argument("--drop", type=float, default=0.0)
    ap.add_argument("--delay", type=float, default=0.0)
    ap.add_argument("--delay-seconds", type=float, default=1.5)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--no-frames", action="store_true", help="leave out every `frames` message")
    args = ap.parse_args()

    noise = Noise(args.wrong_labels, args.confidence_drop, args.missed_swings,
                  args.drop, args.delay, args.delay_seconds, args.seed)
    items = load_inputs(args.stream)
    if args.no_frames:
        items = [(t, m) for t, m in items if m.get("type") != "frames"]
    counts = {}
    if noise.active():
        items, counts = apply(items, noise)

    match_id = args.match_id or f"replay_{args.stream.stem}_{int(time.time())}"
    out = args.out or (HERE / "eval" / "replay" / "out" / f"{match_id}.jsonl")
    out.parent.mkdir(parents=True, exist_ok=True)

    sent, got = asyncio.run(replay(items, args.url, match_id, args.speed, args.tail))
    time.sleep(0.5)
    traces = server_traces(args.streams_dir, match_id)

    meta = {"dir": "meta", "source": str(args.stream), "match_id": match_id, "url": args.url,
            "speed": args.speed, "no_frames": args.no_frames, "noise": noise.describe(), "noise_counts": counts,
            "sent": len(sent), "got": len(got), "traces": len(traces)}
    with out.open("w") as f:
        for row in [meta, *sent, *got, *traces]:
            f.write(json.dumps(row) + "\n")

    kinds: dict[str, int] = {}
    for row in got:
        kind = str(row["message"].get("type"))
        kinds[kind] = kinds.get(kind, 0) + 1
    print(json.dumps({"out": str(out), "match_id": match_id, "sent": len(sent), "got": kinds,
                      "traces": len(traces), "noise_counts": counts}))


if __name__ == "__main__":
    main()
