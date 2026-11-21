"""python -m eval.real_game.round1: the whole regression check in one command.

It prints the game commit first, then plays the real engine, headless, against
two agent servers that are already running: a normal one started with
`--record`, and one started with `--no-adapt`.

  ./.venv/bin/python -m eval.real_game.round1 --url ws://localhost:8000/ws \
      --baseline-url ws://localhost:8001/ws

What it runs:
  1. Does adapting help: every player in --players, the same seeds against
     both servers, then every behaviour version replayed on a large sample.
  2. Lifecycle on the normal server: a socket cut in the middle of a match,
     three malformed messages, and a second match under a used match id.
  3. The numbers from the logs and the server's recordings (analyse.py).

What it leaves out, because each needs its own server: the time to `ready`
on a fresh design, a server that goes away and comes back, and a model that
fails or times out. Start a server for each and point live_match.mts at it.

--quick plays one short match per player, as a smoke test after a pull.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from eval.real_game import analyse
from eval.real_game.proof import HERE, tsx

PLAYERS = ("forehand_lover,baseline_grinder,even,forehand_lover-to-baseline_grinder,"
           "random,never_swings,contrarian")


def lifecycle(args: argparse.Namespace, game_root: Path, out: Path, stamp: str) -> list[dict]:
    """Three short matches that each break something on purpose."""
    cases = [
        ("reconnect", ["--player", "forehand_lover", "--rounds", "12", "--drop-socket-at", "4"]),
        ("badevents", ["--player", "even", "--rounds", "8", "--bad-events-at", "3"]),
        ("sameid", ["--player", "baseline_grinder", "--rounds", "6", "--break-every", "2"]),
    ]

    def run(name: str, flags: list[str], suffix: str = "") -> dict:
        match_id = f"real_life_{name}_{stamp}"
        log = out / f"{match_id}{suffix}.jsonl"
        done = subprocess.run(
            tsx(game_root, "live_match.mts", "--url", args.url, "--pace", args.pace, "--match-id", match_id,
                "--log", str(log), "--quiet", *flags),
            capture_output=True, text=True,
        )
        summary = json.loads(done.stdout.strip().splitlines()[-1]) if done.stdout.strip() else {}
        return {"case": name + suffix, "exit": done.returncode, "summary": summary}

    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda case: run(*case), cases))
    # The same match id again, after the first match played every round: it should start a new match.
    results.append(run("sameid", cases[2][1], ".again"))
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m eval.real_game.round1", description=__doc__.split("\n")[0])
    parser.add_argument("--game-root", default=str(HERE.parents[2]), help="folder that holds client/ and shared/")
    parser.add_argument("--url", default="ws://localhost:8000/ws", help="the normal agent server, started with --record")
    parser.add_argument("--baseline-url", default="ws://localhost:8001/ws", help="the server started with --no-adapt")
    parser.add_argument("--players", default=PLAYERS)
    parser.add_argument("--personas", default=None, help="personas file for players named persona-NAME")
    parser.add_argument("--matches", type=int, default=3)
    parser.add_argument("--rounds", type=int, default=30)
    parser.add_argument("--pace", default="real")
    parser.add_argument("--parallel", type=int, default=16)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--streams", default="data/streams", help="where the normal server writes its recordings")
    parser.add_argument("--out", default="data/eval/real_game")
    parser.add_argument("--quick", action="store_true", help="one 8 point match per player, no replay")
    parser.add_argument("--skip-lifecycle", action="store_true")
    args = parser.parse_args(argv)

    game_root = Path(args.game_root).resolve()
    commit = subprocess.run(["git", "-C", str(game_root), "rev-parse", "--short", "HEAD"], capture_output=True, text=True)
    stamp_file = game_root / "COMMIT"  # an unpacked copy can say which commit it is here
    game_commit = commit.stdout.strip() if commit.returncode == 0 else (stamp_file.read_text().strip() if stamp_file.exists() else "unknown")
    print(f"Game commit: {game_commit}   ({game_root})")
    print(f"Started: {time.strftime('%Y-%m-%d %H:%M:%S')}   normal server {args.url}   unchanged server {args.baseline_url}")
    print(flush=True)

    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = Path(args.out) / f"round1-{stamp}"
    out.mkdir(parents=True, exist_ok=True)
    matches, rounds = (1, 8) if args.quick else (args.matches, args.rounds)

    proof = [sys.executable, "-m", "eval.real_game.proof", "--game-root", str(game_root), "--url", args.url,
             "--baseline-url", args.baseline_url, "--players", args.players, "--matches", str(matches),
             "--rounds", str(rounds), "--window", str(max(1, rounds // 2)), "--pace", args.pace,
             "--parallel", str(args.parallel), "--seed", str(args.seed), "--out", str(out / "matches"),
             "--replay-rounds", "0" if args.quick else "300"]
    if args.personas:
        proof += ["--personas", args.personas]
    print("== 1. Does adapting help ==", flush=True)
    subprocess.run(proof, check=False)

    if not args.skip_lifecycle:
        print("\n== 2. Lifecycle ==", flush=True)
        for result in lifecycle(args, game_root, out, stamp):
            s = result["summary"]
            print(f"{result['case']:14s} exit {result['exit']}  score {s.get('score')}  status {s.get('final_status')}  "
                  f"ready messages {s.get('ready_messages')}  events dropped while offline "
                  f"{s.get('events_dropped_while_not_connected')}  errors {[e['message'].get('about') for e in s.get('errors', [])]}  "
                  f"versions {s.get('versions_by_round')}")

    print("\n== 3. The numbers ==", flush=True)
    for folder in sorted((out / "matches").glob("*/")):
        analyse.analyse(str(folder), args.streams)
    print(f"\nLogs: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
