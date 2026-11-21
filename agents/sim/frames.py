"""A simple top-down picture of the latest play, for exercising the frames path.

It draws the zones named in the events as a grid and marks where the last few
plays landed. It knows nothing about any one game's court.
"""
from __future__ import annotations

import base64
import io
from typing import Any

from PIL import Image, ImageDraw

WIDTH, HEIGHT = 384, 384


def draw_frame(events: list[dict[str, Any]], npc: str) -> dict[str, str]:
    image = Image.new("RGB", (WIDTH, HEIGHT), (18, 18, 18))
    pen = ImageDraw.Draw(image)
    pen.rectangle([16, 16, WIDTH - 16, HEIGHT - 16], outline=(200, 200, 200), width=2)
    pen.line([16, HEIGHT // 2, WIDTH - 16, HEIGHT // 2], fill=(200, 200, 200), width=1)
    for index, event in enumerate(events):
        y = 30 + index * 26
        who = "NPC" if event.get("by") == npc else "player"
        colour = (230, 120, 60) if who == "NPC" else (90, 170, 240)
        words = ", ".join(f"{k}={v}" for k, v in (event.get("data") or {}).items() if isinstance(v, str))
        pen.text((24, y), f"{who} {event.get('name')}: {words}"[:60], fill=colour)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=70)
    return {"mime_type": "image/jpeg", "data": base64.b64encode(buffer.getvalue()).decode("ascii")}
