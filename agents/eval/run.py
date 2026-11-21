"""The proof run: does adapting take a player's habit away, against an unchanged baseline?

For each scripted player it plays M matches of R rounds against a normal
agent server and the same number against a server started with --no-adapt.
It talks to the servers only through the socket, as a game would. Matches
with the same number use the same seed in both arms, so the scripted player
makes the same draws where it can.

Fast matches would end before the slower update loop ever lands, so the run
holds each match open: every few rounds it waits for the next
`strategy_update`, with a timeout. How long comes from the game's own plan:
`update_seconds` sets the hold, and `break_seconds` sets how long a break may
wait for a deeper update.
"""
from __future__ import annotations

import asyncio
import json
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from server import measures
from sim.game import MatchLog, SimGame
from sim.headless import SimModel, load_json

Message = dict[str, Any]

STAND_IN_LINE = (
    "STAND-IN GAME: these numbers come from a simulator with scripted players, not from the real game. "
    "A matchup table learned here is provisional."
)


def hold_plan(model: SimModel, setup: Message) -> dict[str, float]:
    """How long to hold a fast match open, from the game's own plan."""
    plan = {**setup.get("plan", {}), **model.spec.get("plan", {})}
    pacing = model.spec.get("pacing", {})
    update_seconds = float(plan.get("update_seconds", 20))
    break_every = int(plan.get("break_every", 1))  # 0: no breaks, so the gap between rounds is the pacing
    break_seconds = float(plan.get("break_seconds", 10))
    exchange_seconds = float(pacing.get("exchange_seconds", 1.5))
    # A rough length for one round in real play, to space the holds like a real match.
    round_seconds = exchange_seconds * 2.5 + (break_seconds if break_every == 1 else float(pacing.get("gap_seconds", 1)))
    return {
        "hold_every": max(1, round(update_seconds / max(round_seconds, 0.1))),
        "hold_seconds": update_seconds + 10,
        "break_seconds": break_seconds,
    }


def find_habit(model: SimModel, setup: Message, player: str, events: list[Message]) -> dict[str, Any] | None:
    """The play this scripted player leans on. sim.json can name it; otherwise
    the strongest habit among the fields the player itself chooses."""
    player = player.partition(">")[2] or player   # a player who switches is judged on the new style
    named = model.players[player].get("habit")
    if named:
        return dict(named)
    # Only the play the player makes every exchange. A field like the weapon on
    # a kill is only reported when the player wins, so its payoff means nothing.
    event = model.round_spec["exchange"]["player"]["event"]
    own = {(event, name) for name in model.players[player].get("plays", {}).get(event, {})}
    for habit in measures.habits(setup, events):
        if (habit["event"], habit["field"]) in own:
            return {"event": habit["event"], "field": habit["field"], "value": habit["value"]}
    return None


async def play_match(args: Any, setup: Message, model: SimModel, player: str, arm: str, index: int,
                     url: str, holds: dict[str, float], stamp: str) -> MatchLog:
    match_id = f"eval_{model.spec.get('game', 'game')}_{player.replace('>', '-to-')}_{arm}_{index}_{stamp}"
    seed = args.seed * 1000 + index
    adapt = arm == "adapt"
    hold_every = int(holds["hold_every"]) if adapt else 1
    hold_seconds = holds["hold_seconds"] if adapt else args.baseline_hold
    if args.game_cmd:
        return await asyncio.to_thread(
            run_external, args, player, url, match_id, seed, hold_every, hold_seconds, adapt
        )
    first, _, second = player.partition(">")   # "a>b": a plays the first half, b the second
    game = SimGame(
        setup, model, url, mode="live", player=first, switch_to=second or None, rounds=args.rounds, seed=seed, speed="fast",
        match_id=match_id, hold_every=hold_every, hold_seconds=hold_seconds, wait_at_breaks=adapt,
        ready_timeout=args.ready_timeout, quiet=not args.verbose,
    )
    return await game.run()


def run_external(args: Any, player: str, url: str, match_id: str, seed: int,
                 hold_every: int, hold_seconds: float, adapt: bool) -> MatchLog:
    """Run any game that takes the same flags as `python -m sim` and writes a --log."""
    with tempfile.TemporaryDirectory() as folder:
        log_path = Path(folder) / "match.jsonl"
        command = args.game_cmd.format(
            python=shlex.quote(sys.executable), setup=shlex.quote(args.setup), model=shlex.quote(args.model),
            url=url, player=player, rounds=args.rounds, seed=seed, match_id=match_id,
            hold_every=hold_every, hold_seconds=hold_seconds, log=shlex.quote(str(log_path)),
            wait_at_breaks="--wait-at-breaks" if adapt else "",
        )
        subprocess.run(command, shell=True, check=True, stdout=subprocess.DEVNULL)
        log = MatchLog(match_id, player)
        for line in log_path.read_text().splitlines():
            row = json.loads(line)
            (log.sent if row["dir"] == "out" else log.received).append(row["message"])
        return log


