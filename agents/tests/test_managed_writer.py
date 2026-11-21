"""Managed agent writer tests with no network.

The Managed Agents API is replaced by a fake sandbox here only. The fake
runs the real evaluator on the candidates it is given, so the checks the
writer makes on a proposal are the real ones.
"""
from __future__ import annotations

import asyncio
import copy
import io
import json
from pathlib import Path
from typing import Any

import pytest

from adaptive_npc.pick import pick
from server import managed_writer
from server.managed_client import ManagedError, paths
from server.managed_writer import FILES, ManagedAgentWriter, _load, evaluator, sandbox_sources, score_here, steps_of, task_text

# ------------------------------------------------------------------ tennis facts, built by hand

# The game's own setup is read from the example at test time, so its names are never copied here.
SETUP: dict[str, Any] = json.loads((Path(__file__).resolve().parent.parent / "examples" / "tennis" / "setup.json").read_text())
DEFAULT_BEHAVIOUR: dict[str, Any] = SETUP["default_behaviour"]

PERSONAS = [
    {"name": "forehand_lover", "about": "Leans on the forehand and goes cross-court.",
     "plays": {"shot": {"side": {"forehand": 0.8, "backhand": 0.2}, "lands": {"left_deep": 0.6, "middle_deep": 0.2, "right_deep": 0.2}}}},
    {"name": "net_rusher", "about": "Comes to the net early. Weak against lobs.",
     "plays": {"shot": {"side": {"forehand": 0.5, "backhand": 0.5}}}},
    {"name": "even", "about": "No clear habit.", "plays": {}},
]


def row(player: str, decision: str, option: str, npc_wins: int, rounds: int = 20) -> dict[str, Any]:
    return {"player": player, "npc": "opponent", "decision": decision, "option": option,
            "rounds": rounds, "npc_wins": npc_wins, "stats": {}}


# The first behaviour loses to all three. Waiting on the left clearly beats it
# against the forehand lover, and the lob clearly beats it against the net rusher.
MATCHUPS = [
    row("forehand_lover", "", "baseline", 5),
    row("net_rusher", "", "baseline", 6),
    row("even", "", "baseline", 8),
    row("forehand_lover", "position", "left_deep", 13),
    row("forehand_lover", "position", "middle_deep", 5),
    row("forehand_lover", "position", "right_deep", 2),
    row("forehand_lover", "shot_type", "lob", 6),
    row("forehand_lover", "aim", "right_deep", 8),
    row("net_rusher", "shot_type", "lob", 14),
    row("net_rusher", "shot_type", "dropshot", 3),
    row("net_rusher", "position", "left_deep", 6),
    row("even", "position", "left_deep", 7),
    row("even", "shot_type", "lob", 8),
]


def tennis_facts() -> dict[str, Any]:
    return {
        "setup": SETUP,
        "goal": SETUP["goal"],
        "behaviour": copy.deepcopy(DEFAULT_BEHAVIOUR),
        "values": {"like_forehand_lover": 0.8, "like_net_rusher": 0.1, "like_even": 0.1, "forehand_goes_cross_court": 0.9},
        "confidence": {"like_forehand_lover": 0.8, "like_net_rusher": 0.6, "like_even": 0.6, "forehand_goes_cross_court": 0.9},
        "value_about": {"like_forehand_lover": "Plays like the forehand lover.", "like_net_rusher": "Plays like the net rusher.",
                        "like_even": "Plays with no clear habit.", "forehand_goes_cross_court": "The forehand goes cross-court."},
        "measures": {"rounds": 2, "player_win_rate": 1.0, "habits": []},
        "recent_rounds": [],
        "personas": PERSONAS,
        "matchups": MATCHUPS,
        "counters": [{"npc": "opponent", "decision": "position", "option": "left_deep", "edge": 0.32,
                      "against": "forehand_lover", "likeness": 0.8}],
        "earlier": [],
        "max_candidates": None,
    }


def counter_behaviour(base: float = 0.6) -> dict[str, Any]:
    """The first behaviour, leaning towards waiting on the left."""
    behaviour = copy.deepcopy(DEFAULT_BEHAVIOUR)
    behaviour["version"] = 1
    position = behaviour["npcs"]["opponent"]["decisions"]["position"]
    position["left_deep"] = {"base": base, "when": {"forehand_goes_cross_court": 0.5}}
    position["middle_deep"] = {"base": 0.2}
    return behaviour


