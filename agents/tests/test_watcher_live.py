"""One real read on tennis-shaped data. Runs only when GEMINI_API_KEY is set.

    ./.venv/bin/python -m pytest tests/test_watcher_live.py -q -s
"""
from __future__ import annotations

import base64
import io
import json
import os
import random
from pathlib import Path
from typing import Any

import pytest
from PIL import Image, ImageDraw

from server.interfaces import Design, MatchState, ValueSpec
from server.watcher import DecisionsWatcher

pytestmark = pytest.mark.skipif(not os.environ.get("GEMINI_API_KEY"), reason="needs GEMINI_API_KEY")

SETUP: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parent.parent / "examples" / "tennis" / "setup.json").read_text()
)
ZONES: list[str] = SETUP["lists"]["zone"]

QUESTIONS: dict[str, dict[str, Any]] = {
    "comes_to_net": {"type": "noul", "instructions": (
        "Does the player come up to the net? A shot hit from a *_short zone means the player was at the net.")},
    "prefers_forehand": {"type": "score", "instructions": "How often does the player hit forehands rather than backhands?",
                         "criteria": ["Never", "Rarely", "Half the time", "Often", "Almost always"]},
    "aims_left": {"type": "score", "instructions": (
        "How often do the player's shots go to the left of the screen (angle below 0, or landing left)?"),
                  "criteria": ["Never", "Rarely", "A third of the time", "Often", "Almost always"]},
    "hits_hard": {"type": "score", "instructions": "How hard does the player usually swing? Power runs from 0 to 1.",
                  "criteria": ["Very soft", "Soft", "Medium", "Hard", "Very hard"]},
    "favours_topspin": {"type": "choice", "instructions": "Which shot type does the player use most?",
                        "criteria": {"dropshot": "Drop shots", "slice": "Slices", "topspin": "Topspin",
                                     "other": "No clear favourite"},
                        "value_of": "topspin"},
    "makes_errors": {"type": "noul", "instructions": "Do more than a quarter of the player's shots go out or into the net?"},
}

# Per shot type: (power range, rotation range), the numbers behind the game's label.
_SHOT_NUMBERS = {
    "topspin": ((0.7, 0.95), (0.4, 0.9)),
    "slice": ((0.35, 0.6), (-0.8, -0.3)),
    "dropshot": ((0.1, 0.3), (-0.5, -0.1)),
}


def player_shots(count: int, start_t: float, seed: int) -> list[dict[str, Any]]:
    """A baseline player who loves a hard topspin forehand cross-court, with an NPC shot after each."""
    rng = random.Random(seed)
    events = []
    for i in range(count):
        forehand = rng.random() < 0.8
        kind = rng.choices(["topspin", "slice", "dropshot"], weights=[65, 25, 10])[0]
        power, rotation = _SHOT_NUMBERS[kind]
        timing = rng.choices(["early", "on_time", "late"], weights=[15, 60, 25])[0]
        late = 0.6 if timing == "late" else 1.0  # late contact is weaker and less clean
        side_factor = 1.0 if forehand else 0.7   # a weaker backhand
        events.append({
            "type": "event", "match_id": "m_live", "name": "shot", "round": 2, "t": start_t + 2.0 * i, "by": "player",
            "data": {
                "rally": i + 1,
                "side": "forehand" if forehand else "backhand",
                "shot_type": kind,
                "power": round(rng.uniform(*power) * late * side_factor, 2),
                "confidence": round(rng.uniform(0.6, 0.95), 2),
                "timing": timing,
                "quality": round(rng.uniform(0.6, 0.9) * late, 2),
                "rotation": round(rng.uniform(*rotation), 2),
                "angle": round(rng.uniform(-0.8, -0.3) if forehand else rng.uniform(-0.2, 0.5), 2),
                "from": rng.choice(["left_deep", "middle_deep", "right_deep"]),
                "arm_zone": "right" if forehand else rng.choice(["left", "center"]),
                "other_position": rng.choice(ZONES),
                "lands": "left_deep" if forehand and rng.random() < 0.8 else rng.choice(ZONES),
                "result": "in" if rng.random() < 0.9 else "out",
            },
        })
        if i % 4 == 3:
            events.append({
                "type": "event", "match_id": "m_live", "name": "missed_swing", "round": 2,
                "t": start_t + 2.0 * i + 0.5, "by": "player",
                "data": {"side": "backhand", "arm_zone": "left", "shot_type": "slice",
                         "power": round(rng.uniform(0.3, 0.6), 2), "reason": "too_late"},
            })
        events.append({
            "type": "event", "match_id": "m_live", "name": "shot", "round": 2, "t": start_t + 2.0 * i + 1, "by": "opponent",
            "picked": {"shot_type": "flat"}, "data": {"shot_type": "flat", "lands": "middle_deep", "result": "in"},
        })
    return events


def court_frame() -> str:
    """A plain drawing of a court with the player at the bottom left, as base64 JPEG."""
    image = Image.new("RGB", (384, 288), (40, 110, 60))
    draw = ImageDraw.Draw(image)
    draw.rectangle((60, 20, 324, 268), outline="white", width=3)
    draw.line((60, 144, 324, 144), fill="white", width=3)
    draw.ellipse((90, 230, 110, 250), fill=(30, 60, 200))   # the player
    draw.ellipse((185, 30, 205, 50), fill=(200, 40, 40))    # the opponent
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=80)
    return base64.b64encode(out.getvalue()).decode("ascii")


def make_match(events: list[dict[str, Any]]) -> tuple[MatchState, list]:
    values = [ValueSpec(name, name.replace("_", " ").capitalize(), q) for name, q in QUESTIONS.items()]
    traces: list = []
    match = MatchState(
        match_id="m_live", setup=SETUP,
        design=Design(values=values, behaviour={"version": 1, "npcs": {}}),
        behaviour={"version": 1, "npcs": {}}, events=events, trace=traces.append,
    )
    return match, traces


async def test_real_read_on_tennis_data() -> None:
    match, traces = make_match(player_shots(9, 30.0, seed=1))
    match.frames = {"type": "frames", "match_id": "m_live", "round": 2, "t": 47.0,
                    "views": {"court": {"mime_type": "image/jpeg", "data": court_frame()}}}
    watcher = DecisionsWatcher()
    await watcher.warm()

    first = await watcher.read(match)
    print("\nfirst read:", json.dumps(first, indent=2))
    print("traces:", json.dumps(traces, indent=2))
    assert first is not None, traces
    assert set(first["values"]) == set(QUESTIONS)
    assert all(0 <= v <= 1 for v in first["values"].values())
    assert first["values"]["prefers_forehand"] > first["values"]["comes_to_net"]
    assert first["picture_note"]

    match.events.extend(player_shots(4, 48.0, seed=2))
    second = await watcher.read(match)
    print("second read:", json.dumps(second, indent=2))
    assert second is not None
    assert match.player.reads == 2
