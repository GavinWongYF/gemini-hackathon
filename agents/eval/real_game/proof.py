"""python -m eval.real_game.proof: the proof run on the real tennis engine.

The stand-in proof (`python -m eval`) plays a simulator. This one plays the
real engine, headless, with the game's own scripted players standing in for
the person. For each scripted player it plays M live matches against a normal
agent server and M against a server started with --no-adapt, then prints the
same table: the habit payoff in the first and last part of the match, the
player's share of points, and how many behaviours were used.

Then the check a real engine makes possible. Every behaviour version the
server sent in an adapting match is replayed for many points against the same
scripted player, so each update can be judged on a large sample.

Start two agent servers, one normal and one with --no-adapt, then from
`agents/`:

  ./.venv/bin/python -m eval.real_game.proof --game-root <folder with client/ and shared/> \
      --url ws://localhost:8000/ws --baseline-url ws://localhost:8001/ws --matches 3 --rounds 24

The adapting matches run in real time, because the update loop needs the
match to last. The unchanged matches call no model, so they run flat out.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from eval.run import score_match, summarise, table
from server import measures
from sim.game import MatchLog

HERE = Path(__file__).resolve().parent
PLAYER_CHOSEN_FIELDS = ("shot_type", "lands", "side")  # what a scripted player picks on each shot


def tsx(game_root: Path, script: str, *flags: str) -> list[str]:
    return ["npx", "--yes", "tsx", "--tsconfig", str(game_root / "client" / "tsconfig.json"),
            str(HERE / script), "--game-root", str(game_root), *flags]


def play(args: Any, game_root: Path, out: Path, player: str, arm: str, index: int, stamp: str) -> dict[str, Any]:
    adapt = arm == "adapt"
    match_id = f"real_{player}_{arm}_{index}_{stamp}"
    log_path = out / f"{match_id}.jsonl"
    command = tsx(
        game_root, "live_match.mts",
        "--url", args.url if adapt else args.baseline_url,
        "--player", player, "--rounds", str(args.rounds),
        # Open-ended: the game's own plan and no breaks, stopped by the point count alone.
        *(["--seconds", "100000"] if args.open_ended else
          ["--break-every", str(args.break_every), "--break-seconds", str(args.break_seconds)]),
        "--pace", args.pace if adapt else args.baseline_pace,
        "--seed", str(args.seed * 1000 + index), "--match-id", match_id, "--log", str(log_path), "--quiet",
        *(["--personas", args.personas] if args.personas else []),
    )
    done = subprocess.run(command, capture_output=True, text=True)
    if args.verbose:
        print(f"done {match_id} (exit {done.returncode})", file=sys.stderr, flush=True)
    return {"player": player, "arm": arm, "index": index, "match_id": match_id, "log": log_path,
            "exit": done.returncode, "stderr": done.stderr[-2000:]}


def read_log(match: dict[str, Any]) -> tuple[MatchLog, dict[str, Any], dict[str, Any] | None]:
    log = MatchLog(match["match_id"], match["player"])
    versions: dict[int, Any] = {}
    setup: dict[str, Any] = {}
    summary = None
    for line in Path(match["log"]).read_text().splitlines():
        row = json.loads(line)
        if row["dir"] == "out":
            log.sent.append(row["message"])
            if row["message"]["type"] == "setup":
                setup = row["message"]
        elif row["dir"] == "in":
            log.received.append(row["message"])
        elif row["dir"] == "meta":
            versions[row["round"]] = row["version"]
        elif row["dir"] == "summary":
            summary = row["summary"]
    log.versions = [versions.get(r["round"]) for r in sorted(log.rounds, key=lambda r: r["round"])]
    return log, setup, summary


def find_habits(setup: dict[str, Any], events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The scripted player's strongest habit, then its strongest in each other field it chooses."""
    found: list[dict[str, Any]] = []
    for habit in measures.habits(setup, events):
        if habit["field"] in PLAYER_CHOSEN_FIELDS and habit["field"] not in {h["field"] for h in found}:
            found.append({"event": habit["event"], "field": habit["field"], "value": habit["value"],
                          "share": habit["share"]})
    return found


