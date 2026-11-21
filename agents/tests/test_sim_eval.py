"""The proof run against two fake agent servers: one adapting, one unchanged."""
from __future__ import annotations

import json
from argparse import Namespace
from pathlib import Path

from websockets.asyncio.server import serve

from eval.run import STAND_IN_LINE, run
from sim.fake_server import handle

ROOT = Path(__file__).resolve().parent.parent


def _args(url: str, baseline: str, out: Path, setup: str, model: str, **extra: object) -> Namespace:
    values = dict(setup=setup, model=model, url=url, baseline_url=baseline, matches=2, rounds=6, window=2,
                  players=None, seed=1, parallel=4, baseline_hold=0.0, ready_timeout=5.0, game_cmd=None,
                  out=str(out), verbose=False)
    values.update(extra)
    return Namespace(**values)


async def test_eval_prints_a_table_and_saves_raw_numbers(tmp_path: Path) -> None:
    async with serve(lambda ws: handle(ws, adapt=True), "localhost", 0) as adapting, \
            serve(lambda ws: handle(ws, adapt=False), "localhost", 0) as unchanged:
        url = f"ws://localhost:{next(iter(adapting.sockets)).getsockname()[1]}/ws"
        baseline = f"ws://localhost:{next(iter(unchanged.sockets)).getsockname()[1]}/ws"
        report = await run(_args(url, baseline, tmp_path, str(ROOT / "examples/tennis/setup.json"),
                                 str(ROOT / "examples/tennis/sim.json")))
    assert STAND_IN_LINE.startswith("STAND-IN GAME")
    lines = report["table"].splitlines()
    assert lines[0].startswith("| Player | Opponent | Habit")
    assert len(lines) == 2 + 3 * 2
    assert "| forehand_lover | adapting | lands=left_deep |" in report["table"]
    saved = json.loads(Path(report["saved_to"]).read_text())
    assert saved["stand_in"] is True
    rows = saved["raw"]["forehand_lover"]["adapt"]
    assert len(rows) == 2 and len(rows[0]["rounds"]) == 6
    assert saved["results"]["even"]["baseline"]["versions_used"] == 1.0
    assert saved["results"]["forehand_lover"]["adapt"]["versions_used"] > 1


async def test_eval_runs_an_external_game_command(tmp_path: Path) -> None:
    command = ("{python} -m sim --setup {setup} --model {model} --url {url} --player {player} "
               "--rounds {rounds} --seed {seed} --match-id {match_id} --hold-every {hold_every} "
               "--hold-seconds {hold_seconds} {wait_at_breaks} --log {log} --quiet")
    async with serve(lambda ws: handle(ws, adapt=True), "localhost", 0) as adapting:
        url = f"ws://localhost:{next(iter(adapting.sockets)).getsockname()[1]}/ws"
        report = await run(_args(url, None, tmp_path, str(ROOT / "examples/csgo/setup.json"),
                                 str(ROOT / "examples/csgo/sim.json"), matches=1, rounds=4,
                                 players="rusher", game_cmd=command))
    assert "| rusher | adapting | place=main |" in report["table"]