# ------------------------------------------------------------------ the evaluator

def test_evaluator_scores_the_counter_closer_to_a_half() -> None:
    facts = tennis_facts()
    before = score_here(facts["behaviour"], facts)
    after = score_here(counter_behaviour(), facts)
    assert before["ok"] and after["ok"]
    assert before["player_win_share"] > 0.65          # the first behaviour loses to this player
    assert after["player_win_share"] < before["player_win_share"]
    assert after["distance"] < before["distance"]
    assert set(after["by_persona"]) == {"forehand_lover", "net_rusher", "even"}
    assert after["by_persona"]["forehand_lover"]["likeness"] == 0.8


def test_evaluator_is_repeatable() -> None:
    facts = tennis_facts()
    assert score_here(counter_behaviour(), facts) == score_here(counter_behaviour(), facts)


def test_evaluator_names_what_is_wrong() -> None:
    facts = tennis_facts()
    bad = counter_behaviour()
    opponent = bad["npcs"]["opponent"]
    opponent["decisions"]["shot_type"]["smash"] = {"base": 1}
    opponent["rules"] = [{"if": [{"fact": "player_mood", "is": "sad"}], "do": {"shot_type": "lob"}}] * 5
    result = score_here(bad, facts)
    assert not result["ok"] and not result["passed"]
    text = " ".join(result["problems"])
    assert "smash" in text and "player_mood" in text and "5 rules" in text


def test_a_rule_that_fits_is_counted() -> None:
    facts = tennis_facts()
    ruled = counter_behaviour()
    ruled["npcs"]["opponent"]["rules"] = [
        {"if": [{"fact": "player_last_side", "is": "forehand"}], "do": {"position": "left_deep"}, "why": "7 of 9."}
    ]
    assert score_here(ruled, facts)["ruled_share"] > 0.1


def test_no_matchups_cannot_be_scored() -> None:
    facts = tennis_facts()
    facts["matchups"] = []
    assert not score_here(counter_behaviour(), facts)["ok"]


# ------------------------------------------------------------------ the guard and the audit

@pytest.fixture
def guard(tmp_path, monkeypatch):
    gate = _load("gate_under_test", FILES / "gate.py")
    audit = _load("audit_under_test", FILES / "audit.py")
    (tmp_path / "tests").mkdir()
    (tmp_path / "library").mkdir()
    monkeypatch.setattr(gate, "TESTS", str(tmp_path / "tests"))
    monkeypatch.setattr(gate, "LOG", str(tmp_path / "hook_log" / "gate.jsonl"))
    monkeypatch.setattr(audit, "TESTS", str(tmp_path / "tests"))
    monkeypatch.setattr(audit, "LIBRARY", str(tmp_path / "library"))
    monkeypatch.setattr(audit, "LOG", str(tmp_path / "hook_log" / "audit.jsonl"))
    return gate, audit, tmp_path


def run_gate(gate, monkeypatch, capsys, call: dict[str, Any]) -> dict[str, Any]:
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({"tool_call": call})))
    gate.main()
    return json.loads(capsys.readouterr().out)


def test_gate_blocks_an_untested_save_and_allows_a_tested_one(guard, monkeypatch, capsys) -> None:
    gate, _, folder = guard
    write = {"name": "write_file", "args": {"path": "workspace/library/r1_a.json"}}
    copy_in = {"name": "execute_code", "args": {"code": "cd /workspace && cp candidates/r1_a.json library/r1_a.json", "language": "bash"}}
    assert run_gate(gate, monkeypatch, capsys, write)["decision"] == "deny"
    assert run_gate(gate, monkeypatch, capsys, copy_in)["decision"] == "deny"

    (folder / "tests" / "r1_a.json").write_text(json.dumps({"passed": False}))
    assert run_gate(gate, monkeypatch, capsys, copy_in)["decision"] == "deny"

    (folder / "tests" / "r1_a.json").write_text(json.dumps({"passed": True}))
    assert run_gate(gate, monkeypatch, capsys, write)["decision"] == "allow"
    assert run_gate(gate, monkeypatch, capsys, copy_in)["decision"] == "allow"
    documented = {"name": "write_to_file", "args": {"TargetFile": "/workspace/library/r1_b.json"}}
    assert run_gate(gate, monkeypatch, capsys, documented)["decision"] == "deny"

    log = [json.loads(line) for line in (folder / "hook_log" / "gate.jsonl").read_text().splitlines()]
    assert len(log) == 6 and all(line["save"] for line in log)
    assert [line["decision"] for line in log].count("deny") == 4


