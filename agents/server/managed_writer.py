"""The deepest rule writer: a managed agent that tests its rule sets before it answers.

A game that can wait a minute or more gets this writer. It hands the match
facts to a Gemini managed agent in a sandbox. The agent writes candidate
rule sets, scores each one with `sandbox_files/evaluate.py`, saves the ones
that pass into a library behind a guard, and hands back the one that lands
closest to the goal. This file starts the run, shows its progress, and then
checks the answer itself before passing it on:

- the kept rule set must be one the evaluator scored inside the sandbox,
- its score is worked out again here with the same evaluator,
- the guard's log says how many saves it let through and how many it refused.

The sandbox is made once for each game and reused, so its library of tested
rule sets grows from run to run.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import re
import secrets
import time
from pathlib import Path
from types import ModuleType
from typing import Any, Callable

from server import config, contract
from server.interfaces import Facts, Message, Proposal, Trace, trace_message
from server.managed_client import DONE, ManagedClient, ManagedError, source, tokens

HERE = Path(__file__).resolve().parent
FILES = HERE / "sandbox_files"
PICK_FILE = HERE.parent / "sdk" / "python" / "adaptive_npc" / "pick.py"

POLL_SECONDS = float(os.environ.get("NPC_MANAGED_POLL_SECONDS", "2.5"))
TOKENS_BASE = int(os.environ.get("NPC_MANAGED_TOKENS_BASE", "300000"))
TOKENS_EACH = int(os.environ.get("NPC_MANAGED_TOKENS_EACH", "100000"))
TARGET_SHARE = float(os.environ.get("NPC_TARGET_PLAYER_SHARE", "0.5"))
GUARD_CHECK = os.environ.get("NPC_MANAGED_GUARD_CHECK", "") == "1"
SCORE_TOLERANCE = 0.02

# One sandbox for each (game, slot), shared by every writer in this process.
# Slot 0 is the usual one. Slot 1 and up exist only when runs are split.
_ENVIRONMENTS: dict[tuple[str, int], str] = {}
ANY_GAME = ""

# Sandboxes made earlier can be named here so a restarted server keeps their
# libraries: NPC_MANAGED_ENVIRONMENTS="<game>=<environment id>,<game>=<environment id>".
for _pair in os.environ.get("NPC_MANAGED_ENVIRONMENTS", "").split(","):
    _game, _, _environment = _pair.strip().partition("=")
    if _game and _environment:
        _ENVIRONMENTS[(_game, 0)] = _environment

SPLIT_HINTS = [
    "Lean on the strongest rows in `counters`: use rules for the clear-cut cases.",
    "Prefer gentle changes: shift weights before adding rules, and leave one habit alone.",
    "Look for a counter the other writers will miss: an option that helps against two kinds of player.",
]


def _load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {path}.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def evaluator() -> ModuleType:
    """The same evaluator the sandbox runs, loaded from its file."""
    return _load("npc_sandbox_evaluate", FILES / "evaluate.py")


def score_here(behaviour: Any, facts: Facts) -> dict[str, Any]:
    """Score a behaviour on this machine with the sandbox's evaluator and the game's own `pick`."""
    return evaluator().score(behaviour, facts, _load("npc_sdk_pick", PICK_FILE).pick)


def game_notes(setup: Message) -> str:
    """The part of the sandbox instructions that describes one game."""
    lines = ["## The game", "", f"Name: {setup.get('game', 'unnamed')}", f"About: {setup.get('about', '')}",
             f"Goal: {setup.get('goal', '')}", "", "NPCs, their decisions and the options of each:"]
    for npc, entry in (setup.get("npcs") or {}).items():
        lines.append(f"- `{npc}`: {(entry or {}).get('about', '')}")
        for decision, spec in ((entry or {}).get("decisions") or {}).items():
            options = ", ".join(f"`{name}`" for name in (spec or {}).get("options") or [])
            lines.append(f"  - `{decision}` ({(spec or {}).get('when', '')}): {options}")
    lines += ["", "Facts an NPC can see when it chooses:"]
    for fact, spec in (setup.get("facts") or {}).items():
        names = contract._allowed_names(setup, spec)
        kind = "one of " + ", ".join(f"`{name}`" for name in names) if names else json.dumps(spec)
        lines.append(f"- `{fact}`: {kind}")
    return "\n".join(lines) + "\n"


def sandbox_sources(setup: Message) -> list[dict[str, str]]:
    """Every file a new sandbox starts with. `pick.py` is read from the SDK, so there is one copy."""
    read = lambda name: (FILES / name).read_text()  # noqa: E731
    return [
        source(".agents/AGENTS.md", read("instructions.md") + "\n" + game_notes(setup)),
        source(".agents/skills/playtest/SKILL.md", read("playtest_skill.md")),
        source(".agents/hooks.json", read("hooks.json")),
        source(".agents/hooks-scripts/gate.py", read("gate.py")),
        source(".agents/hooks-scripts/audit.py", read("audit.py")),
        source("/workspace/tools/evaluate.py", read("evaluate.py")),
        source("/workspace/tools/pick.py", PICK_FILE.read_text()),
        source("/workspace/library/README.md", "Rule sets that passed their test. One file for each.\n"),
    ]


def task_text(run_id: str, count: int, version: int, hint: str = "", guard_check: bool = False) -> str:
    """What one run is asked to do."""
    names = ", ".join(f"{run_id}_{chr(ord('a') + index)}" for index in range(count))
    lines = [
        f"Run id: {run_id}",
        f"Facts: /workspace/runs/{run_id}/facts.json",
        f"Write {count} candidate rule set{'s' if count != 1 else ''}, named {names}, as "
        f"/workspace/candidates/<name>.json. Each is a whole behaviour with \"version\": {version}.",
        "Test every one with the playtest skill, copy the ones that pass into /workspace/library/, "
        f"and save your answer as /workspace/out/{run_id}/proposal.json in the proposal shape from your instructions.",
        "Keep the candidate whose tested player_win_share is closest to the target. "
        "List every candidate in `tested.candidates` with its numbers and one line on why it won or lost.",
        "Use as few steps as you can. Stop as soon as the proposal is saved.",
    ]
    if hint:
        lines.insert(3, f"Your angle for this run: {hint}")
    if guard_check:
        lines.insert(3, (
            f"First, check that the guard is on: before testing anything, try once to copy "
            f"/workspace/candidates/{run_id}_a.json into /workspace/library/. It should be refused. "
            "Then carry on as usual."
        ))
    return "\n".join(lines)


def _say(trace: Trace, message: Message) -> None:
    """Send one trace line. A broken viewer must never break the writer."""
    try:
        trace(message)
    except Exception:
        pass


def _json(text: str | None) -> Any:
    try:
        return json.loads(text) if text else None
    except ValueError:
        return None


def _lines(text: str | None) -> list[dict[str, Any]]:
    """The lines of a .jsonl file, skipping any that do not parse."""
    found = [_json(line) for line in (text or "").splitlines() if line.strip()]
    return [line for line in found if isinstance(line, dict)]


def _percent(share: Any) -> str:
    return f"{float(share):.0%}" if isinstance(share, (int, float)) else "an unknown share"


class ManagedAgentWriter:
    """Implements `interfaces.RuleWriter` with a managed agent run.

    candidates: how many rule sets the agent writes and tests before it keeps one.
    runs:       1 for a single run. 2 or more splits the candidates across that
                many runs side by side, each in its own sandbox, and keeps the best.
    """

    def __init__(self, candidates: int = 1, runs: int = 1, client: ManagedClient | None = None,
                 model: str | None = None, guard_check: bool | None = None) -> None:
        self.candidates = max(1, int(candidates))
        self.runs = max(1, int(runs))
        self.name = "deep" if self.candidates == 1 else "deepest"
        self.model = model or config.MANAGED_AGENT_MODEL
        self.guard_check = GUARD_CHECK if guard_check is None else guard_check
        self.client = client or ManagedClient()
        self.history: list[dict[str, Any]] = []            # one record for each run, newest last
        self.on_event: Callable[[dict[str, Any]], None] | None = None   # sees every raw stream event
        self._tails: set[asyncio.Task[None]] = set()

    # ------------------------------------------------------------ the sandbox

    async def prepare(self, setup: Message | None = None, trace: Trace = lambda message: None, slot: int = 0) -> str | None:
        """Make the sandbox for a game once, before any match needs it.

        Returns the environment id, or None if it could not be made. Later
        runs for the same game reuse it, with its library of tested rule sets.
        """
        setup = setup or {}
        key = (str(setup.get("game") or ANY_GAME), slot)   # with no setup, the sandbox serves any game
        if key in _ENVIRONMENTS:
            return _ENVIRONMENTS[key]
        started = time.monotonic()
        try:
            run = await self.client.start(
                "Reply with the single word ready. Do nothing else.",
                model=self.model, max_total_tokens=50_000, sources=sandbox_sources(setup),
            )
            environment = run.get("environment_id")
            while run.get("status") not in DONE and time.monotonic() - started < 90:
                await asyncio.sleep(POLL_SECONDS)
                run = await self.client.get(run["id"])
            if not environment:
                raise ManagedError("The reply named no environment.")
        except Exception as error:
            _say(trace, trace_message("adapter", "error", f"Could not prepare a sandbox: {error}", model=self.model))
            return None
        _ENVIRONMENTS[key] = environment
        seconds = time.monotonic() - started
        self.history.append({"kind": "prepare", "environment": environment, "interaction": run.get("id"),
                             "seconds": round(seconds, 1), "status": run.get("status"), "tokens": tokens(run)})
        _say(trace, trace_message(
            "adapter", "done", f"A sandbox for {key[0] or 'any game'} is ready, with the evaluator, the guard and an empty library.",
            model=self.model, ms=seconds * 1000, data={"environment": environment},
        ))
        return environment

    # ------------------------------------------------------------ the writer

    async def write(self, facts: Facts, budget_seconds: float, trace: Trace) -> Proposal | None:
        """Return a tested proposal inside the budget, or None to keep the current rules. Never raises."""
        started = time.monotonic()
        try:
            return await self._write(facts, started + budget_seconds, trace, started)
        except Exception as error:
            about = str(error) if isinstance(error, ManagedError) else f"{type(error).__name__}: {error}"
            _say(trace, trace_message("adapter", "error", f"The managed agent writer failed. {about}"[:300],
                                      model=self.model, ms=(time.monotonic() - started) * 1000))
            return None

    async def _write(self, facts: Facts, deadline: float, trace: Trace, started: float) -> Proposal | None:
        if not facts.get("matchups"):
            _say(trace, trace_message("adapter", "error",
                                      "No matchup table to test rule sets against, so the managed agent was not started."))
            return None
        cap = facts.get("max_candidates")
        count = min(self.candidates, int(cap)) if isinstance(cap, (int, float)) and cap >= 1 else self.candidates
        shares = [count]
        if self.runs > 1 and count > 1:
            parts = min(self.runs, count)
            shares = [count // parts + (1 if index < count % parts else 0) for index in range(parts)]
        hints = SPLIT_HINTS if len(shares) > 1 else [""]
        results = await asyncio.gather(*(
            self._one_run(facts, share, deadline, trace, slot, hints[slot % len(hints)])
            for slot, share in enumerate(shares)
        ), return_exceptions=True)
        good = [result for result in results if isinstance(result, dict)]
        for result in results:
            if isinstance(result, Exception):
                _say(trace, trace_message("adapter", "error", f"One managed agent run failed. {result}"[:300], model=self.model))
        if not good:
            return None
        best = min(good, key=lambda proposal: proposal["tested"]["kept_distance"])
        if len(good) > 1:
            others = [candidate for proposal in good if proposal is not best
                      for candidate in proposal["tested"]["candidates"]]
            best["tested"]["candidates"] += others
            best["tested"]["attempts"] = [attempt for proposal in good for attempt in proposal["tested"]["attempts"]]
            best["tested"]["tests_run"] = sum(proposal["tested"]["tests_run"] for proposal in good)
            best["tested"]["runs"] = [proposal["tested"]["run"] for proposal in good]
            _say(trace, trace_message(
                "adapter", "done",
                f"{len(good)} runs side by side tested {len(best['tested']['candidates'])} rule sets. "
                f"Kept {best['tested']['kept']}, {best['tested']['kept_distance']} from the target.",
                model=self.model, ms=(time.monotonic() - started) * 1000,
            ))
        return best

    async def _one_run(self, facts: Facts, count: int, deadline: float, trace: Trace, slot: int, hint: str) -> Proposal | None:
        """One managed agent run: start it, watch it, fetch and check its proposal."""
        started = time.monotonic()
        setup = facts.get("setup") or {}
        key = (str(setup.get("game") or "game"), slot)
        run_id = "r" + secrets.token_hex(3)
        version = int(((facts.get("behaviour") or {}).get("version") or 0)) + 1
        sent = {**facts, "run_id": run_id, "target_player_share": TARGET_SHARE}
        facts_path = f"workspace/runs/{run_id}/facts.json"
        task = task_text(run_id, count, version, hint, self.guard_check)
        budget = TOKENS_BASE + TOKENS_EACH * count
        record: dict[str, Any] = {"kind": "run", "run_id": run_id, "candidates": count, "model": self.model}
        self.history.append(record)

        environment = _ENVIRONMENTS.get(key) or _ENVIRONMENTS.get((ANY_GAME, slot))
        seen_gate = 0
        run: dict[str, Any] = {}
        if environment:
            # A sandbox that exists already: only the facts are new.
            began = time.monotonic()
            try:
                _, log = await asyncio.gather(
                    self.client.upload(environment, facts_path, json.dumps(sent)),
                    self.client.read(environment, "workspace/hook_log/gate.jsonl"),
                )
                record["upload_seconds"] = round(time.monotonic() - began, 1)
                seen_gate = len(_lines(log))   # the guard's log from earlier runs is not this run's
                run = await self.client.start(task, model=self.model, max_total_tokens=budget, environment_id=environment)
            except ManagedError as error:
                if error.status == 402:
                    raise
                # The sandbox may be gone. Forget it and make a new one below.
                _ENVIRONMENTS.pop(key, None)
                record["reuse_failed"] = str(error)[:200]
                environment, seen_gate = None, 0
        if not run:
            sources = sandbox_sources(setup) + [source("/" + facts_path, json.dumps(sent))]
            run = await self.client.start(task, model=self.model, max_total_tokens=budget, sources=sources)
            environment = run.get("environment_id") or ""
            if environment:
                _ENVIRONMENTS[key] = environment
        record.update({"interaction": run.get("id"), "environment": environment,
                       "start_seconds": round(time.monotonic() - started, 1)})
        _say(trace, trace_message(
            "adapter", "start",
            f"A managed agent is writing {count} rule set{'s' if count != 1 else ''} and testing "
            f"{'each' if count != 1 else 'it'} in its sandbox before it answers.",
            model=self.model, data={"run": run_id, "interaction": run.get("id"), "environment": environment, "candidates": count},
        ))

        said: set[tuple[Any, ...]] = set()   # steps already shown, so the stream and the polling never repeat each other
        wake = asyncio.Event()               # set by the stream when the answer is saved or the run ends
        follow = asyncio.create_task(self._follow(run["id"], run_id, trace, record, said, wake))
        try:
            proposal, status = await self._watch(run, run_id, environment, deadline, trace, seen_gate, said, wake, record)
        finally:
            follow.cancel()
        seconds = time.monotonic() - started
        record.update({"seconds": round(seconds, 1), "answer_seconds": round(seconds, 1), "status": status})
        if proposal is None:
            why = "The time ran out" if status not in DONE else f"The run ended ({status}) with no proposal"
            _say(trace, trace_message("adapter", "error", f"{why} after {seconds:.0f} seconds. The current rules stay.",
                                      model=self.model, ms=seconds * 1000, data={"run": run_id}))
            self._tail(run["id"], record, trace, announce=False)
            return None

        checked = await self._check(proposal, sent, run_id, environment, seen_gate, version)
        if isinstance(checked, str):
            _say(trace, trace_message("adapter", "error", checked, model=self.model, ms=seconds * 1000, data={"run": run_id}))
            self._tail(run["id"], record, trace, announce=False)
            return None
        seconds = time.monotonic() - started
        record["check_seconds"] = round(seconds - record["answer_seconds"], 1)
        tested = checked["tested"]
        tested["run"] = {"id": run_id, "interaction": run.get("id"), "environment": environment,
                         "model": self.model, "seconds": round(seconds, 1),
                         "tokens_so_far": record.get("tokens_so_far")}
        record.update({"seconds": round(seconds, 1), "kept": tested["kept"], "guard": tested["guard"]})
        guard = tested["guard"]
        _say(trace, trace_message(
            "adapter", "done",
            f"Kept {tested['kept']}: you would win {_percent(tested['kept_share'])} of rounds, "
            f"{tested['kept_distance']} from the target. {tested['tests_run']} tests run in the sandbox, "
            f"{guard['saves_approved']} saved to the library, {guard['saves_blocked']} blocked by the guard.",
            model=self.model, ms=seconds * 1000, data={"run": run_id, "tested": tested},
        ))
        self._tail(run["id"], record, trace, announce=True)
        return checked

    # ------------------------------------------------------------ watching a run

    async def _watch(self, run: dict[str, Any], run_id: str, environment: str, deadline: float, trace: Trace,
                     seen_gate: int, said: set[tuple[Any, ...]], wake: asyncio.Event,
                     record: dict[str, Any]) -> tuple[Proposal | None, str]:
        """Wait until the proposal is saved, the run ends or the time runs out.

        While the event stream in `_follow` is live it shows the steps, and
        this loop only looks for the answer. Without the stream it lists the
        sandbox's files, which works while a run is going, so each new
        candidate, test result, library entry and refused save still becomes
        one trace line.
        """
        mine = re.compile(rf"(candidates|tests|library)/({run_id}_[A-Za-z0-9_.\-]+)\.json$")
        proposal_path = f"workspace/out/{run_id}/proposal.json"
        seen: set[tuple[str, str]] = set()
        status = str(run.get("status") or "in_progress")
        while True:
            streaming = record.get("stream_events", 0) > 0 and "stream_error" not in record
            listing: list[str] = [] if streaming else await self.client.files(environment)
            for path in sorted(listing):
                found = mine.search(path)
                if not found or (found.group(1), found.group(2)) in seen:
                    continue
                folder, name = found.groups()
                seen.add((folder, name))
                if folder == "candidates":
                    self._step(trace, said, ("writing", f"Wrote rule set {name}.", ("writing", name)), run_id)
                elif folder == "library":
                    self._step(trace, said, approved_step(name), run_id)
                else:
                    result = _json(await self.client.read(environment, f"workspace/tests/{name}.json")) or {}
                    self._step(trace, said, tested_step({"name": name, **result}), run_id)
            if any(path.endswith("hook_log/gate.jsonl") for path in listing):
                gate = _lines(await self.client.read(environment, "workspace/hook_log/gate.jsonl"))
                for line in gate[seen_gate:]:
                    if line.get("decision") == "deny":
                        self._step(trace, said, blocked_step(str(line.get("reason") or "")), run_id)
                seen_gate = max(seen_gate, len(gate))
            if streaming or any(path.endswith(f"out/{run_id}/proposal.json") for path in listing):
                proposal = _json(await self.client.read(environment, proposal_path))
                if isinstance(proposal, dict) and isinstance(proposal.get("behaviour"), dict):
                    return proposal, status
            if status in DONE:
                return None, status
            if time.monotonic() + POLL_SECONDS >= deadline:
                return None, status
            try:
                await asyncio.wait_for(wake.wait(), POLL_SECONDS)
            except asyncio.TimeoutError:
                pass
            wake.clear()
            status = str((await self.client.get(run["id"])).get("status") or status)

    def _step(self, trace: Trace, said: set[tuple[Any, ...]], step: tuple[str, str, tuple[Any, ...]], run_id: str) -> None:
        """Send one step trace, unless the same step was already shown."""
        kind, about, key = step
        if key in said:
            return
        said.add(key)
        _say(trace, trace_message("adapter", "step", about, model=self.model, data={"kind": kind, "run": run_id}))

    async def _follow(self, interaction: str, run_id: str, trace: Trace, record: dict[str, Any],
                      said: set[tuple[Any, ...]], wake: asyncio.Event) -> None:
        """Follow the run's own event stream and show each step the agent takes as it happens.

        The stream carries the agent's thoughts, every file it writes, every
        test result and every save the guard refuses. The file polling in
        `_watch` does not depend on it: if the stream does not open or
        breaks, the run carries on and the polling shows the same steps.
        """
        record["stream_events"] = 0
        state: dict[str, Any] = {}
        try:
            async for event in self.client.events(interaction):
                record["stream_events"] += 1
                if self.on_event:
                    self.on_event(event)
                data = event.get("data") if isinstance(event.get("data"), dict) else {}
                usage = data.get("usage") or (data.get("interaction") or {}).get("usage")
                if isinstance(usage, dict) and usage.get("total_tokens"):
                    record["tokens_so_far"] = int(usage["total_tokens"])
                for step in steps_of(event, run_id, state):
                    self._step(trace, said, step, run_id)
                if state.pop("answer_saved", False) or event.get("event") == "interaction.completed":
                    wake.set()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            record["stream_error"] = str(error)[:200]

    def _tail(self, interaction: str, record: dict[str, Any], trace: Trace, announce: bool) -> None:
        """After the answer is handed back, wait for the run to close and note its tokens."""

        async def wait() -> None:
            try:
                ends = time.monotonic() + 120
                run = await self.client.get(interaction)
                while run.get("status") not in DONE and time.monotonic() < ends:
                    await asyncio.sleep(POLL_SECONDS)
                    run = await self.client.get(interaction)
                record.update({"final_status": run.get("status"), "tokens": tokens(run)})
                if announce and record["tokens"]:
                    _say(trace, trace_message(
                        "adapter", "done",
                        f"The managed agent run closed. It used {record['tokens'].get('total_tokens', 0):,} tokens.",
                        model=self.model, data={"run": record.get("run_id"), "tokens": record["tokens"]},
                    ))
            except Exception as error:
                record["tail_error"] = str(error)[:200]

        task = asyncio.get_running_loop().create_task(wait())
        self._tails.add(task)
        task.add_done_callback(self._tails.discard)

    async def settle(self) -> None:
        """Wait for the runs that already answered to close, so their token counts are in `history`."""
        if self._tails:
            await asyncio.gather(*list(self._tails), return_exceptions=True)

    # ------------------------------------------------------------ checking the answer

    async def _check(self, proposal: Proposal, facts: Facts, run_id: str, environment: str,
                     seen_gate: int, version: int) -> Proposal | str:
        """Check the agent's answer against what its sandbox actually holds.

        Returns the proposal with a `tested` block built from the evaluator's
        own result files, or one plain sentence on why the answer is refused.
        """
        setup = facts.get("setup") or {}
        behaviour = proposal["behaviour"]
        value_names = set(facts.get("values") or {}) | set(facts.get("value_about") or {})
        problems = contract.check_behaviour(setup, {**behaviour, "version": version}, value_names)
        if problems:
            return f"The managed agent's rule set does not fit the game: {problems[0].get('about', problems[0])}"

        # Everything below is read from files the evaluator and the guard wrote, not from what the agent says.
        logs = await asyncio.gather(*(self.client.read(environment, f"workspace/{path}") for path in (
            "tests/history.jsonl", "hook_log/gate.jsonl", "hook_log/audit.jsonl")))
        history = [line for line in _lines(logs[0]) if line.get("run") == run_id]
        gate, audit = _lines(logs[1])[seen_gate:], _lines(logs[2])
        names = sorted({str(line.get("name")) for line in history})
        if not names:   # a sandbox made before the history file existed: fall back to the file list
            names = sorted({found.group(1) for path in await self.client.files(environment)
                            if (found := re.search(rf"tests/({run_id}_[A-Za-z0-9_.\-]+)\.json$", path))})
        texts = await asyncio.gather(*(self.client.read(environment, f"workspace/tests/{name}.json") for name in names))
        measured = {name: result for name, text in zip(names, texts) if isinstance(result := _json(text), dict)}

        ev = evaluator()
        mark = ev.fingerprint(behaviour)
        claims = proposal.get("tested") if isinstance(proposal.get("tested"), dict) else {}
        said = {str(c.get("name")): c for c in claims.get("candidates") or [] if isinstance(c, dict)}
        kept = next((name for name, result in measured.items()
                     if result.get("fingerprint") == mark and result.get("passed")), None)
        if kept is None:
            return ("The managed agent handed back a rule set with no passing test in its sandbox, "
                    "so it was refused and the current rules stay.")

        here = score_here(behaviour, facts)
        current = score_here(facts.get("behaviour") or {}, facts)
        blocked = [line for line in gate if line.get("decision") == "deny"]
        library = (audit[-1].get("library") if audit else None) or {}
        installed = sorted(name for name, state in library.items() if name.startswith(run_id) and state == "tested")

        candidates = []
        for name, result in measured.items():
            claim = said.get(name) or {}
            candidates.append({
                "name": name,
                "idea": claim.get("idea", ""),
                "player_win_share": result.get("player_win_share"),
                "distance": result.get("distance"),
                "passed": bool(result.get("passed")),
                "by_persona": result.get("by_persona"),
                "problems": result.get("problems") or [],
                "kept": name == kept,
                "in_library": library.get(name) == "tested",
                "verdict": claim.get("verdict", ""),
            })
        candidates.sort(key=lambda c: (c["distance"] is None, c["distance"] or 0))
        attempts = [{key: line.get(key) for key in ("name", "player_win_share", "distance", "passed")} for line in history]
        proposal.pop("settings", None)   # a writer changes rule sets only, never a game setting
        sandbox_share = measured[kept].get("player_win_share")
        proposal["behaviour"] = {**behaviour, "version": version}
        proposal["tested"] = {
            "measure": "The share of rounds the player is expected to win, estimated from the matchup table "
                       "by evaluate.py inside the agent's sandbox. The target is the goal, not a win.",
            "target": measured[kept].get("target"),
            "kept": kept,
            "kept_share": sandbox_share,
            "kept_distance": measured[kept].get("distance"),
            "kept_is_closest": bool(candidates) and candidates[0]["name"] == kept,
            "candidates": candidates,
            "tests_run": len(attempts) or len(candidates),
            "attempts": attempts,
            "current": {"player_win_share": current.get("player_win_share"), "distance": current.get("distance")},
            "rescored_here": {
                "player_win_share": here.get("player_win_share"),
                "matches_sandbox": isinstance(sandbox_share, (int, float)) and here.get("ok", False)
                and abs(here["player_win_share"] - sandbox_share) <= SCORE_TOLERANCE,
            },
            "guard": {
                "calls_checked": len(gate),
                "saves_approved": len(installed),      # rule sets of this run now in the library, each with a passing test
                "saves_blocked": len(blocked),         # calls the guard refused during this run
                "blocked": [str(line.get("reason")) for line in blocked][:5],
                "library_size": len(library),          # with what earlier runs left there
                "library": {name: state for name, state in library.items() if name.startswith(run_id)},
                "flagged": sorted(name for name, state in library.items() if state != "tested"),
            },
        }
        return proposal


Step = tuple[str, str, tuple[Any, ...]]   # (kind, one plain sentence, a key that stops repeats)


def tested_step(result: dict[str, Any]) -> Step:
    name = str(result.get("name") or "a rule set")
    verdict = "It passed." if result.get("passed") else (
        "It failed: " + "; ".join(result.get("problems") or ["too far from the target"]))
    about = f"Tested {name}: you would win {_percent(result.get('player_win_share'))} of rounds against it. {verdict}"
    return "testing", about[:300], ("testing", name, result.get("fingerprint"))


def approved_step(name: str) -> Step:
    return "approved", f"The guard let {name} into the library: it has a passing test.", ("approved", name)


def blocked_step(reason: str) -> Step:
    return "blocked", f"The guard refused a save. {reason}"[:300], ("blocked", reason[:60])


def thought_step(text: str) -> Step | None:
    """One sentence from a thought summary, which reads `**Title**` then a paragraph."""
    title, _, body = text.strip().partition("\n")
    body = " ".join(body.replace("`", "").split()) or title.strip("* ")
    sentence = re.split(r"(?<=[.!?])\s", body, maxsplit=1)[0][:240]
    return ("thought", sentence, ("thought", sentence[:60])) if sentence else None


def steps_of(event: dict[str, Any], run_id: str, state: dict[str, Any]) -> list[Step]:
    """The steps worth showing from one stream event.

    `state` carries what the agent last asked for, so that a result can be
    read against its call. It gets `answer_saved` when the proposal is written.
    """
    data = event.get("data") if isinstance(event.get("data"), dict) else {}
    kind_of_event = event.get("event")
    if kind_of_event == "step.delta":
        content = (data.get("delta") or {}).get("content") if isinstance(data.get("delta"), dict) else None
        text = content.get("text") if isinstance(content, dict) else None
        step = thought_step(text) if isinstance(text, str) and text.strip() else None
        return [step] if step else []
    step = data.get("step")
    if kind_of_event != "step.start" or not isinstance(step, dict):
        return []
    kind = str(step.get("type") or "")
    args = step.get("arguments") if isinstance(step.get("arguments"), dict) else {}
    answer = f"out/{run_id}/proposal.json"
    found: list[Step] = []
    if kind == "function_call":
        target = str(args.get("TargetFile") or args.get("path") or args.get("AbsolutePath") or "")
        writes = any(word in str(step.get("name") or "") for word in ("write", "replace"))
        state["target"] = target if writes else ""
        draft = re.search(rf"candidates/({run_id}_[\w.\-]+)\.json$", target)
        if writes and draft:
            found.append(("writing", f"Writing rule set {draft.group(1)}.", ("writing", draft.group(1))))
        elif writes and target.endswith(answer):
            found.append(("writing", "Writing up the answer.", ("writing", "answer")))
    elif kind == "code_execution_call":
        state["code"] = str(args.get("code") or "")
    elif kind in ("function_result", "code_execution_result"):
        text = str(step.get("result") or "")
        asked = state.pop("code", "") if kind == "code_execution_result" else state.pop("target", "")
        if step.get("is_error") and ("Blocked by hook" in text or "permission_denied" in text):
            return [blocked_step(text.split("Blocked by hook:", 1)[-1].strip())]
        for line in text.splitlines():
            result = _json(line) if line.startswith("{") else None
            if isinstance(result, dict) and "passed" in result and "name" in result:
                found.append(tested_step(result))
        if not step.get("is_error"):
            saving = kind == "function_result" or re.search(r"\b(cp|mv)\b", asked)
            for name in dict.fromkeys(re.findall(r"library/([\w.\-]+)\.json", asked) if saving else []):
                found.append(approved_step(name))
            if answer in asked:
                state["answer_saved"] = True
    return found
