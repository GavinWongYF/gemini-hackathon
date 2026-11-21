"""The agent server: one socket for the game, one for viewers.

    /ws      the game talks here, in the messages docs/api.md describes
    /watch   viewers get everything that happens, for the second screen
    /health  a quick check that the server is up and which parts it has
    /screen  the second screen's page, when the folder holds an index.html

Nothing in here knows which game is on the other end.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import keys
from .contract import check_setup
from .hub import Hub
from .interfaces import Adapter, Designer, Watcher, trace_message
from .session import Parts, Session, Settings

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SCREEN = "demo/tennis-screen"

# Where each real part lives. Each has a constructor that takes no arguments.
REAL_PARTS = {
    "watcher": ("server.watcher", "DecisionsWatcher"),
    "designer": ("server.designer", "GeminiDesigner"),
    "adapter": ("server.adapter", "GeminiAdapter"),
}


def _load_part(name: str) -> Any:
    """Import and build one real part, or say in one line why it is missing."""
    module_name, class_name = REAL_PARTS[name]
    try:
        return getattr(importlib.import_module(module_name), class_name)()
    except Exception as problem:
        print(f"[server] Running without the {name} ({module_name}.{class_name}): {type(problem).__name__}: {problem}")
        return None


def create_app(
    watcher: Watcher | None = None,
    designer: Designer | None = None,
    adapter: Adapter | None = None,
    *,
    real_parts: bool = True,
    adapt: bool = True,
    record: bool = False,
    reuse_designs: bool = True,
    data_dir: Path | str | None = None,
    screen_dir: Path | str | None = None,
    settings: Settings | None = None,
) -> FastAPI:
    """Build the server.

    watcher, designer, adapter: pass your own, as the tests do. Any left as
        None is loaded from its real module, unless real_parts is False.
    adapt:   False plays the unchanged baseline. No `strategy_update` is sent.
    record:  write each match's viewer stream to <data_dir>/streams/.
    """
    data = Path(data_dir) if data_dir else ROOT / "data"
    settings = settings or Settings()
    settings.adapt = adapt and settings.adapt
    settings.reuse_designs = reuse_designs and settings.reuse_designs
    settings.designs_dir = data / "designs"

    parts = Parts(watcher=watcher, designer=designer, adapter=adapter)
    if real_parts and settings.adapt:
        for name in REAL_PARTS:
            if getattr(parts, name) is None:
                setattr(parts, name, _load_part(name))

    hub = Hub(record_dir=data / "streams" if record else None)
    sessions: dict[str, Session] = {}
    uses_a_key = real_parts and settings.adapt  # only the real parts call a model

    def key_changed(line: str) -> None:
        """The key ran out and the process moved to the next one. Tell every match that is still going."""
        for session in sessions.values():
            if not session.finished():
                session.trace(trace_message("server", "done", line))

    if uses_a_key:
        keys.on_notice(key_changed)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        for session in sessions.values():
            session.close()
        hub.close()

    app = FastAPI(title="Adaptive NPC agent server", lifespan=lifespan)
    # A game's own page can load the side panels from /screen, and that page
    # is served from another address, so any page may fetch what we serve.
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"])
    app.state.hub = hub
    app.state.sessions = sessions
    app.state.parts = parts
    app.state.settings = settings

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "ok": True,
            "adapting": settings.adapt,
            "recording": record,
            "parts": {name: getattr(parts, name) is not None for name in REAL_PARTS},
            "matches": {
                match_id: {
                    "connected": session.socket is not None,
                    "ready": session.match is not None,
                    "rounds": len(session.match.rounds) if session.match else 0,
                    "version": session.match.behaviour.get("version") if session.match else None,
                }
                for match_id, session in sessions.items()
            },
        }

    @app.websocket("/ws")
    async def game(socket: WebSocket) -> None:
        await socket.accept()
        session: Session | None = None
        try:
            while True:
                message = await _next_message(socket)
                if message is None:
                    continue
                if message["type"] == "setup":
                    session = await _on_setup(socket, message) or session
                elif session is None:
                    await _refuse(socket, message.get("match_id"), {
                        "about": "Send `setup` first. Nothing else can be read until the game has described itself.",
                        "where": "type", "got": message["type"],
                    })
                else:
                    await session.on_message(message)
        except WebSocketDisconnect:
            pass
        finally:
            if session is not None and session.socket is socket:
                session.socket = None
                # Viewers are told, so a screen following this match knows the game is gone.
                session.trace(trace_message("server", "done", "The game left.", data={"game": "left"}))

    async def _on_setup(socket: WebSocket, setup: dict[str, Any]) -> Session | None:
        problems = check_setup(setup)
        match_id = setup.get("match_id")
        if problems:
            known = isinstance(match_id, str) and match_id != ""
            if known:  # viewers see a refused setup too
                hub.publish(match_id, "in", 0.0, setup)
            for problem in problems[:10]:
                await _refuse(socket, match_id, problem)
                if known:
                    hub.publish(match_id, "out", 0.0, {"type": "error", "match_id": match_id, **problem})
            return None
        session = sessions.get(match_id)
        if session is not None and session.finished():
            # That match played all its rounds. The same id now starts a new one.
            session.close()
            hub.reset(match_id)
            session = None
        is_new = session is None
        if session is None:
            session = sessions[match_id] = Session(match_id, parts, settings, hub)
        await session.on_setup(socket, setup)
        if is_new and uses_a_key:
            session.trace(trace_message("server", "done", keys.start_line()))
        return session

    @app.websocket("/watch")
    async def watch(socket: WebSocket) -> None:
        await socket.accept()
        queue = hub.join(socket.query_params.get("match_id"))

        async def pump() -> None:
            while True:
                await socket.send_text(json.dumps(await queue.get()))

        sender = asyncio.create_task(pump())
        try:
            while True:  # viewers only listen. This just notices when one leaves.
                if (await socket.receive())["type"] == "websocket.disconnect":
                    break
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            sender.cancel()
            hub.leave(queue)

    screen = Path(screen_dir or os.environ.get("NPC_SCREEN_DIR") or ROOT / DEFAULT_SCREEN)
    if (screen / "index.html").is_file():
        app.mount("/screen", StaticFiles(directory=screen, html=True), name="screen")
    else:
        print(f"[server] No second screen to serve: {screen / 'index.html'} does not exist.")
    return app


async def _next_message(socket: WebSocket) -> dict[str, Any] | None:
    """Read one message. A message that can't be read gets an `error` and None comes back."""
    raw = await socket.receive()
    if raw["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(raw.get("code", 1000))
    text = raw.get("text")
    if text is None:
        text = (raw.get("bytes") or b"").decode("utf-8", errors="replace")
    try:
        message = json.loads(text)
    except ValueError:
        await _refuse(socket, None, {
            "about": "The message is not valid JSON. Every message is one JSON object.",
            "where": "message", "got": text[:200],
        })
        return None
    if not isinstance(message, dict) or not isinstance(message.get("type"), str):
        await _refuse(socket, message.get("match_id") if isinstance(message, dict) else None, {
            "about": "Every message is one JSON object with a `type`.",
            "where": "type", "got": message if not isinstance(message, dict) else message.get("type"),
        })
        return None
    return message


async def _refuse(socket: WebSocket, match_id: Any, problem: dict[str, Any]) -> None:
    """Send an `error` for a message that came before there was a match to file it under."""
    reply = {"type": "error", "match_id": match_id if isinstance(match_id, str) else "", **problem}
    try:
        await socket.send_text(json.dumps(reply, default=str))
    except Exception:
        pass
