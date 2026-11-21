"""A small client for the Gemini Decisions API.

The watcher calls `ask` about once a second. One client is kept for the life
of the process, so the connection to the API stays open between calls.
"""
from __future__ import annotations

import asyncio
from typing import Any

from google import genai

from server import config, keys

TIMEOUT_SECONDS = 3.0

_client: genai.Client | None = None
_made_with = 0  # the key generation the shared client was built under


def _get_client() -> genai.Client:
    """The shared client, made on first use so the key is read only when needed.

    It is made again if the key has changed since.
    """
    global _client, _made_with
    if _client is None or _made_with != keys.generation():
        _client = genai.Client(api_key=config.api_key(), http_options={"api_version": "v1beta"})
        _made_with = keys.generation()
    return _client


async def ask(
    input_parts: list[dict[str, Any]],
    questions: dict[str, dict[str, Any]],
    *,
    model: str | None = None,
    timeout: float = TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Ask the Decisions API every question about one input.

    `input_parts` are Decisions API input items, like
    {"type": "text", "text": "..."} or
    {"type": "image", "mime_type": "image/jpeg", "data": "<base64>", "resolution": "low"}.

    Returns {"answers": {name: answer}, "usage": {...}} as plain dicts.
    Raises on a timeout or an API error. The watcher catches everything.
    """
    async def create() -> Any:
        return await asyncio.wait_for(
            _get_client().aio.decisions.create(
                model=model or config.WATCHER_MODEL,
                input=input_parts,
                questions=questions,
            ),
            timeout=timeout,
        )

    # If the key has run out of credit and another is waiting, this moves to it and asks once more.
    response = await keys.with_fallback(create)
    return response.model_dump(exclude_none=True)
