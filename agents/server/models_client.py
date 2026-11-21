"""One small way to ask a Gemini 4 model for JSON.

Every call sends an explicit thinking level and a JSON schema, so the reply
is always structured output and never free text we have to parse. Nothing
else is tuned: Gemini 4 models take no temperature, top-p, top-k or thinking
budget.
"""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any

from google import genai

from server import config, keys

_client: genai.Client | None = None
_made_with = 0  # the key generation the shared client was built under


class ModelError(RuntimeError):
    """The model call failed, timed out, or did not return JSON."""


@dataclass
class ModelReply:
    """What came back from one call."""

    data: dict[str, Any]
    model: str
    thinking: str
    ms: float
    usage: dict[str, int] = field(default_factory=dict)


def _get_client() -> genai.Client:
    """One shared client, made on first use so imports never need the key.

    It is made again if the key has changed since.
    """
    global _client, _made_with
    if _client is None or _made_with != keys.generation():
        _client = genai.Client(api_key=config.api_key())
        _made_with = keys.generation()
    return _client


def _usage(reply: Any) -> dict[str, int]:
    """Token counts from a reply. Thinking tokens bill as output."""
    usage = getattr(reply, "usage", None)
    counts = {}
    for short, name in (
        ("input", "total_input_tokens"),
        ("output", "total_output_tokens"),
        ("thinking", "total_thought_tokens"),
    ):
        counts[short] = int(getattr(usage, name, 0) or 0)
    return counts


async def ask_json(
    model: str,
    thinking: str,
    prompt: str,
    schema: dict[str, Any],
    *,
    system: str | None = None,
    timeout: float = 120.0,
) -> ModelReply:
    """Ask `model` one question and get back JSON that fits `schema`.

    Raises ModelError on a timeout, an API error or a reply that is not a
    JSON object. The caller decides what to do then.
    """
    request: dict[str, Any] = {
        "model": model,
        "input": prompt,
        "generation_config": {"thinking_level": thinking},
        "response_format": {"type": "text", "mime_type": "application/json", "schema": schema},
        "store": False,
        # A long answer can stop at the per-request decode limit. This resumes it.
        "automatic_continuation": True,
    }
    if system:
        request["system_instruction"] = system

    async def create() -> Any:
        return await _get_client().aio.interactions.create(**request)

    started = time.monotonic()
    try:
        # If the key has run out of credit and another is waiting, this moves to it and asks once more.
        reply = await asyncio.wait_for(keys.with_fallback(create), timeout)
    except asyncio.TimeoutError as error:
        raise ModelError(f"{model} did not answer within {timeout:.0f} seconds") from error
    except Exception as error:  # the SDK raises many kinds, and callers treat them all the same
        raise ModelError(f"{model} call failed: {type(error).__name__}: {str(error)[:300]}") from error
    ms = (time.monotonic() - started) * 1000

    text = getattr(reply, "output_text", None) or ""
    status = getattr(reply, "status", None)
    try:
        data = json.loads(text)
    except json.JSONDecodeError as error:
        raise ModelError(
            f"{model} did not return whole JSON after {ms / 1000:.0f} seconds "
            f"(status {status}, {len(text)} characters): {text[:80]!r}"
        ) from error
    if not isinstance(data, dict):
        raise ModelError(f"{model} returned JSON that is not an object")
    return ModelReply(data=data, model=model, thinking=thinking, ms=ms, usage=_usage(reply))