def test_gate_leaves_ordinary_work_alone(guard, monkeypatch, capsys) -> None:
    gate, _, _ = guard
    allowed = [
        {"name": "write_file", "args": {"path": "workspace/candidates/r1_a.json"}},
        {"name": "execute_code", "args": {"code": "ls /workspace/library/ 2>/dev/null; cat /workspace/runs/r1/facts.json", "language": "bash"}},
        {"name": "execute_code", "args": {"language": "bash", "code":
            "cd /workspace && for n in r1_a r1_b; do python3 tools/evaluate.py candidates/$n.json --facts runs/r1/facts.json; done"}},
        {"name": "execute_code", "args": {"code": "python3 /workspace/tools/evaluate.py /workspace/library/r0_a.json --facts /workspace/runs/r1/facts.json", "language": "bash"}},
        {"name": "write_file", "args": {"path": "workspace/out/r1/proposal.json"}},
    ]
    for call in allowed:
        assert run_gate(gate, monkeypatch, capsys, call)["decision"] == "allow", call


def test_gate_protects_test_results_and_its_own_files(guard, monkeypatch, capsys) -> None:
    gate, _, _ = guard
    refused = [
        {"name": "write_file", "args": {"path": "workspace/tests/r1_a.json"}},
        {"name": "write_file", "args": {"path": ".agents/hooks-scripts/gate.py"}},
        {"name": "execute_code", "args": {"code": "echo '{\"passed\": true}' > /workspace/tests/r1_a.json", "language": "bash"}},
        {"name": "execute_code", "args": {"code": "cp /workspace/candidates/*.json /workspace/library/", "language": "bash"}},
    ]
    for call in refused:
        assert run_gate(gate, monkeypatch, capsys, call)["decision"] == "deny", call


def test_audit_flags_a_library_entry_that_is_not_the_tested_one(guard, monkeypatch) -> None:
    _, audit, folder = guard
    tested, changed = counter_behaviour(0.6), counter_behaviour(0.9)
    (folder / "library" / "r1_a.json").write_text(json.dumps(tested))
    (folder / "library" / "r1_b.json").write_text(json.dumps(changed))
    (folder / "library" / "r1_c.json").write_text(json.dumps(tested))
    result = {"passed": True, "fingerprint": evaluator().fingerprint(tested)}
    (folder / "tests" / "r1_a.json").write_text(json.dumps(result))
    (folder / "tests" / "r1_b.json").write_text(json.dumps(result))
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({"tool_call": {"name": "execute_code", "args": {"code": "ls"}}})))
    audit.main()
    line = json.loads((folder / "hook_log" / "audit.jsonl").read_text().splitlines()[-1])
    assert line["library"] == {"r1_a": "tested", "r1_b": "changed", "r1_c": "untested"}
    assert line["flagged"] == ["r1_b", "r1_c"]


# ------------------------------------------------------------------ the writer, against a fake sandbox