def replay(args: Any, game_root: Path, logs: list[Path]) -> list[dict[str, Any]]:
    if not logs:
        return []
    command = tsx(game_root, "replay_versions.mts", "--log", ",".join(str(p) for p in logs),
                  "--rounds", str(args.replay_rounds), "--json",
                  *(["--personas", args.personas] if args.personas else []))
    done = subprocess.run(command, capture_output=True, text=True)
    if done.returncode != 0:
        print(done.stderr[-2000:], file=sys.stderr)
        return []
    return json.loads(done.stdout.strip().splitlines()[-1])


def replay_tables(replays: list[dict[str, Any]], rounds: int) -> str:
    def pct(x: float) -> str:
        return "-" if x is None else f"{round(100 * x)}%"

    lines = [
        f"Every behaviour version, replayed for {rounds} points against the same scripted player. "
        "The goal is a player share near 50%.",
        "batch: the game's own practice batch (base weights and rules only, default settings). "
        "as played: with the player values and settings that version last had in the match.",
        "",
        "| Match | Version | From | Live points | Player share, batch | Player share, as played | Rules | Speed |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for match in replays:
        for v in match["versions"]:
            lines.append(
                f"| {match['match_id']} | v{v['version']} | {v['from']} | {v['live_points_played']} "
                f"| {pct(v['batch_player_share'])} | {pct(v['as_played_player_share'])} | {v['rules']} "
                f"| {v['settings'].get('opponent_speed', 'default')} |"
            )
    lines += ["", "| Player | Matches | Default | Ready | Last version sent | Updates that moved toward 50% | Updates within 10 points of 50% |",
              "| --- | --- | --- | --- | --- | --- | --- |"]
    by_player: dict[str, list[dict[str, Any]]] = {}
    for match in replays:
        by_player.setdefault(match["player"], []).append(match)
    for player, matches in by_player.items():
        first, ready, last, closer, near, updates = [], [], [], 0, 0, 0
        for match in matches:
            shares = [(v["from"], v["as_played_player_share"]) for v in match["versions"]]
            first += [s for kind, s in shares if kind == "default"]
            ready += [s for kind, s in shares if kind == "ready"]
            if shares:
                last.append(shares[-1][1])
            for (_, before), (kind, after) in zip(shares, shares[1:]):
                if kind in ("default", "ready"):
                    continue
                updates += 1
                closer += 1 if abs(after - 0.5) < abs(before - 0.5) else 0
                near += 1 if abs(after - 0.5) <= 0.1 else 0
        mean = lambda xs: pct(sum(xs) / len(xs)) if xs else "-"  # noqa: E731
        lines.append(f"| {player} | {len(matches)} | {mean(first)} | {mean(ready)} | {mean(last)} "
                     f"| {closer} of {updates} | {near} of {updates} |")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m eval.real_game.proof",
                                     description="Adapting against an unchanged baseline, on the real engine.")
    parser.add_argument("--game-root", default=str(HERE.parents[2]), help="folder that holds client/ and shared/")
    parser.add_argument("--url", default="ws://localhost:8000/ws", help="the normal agent server")
    parser.add_argument("--baseline-url", default=None, help="the agent server started with --no-adapt")
    parser.add_argument("--players", default="forehand_lover,baseline_grinder,even,forehand_lover-to-baseline_grinder",
                        help='comma-separated scripted players; "a-to-b" changes style half way through')
    parser.add_argument("--personas", default=None,
                        help="a list of persona objects, or a stored design, for players named persona-NAME")
    parser.add_argument("--matches", type=int, default=3, help="matches per player per arm")
    parser.add_argument("--rounds", type=int, default=24, help="points per match")
    parser.add_argument("--window", type=int, default=None, help="points in the first and last window (default a third)")
    parser.add_argument("--break-every", type=int, default=4)
    parser.add_argument("--break-seconds", type=float, default=5)
    parser.add_argument("--open-ended", action="store_true",
                        help="send the game's own plan and play with no breaks, for a game whose plan is open-ended")
    parser.add_argument("--pace", default="real", help="pace of the adapting matches: real, a multiplier, or max")
    parser.add_argument("--baseline-pace", default="max")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--parallel", type=int, default=6, help="matches played at once")
    parser.add_argument("--replay-rounds", type=int, default=300, help="points per behaviour version (0 to skip)")
    parser.add_argument("--logs", default=None, help="score the match logs in this folder instead of playing")
    parser.add_argument("--out", default="data/eval/real_game")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    game_root = Path(args.game_root).resolve()
    players = args.players.split(",")
    window = args.window or max(1, args.rounds // 3)
    stamp = time.strftime("%Y%m%d-%H%M%S")

    if args.logs:
        out = Path(args.logs)
        matches = []
        for path in sorted(out.glob("real_*.jsonl")):
            name = path.stem[len("real_"):]
            for arm in ("adapt", "baseline"):
                if f"_{arm}_" in name:
                    matches.append({"player": name.split(f"_{arm}_")[0], "arm": arm, "match_id": path.stem,
                                    "log": path, "exit": 0, "stderr": ""})
        players = [p for p in players if any(m["player"] == p for m in matches)]
    else:
        out = Path(args.out) / stamp
        out.mkdir(parents=True, exist_ok=True)
        arms = ["adapt"] + (["baseline"] if args.baseline_url else [])
        jobs = [(p, arm, i) for p in players for arm in arms for i in range(args.matches)]
        with ThreadPoolExecutor(max_workers=max(1, args.parallel)) as pool:
            matches = list(pool.map(lambda job: play(args, game_root, out, *job, stamp), jobs))

    for match in matches:
        if match["exit"] != 0:
            print(f"WARNING {match['match_id']} exited {match['exit']}: {match['stderr'][-300:]}", file=sys.stderr)

    read = {m["match_id"]: read_log(m) for m in matches if Path(m["log"]).exists()}
    results: dict[str, Any] = {}
    raw: dict[str, Any] = {}
    problems: list[dict[str, Any]] = []
    for player in players:
        mine = [m for m in matches if m["player"] == player and m["match_id"] in read]
        if not mine:
            continue
        setup = read[mine[0]["match_id"]][1]
        events = [e for m in mine for e in read[m["match_id"]][0].events]
        for habit in find_habits(setup, events):
            label = f"{player}"
            key = label if label not in results else f"{label} ({habit['field']})"
            results[key] = {"habit": habit}
            raw[key] = {"habit": habit}
            for arm in ("adapt", "baseline"):
                rows = [score_match(read[m["match_id"]][0], habit, window) for m in mine if m["arm"] == arm]
                if rows:
                    results[key][arm] = summarise(rows)
                    raw[key][arm] = rows
        for m in mine:
            summary = read[m["match_id"]][2] or {}
            if summary.get("errors") or summary.get("game_would_not_apply") or summary.get("mock_fallback"):
                problems.append({"match_id": m["match_id"], "errors": summary.get("errors"),
                                 "game_would_not_apply": summary.get("game_would_not_apply"),
                                 "mock_fallback": summary.get("mock_fallback")})

    replays = []
    if args.replay_rounds > 0:
        replays = replay(args, game_root, [Path(m["log"]) for m in matches if m["arm"] == "adapt" and m["match_id"] in read])

    commit = subprocess.run(["git", "-C", str(game_root), "rev-parse", "--short", "HEAD"], capture_output=True, text=True)
    stamp_file = game_root / "COMMIT"  # an unpacked copy can say which commit it is here
    game_commit = commit.stdout.strip() if commit.returncode == 0 else (stamp_file.read_text().strip() if stamp_file.exists() else None)
    report = {"real_engine": True, "game_root": str(game_root), "game_commit": game_commit,
              "matches": args.matches, "rounds": args.rounds,
              "window": window, "seed": args.seed, "pace": args.pace, "results": results, "raw": raw,
              "replays": replays, "problems": problems}
    report_path = out / ("report.json" if not args.logs else f"report-rescored-{stamp}.json")
    report_path.write_text(json.dumps(report, indent=2, default=str))

    print("REAL ENGINE: the game's own match engine and opponent brain, headless, with its scripted players "
          "standing in for the person.")
    print()
    print(f"{args.matches if not args.logs else 'Stored'} matches of {args.rounds} points per player and opponent. "
          f"Adapting matches at pace {args.pace}. Game commit {report['game_commit']}.")
    print("Habit payoff: how often the player's favourite play came in a point the player won.")
    print()
    print(table(results, window))
    if replays:
        print()
        print(replay_tables(replays, args.replay_rounds))
    if problems:
        print()
        print(f"{len(problems)} matches had errors from the server or behaviour the game would not apply. See {report_path.name}.")
    print()
    print(f"Raw numbers and match logs: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
