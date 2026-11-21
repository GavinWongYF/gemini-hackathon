"""python -m eval: the proof run.

Start two agent servers, one normal and one with --no-adapt, then:

  python -m eval --setup examples/tennis/setup.json --model examples/tennis/sim.json \
      --url ws://localhost:8000/ws --baseline-url ws://localhost:8001/ws --matches 3 --rounds 12

To run it against another game instead of the built-in stand-in, give
--game-cmd a command that takes the same flags as `python -m sim` and writes
a --log, for example:

  --game-cmd "{python} -m sim --setup {setup} --model {model} --url {url} --player {player} \
      --rounds {rounds} --seed {seed} --match-id {match_id} --hold-every {hold_every} \
      --hold-seconds {hold_seconds} {wait_at_breaks} --log {log} --quiet"
"""
from __future__ import annotations

import argparse
import asyncio

from .run import STAND_IN_LINE, run


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m eval", description="Adapting against an unchanged baseline.")
    parser.add_argument("--setup", required=True)
    parser.add_argument("--model", required=True, help="the game's sim.json")
    parser.add_argument("--url", default="ws://localhost:8000/ws", help="the normal agent server")
    parser.add_argument("--baseline-url", default=None, help="the agent server started with --no-adapt")
    parser.add_argument("--matches", type=int, default=3, help="matches per player per arm")
    parser.add_argument("--rounds", type=int, default=12, help="rounds per match")
    parser.add_argument("--window", type=int, default=None, help="rounds in the first and last window (default a third)")
    parser.add_argument("--players", default=None, help="comma-separated scripted players (default all)")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--parallel", type=int, default=1, help="matches played at once")
    parser.add_argument("--baseline-hold", type=float, default=0.5,
                        help="seconds the baseline arm waits between rounds so player reads can land")
    parser.add_argument("--ready-timeout", type=float, default=300.0)
    parser.add_argument("--game-cmd", default=None, help="run this game command per match instead of the stand-in")
    parser.add_argument("--out", default="data/eval")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    report = asyncio.run(run(args))
    print(STAND_IN_LINE)
    print()
    print(f"Game: {report['game']}. {report['matches']} matches of {report['rounds']} rounds per player and opponent. "
          f"Holds: every {report['holds']['hold_every']} rounds, up to {report['holds']['hold_seconds']:.0f}s, "
          f"from the game's plan.")
    print("Habit payoff: how often the player's favourite play came in a round the player won.")
    print()
    print(report["table"])
    print()
    print(f"Raw numbers saved to {report['saved_to']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
