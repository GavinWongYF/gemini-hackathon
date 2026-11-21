"""A tiny counting stand-in for the agent server, for tests and dry runs.

It speaks the contract but uses no model. It answers `setup` with `ready`,
sends a `player_read` after player events, and, unless started with
--no-adapt, sends a `strategy_update` after each round (marked "full" when a
break starts, else "quick") that leans every NPC
decision toward the options that were picked in rounds the NPC won. In
practice mode it first asks for one practice run per scripted player.

  python -m sim.fake_server --port 8765 [--no-adapt]
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import json
from collections import defaultdict
from typing import Any

from websockets.asyncio.server import ServerConnection, serve

from server import measures

Message = dict[str, Any]


def _uniform(setup: Message) -> Message:
    npcs = {}
    for npc, spec in setup.get("npcs", {}).items():
        decisions = {d: {o: {"base": 1.0} for o in s.get("options", {})} for d, s in spec.get("decisions", {}).items()}
        npcs[npc] = {"decisions": decisions, "rules": []}
    return {"version": 0, "npcs": npcs}


def learn(setup: Message, start: Message, events: list[Message], rounds: list[Message], version: int) -> Message:
    """Lean each decision toward the options picked in rounds the NPC won."""
    winners = {r["round"]: r.get("winner") for r in rounds}
    picked = defaultdict(lambda: defaultdict(lambda: [0, 0]))  # (npc, decision) -> option -> [npc wins, uses]
    for event in events:
        if not event.get("picked") or event.get("round") not in winners:
            continue
        npc = event["by"]
        for decision, option in event["picked"].items():
            tally = picked[(npc, decision)][option]
            tally[0] += 1 if winners[event["round"]] == npc else 0
            tally[1] += 1
    behaviour = copy.deepcopy(start)
    behaviour["version"] = version
    for npc, mine in behaviour.get("npcs", {}).items():
        for decision, options in mine.get("decisions", {}).items():
            for option, spec in options.items():
                wins, uses = picked[(npc, decision)][option]
                score = (wins + 1) / (uses + 2)
                spec["base"] = round(max(spec.get("base", 0), 0.05) * (2 * score) ** 3, 4)
    return behaviour


class Match:
    def __init__(self, setup: Message, adapt: bool):
        self.setup = setup
        self.adapt = adapt
        self.start = copy.deepcopy(setup.get("default_behaviour") or _uniform(setup))
        self.events: list[Message] = []
        self.rounds: list[Message] = []
        self.version = 1
        self.waiting: set[str] = set()


async def handle(ws: ServerConnection, adapt: bool) -> None:
    match: Match | None = None

    async def send(message: Message) -> None:
        await ws.send(json.dumps(message))

    async def ready() -> None:
        assert match is not None
        behaviour = copy.deepcopy(match.start)
        behaviour["version"] = 1
        await send({"type": "ready", "match_id": match.setup["match_id"], "values": {}, "behaviour": behaviour})

    async for raw in ws:
        message = json.loads(raw)
        kind = message.get("type")
        if kind == "setup":
            match = Match(message, adapt)
            players = list(message.get("practice", {}).get("players", {}))
            if message.get("mode") == "practice" and players:
                for index, name in enumerate(players):
                    run_id = f"p_{index}"
                    match.waiting.add(run_id)
                    await send({"type": "practice_run", "match_id": message["match_id"], "run_id": run_id,
                                "player": name, "rounds": 10, "behaviour": match.start})
            else:
                await ready()
        elif match is None:
            continue
        elif kind == "practice_result":
            match.waiting.discard(message.get("run_id"))
            if not match.waiting:
                await ready()
        elif kind == "event":
            match.events.append(message)
            if message.get("by") == "player":
                found = measures.habits(match.setup, match.events, minimum_uses=1)[:4]
                values = {f"{h['field']}_{h['value']}": h["share"] for h in found}
                await send({"type": "player_read", "match_id": match.setup["match_id"], "round": message.get("round"),
                            "t": message.get("t"), "values": values,
                            "based_on_events": sum(1 for e in match.events if e.get("by") == "player"),
                            "why": "Counted the player's plays so far."})
        elif kind == "round_end":
            match.rounds.append(message)
            if match.adapt:
                match.version += 1
                behaviour = learn(match.setup, match.start, match.events, match.rounds, match.version)
                await send({"type": "strategy_update", "match_id": match.setup["match_id"], "version": match.version,
                            "source": "full" if message.get("break") else "quick", "observations": ["Counted which options won rounds."],
                            "plan": ["Lean toward the options that won."], "changes": [], "behaviour": behaviour})


async def serve_forever(port: int, adapt: bool) -> None:
    async with serve(lambda ws: handle(ws, adapt), "localhost", port, max_size=None) as server:
        await server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m sim.fake_server")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-adapt", action="store_true")
    args = parser.parse_args()
    print(f"counting stand-in server on ws://localhost:{args.port}/ws (adapt={not args.no_adapt})", flush=True)
    asyncio.run(serve_forever(args.port, not args.no_adapt))


if __name__ == "__main__":
    main()
