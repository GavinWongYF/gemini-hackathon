"""The session's hookups for the designer and the adapter, against fake parts. No network."""
from __future__ import annotations

import asyncio
from typing import Any

from fakes import Client, FakeAdapter, FakeDesigner, FakeWatcher, fast_settings, running, tennis_setup

from server.app import create_app
from server.contract import check_message
from server.interfaces import Design, ValueSpec
from server.session import baseline_behaviour
from server.store import load_design


def build(tmp_path, designer, adapter, **settings: Any):
    return create_app(FakeWatcher(), designer, adapter, real_parts=False, data_dir=tmp_path, settings=fast_settings(**settings))


class TwoStepDesigner(FakeDesigner):
    """A designer that can hand over a design built in code at once, and a fuller one later."""

    def __init__(self, delay: float = 0.0, later: bool = False) -> None:
        super().__init__(delay=delay)
        self.later = later
        self.finished = 0

    def quick(self, setup):
        return Design(values=[ValueSpec("built_in_code", "Built in code", {})], behaviour=baseline_behaviour(setup))

    async def finish(self, setup, playtest, trace):
        self.finished += 1
        if not self.later:
            return None
        await asyncio.sleep(0.1)
        design = await FakeDesigner().design(setup, None, trace)
        design.values.append(ValueSpec("answered_late", "Came from the late answer", {}))
        return design


class PreparingAdapter(FakeAdapter):
    def __init__(self) -> None:
        super().__init__()
        self.prepared: list[str] = []

    def prepare(self, setup, trace) -> None:
        self.prepared.append(setup["match_id"])


async def test_ready_carries_the_code_built_questions_while_the_design_is_on_its_way(tmp_path):
    designer = TwoStepDesigner(delay=0.5)
    setup = tennis_setup()
    async with running(build(tmp_path, designer, FakeAdapter(), ready_wait=0.1)) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(setup)
            ready = await game.until("ready", timeout=0.4)
            assert ready["values"] == {"built_in_code": {"label": "Built in code", "kind": "share"}}
            assert ready["behaviour"] == setup["default_behaviour"]
            update = await game.until("strategy_update")                  # the full design follows
            assert set(update["new_values"]) == {"side_forehand", "side_backhand"}
            assert check_message(setup, update) == []
            await game.drain(0.2)
    assert designer.finished == 1


async def test_a_design_that_finishes_after_ready_is_stored_and_delivered(tmp_path):
    designer = TwoStepDesigner(later=True)
    setup = tennis_setup()
    async with running(build(tmp_path, designer, FakeAdapter())) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(setup)
            ready = await game.until("ready")
            assert "answered_late" not in ready["values"]
            update = await game.until("strategy_update")
            assert "answered_late" in update["new_values"] and check_message(setup, update) == []
    stored = load_design(tmp_path / "designs", setup)                     # the next match starts with it
    assert stored is not None and "answered_late" in [value.name for value in stored.values]


async def test_the_adapter_hears_about_a_live_game_at_setup(tmp_path):
    adapter = PreparingAdapter()
    async with running(build(tmp_path, FakeDesigner(), adapter)) as host:
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup(match_id="m_live"))
            await game.until("ready")
        async with Client(f"ws://{host}/ws") as game:
            await game.send(tennis_setup(match_id="m_practice", mode="practice"))
            await game.until("ready")
    assert adapter.prepared == ["m_live"]                                 # a practice session adapts nothing