class FakeSandbox:
    """Stands in for the Managed Agents API. Test use only.

    When a run starts it plays the part of the agent: it writes the given
    candidates, scores them with the real evaluator, logs the guard's
    decisions and saves a proposal. `flaw` makes it misbehave on purpose.
    """

    def __init__(self, candidates: list[dict[str, Any]], flaw: str = "") -> None:
        self.candidates = candidates
        self.flaw = flaw
        self.store: dict[str, str] = {}
        self.started: list[dict[str, Any]] = []
        self.uploads: list[str] = []
        self.polls = 0

    async def start(self, task: str, *, model: str, max_total_tokens: int, sources=None, environment_id=None) -> dict[str, Any]:
        if self.flaw == "no_credit":
            raise ManagedError("The API credit has run out (HTTP 402).", 402)
        self.started.append({"task": task, "model": model, "max_total_tokens": max_total_tokens,
                             "sources": sources, "environment_id": environment_id})
        for item in sources or []:
            self.store[item["target"].lstrip("/")] = item["content"]
        if "Run id:" in task:
            self._play(task.split("Run id: ")[1].split()[0])
        return {"id": f"run_{len(self.started)}", "status": "in_progress", "environment_id": environment_id or "env_1"}

    def _play(self, run_id: str) -> None:
        facts = json.loads(self.store[f"workspace/runs/{run_id}/facts.json"])
        scored, gate = [], []
        for index, behaviour in enumerate(self.candidates):
            name = f"{run_id}_{chr(ord('a') + index)}"
            result = {"name": name, **evaluator().score(behaviour, facts, pick)}
            self.store[f"workspace/candidates/{name}.json"] = json.dumps(behaviour)
            self.store[f"workspace/tests/{name}.json"] = json.dumps(result)
            self.store["workspace/tests/history.jsonl"] = self.store.get("workspace/tests/history.jsonl", "") + json.dumps(
                {"name": name, "run": run_id, **{key: result.get(key) for key in ("passed", "player_win_share", "distance")}}) + "\n"
            gate.append({"tool": "execute_code", "save": True, "decision": "allow" if result["passed"] else "deny",
                         "reason": None if result["passed"] else f"library/{name}.json blocked: no passing test."})
            if result["passed"]:
                self.store[f"workspace/library/{name}.json"] = json.dumps(behaviour)
                scored.append((result["distance"], name, behaviour))
        self.store["workspace/hook_log/gate.jsonl"] = "\n".join(json.dumps(line) for line in gate)
        self.store["workspace/hook_log/audit.jsonl"] = json.dumps({"library": {name: "tested" for _, name, _ in scored}})
        if self.flaw in ("silent", "slow") or not scored:
            return
        _, kept, behaviour = min(scored, key=lambda item: item[0])
        if self.flaw == "untested":
            behaviour = counter_behaviour(0.99)
        self.store[f"workspace/out/{run_id}/proposal.json"] = json.dumps({
            "behaviour": behaviour,
            "observations": ["You hit 8 of 10 forehands cross-court."],
            "plan": ["I will wait on the left, where 8 of your 10 forehands land."],
            "changes": [{"where": "opponent.position.left_deep", "from": {"base": 0.1}, "to": {"base": 0.6},
                         "why": "It won 13 of 20 practice rounds, up from 5.", "expect": "You win about half."}],
            "tested": {"kept": kept, "candidates": [{"name": kept, "idea": "Wait on the left.", "verdict": "Kept: closest."}]},
        })

    async def get(self, run_id: str) -> dict[str, Any]:
        self.polls += 1
        done = self.polls >= 2 and self.flaw != "slow"
        return {"id": run_id, "status": "completed" if done else "in_progress",
                "usage": {"total_tokens": "1234"} if done else {}}

    async def files(self, environment_id: str, folder: str = "workspace") -> list[str]:
        await asyncio.sleep(0.01)   # a real listing takes a moment, which lets the event stream speak first
        return [path for path in self.store if path.startswith(folder)]

    async def read(self, environment_id: str, path: str) -> str | None:
        return self.store.get(path.lstrip("/"))

    async def upload(self, environment_id: str, path: str, content: str) -> None:
        self.uploads.append(path)
        self.store[path.lstrip("/")] = content

    async def events(self, run_id: str, last_event_id=None):
        yield thought("**Reading the player**\n\nYou lean on one side in 8 of 10 rounds. More follows.")


def thought(text: str) -> dict[str, Any]:
    return {"event": "step.delta", "id": "", "data": {"index": 1, "delta": {"content": {"text": text}}}}


def started(step: dict[str, Any]) -> dict[str, Any]:
    return {"event": "step.start", "id": "", "data": {"index": 1, "step": step}}


def fake(candidates: list[dict[str, Any]], flaw: str = "") -> Any:
    return FakeSandbox(candidates, flaw)


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setattr(managed_writer, "_ENVIRONMENTS", {})
    monkeypatch.setattr(managed_writer, "POLL_SECONDS", 0.01)


