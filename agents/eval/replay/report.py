"""Summarise replay outputs, and compare noisy replays with a clean one.

    python -m eval.replay.report OUT [OUT ...]            one summary per file
    python -m eval.replay.report --base CLEAN OUT [...]   plus the change from CLEAN

A summary covers: frames sent and read, watcher read times with and without a
frame, `error` messages, the final `player_read`, its strongest habit and its
strongest style, and the `strategy_update` lines.
"""
from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path

STYLE = "like_"


def load(path: Path) -> dict:
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    meta = next((r for r in rows if r.get("dir") == "meta"), {})
    sent = [r for r in rows if r.get("dir") == "in"]
    got = [r for r in rows if r.get("dir") == "out"]
    traces = [r for r in rows if r.get("dir") == "trace"]
    return {"meta": meta, "sent": sent, "got": got, "traces": traces}


def _median(xs: list[float]) -> float | None:
    return round(statistics.median(xs), 1) if xs else None


def summarise(path: Path) -> dict:
    run = load(path)
    sent, got, traces = run["sent"], run["got"], run["traces"]
    frame_times = [r["t"] for r in sent if r["message"].get("type") == "frames"]
    player_events = sum(1 for r in sent if r["message"].get("type") == "event" and r["message"].get("by") == "player")

    reads = [r for r in traces if r["message"].get("stage") == "watcher" and r["message"].get("status") == "done"]
    starts = [r for r in traces if r["message"].get("stage") == "watcher" and r["message"].get("status") == "start"]
    watcher_errors = [r["message"].get("about") for r in traces
                      if r["message"].get("stage") == "watcher" and r["message"].get("status") == "error"]
    with_frame = [float(r["message"]["ms"]) for r in reads if "frame" in r["message"].get("about", "") and " 0 frame" not in r["message"].get("about", "")]
    without = [float(r["message"]["ms"]) for r in reads if " 0 frame" in r["message"].get("about", "")]
    tokens_f = [r["message"].get("data", {}).get("input_tokens") for r in reads if " 0 frame" not in r["message"].get("about", "")]
    tokens_n = [r["message"].get("data", {}).get("input_tokens") for r in reads if " 0 frame" in r["message"].get("about", "")]

    # Which frame each read looked at: the newest one sent before the read started.
    frames_seen = set()
    for s in starts:
        if " 0 frame" in s["message"].get("about", ""):
            continue
        before = [i for i, t in enumerate(frame_times) if t <= s["t"] + 0.05]
        if before:
            frames_seen.add(before[-1])

    player_reads = [r["message"] for r in got if r["message"].get("type") == "player_read"]
    updates = [r["message"] for r in got if r["message"].get("type") == "strategy_update"]
    errors = [r["message"] for r in got if r["message"].get("type") == "error"]
    final = player_reads[-1]["values"] if player_reads else {}
    habits = {k: v for k, v in final.items() if not k.startswith(STYLE)}
    styles = {k: v for k, v in final.items() if k.startswith(STYLE)}

    return {
        "file": path.name,
        "noise": run["meta"].get("noise", {}).get("wrong_labels"),
        "noise_counts": run["meta"].get("noise_counts"),
        "frames_sent": len(frame_times),
        "frames_read": len(frames_seen),
        "player_events_sent": player_events,
        "watcher_reads": len(reads),
        "watcher_errors": watcher_errors,
        "read_ms_with_frame": {"n": len(with_frame), "median": _median(with_frame),
                               "max": max(with_frame) if with_frame else None},
        "read_ms_without_frame": {"n": len(without), "median": _median(without),
                                  "max": max(without) if without else None},
        "input_tokens_median": {"with_frame": _median([t for t in tokens_f if t]),
                                "without_frame": _median([t for t in tokens_n if t])},
        "player_reads": len(player_reads),
        "errors": [e.get("about") or e.get("message") or e for e in errors],
        "final_values": final,
        "top_habit": max(habits, key=habits.get) if habits else None,
        "top_style": max(styles, key=styles.get) if styles else None,
        "strategy_updates": len(updates),
        "observations": [line for u in updates for line in (u.get("observations") or [])],
        "plan": [line for u in updates for line in (u.get("plan") or [])],
    }


def compare(base: dict, other: dict) -> dict:
    a, b = base["final_values"], other["final_values"]
    diffs = {k: round(b[k] - a[k], 3) for k in a if k in b}
    worst = max(diffs, key=lambda k: abs(diffs[k])) if diffs else None
    return {
        "top_habit_changed": base["top_habit"] != other["top_habit"],
        "top_style_changed": base["top_style"] != other["top_style"],
        "max_abs_diff": abs(diffs[worst]) if worst else None,
        "max_diff_value": worst,
        "over_0_2": sorted(k for k, d in diffs.items() if abs(d) > 0.2),
    }


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m eval.replay.report")
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--base", type=Path, default=None)
    ap.add_argument("--brief", action="store_true", help="leave out the values and the update lines")
    args = ap.parse_args()
    base = summarise(args.base) if args.base else None
    for path in args.files:
        s = summarise(path)
        if base is not None:
            s["vs_base"] = compare(base, s)
        if args.brief:
            for k in ("final_values", "observations", "plan"):
                s.pop(k, None)
        print(json.dumps(s))


if __name__ == "__main__":
    main()
