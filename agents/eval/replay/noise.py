"""A noise layer that stands in for a game's sensing mistakes.

It changes only what the game sends about the player:
- relabels a share of player swings with the wrong `shot_type` or `side`,
- lowers `confidence`,
- adds `missed_swing` events,
- drops or delays player events.

Everything is seeded, so the same settings give the same noisy stream.
"""
from __future__ import annotations

import copy
import random
from dataclasses import dataclass

SWING_EVENTS = ("shot", "swing_start", "missed_swing")
SIDES = ("forehand", "backhand")


@dataclass
class Noise:
    wrong_labels: float = 0.0   # share of player swings given a wrong shot_type or side
    confidence_drop: float = 0.0  # subtract this from every player `confidence`
    missed_swings: float = 0.0  # chance of an extra missed_swing after each player shot
    drop: float = 0.0           # chance a player event never arrives
    delay: float = 0.0          # chance a player event arrives late
    delay_seconds: float = 1.5  # how late, at most
    seed: int = 1

    def active(self) -> bool:
        return any((self.wrong_labels, self.confidence_drop, self.missed_swings, self.drop, self.delay))

    def describe(self) -> dict:
        return {k: getattr(self, k) for k in self.__dataclass_fields__}


def shot_types(setup: dict) -> list[str]:
    """The player's shot types as the game declared them, or a tennis fallback."""
    lists = setup.get("lists") or {}
    for key in ("human_shot_type", "player_shot_type", "shot_type"):
        if isinstance(lists.get(key), list) and lists[key]:
            return [str(x) for x in lists[key]]
    return ["topspin", "slice", "dropshot"]


def apply(items: list[tuple[float, dict]], noise: Noise) -> tuple[list[tuple[float, dict]], dict]:
    """Return the noisy (send_time, message) list, sorted by send time, and counts of what changed."""
    rng = random.Random(noise.seed)
    setup = next((m for _, m in items if m.get("type") == "setup"), {})
    types = shot_types(setup)
    counts = {"player_swings": 0, "relabelled": 0, "dropped": 0, "delayed": 0, "missed_added": 0}
    out: list[tuple[float, dict]] = []

    for send_t, message in items:
        if message.get("type") != "event" or message.get("by") != "player":
            out.append((send_t, message))
            continue
        message = copy.deepcopy(message)
        data = message.setdefault("data", {})

        if rng.random() < noise.drop:
            counts["dropped"] += 1
            continue

        if message.get("name") in SWING_EVENTS:
            counts["player_swings"] += 1
            if rng.random() < noise.wrong_labels:
                fields = [f for f in ("shot_type", "side") if f in data]
                if fields:
                    field = rng.choice(fields)
                    if field == "side":
                        data["side"] = SIDES[1] if data["side"] == SIDES[0] else SIDES[0]
                    else:
                        others = [t for t in types if t != data["shot_type"]] or types
                        data["shot_type"] = rng.choice(others)
                    counts["relabelled"] += 1

        if noise.confidence_drop and isinstance(data.get("confidence"), (int, float)):
            data["confidence"] = round(max(0.0, float(data["confidence"]) - noise.confidence_drop), 3)

        if rng.random() < noise.delay:
            send_t += rng.uniform(0.2, noise.delay_seconds)
            counts["delayed"] += 1
        out.append((send_t, message))

        if message.get("name") == "shot" and rng.random() < noise.missed_swings:
            missed = {
                "type": "event", "match_id": message.get("match_id"), "name": "missed_swing",
                "round": message.get("round"), "t": round(float(message.get("t") or 0) + 0.4, 3),
                "by": "player",
                "data": {k: data[k] for k in ("side", "arm_zone", "shot_type", "power") if k in data},
            }
            missed["data"]["reason"] = "too_early"
            out.append((send_t + 0.4, missed))
            counts["missed_added"] += 1

    out.sort(key=lambda pair: pair[0])
    return out, counts