def collect() -> tuple[list[dict[str, Any]], Any]:
    seen: list[dict[str, Any]] = []
    return seen, seen.append


def test_names_follow_the_tiers() -> None:
    assert ManagedAgentWriter(1, client=object()).name == "deep"
    assert ManagedAgentWriter(4, client=object()).name == "deepest"


def test_sandbox_gets_the_tools_the_guard_and_the_game() -> None:
    sources = {item["target"]: item["content"] for item in sandbox_sources(SETUP)}
    assert "def pick(" in sources["/workspace/tools/pick.py"]
    assert "def score(" in sources["/workspace/tools/evaluate.py"]
    assert "pre_tool_execution" in sources[".agents/hooks.json"]
    assert "`opponent`" in sources[".agents/AGENTS.md"] and "`player_position`" in sources[".agents/AGENTS.md"]
    assert "name: playtest" in sources[".agents/skills/playtest/SKILL.md"]
    assert not any("GEMINI_API_KEY" in content for content in sources.values())
    task = task_text("r1", 3, 2)
    assert "r1_a, r1_b, r1_c" in task and "/workspace/out/r1/proposal.json" in task


async def test_write_returns_a_tested_proposal() -> None:
    sandbox = fake([counter_behaviour(0.6), counter_behaviour(0.3), DEFAULT_BEHAVIOUR])
    writer = ManagedAgentWriter(3, client=sandbox, model="test-model")
    seen, trace = collect()
    proposal = await writer.write(tennis_facts(), 5, trace)
    await writer.settle()

    assert proposal is not None
    tested = proposal["tested"]
    assert proposal["behaviour"]["version"] == 1
    assert len(tested["candidates"]) == 3
    assert tested["kept"] == tested["candidates"][0]["name"] and tested["kept_is_closest"]
    assert tested["rescored_here"]["matches_sandbox"]
    assert tested["current"]["distance"] > tested["kept_distance"]
    assert tested["guard"]["saves_approved"] + tested["guard"]["saves_blocked"] == 3
    assert tested["guard"]["library_size"] == tested["guard"]["saves_approved"]

    statuses = [message["status"] for message in seen]
    assert statuses[0] == "start" and "done" in statuses and "error" not in statuses
    kinds = {message["data"]["kind"] for message in seen if message["status"] == "step"}
    assert {"writing", "testing", "approved", "thought"} <= kinds
    assert "settings" not in proposal and tested["tests_run"] == 3
    assert all(message["stage"] == "adapter" and message["model"] == "test-model" for message in seen)
    done = [message for message in seen if message["status"] == "done"]
    assert "ms" in done[0] and writer.history[-1]["tokens"] == {"total_tokens": 1234}
    assert sandbox.started[0]["max_total_tokens"] > 0
    assert "GEMINI_API_KEY" not in json.dumps(sandbox.started)


async def test_the_sandbox_is_reused_and_only_the_facts_are_sent_again() -> None:
    sandbox = fake([counter_behaviour()])
    writer = ManagedAgentWriter(1, client=sandbox)
    assert await writer.prepare(SETUP) == "env_1"
    assert await writer.write(tennis_facts(), 5, lambda message: None) is not None
    assert await writer.write(tennis_facts(), 5, lambda message: None) is not None
    runs = [start for start in sandbox.started if "Run id:" in start["task"]]
    assert [run["environment_id"] for run in runs] == ["env_1", "env_1"]
    assert all(run["sources"] is None for run in runs)
    assert len(sandbox.uploads) == 2 and all(path.endswith("facts.json") for path in sandbox.uploads)


async def test_split_runs_use_separate_sandboxes_and_keep_the_best() -> None:
    sandbox = fake([counter_behaviour(0.6), counter_behaviour(0.2)])
    writer = ManagedAgentWriter(4, runs=2, client=sandbox)
    proposal = await writer.write(tennis_facts(), 5, lambda message: None)
    assert proposal is not None
    assert len(proposal["tested"]["runs"]) == 2
    assert proposal["tested"]["tests_run"] == 4 and len(proposal["tested"]["attempts"]) == 4
    assert len(managed_writer._ENVIRONMENTS) == 2


