"""The stand-in game's core, with no socket: scripted players and how a round plays out.

This file imports only the standard library and `pick`, so it can be copied
on its own (with adaptive_npc/pick.py beside it) into a sandbox and run there:

  python -m sim.headless --setup s.json --model sim.json --behaviour b.json --player p.json --rounds 200

`--player` is a scripted player's name from sim.json, or a persona JSON file
{"name", "about", "plays"}. It prints one JSON line in the shape of a
`practice_result`.

Everything game-specific lives in a JSON file (see examples/*/sim.json). This
file only knows the general shape: a round is a run of exchanges, in each
exchange the NPC makes its choices with `pick` and the scripted player makes a
play, and a table of adjustments says who is more likely to win that exchange.

Templates inside the JSON can refer to what happened so far:
  "$exchange"         the exchange number in this round, starting at 1
  "$picked.<name>"    an option the NPC picked this round
  "$player.<field>"   a field of the player's latest play
A list in a template means "one of these, at random".

Two optional blocks make the player's plays look like a real game's:
  "play_rules"  per event, a list of {"when": {"player": {...}, "npc": {...}},
                "spread": {field: spread}}. Every rule that matches redraws its
                fields, in order, so later rules can build on earlier ones (spin
                that fits the shot type, late timing against a fast ball).
  "outcome.swap"  per way an exchange can end, {"chance", "event", "how"}: some
                of the time the player's event becomes another one, like a
                missed swing instead of a shot that went out.
A condition is a name, a list of names, or {"min", "max"} for a number.

An exchange can also have two steps between the NPC's ball and the player's play:
  "tell"   a player event sent first, like the start of a swing. "copy" maps a
           tell field to the play field it gives away, and "match" is how often
           it gives it away honestly (a persona's own "tells" can override it).
  "react"  NPC decisions made after the tell, with their own event.
Facts can read the tell as "$tell.<field>". An "adjust" entry can be a group,
{"group", "scale", "rows"}, so a whole family of effects has one strength.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

try:
    from adaptive_npc import pick
except ImportError:  # copied into a sandbox with pick.py beside this file
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from pick import pick  # type: ignore[no-redef]

Message = dict[str, Any]
Emit = Callable[[str, str, dict[str, Any], dict[str, str] | None, list[str] | None], Awaitable[None]]


async def _no_emit(*_: Any) -> None:
    return None


async def _no_pause() -> None:
    return None


def load_json(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


@dataclass
class RoundResult:
    winner: str              # "player" or the NPC id
    how: str
    exchanges: int
    stats: dict[str, Any] = field(default_factory=dict)


class SimModel:
    """One game's scripted players and outcome table, read from a sim.json."""

    def __init__(self, spec: dict[str, Any], setup: dict[str, Any]):
        self.spec = spec
        self.setup = setup
        self.npc: str = spec["npc"]
        self.players: dict[str, Any] = spec["players"]
        self.round_spec: dict[str, Any] = spec["round"]
        self.outcome: dict[str, Any] = spec["outcome"]

    # What the game offers ------------------------------------------------

    def legal(self, decision: str) -> list[str]:
        """Every option for one decision, as declared in setup."""
        npc = self.setup.get("npcs", {}).get(self.npc, {})
        return list(npc.get("decisions", {}).get(decision, {}).get("options", {}).keys())

    def practice_block(self) -> dict[str, Any]:
        """The `practice` block for setup. `stand_in` says the results come
        from this simulator, not from the real game."""
        return {
            "stand_in": True,
            "players": {name: {"about": p.get("about", "")} for name, p in self.players.items()},
        }

    # Drawing plays and filling templates -----------------------------------

    def persona(self, player: str | dict[str, Any]) -> dict[str, Any]:
        """A scripted player as a persona: {"name", "about", "plays"}. Accepts a
        name from the sim model or a persona object the agents wrote."""
        if isinstance(player, dict):
            return {"name": player.get("name", "persona"), "about": player.get("about", ""),
                    "plays": player.get("plays", {}) or {}, "tells": player.get("tells", {}) or {}}
        if player not in self.players:
            raise KeyError(f"unknown scripted player: {player}")
        spec = self.players[player]
        return {"name": player, "about": spec.get("about", ""), "plays": spec.get("plays", {}),
                "tells": spec.get("tells", {})}

    def _declared(self, event: str) -> dict[str, Any]:
        return self.setup.get("events", {}).get(event, {}).get("fields", {})

    def _even(self, spec: Any) -> Any:
        """An even spread for one declared field, or None if it has no fixed choices."""
        if isinstance(spec, str):
            spec = self.setup.get("lists", {}).get(spec, spec)
        if isinstance(spec, list):
            return {name: 1.0 for name in spec}
        if isinstance(spec, dict) and "min" in spec:
            return {"min": spec["min"], "max": spec["max"]}
        return None

    def draw(self, persona: dict[str, Any], event: str, rng: random.Random) -> dict[str, Any]:
        """One play by a scripted player. Fields the persona gives a spread for
        follow it. Every other declared field is spread evenly."""
        given = persona.get("plays", {}).get(event, {})
        # sim.json can narrow what the player may choose, like the three shots
        # a human can hit out of the five the game knows.
        narrowed = self.spec.get("player_choices", {}).get(event, {})
        out: dict[str, Any] = {}
        for name, declared in self._declared(event).items():
            declared = narrowed.get(name, declared)
            dist = given.get(name, self._even(declared))
            if dist is None or dist == {}:
                continue
            out[name] = self._draw_one(dist, rng)
        return out

    @staticmethod
    def fill(template: dict[str, Any] | None, ctx: dict[str, Any], rng: random.Random) -> dict[str, Any]:
        """Turn a template into plain data. Unknown references are left out."""
        out: dict[str, Any] = {}
        for key, value in (template or {}).items():
            if isinstance(value, list):
                value = rng.choice(value)
            if isinstance(value, str) and value.startswith("$"):
                path = value[1:].split(".")
                found: Any = ctx
                for part in path:
                    found = found.get(part) if isinstance(found, dict) else None
                value = found
            if value is not None:
                out[key] = value
        return out

    # Who wins an exchange ------------------------------------------------

    @staticmethod
    def _matches(want: dict[str, Any], got: dict[str, Any]) -> bool:
        for key, value in want.items():
            have = got.get(key)
            if isinstance(value, dict):
                if not isinstance(have, (int, float)) or not value.get("min", have) <= have <= value.get("max", have):
                    return False
                continue
            allowed = value if isinstance(value, list) else [value]
            if have not in allowed:
                return False
        return True

    @staticmethod
    def _draw_one(dist: Any, rng: random.Random) -> Any:
        if isinstance(dist, dict) and "min" in dist:
            return round(rng.uniform(dist["min"], dist["max"]), 2)
        if isinstance(dist, dict) and dist:
            names, weights = zip(*dist.items())
            return rng.choices(names, weights=weights)[0] if sum(weights) > 0 else rng.choice(names)
        return dist

    def shape(self, event: str, data: dict[str, Any], picked: dict[str, str], rng: random.Random,
              seen: dict[str, Any] | None = None) -> dict[str, Any]:
        """Apply the `play_rules` for one event to a play, in place. Conditions
        on the player read `seen` (what is known so far) plus the play itself."""
        for rule in self.spec.get("play_rules", {}).get(event, []):
            when = rule.get("when", {})
            known = {**(seen or {}), **data}
            if self._matches(when.get("player", {}), known) and self._matches(when.get("npc", {}), picked):
                for name, dist in rule.get("spread", {}).items():
                    data[name] = self._draw_one(dist, rng)
        return data

    def carry(self, persona: dict[str, Any], play: dict[str, Any], event: str, picked: dict[str, str],
              rng: random.Random) -> dict[str, Any]:
        """Turn a play into another event: keep the fields both declare, draw the rest."""
        declared = self._declared(event)
        data = {name: play[name] for name in declared if name in play}
        for name, value in self.draw(persona, event, rng).items():
            data.setdefault(name, value)
        return self.shape(event, data, picked, rng, seen=play)

    def _adjust_rows(self) -> list[tuple[dict[str, Any], float]]:
        rows: list[tuple[dict[str, Any], float]] = []
        for entry in self.outcome.get("adjust", []):
            if "rows" in entry:
                rows.extend((row, float(entry.get("scale", 1.0))) for row in entry["rows"])
            else:
                rows.append((entry, 1.0))
        return rows

    def tell(self, persona: dict[str, Any], play: dict[str, Any], picked: dict[str, str],
             rng: random.Random) -> dict[str, Any]:
        """The player's tell before a play: some fields give the play away, honestly or not."""
        spec = self.round_spec["exchange"]["tell"]
        event = spec["event"]
        honesty = {**spec.get("match", {}), **persona.get("tells", {})}
        data: dict[str, Any] = {}
        for field_name, source in spec.get("copy", {}).items():
            actual = play.get(source)
            if rng.random() < float(honesty.get(field_name, 1.0)):
                data[field_name] = actual
            else:
                spread = self._even(self._declared(event).get(field_name)) or {}
                others = [name for name in spread if name != actual]
                data[field_name] = rng.choice(others) if others else actual
        for name, value in self.draw(persona, event, rng).items():
            data.setdefault(name, value)
        return self.shape(event, data, picked, rng, seen=play)

    def chances(self, play: dict[str, Any], picked: dict[str, str]) -> tuple[float, float]:
        """The chance this exchange ends with a point to the player, and to the NPC."""
        player_wins = float(self.outcome["player_wins"])
        npc_wins = float(self.outcome["npc_wins"])
        for adjust, scale in self._adjust_rows():
            if self._matches(adjust.get("player", {}), play) and self._matches(adjust.get("npc", {}), picked):
                player_wins += scale * adjust.get("player_wins", 0)
                npc_wins += scale * adjust.get("npc_wins", 0)
        player_wins = min(max(player_wins, 0.0), 1.0)
        npc_wins = min(max(npc_wins, 0.0), 1.0)
        total = player_wins + npc_wins
        if total > 1:
            player_wins, npc_wins = player_wins / total, npc_wins / total
        return player_wins, npc_wins

    # One round -------------------------------------------------------------

    def _pick_all(
        self,
        decisions: list[str],
        behaviour: dict[str, Any],
        values: dict[str, float],
        facts: dict[str, Any],
        rng: random.Random,
    ) -> tuple[dict[str, str], list[str]]:
        picked: dict[str, str] = {}
        by_rule: list[str] = []
        for decision in decisions:
            choice, ruled = pick(self.npc, decision, self.legal(decision), behaviour, values, facts, rng)
            picked[decision] = choice
            if ruled:
                by_rule.append(decision)
        return picked, by_rule

    async def play_round(
        self,
        player: str | dict[str, Any],
        behaviour: dict[str, Any],
        values: Callable[[], dict[str, float]],
        rng: random.Random,
        emit: Emit = _no_emit,
        pause: Callable[[], Awaitable[None]] = _no_pause,
    ) -> RoundResult:
        """Play one round. `behaviour` is fixed for the whole round. `values`
        is read fresh at every pick, so a `player_read` that lands mid-round
        is used straight away. `emit(name, by, data, picked, by_rule)` sends
        one event; practice runs pass a no-op."""
        persona = self.persona(player)
        spec = self.round_spec
        exchange_spec = spec["exchange"]
        npc_first = exchange_spec.get("order", "npc_first") == "npc_first"
        max_exchanges = int(spec.get("max_exchanges", 6))
        round_picks: dict[str, str] = {}
        last_play: dict[str, Any] = {}
        ctx: dict[str, Any] = {"exchange": 0, "picked": round_picks, "player": last_play}

        start = spec.get("start")
        if start:
            facts = self.fill(exchange_spec.get("facts"), ctx, rng)
            picked, by_rule = self._pick_all(start.get("decisions", []), behaviour, values(), facts, rng)
            round_picks.update(picked)
            event = start["event"]
            await emit(event["name"], self.npc, self.fill(event.get("data"), ctx, rng), picked, by_rule)

        player_spec = exchange_spec["player"]
        npc_spec = exchange_spec["npc"]
        player_wins = npc_wins = 0.5
        for exchange in range(1, max_exchanges + 1):
            ctx["exchange"] = exchange
            play = self.draw(persona, player_spec["event"], rng)
            if npc_first:
                # The NPC chooses before it sees this play, from the last one.
                facts = self.fill(exchange_spec.get("facts"), {**ctx, "player": last_play}, rng)
            else:
                facts = self.fill(exchange_spec.get("facts"), {**ctx, "player": play}, rng)
            picked, by_rule = self._pick_all(npc_spec.get("decisions", []), behaviour, values(), facts, rng)
            round_picks.update(picked)
            ctx["player"] = play
            play.update(self.fill(player_spec.get("data"), ctx, rng))
            # After the NPC has chosen, so a rule can react to the ball it hit.
            self.shape(player_spec["event"], play, round_picks, rng)

            tell_spec, react_spec = exchange_spec.get("tell"), exchange_spec.get("react")
            tell_data: dict[str, Any] | None = None
            react_picks: dict[str, str] = {}
            react_rule: list[str] = []
            if tell_spec:
                tell_data = self.tell(persona, play, round_picks, rng)
                ctx["tell"] = tell_data
            if react_spec:
                seen = last_play if npc_first else play
                facts = self.fill(exchange_spec.get("facts"), {**ctx, "player": seen}, rng)
                react_picks, react_rule = self._pick_all(react_spec.get("decisions", []), behaviour, values(), facts, rng)
                round_picks.update(react_picks)

            player_wins, npc_wins = self.chances(play, round_picks)
            roll = rng.random()
            ended = "player" if roll < player_wins else "npc" if roll < player_wins + npc_wins else "none"

            player_event, player_data, how = player_spec["event"], play, None
            swap = self.outcome.get("swap", {}).get(ended)
            if swap and rng.random() < float(swap.get("chance", 1.0)):
                player_event = swap["event"]
                player_data = self.carry(persona, play, player_event, round_picks, rng)
                how = swap.get("how")
            else:
                play.update(self.fill(self.outcome.get("player_data", {}).get(ended), ctx, rng))

            npc_event = npc_spec.get("event")
            npc_data = self.fill(npc_event.get("data"), ctx, rng) if npc_event else {}
            # Before the play: the tell, then the NPC's reaction to it.
            before: list[tuple[str, str, dict[str, Any], dict[str, str] | None, list[str] | None]] = []
            if tell_spec and tell_data is not None:
                before.append(("player", tell_spec["event"], tell_data, None, None))
            if react_spec and react_spec.get("event"):
                react_event = react_spec["event"]
                before.append((self.npc, react_event["name"], self.fill(react_event.get("data"), ctx, rng),
                               react_picks, react_rule))
            npc_send = [(self.npc, npc_event["name"], npc_data, picked, by_rule)] if npc_event else []
            player_send = [("player", player_event, player_data, None, None)]
            if npc_first:
                sends = npc_send + before + player_send
            else:
                sends = before + player_send + npc_send
            for by, name, data, picks, ruled in sends:
                await emit(name, by, data, picks, ruled)

            last_play.clear()
            last_play.update(play)
            await pause()
            if ended != "none":
                return await self._finish(persona, ended, exchange, ctx, rng, emit, how=how)

        # Nobody ended it in time: the last exchange decides, in proportion to the chances.
        total = player_wins + npc_wins
        ended = "player" if rng.random() < (player_wins / total if total else 0.5) else "npc"
        return await self._finish(persona, ended, max_exchanges, ctx, rng, emit, long=True)

    async def _finish(
        self, persona: dict[str, Any], ended: str, exchanges: int, ctx: dict[str, Any], rng: random.Random,
        emit: Emit, long: bool = False, how: str | None = None,
    ) -> RoundResult:
        end_event = self.outcome.get("end_events", {}).get(ended)
        if end_event:
            # A kill by the player draws its weapon from the player's own spread.
            drawn = self.draw(persona, end_event["name"], rng) if ended == "player" else {}
            data = {**drawn, **self.fill(end_event.get("data"), ctx, rng)}
            by = "player" if ended == "player" else self.npc
            await emit(end_event["name"], by, data, None, None)
        if how is None:
            how_names = self.outcome.get("how", {})
            how = how_names.get("long" if long else ended, "long" if long else ended)
        stats = self.fill(self.outcome.get("stats"), ctx, rng)
        return RoundResult("player" if ended == "player" else self.npc, how, exchanges, stats)