def score_match(log: MatchLog, habit: dict[str, Any] | None, window: int) -> dict[str, Any]:
    rounds = sorted(log.rounds, key=lambda r: r["round"])
    first, last = rounds[:window], rounds[-window:]
    row: dict[str, Any] = {
        "match_id": log.match_id,
        "rounds": [{"round": r["round"], "winner": r["winner"], "version": v}
                   for r, v in zip(rounds, log.versions or [None] * len(rounds))],
        "updates_received": len(log.updates),
        "versions_used": len({v for v in log.versions if v is not None}),
    }
    for name, part in (("first", first), ("last", last), ("all", rounds)):
        row[f"win_{name}"] = [1 if r["winner"] == "player" else 0 for r in part]
        if habit:
            row[f"habit_{name}"] = measures.habit_payoff(habit, log.events, part)
    return row


def summarise(rows: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {"matches": len(rows)}
    for name in ("first", "last", "all"):
        wins = [w for row in rows for w in row[f"win_{name}"]]
        out[f"win_{name}"] = round(sum(wins) / len(wins), 3) if wins else None
        uses = sum(row.get(f"habit_{name}", {}).get("uses", 0) for row in rows)
        won = sum(row.get(f"habit_{name}", {}).get("wins", 0) for row in rows)
        out[f"habit_{name}"] = round(won / uses, 3) if uses else None
        out[f"habit_uses_{name}"] = uses
    out["updates_received"] = sum(row["updates_received"] for row in rows)
    out["versions_used"] = round(sum(row["versions_used"] for row in rows) / len(rows), 1) if rows else 0
    return out


def table(results: dict[str, Any], window: int) -> str:
    def pct(x: float | None) -> str:
        return "-" if x is None else f"{round(100 * x)}%"

    lines = [
        f"| Player | Opponent | Habit | Habit payoff, first {window} | Habit payoff, last {window} "
        f"| Player wins, first {window} | Player wins, last {window} | Player wins, all | Behaviours used |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for player, entry in results.items():
        habit = entry["habit"]
        label = f"{habit['field']}={habit['value']}" if habit else "none"
        for arm, name in (("adapt", "adapting"), ("baseline", "unchanged")):
            s = entry.get(arm)
            if not s:
                continue
            lines.append(
                f"| {player} | {name} | {label} | {pct(s['habit_first'])} | {pct(s['habit_last'])} "
                f"| {pct(s['win_first'])} | {pct(s['win_last'])} | {pct(s['win_all'])} | {s['versions_used']} |"
            )
    return "\n".join(lines)


async def run(args: Any) -> dict[str, Any]:
    setup = load_json(args.setup)
    model = SimModel(load_json(args.model), setup)
    holds = hold_plan(model, setup)
    players = args.players.split(",") if args.players else list(model.players)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    window = args.window or max(1, args.rounds // 3)
    arms = {"adapt": args.url}
    if args.baseline_url:
        arms["baseline"] = args.baseline_url
    limit = asyncio.Semaphore(max(1, args.parallel))

    async def one(player: str, arm: str, index: int) -> tuple[str, str, MatchLog]:
        async with limit:
            log = await play_match(args, setup, model, player, arm, index, arms[arm], holds, stamp)
            if args.verbose:
                print(f"done {player} {arm} match {index}", file=sys.stderr, flush=True)
            return player, arm, log

    jobs = [one(p, arm, i) for p in players for arm in arms for i in range(args.matches)]
    logs = await asyncio.gather(*jobs)

    results: dict[str, Any] = {}
    raw: dict[str, Any] = {}
    for player in players:
        player_logs = [log for p, _, log in logs if p == player]
        habit = find_habit(model, setup, player, [e for log in player_logs for e in log.events])
        results[player] = {"habit": habit}
        raw[player] = {"habit": habit}
        for arm in arms:
            rows = [score_match(log, habit, window) for p, a, log in logs if p == player and a == arm]
            results[player][arm] = summarise(rows)
            raw[player][arm] = rows
    report = {
        "stand_in": True,
        "note": STAND_IN_LINE,
        "game": model.spec.get("game"),
        "setup": args.setup,
        "model": args.model,
        "urls": arms,
        "matches": args.matches,
        "rounds": args.rounds,
        "window": window,
        "seed": args.seed,
        "holds": holds,
        "results": results,
        "raw": raw,
    }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{model.spec.get('game', 'game')}-{stamp}.json"
    path.write_text(json.dumps(report, indent=2))
    report["saved_to"] = str(path)
    report["table"] = table(results, window)
    return report