@pytest.mark.parametrize("flaw, word", [
    ("untested", "no passing test"),
    ("silent", "no proposal"),
    ("slow", "time ran out"),
    ("no_credit", "402"),
])
async def test_write_never_raises_and_says_why(flaw: str, word: str) -> None:
    sandbox = fake([counter_behaviour()], flaw)
    seen, trace = collect()
    proposal = await ManagedAgentWriter(1, client=sandbox).write(tennis_facts(), 0.2, trace)
    assert proposal is None
    errors = [message["about"] for message in seen if message["status"] == "error"]
    assert errors and word in errors[-1]


async def test_no_matchups_means_no_run() -> None:
    sandbox = fake([counter_behaviour()])
    facts = tennis_facts()
    facts["matchups"] = []
    seen, trace = collect()
    assert await ManagedAgentWriter(1, client=sandbox).write(facts, 5, trace) is None
    assert not sandbox.started and seen[-1]["status"] == "error"


def test_file_list_replies_are_read_whatever_their_shape() -> None:
    listing = {"files": [{"name": "workspace/tests/r1_a.json", "type": "FILE", "size_bytes": "12"},
                         {"name": "workspace/tests", "type": "DIRECTORY"},
                         {"path": "workspace/out/r1/proposal.json"}]}
    assert paths(listing) == ["workspace/tests/r1_a.json", "workspace/out/r1/proposal.json"]


def test_stream_events_become_plain_steps() -> None:
    state: dict[str, Any] = {}
    result = {"name": "r1_a", "passed": True, "player_win_share": 0.52, "fingerprint": "abc"}
    events = [
        thought("**Reading the player**\n\nYou lean on `one side` in 8 of 10 rounds. More follows."),
        started({"type": "function_call", "name": "write_to_file", "arguments": {"TargetFile": "/workspace/candidates/r1_a.json", "CodeContent": "{}"}}),
        started({"type": "function_result", "name": "write_to_file", "is_error": False, "result": "Created file"}),
        started({"type": "code_execution_call", "arguments": {"language": "bash", "code": "python3 tools/evaluate.py candidates/r1_a.json"}}),
        started({"type": "code_execution_result", "is_error": False, "result": "[STDOUT]\n" + json.dumps(result)}),
        started({"type": "code_execution_call", "arguments": {"language": "bash", "code": "cp candidates/r1_b.json library/r1_b.json"}}),
        started({"type": "code_execution_result", "is_error": True,
                 "result": "generic::permission_denied: Blocked by hook: library/r1_b.json blocked: no passing test."}),
        started({"type": "code_execution_call", "arguments": {"language": "bash", "code": "cp candidates/r1_a.json library/r1_a.json"}}),
        started({"type": "code_execution_result", "is_error": False, "result": ""}),
        started({"type": "function_call", "name": "write_to_file", "arguments": {"TargetFile": "/workspace/out/r1/proposal.json"}}),
        started({"type": "function_result", "name": "write_to_file", "is_error": False, "result": "Created file"}),
    ]
    steps = [step for event in events for step in steps_of(event, "r1", state)]
    assert [kind for kind, _, _ in steps] == ["thought", "writing", "testing", "blocked", "approved", "writing"]
    assert steps[0][1] == "You lean on one side in 8 of 10 rounds."
    assert "52%" in steps[2][1] and "no passing test" in steps[3][1] and "r1_a" in steps[4][1]
    assert state.get("answer_saved") is True


async def test_a_lost_sandbox_is_replaced_by_a_new_one() -> None:
    sandbox = fake([counter_behaviour()])
    managed_writer._ENVIRONMENTS[("tennis", 0)] = "env_gone"

    async def refuse(environment_id: str, path: str, content: str) -> None:
        raise ManagedError("Uploading failed: NotFound.")

    sandbox.upload = refuse
    writer = ManagedAgentWriter(1, client=sandbox)
    assert await writer.write(tennis_facts(), 5, lambda message: None) is not None
    assert managed_writer._ENVIRONMENTS[("tennis", 0)] == "env_1"
    assert sandbox.started[0]["sources"] is not None