# Playing many rounds with no socket ---------------------------------------------


def run_sync(coroutine: Any) -> Any:
    """Run a round that never really waits (no emit, no pause) without an event loop."""
    try:
        coroutine.send(None)
    except StopIteration as done:
        return done.value
    coroutine.close()
    raise RuntimeError("a headless round tried to wait on something")


def play(
    setup: dict[str, Any],
    model: dict[str, Any] | SimModel,
    behaviour: dict[str, Any] | None,
    player: str | dict[str, Any],
    rounds: int,
    seed: int | str = 0,
) -> dict[str, Any]:
    """Play `rounds` rounds of `behaviour` against one scripted player or
    persona, with no events. Returns the numbers a `practice_result` carries."""
    sim = model if isinstance(model, SimModel) else SimModel(model, setup)
    persona = sim.persona(player)
    behaviour = behaviour or setup.get("default_behaviour") or {"version": 0, "npcs": {}}
    rng = random.Random(seed)
    wins = {"player": 0, sim.npc: 0}
    exchanges = 0
    for _ in range(rounds):
        result = run_sync(sim.play_round(persona, behaviour, dict, rng))
        wins[result.winner] = wins.get(result.winner, 0) + 1
        exchanges += result.exchanges
    return {
        "player": persona["name"],
        "rounds": rounds,
        "wins": wins,
        "stats": {"average_exchanges": round(exchanges / rounds, 2) if rounds else 0},
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m sim.headless", description=__doc__.splitlines()[0])
    parser.add_argument("--setup", required=True)
    parser.add_argument("--model", required=True, help="the game's sim.json")
    parser.add_argument("--behaviour", default=None, help="a behaviour JSON file (default: the setup's default)")
    parser.add_argument("--player", required=True, help="a scripted player's name, or a persona JSON file")
    parser.add_argument("--rounds", type=int, default=200)
    parser.add_argument("--seed", default="0")
    args = parser.parse_args(argv)
    setup = load_json(args.setup)
    behaviour = load_json(args.behaviour) if args.behaviour else None
    player: str | dict[str, Any] = args.player
    if args.player.endswith(".json") or Path(args.player).is_file():
        player = load_json(args.player)
    try:
        result = play(setup, load_json(args.model), behaviour, player, args.rounds, args.seed)
    except KeyError as problem:
        print(json.dumps({"error": str(problem)}))
        return 2
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
