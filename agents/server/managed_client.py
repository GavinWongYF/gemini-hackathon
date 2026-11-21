"""A small client for Gemini Managed Agents: start a run, watch it, read its files.

Plain HTTP, so every request is visible here. A run happens in a sandbox
(an "environment") that keeps its files between runs.
"""
from __future__ import annotations

import asyncio
import json
import warnings
from typing import Any, AsyncIterator

import httpx

from server import config, keys

BASE = "https://generativelanguage.googleapis.com/v1beta"
REVISION = "2026-05-20"
DONE = ("completed", "failed", "cancelled", "canceled", "incomplete", "expired")


class ManagedError(RuntimeError):
    """A request to the Managed Agents API did not work."""

    def __init__(self, about: str, status: int | None = None) -> None:
        super().__init__(about)
        self.status = status


def source(target: str, content: str) -> dict[str, str]:
    """One file to place in a new sandbox. A target under `.agents/` lands at the sandbox root."""
    return {"type": "inline", "target": target, "content": content}


def final_text(run: dict[str, Any]) -> str:
    """The agent's last message in a finished run."""
    texts = [part.get("text", "") for step in run.get("steps") or [] if step.get("type") == "model_output"
             for part in step.get("content") or [] if isinstance(part, dict)]
    return texts[-1] if texts else ""


def tokens(run: dict[str, Any]) -> dict[str, int]:
    """Token counts of a finished run. Empty while it is still going."""
    usage = run.get("usage") or {}
    return {key: int(value) for key, value in usage.items() if str(value).isdigit()}


def paths(listing: Any) -> list[str]:
    """Every file path in a file-list reply, whatever it is nested in."""
    found: list[str] = []
    if isinstance(listing, dict):
        name = listing.get("path") or listing.get("name")
        if isinstance(name, str) and str(listing.get("type", "FILE")).upper() != "DIRECTORY":
            found.append(name)
        for value in listing.values():
            found += paths(value)
    elif isinstance(listing, list):
        for item in listing:
            found += paths(item)
    return found


