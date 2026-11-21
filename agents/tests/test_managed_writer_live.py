"""One real managed agent run on the tennis test facts.

It costs money and can create a sandbox, so it runs only when asked:

    NPC_MANAGED_LIVE=1 ./.venv/bin/python -m pytest tests/test_managed_writer_live.py -q -s

NPC_MANAGED_ENVIRONMENTS="tennis=<environment id>" reuses a sandbox that exists.
NPC_MANAGED_LIVE_CANDIDATES sets how many rule sets the agent tries (1 if unset).
"""
from __future__ import annotations

import json
import os
import time
from typing import Any

import pytest

from server.managed_writer import ManagedAgentWriter
from test_managed_writer import tennis_facts

pytestmark = pytest.mark.skipif(
    not (os.environ.get("GEMINI_API_KEY") and os.environ.get("NPC_MANAGED_LIVE") == "1"),
    reason="needs GEMINI_API_KEY and NPC_MANAGED_LIVE=1",
)


async def test_a_real_run_returns_a_proposal_it_tested() -> None:
    count = int(os.environ.get("NPC_MANAGED_LIVE_CANDIDATES", "1"))
    writer = ManagedAgentWriter(count)
    started = time.monotonic()
    seen: list[dict[str, Any]] = []

    def trace(message: dict[str, Any]) -> None:
        seen.append(message)
        print(f"{time.monotonic() - started:6.1f}s  {message['status']:5}  {message['about']}")

    proposal = await writer.write(tennis_facts(), 240, trace)
    seconds = time.monotonic() - started
    await writer.settle()
    await writer.client.close()

    assert proposal is not None, [message["about"] for message in seen if message["status"] == "error"]
    tested = proposal["tested"]
    record = writer.history[-1]
    print(f"\nproposal after {seconds:.1f}s on {writer.model}, {record.get('tokens', {}).get('total_tokens')} tokens, "
          f"sandbox {record.get('environment')}")
    print("observations:", json.dumps(proposal["observations"]))
    print("plan:", json.dumps(proposal["plan"]))
    print("tests:", json.dumps(tested["attempts"]))
    print("kept:", tested["kept"], tested["kept_share"], "current rules:", tested["current"]["player_win_share"])
    print("guard:", json.dumps(tested["guard"]))

    assert tested["tests_run"] >= 1 and tested["candidates"]
    assert tested["rescored_here"]["matches_sandbox"]        # the sandbox's score was reproduced here
    assert tested["guard"]["saves_approved"] >= 1 and not tested["guard"]["flagged"]
    assert "settings" not in proposal
    assert any(message["status"] == "step" for message in seen)
