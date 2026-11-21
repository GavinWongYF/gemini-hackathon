"""The shared `pick` cases in sdk/test-vectors.json, run against the Python SDK."""
from __future__ import annotations

import json
import random
from pathlib import Path

import pytest

from adaptive_npc import pick

VECTORS = json.loads((Path(__file__).resolve().parents[1] / "sdk" / "test-vectors.json").read_text())
CASES = VECTORS["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_vector(case):
    expect = case["expect"]
    # The answer must not depend on chance, so try many seeds.
    for seed in range(25):
        option, by_rule = pick(
            case["npc"],
            case["decision"],
            case["legal"],
            case["behaviour"],
            case["values"],
            case["facts"],
            rng=random.Random(seed),
        )
        if "option" in expect:
            assert option == expect["option"], f"seed {seed}"
        else:
            assert option in expect["one_of"], f"seed {seed}"
        assert by_rule is expect["by_rule"], f"seed {seed}"


def test_vectors_cover_each_kind_of_condition():
    seen = set()
    for case in CASES:
        for npc in case["behaviour"].get("npcs", {}).values():
            for rule in npc.get("rules", []):
                for cond in rule["if"]:
                    seen.update(k for k in ("is", "in", "above", "below") if k in cond)
                    seen.update(k for k in ("fact", "value") if k in cond)
    assert seen == {"is", "in", "above", "below", "fact", "value"}