class ManagedClient:
    """One HTTP connection to the Managed Agents API."""

    def __init__(self, timeout: float = 40.0) -> None:
        self._http: httpx.AsyncClient | None = None
        self._made_with = 0                         # the key generation the connection was built under
        self._stale: list[httpx.AsyncClient] = []   # connections built with an earlier key, closed in close()
        self._timeout = timeout

    def _client(self) -> httpx.AsyncClient:
        if self._http is not None and self._made_with != keys.generation():
            self._stale.append(self._http)  # the key changed, so this connection carries the old one
            self._http = None
        if self._http is None:
            self._http = httpx.AsyncClient(
                base_url=BASE, timeout=self._timeout,
                headers={"x-goog-api-key": config.api_key(), "Api-Revision": REVISION},
            )
            self._made_with = keys.generation()
        return self._http

    async def close(self) -> None:
        for http in [*self._stale, self._http]:
            if http is not None:
                await http.aclose()
        self._stale, self._http = [], None

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            return await self._client().request(method, path, **kwargs)
        except httpx.HTTPError as error:
            raise ManagedError(f"{method} {path.split('?')[0]} did not get through: {type(error).__name__}.") from None

    async def _send(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        began = keys.generation()
        reply = await self._request(method, path, **kwargs)
        if reply.status_code == 402 and keys.moved_on(began):
            # The key ran out of credit and another was waiting. Ask once more with that one.
            reply = await self._request(method, path, **kwargs)
        if reply.status_code == 402:
            raise ManagedError("The API credit has run out (HTTP 402).", 402)
        return reply

    async def start(
        self,
        task: str,
        *,
        model: str,
        max_total_tokens: int,
        sources: list[dict[str, str]] | None = None,
        environment_id: str | None = None,
    ) -> dict[str, Any]:
        """Start a run in the background. Pass `sources` for a new sandbox,
        or `environment_id` to reuse one. Returns `id`, `status` and `environment_id`."""
        environment: Any = environment_id or {"type": "remote", "sources": sources or []}
        body = {
            "agent": config.MANAGED_AGENT,
            "environment": environment,
            "input": task,
            "agent_config": {"type": "antigravity", "model": model, "max_total_tokens": max_total_tokens},
            "background": True,
            "store": True,
        }
        reply = await self._send("POST", "/interactions", json=body)
        if reply.status_code >= 400:
            raise ManagedError(f"Starting a run failed with HTTP {reply.status_code}: {reply.text[:300]}", reply.status_code)
        return reply.json()

    async def get(self, run_id: str) -> dict[str, Any]:
        """The run as it stands. `steps` and `usage` only appear once it is done."""
        reply = await self._send("GET", f"/interactions/{run_id}")
        if reply.status_code >= 400:
            raise ManagedError(f"Reading run {run_id} failed with HTTP {reply.status_code}.", reply.status_code)
        return reply.json()

    async def files(self, environment_id: str, folder: str = "workspace") -> list[str]:
        """Every file under a folder of the sandbox. Works while a run is going."""
        reply = await self._send("GET", f"/environments/{environment_id}/files/{folder}", params={"recursive": "true"})
        if reply.status_code == 404:
            return []
        if reply.status_code >= 400:
            raise ManagedError(f"Listing files failed with HTTP {reply.status_code}.", reply.status_code)
        return paths(reply.json())

    async def read(self, environment_id: str, path: str) -> str | None:
        """One file from the sandbox as text, or None when it is not there."""
        reply = await self._send("GET", f"/environments/{environment_id}/files/{path.lstrip('/')}", params={"alt": "media"})
        if reply.status_code == 404:
            return None
        if reply.status_code >= 400:
            raise ManagedError(f"Reading {path} failed with HTTP {reply.status_code}.", reply.status_code)
        return reply.text

    async def upload(self, environment_id: str, path: str, content: str) -> None:
        """Put one file into a sandbox that already exists. This is slow, so
        files that are known when the sandbox is made go in `sources`."""
        from google import genai

        def send() -> None:
            client = genai.Client(api_key=config.api_key(), http_options={"api_version": "v1beta"})
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")   # the SDK warns that this part of it is still in preview
                client.environments.files.upload(
                    environment=environment_id, path=path.lstrip("/"),
                    file=content.encode(), mime_type="text/plain", overwrite=True,
                )

        try:
            # `send` builds its client each time, so a retry after the key changes uses the new key.
            await keys.with_fallback(lambda: asyncio.to_thread(send))
        except Exception as error:
            raise ManagedError(f"Uploading {path} failed: {type(error).__name__}.") from None

    async def events(self, run_id: str, last_event_id: str | None = None) -> AsyncIterator[dict[str, Any]]:
        """Follow a run that is already going, one server-sent event at a time.

        Each item is {"event": name, "id": event id, "data": parsed JSON}."""
        params = {"stream": "true"}
        if last_event_id:
            params["last_event_id"] = last_event_id
        began = keys.generation()
        try:
            for attempt in (1, 2):
                async with self._client().stream(
                    "GET", f"/interactions/{run_id}", params=params,
                    headers={"Accept": "text/event-stream"}, timeout=httpx.Timeout(self._timeout, read=None),
                ) as reply:
                    if reply.status_code == 402 and attempt == 1 and keys.moved_on(began):
                        continue  # the key ran out of credit and another was waiting: open the stream once more
                    if reply.status_code >= 400:
                        raise ManagedError(f"Following run {run_id} failed with HTTP {reply.status_code}.", reply.status_code)
                    name, event_id, data = "", "", []
                    async for line in reply.aiter_lines():
                        if line.startswith("event:"):
                            name = line[6:].strip()
                        elif line.startswith("id:"):
                            event_id = line[3:].strip()
                        elif line.startswith("data:"):
                            data.append(line[5:].strip())
                        elif not line.strip() and data:
                            try:
                                parsed = json.loads("\n".join(data))
                            except ValueError:
                                parsed = {"text": "\n".join(data)}
                            kind = name or (parsed.get("event_type") or parsed.get("type") or "" if isinstance(parsed, dict) else "")
                            yield {"event": kind, "id": event_id, "data": parsed}
                            name, event_id, data = "", "", []
                return
        except httpx.HTTPError as error:
            raise ManagedError(f"The event stream for run {run_id} broke: {type(error).__name__}.") from None
