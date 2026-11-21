"""python -m sim: play one match against the agent server with a scripted player.

Example:
  python -m sim --setup examples/tennis/setup.json --model examples/tennis/sim.json \
      --url ws://localhost:8000/ws --mode live --player forehand_lover --speed real
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from .game import SimGame
from .model import SimModel, load_json


def parse(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python -m sim", description="A stand-in game with no screen.")
    parser.add_argument("--setup", required=True, help="the game's setup.json")
    parser.add_argument("--model", required=True, help="the game's sim.json (scripted players and outcomes)")
    parser.add_argument("--url", default="ws://localhost:8000/ws")
    parser.add_argument("--mode", choices=["live", "practice"], default="live")
    parser.add_argument("--player", default="even", help="a scripted player named in sim.json")
    parser.add_argument("--rounds", type=int, default=None, help="default: the plan in sim.json, else in setup")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--speed", choices=["fast", "real"], default="fast")
    parser.add_argument("--break-seconds", type=float, default=None, help="gap between rounds")
    parser.add_argument("--hold-every", type=int, default=0, help="every N rounds, wait for a new behaviour")
    parser.add_argument("--hold-seconds", type=float, default=0.0, help="longest wait at a hold")
    parser.add_argument("--wait-at-breaks", action="store_true",
                        help="in fast speed, hold each break open until a deeper update lands")
    parser.add_argument("--ready-timeout", type=float, default=300.0,
                        help="give up after this many seconds with no ready and no practice run")
    parser.add_argument("--switch-to", default=None, help="a second scripted player who takes over partway through")
    parser.add_argument("--switch-at", type=int, default=None, help="the round the second player takes over (default: halfway)")
    parser.add_argument("--match-id", default=None)
    parser.add_argument("--frames", action="store_true", help="send a drawn top-down picture each exchange")
    parser.add_argument("--log", default=None, help="write every message sent and received here, one JSON per line")
    parser.add_argument("--quiet", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse(argv)
    setup = load_json(args.setup)
    model = SimModel(load_json(args.model), setup)
    if args.player not in model.players or (args.switch_to and args.switch_to not in model.players):
        print(f"unknown player {args.player!r}. Choose one of: {', '.join(model.players)}", file=sys.stderr)
        return 2
    game = SimGame(
        setup, model, args.url, mode=args.mode, player=args.player, rounds=args.rounds, seed=args.seed,
        speed=args.speed, match_id=args.match_id, break_seconds=args.break_seconds,
        hold_every=args.hold_every, hold_seconds=args.hold_seconds,
        wait_at_breaks=args.wait_at_breaks, switch_to=args.switch_to, switch_at=args.switch_at,
        ready_timeout=args.ready_timeout, frames=args.frames, quiet=args.quiet,
    )
    log = asyncio.run(game.run())
    if args.log:
        path = Path(args.log)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w") as out:
            for message in log.sent:
                out.write(json.dumps({"dir": "out", "message": message}) + "\n")
            for message in log.received:
                out.write(json.dumps({"dir": "in", "message": message}) + "\n")
    rounds = log.rounds
    wins = sum(1 for r in rounds if r["winner"] == "player")
    practice = sum(1 for m in log.sent if m["type"] == "practice_result")
    print(f"stand-in game, scripted player {args.player}: {len(rounds)} rounds, player won {wins}, "
          f"{len(log.updates)} strategy updates received, {practice} practice runs answered"
          + (f", {log.reconnects} reconnects, {log.dropped} messages dropped while away" if log.reconnects or log.dropped else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
