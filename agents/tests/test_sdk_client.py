"""The Python client against a stand-in agent server on a local socket."""
from __future__ import annotations

import asyncio
import json

import websockets

from adaptive_npc import Client

SETUP = {
    "type": "setup", "match_id": "m_test", "game": "tennis", "mode": "live",
    "npcs": {"opponent": {"decisions": {"shot_type": {"options": {"flat": "", "lob": ""}}}}},
    "practice": {"players": {"even": {"about": "No clear habit."}}},
}
ONLY = lambda option, version: {  # noqa: E731
    "version": version,
    "npcs": {"opponent": {"decisions": {"shot_type": {"flat": {"base": 0}, "lob": {"base": 0}, option: {"base": 1}}}, "rules": []}},
}


async def test_client_flow():
    got: list[dict] = []
    step = asyncio.Event()

    async def server(ws):
        async for raw in ws:
            msg = json.loads(raw)
            got.append(msg)
            if msg["type"] == "setup":
                await ws.send(json.dumps({"type": "practice_run", "match_id": "m_test", "run_id": "p_1",
                                          "player": {"name": "lefty", "about": "", "plays": {}},
                                          "rounds": 3, "behaviour": ONLY("lob", 0)}))
            elif msg["type"] == "practice_result":
                await ws.send(json.dumps({"type": "ready", "match_id": "m_test",
                                          "values": {"comes_to_net": {"label": "Comes to the net"}},
                                          "behaviour": ONLY("flat", 1)}))
            elif msg["type"] == "event":
                await ws.send(json.dumps({"type": "player_read", "match_id": "m_test", "values": {"comes_to_net": 0.4}}))
                await ws.send(json.dumps({"type": "strategy_update", "match_id": "m_test", "version": 2,
                                          "settings": {"speed": "fast"}, "behaviour": ONLY("lob", 2)}))
                step.set()

    async with websockets.serve(server, "127.0.0.1", 0) as srv:
        port = srv.sockets[0].getsockname()[1]
        client = Client(SETUP, url=f"ws://127.0.0.1:{port}/ws",
                        on_practice_run=lambda run: {"wins": {"player": 1, "opponent": 2}})
        assert await client.connect(ready_timeout=5)
        assert client.labels == {"comes_to_net": "Comes to the net"}
        result = next(m for m in got if m["type"] == "practice_result")
        assert result["player"] == "lefty" and result["run_id"] == "p_1" and result["wins"]["opponent"] == 2

        assert client.start_round() == {}
        assert client.pick("opponent", "shot_type", ["flat", "lob"]) == ("flat", False)
        await client.event("shot", round=1, by="player", data={"side": "forehand"})
        await asyncio.wait_for(step.wait(), 5)
        await asyncio.sleep(0.05)

        # The new behaviour waits for the gap between rounds.
        assert client.values == {"comes_to_net": 0.4}
        assert client.pending and client.pick("opponent", "shot_type", ["flat", "lob"]) == ("flat", False)
        await client.round_end(round=1, winner="player", how="winner", score={"player": 1, "opponent": 0})
        assert client.start_round() == {"speed": "fast"}
        assert client.pick("opponent", "shot_type", ["flat", "lob"]) == ("lob", False)
        await client.close()

    assert [m["type"] for m in got] == ["setup", "practice_result", "event", "round_end"]
    assert all(m["match_id"] == "m_test" for m in got)
