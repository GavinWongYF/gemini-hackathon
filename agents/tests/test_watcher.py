"""Watcher tests with no network. The Decisions API is replaced by a fake here only."""
from __future__ import annotations

import asyncio
import base64
import io
import re
from typing import Any

import pytest
from PIL import Image

from server import watcher
from server.interfaces import Design, MatchState, PlayerState, ValueSpec

SETUP: dict[str, Any] = {
    "type": "setup",
    "match_id": "m_test",
    "game": "tennis",
    "about": "One human player plays single points against one AI opponent.",
    "lists": {
        "zone": ["left_short", "middle_short", "right_short", "left_deep", "middle_deep", "right_deep"],
        "shot_type": ["flat", "lob", "drop"],
    },
    "events": {
        "shot": {
            "about": "Either side hit the ball.",
            "fields": {
                "rally": "number",
                "side": ["forehand", "backhand"],
                "shot_type": "shot_type",
                "power": {"min": 0, "max": 1, "about": "How hard the swing was."},
                "lands": "zone",
                "note": "text",
            },
        }
    },
    "views": {"court": "The game screen."},
}

VALUES = [
    ValueSpec("comes_to_net", "Comes to the net", {"type": "noul", "instructions": "Does the player come to the net?"}),
    ValueSpec("prefers_forehand", "Hits forehands", {
        "type": "score", "instructions": "How often forehand?",
        "criteria": ["Never", "Rarely", "Sometimes", "Often", "Almost always"],
    }, counts={"event": "shot", "field": "side", "values": ["forehand"]}),
    ValueSpec("favours_flat", "Hits flat", {
        "type": "choice", "instructions": "Favourite shot?",
        "criteria": {"flat": "flat", "lob": "lob", "drop": "drop", "other": "none"},
        "value_of": "flat",
    }),
]


def shot(t: float, by: str = "player", **data: Any) -> dict[str, Any]:
    return {"type": "event", "match_id": "m_test", "name": "shot", "round": 1, "t": t, "by": by, "data": data}


def make_match(events: list[dict[str, Any]] | None = None, frames: dict[str, Any] | None = None) -> tuple[MatchState, list]:
    traces: list = []
    match = MatchState(
        match_id="m_test",
        setup=SETUP,
        design=Design(values=list(VALUES), behaviour={"version": 1, "npcs": {}}),
        behaviour={"version": 1, "npcs": {}},
        events=events or [],
        frames=frames,
        trace=traces.append,
    )
    return match, traces


def fake_reply(net: float = 0.9, score: float = 3.0, flat: float = 0.7, conf: float = 0.8) -> dict[str, Any]:
    return {
        "answers": {
            "comes_to_net": {"type": "noul", "noul": net, "confidence": conf},
            # prefers_forehand names a countable share, so it is asked about the next action.
            "prefers_forehand": {"type": "choice", "choice": "forehand", "confidence": conf,
                                 "probabilities": {"forehand": score / 4, "backhand": 1 - score / 4}},
            "favours_flat": {"type": "choice", "choice": "flat", "confidence": 0.5,
                             "probabilities": {"flat": flat, "lob": 0.2, "drop": 0.1}},
        },
        "usage": {"total_input_tokens": 200},
    }


class FakeAsk:
    def __init__(self, reply: dict[str, Any] | Exception) -> None:
        self.reply = reply
        self.calls: list[tuple[list, dict]] = []

    async def __call__(self, parts: list, questions: dict) -> dict[str, Any]:
        self.calls.append((parts, questions))
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


def tiny_image(fmt: str) -> str:
    out = io.BytesIO()
    Image.new("RGB", (800, 600), (20, 120, 40)).save(out, format=fmt)
    return base64.b64encode(out.getvalue()).decode("ascii")


# ---------------------------------------------------------------- the event summary


def test_summary_counts_names_numbers_and_npc_events() -> None:
    events = [
        shot(1, side="forehand", shot_type="flat", power=0.4, lands="left_deep", rally=1, note="x"),
        shot(2, side="forehand", shot_type="flat", power=0.8, lands="left_deep", rally=3),
        shot(3, side="backhand", shot_type="lob", power=0.6, lands="middle_deep", rally=5),
        shot(2.5, by="opponent", shot_type="drop"),
    ]
    text = watcher.summarise_events(SETUP, events)
    assert "Player `shot` events: 3 (Either side hit the ball.)" in text
    assert "- side: forehand 2 of 3, backhand 1 of 3" in text
    # A field named by a list from `lists` lists every option, zeros included.
    assert "- shot_type: flat 2 of 3, lob 1 of 3, drop 0 of 3" in text
    assert "left_deep 2 of 3" in text and "right_short 0 of 3" in text
    assert "- power: mean 0.6, min 0.4, max 0.8 (scale 0 to 1: How hard the swing was.)" in text
    assert "- rally: mean 3, min 1, max 5" in text
    assert "note" not in text  # free text can't be counted
    assert "NPC events: opponent `shot` 1" in text


def test_window_keeps_only_recent_seconds() -> None:
    events = [shot(1), shot(10), shot(25), shot(30)]
    assert [e["t"] for e in watcher.window(events, 20)] == [10, 25, 30]
    assert watcher.window([], 20) == []


def test_undeclared_fields_are_judged_by_value() -> None:
    events = [shot(1, spin="top", speed=10), shot(2, spin="back", speed=20)]
    text = watcher.summarise_events(SETUP, events)
    assert "- spin: back 1 of 2, top 1 of 2" in text
    assert "- speed: mean 15, min 10, max 20" in text


# ---------------------------------------------------------------- numbers grouped by named fields

GROUP_SETUP: dict[str, Any] = {
    "npcs": {"opponent": {}},
    "lists": {"kind": ["topspin", "slice", "dropshot"]},
    "events": {
        "shot": {
            "fields": {
                "kind": "kind",
                "side": ["forehand", "backhand"],
                "zone": ["left", "center", "right"],
                "foot": ["front", "back"],
                "grip": ["a", "b"],
                "power": {"min": 0, "max": 1},
                "result": ["in", "out"],
                "other_position": ["near", "far"],
            }
        }
    },
}


def gshot(t: float, **data: Any) -> dict[str, Any]:
    return {"type": "event", "name": "shot", "round": 1, "t": t, "by": "player", "data": data}


def power_line_and_groupings(text: str) -> tuple[str, list[str]]:
    lines = text.splitlines()
    i = next(n for n, l in enumerate(lines) if l.startswith("- power:"))
    groupings = []
    for l in lines[i + 1:]:
        if not l.startswith("  - "):
            break
        groupings.append(l)
    return lines[i], groupings


def test_two_groups_with_different_means_both_show() -> None:
    events = [gshot(t, side="forehand", power=p) for t, p in enumerate([0.8, 0.9, 0.7, 0.8, 0.8])]
    events += [gshot(10 + t, side="backhand", power=0.3) for t in range(3)]
    line, groupings = power_line_and_groupings(watcher.summarise_events(GROUP_SETUP, events))
    # The overall line is unchanged.
    assert line == "- power: mean 0.61, min 0.3, max 0.9 (scale 0 to 1)"
    assert groupings == ["  - power mean by side: forehand 0.8 (5), backhand 0.3 (3)"]


def test_groupings_pick_the_biggest_differences() -> None:
    events = []
    for i in range(8):
        events.append(gshot(
            i,
            power=0.9 if i < 4 else 0.1,
            foot="front" if i < 4 else "back",                # splits power exactly: gap 0.8
            result="in" if i in (0, 1, 2, 4) else "out",      # gap 0.4, outcomes may group a number
            side=["forehand", "backhand"][i % 2],             # gap 0
            other_position="near" if i < 4 else "far",        # the NPC's side: never used
            kind="topspin" if i != 7 else "dropshot",         # dropshot has one event: skipped
        ))
    _, groupings = power_line_and_groupings(watcher.summarise_events(GROUP_SETUP, events))
    assert groupings == [
        "  - power mean by foot: front 0.9 (4), back 0.1 (4)",
        "  - power mean by result: in 0.7 (4), out 0.3 (4)",
    ]


def test_small_gaps_are_left_out() -> None:
    # A gap of 0.05 on a 0 to 1 scale is under a tenth of the scale.
    events = [gshot(t, side="forehand" if t < 3 else "backhand", power=0.5 if t < 3 else 0.55) for t in range(6)]
    _, groupings = power_line_and_groupings(watcher.summarise_events(GROUP_SETUP, events))
    assert groupings == []


def test_fields_with_many_options_are_not_grouped() -> None:
    setup = {"events": {"shot": {"fields": {
        "spot": ["a", "b", "c", "d", "e", "f"], "power": {"min": 0, "max": 1}}}}}
    events = [gshot(t, spot="a" if t < 3 else "b", power=0.9 if t < 3 else 0.1) for t in range(6)]
    _, groupings = power_line_and_groupings(watcher.summarise_events(setup, events))
    assert groupings == []


def test_no_declared_numbers_means_no_grouping() -> None:
    setup = {"events": {"shot": {"fields": {"kind": ["topspin", "slice"]}}}}
    events = [gshot(1, kind="topspin", speed=10), gshot(2, kind="topspin", speed=20),
              gshot(3, kind="slice", speed=5), gshot(4, kind="slice", speed=7)]
    text = watcher.summarise_events(setup, events)
    assert text == (
        "Player `shot` events: 4\n"
        "- kind: topspin 2 of 4, slice 2 of 4\n"
        "- speed: mean 10.5, min 5, max 20"
    )


# ---------------------------------------------------------------- the answers


def test_noul_is_its_own_value() -> None:
    assert watcher.to_value(VALUES[0].question, {"type": "noul", "noul": 0.97, "confidence": 0.97}) == (0.97, 0.97)


def test_score_divides_by_levels_minus_one() -> None:
    value, confidence = watcher.to_value(VALUES[1].question, {"type": "score", "score": 3.4, "confidence": 0.7})
    assert value == pytest.approx(0.85)
    assert confidence == 0.7


def test_choice_uses_value_of_or_the_top_probability() -> None:
    answer = {"type": "choice", "choice": "lob", "confidence": 0.6,
              "probabilities": {"flat": 0.3, "lob": 0.6, "drop": 0.1}}
    assert watcher.to_value(VALUES[2].question, answer) == (0.3, 0.6)
    plain = {k: v for k, v in VALUES[2].question.items() if k != "value_of"}
    assert watcher.to_value(plain, answer) == (0.6, 0.6)


def test_api_questions_drop_local_keys() -> None:
    questions = watcher.api_questions(VALUES)
    assert "value_of" not in questions["favours_flat"]
    assert questions["favours_flat"]["criteria"]["other"] == "none"
    assert "value_of" in VALUES[2].question  # the design itself is untouched


# ---------------------------------------------------------------- the blending


def test_blend_takes_first_reading_then_weights_by_confidence() -> None:
    assert watcher.blend(None, 0.8, 0.1, 0.5) == 0.8
    assert watcher.blend(0.2, 1.0, 1.0, 0.5) == pytest.approx(0.6)
    assert watcher.blend(0.2, 1.0, 0.5, 0.5) == pytest.approx(0.4)
    assert watcher.blend(0.2, 1.0, 0.0, 0.5) == pytest.approx(0.2)


def test_update_player_in_place() -> None:
    player = PlayerState()
    watcher.update_player(player, {"a": (0.8, 0.9)}, 0.5)
    before = watcher.update_player(player, {"a": (0.0, 1.0)}, 0.5)
    assert before == {"a": 0.8}
    assert player.values["a"] == pytest.approx(0.4)
    assert player.reads == 2


# ---------------------------------------------------------------- whole reads


async def test_read_updates_state_and_returns_player_read() -> None:
    match, traces = make_match([shot(1, side="forehand"), shot(2, side="forehand"), shot(3, side="backhand")])
    fake = FakeAsk(fake_reply())
    read = await watcher.DecisionsWatcher(ask=fake).read(match)

    assert read is not None
    assert read["type"] == "player_read" and read["match_id"] == "m_test"
    assert read["round"] == 1 and read["t"] == 3
    # prefers_forehand: 2 of 3 counted, read 0.75, the count weighs 3 / (3 + 2).
    assert read["values"] == {"comes_to_net": 0.9, "prefers_forehand": 0.7, "favours_flat": 0.7}
    assert read["based_on_events"] == 3
    assert read["low_confidence"] == ["favours_flat"]
    assert read["why"] == ("Comes to the net: strongest on the first read. "
                           "This rests on the model's read of the last 3 shot events.")
    assert "picture_note" not in read
    assert match.player.reads == 1
    assert match.player.memory["readings"][0]["values"]["comes_to_net"] == 0.9
    assert [t["status"] for t in traces] == ["start", "done"]
    assert traces[1]["model"] and "ms" in traces[1]
    parts, questions = fake.calls[0]
    assert parts[0]["text"].startswith("Game: One human player")
    assert set(questions) == {"comes_to_net", "prefers_forehand", "favours_flat"}

    # A second read with a new event blends rather than replaces.
    match.events.append(shot(4, side="forehand"))
    fake.reply = fake_reply(net=0.1, conf=1.0)
    read = await watcher.DecisionsWatcher(blend_factor=0.5, ask=fake).read(match)
    assert read["values"]["comes_to_net"] == pytest.approx(0.5)
    assert read["why"] == "Comes to the net: weaker. This rests on the model's read of the last 4 shot events."
    assert match.player.reads == 2


async def test_read_sends_one_low_resolution_jpeg_per_view() -> None:
    frames = {"type": "frames", "round": 1, "t": 2.0,
              "views": {"court": {"mime_type": "image/png", "data": tiny_image("PNG")}}}
    match, _ = make_match([shot(1)], frames)
    fake = FakeAsk(fake_reply())
    read = await watcher.DecisionsWatcher(ask=fake).read(match)
    images = [p for p in fake.calls[0][0] if p["type"] == "image"]
    assert len(images) == 1
    assert images[0]["resolution"] == "low" and images[0]["mime_type"] == "image/jpeg"
    picture = Image.open(io.BytesIO(base64.b64decode(images[0]["data"])))
    assert picture.format == "JPEG" and picture.width == 384
    assert read["picture_note"] == "Looked at the latest court frame."


async def test_feed_back_switch_adds_previous_values() -> None:
    match, _ = make_match([shot(1)])
    match.player.values = {"comes_to_net": 0.25}
    fake = FakeAsk(fake_reply())
    await watcher.DecisionsWatcher(feed_back_state=False, ask=fake).read(match)
    assert "previous read" not in fake.calls[0][0][0]["text"]
    match.events.append(shot(2))
    await watcher.DecisionsWatcher(feed_back_state=True, ask=fake).read(match)
    assert "Our previous read of this player" in fake.calls[1][0][0]["text"]


async def test_read_never_raises() -> None:
    match, traces = make_match([shot(1)])
    read = await watcher.DecisionsWatcher(ask=FakeAsk(RuntimeError("boom"))).read(match)
    assert read is None
    assert traces[-1]["status"] == "error" and "boom" in traces[-1]["about"]
    assert match.player.reads == 0


async def test_nothing_new_means_no_call() -> None:
    match, _ = make_match([shot(1)])
    fake = FakeAsk(fake_reply())
    w = watcher.DecisionsWatcher(ask=fake)
    assert await w.read(match) is not None
    assert await w.read(match) is None
    assert len(fake.calls) == 1
    empty, _ = make_match([])
    assert await w.read(empty) is None


async def test_warm_makes_one_call_and_never_raises() -> None:
    fake = FakeAsk(fake_reply())
    await watcher.DecisionsWatcher(ask=fake).warm()
    assert len(fake.calls) == 1
    await watcher.DecisionsWatcher(ask=FakeAsk(RuntimeError("down"))).warm()


def test_events_phrase_names_one_kind_or_says_player() -> None:
    assert watcher.events_phrase([shot(1), shot(2)]) == "2 shot events"
    mixed = [shot(1), {"name": "kill", "by": "player", "t": 2}]
    assert watcher.events_phrase(mixed) == "2 player events"


# ---------------------------------------------------------------- anchoring reads on counts

from server import anchors  # noqa: E402

TENNIS_LIKE: dict[str, Any] = {
    "npcs": {"opponent": {}},
    "lists": {"kind": ["topspin", "slice", "dropshot"], "zone": ["left_deep", "right_deep", "left_short"]},
    "events": {"shot": {"fields": {
        "side": ["forehand", "backhand"], "kind": "kind", "lands": "zone",
        "other_position": "zone", "power": {"min": 0, "max": 1}}}},
}


def spec(name: str, about: str = "", instructions: str = "Does the player do it?", counts=None) -> ValueSpec:
    return ValueSpec(name, about, {"type": "noul", "instructions": instructions}, counts=counts)


DROPSHOTS = {"event": "shot", "field": "kind", "values": ["dropshot"]}


def test_targets_are_found_by_name_and_question() -> None:
    t = anchors.target_for(TENNIS_LIKE, spec("share_of_side_forehand"))
    assert (t.event, t.field, t.options) == ("shot", "side", ["forehand"])
    # The designer's `counts` is used exactly, once it checks out against setup.
    t = anchors.target_for(TENNIS_LIKE, spec("plays_dropshots", "Plays dropshots", counts=DROPSHOTS))
    assert (t.event, t.field, t.options) == ("shot", "kind", ["dropshot"])
    bad = {"event": "shot", "field": "kind", "values": ["smash"]}
    assert anchors.target_for(TENNIS_LIKE, spec("share_of_side_forehand", counts=bad)) is None
    # Without `counts`, only a guess that names both the option and its field (or list).
    assert anchors.target_for(TENNIS_LIKE, spec("plays_dropshots", "Plays dropshots")) is None
    t = anchors.target_for(TENNIS_LIKE, spec("dropshot_kind", "Picks the dropshot kind"))
    assert (t.field, t.options) == ("kind", ["dropshot"])
    t = anchors.target_for(TENNIS_LIKE, spec("lands_left_deep", "Lands left deep"))
    assert (t.field, t.options) == ("lands", ["left_deep"])
    # Where the arm is is not where the ball goes: an option named without its field is not counted.
    assert anchors.target_for(TENNIS_LIKE, spec("aims_left_side", "Hits toward the left corner",
                                                "How often do shots land in `left_deep`?")) is None
    assert anchors.target_for(TENNIS_LIKE, spec("comes_to_net", "Comes to the net")) is None
    assert anchors.target_for(TENNIS_LIKE, spec("hits_hard", "Swings hard")) is None


def test_next_action_question_asks_for_a_share() -> None:
    t = anchors.target_for(TENNIS_LIKE, spec("plays_dropshots", counts=DROPSHOTS))
    question = anchors.next_action_question(t)
    assert question["type"] == "choice" and set(question["criteria"]) == {"topspin", "slice", "dropshot"}
    answer = {"type": "choice", "confidence": 0.5, "probabilities": {"topspin": 0.5, "slice": 0.2, "dropshot": 0.3}}
    assert anchors.share_from_answer(t, answer) == (0.3, 0.5)


def tshot(t: float, **data: Any) -> dict[str, Any]:
    return {"type": "event", "name": "shot", "round": 1, "t": t, "by": "player", "data": data}


def tennis_match(events: list[dict[str, Any]], values: list[ValueSpec], personas=None) -> tuple[MatchState, list]:
    traces: list = []
    match = MatchState(
        match_id="m_a", setup=TENNIS_LIKE,
        design=Design(values=values, behaviour={"version": 1, "npcs": {}}, personas=personas or []),
        behaviour={"version": 1, "npcs": {}}, events=events, trace=traces.append,
    )
    return match, traces


async def test_a_countable_value_ends_near_the_counted_share_even_when_the_read_is_wrong() -> None:
    # The player plays 3 dropshots in 10 shots. The read says 0.98, like a yes or no answer would.
    events = [tshot(i, kind="dropshot" if i % 3 == 1 else "topspin") for i in range(10)]
    wrong = {"answers": {"plays_dropshots": {"type": "choice", "confidence": 0.98,
                                             "probabilities": {"dropshot": 0.98, "topspin": 0.02}}}}
    match, _ = tennis_match(events[:1], [spec("plays_dropshots", "Plays dropshots", counts=DROPSHOTS)])
    w = watcher.DecisionsWatcher(ask=FakeAsk(wrong))
    first = await w.read(match)
    assert first["values"]["plays_dropshots"] < 0.98  # heads toward the count from the first read
    assert first["low_confidence"] == ["plays_dropshots"]  # one event is too few to call a habit
    match.events = events
    last = await w.read(match)
    assert abs(last["values"]["plays_dropshots"] - 0.3) <= 0.2
    many = [tshot(i, kind="dropshot" if i % 10 < 3 else "topspin") for i in range(20)]
    match.events = many
    last = await w.read(match)
    assert abs(last["values"]["plays_dropshots"] - 0.3) <= 0.1
    assert "6 of the last 20 shot events had kind dropshot" in last["why"]
    assert not re.search(r"\b0\.\d", last["why"])  # no raw 0 to 1 scores in the text


async def test_likeness_is_anchored_by_persona_plays() -> None:
    personas = [
        {"name": "lefty", "about": "", "plays": {"shot": {"side": {"forehand": 0.8, "backhand": 0.2}}}},
        {"name": "righty", "about": "", "plays": {"shot": {"side": {"forehand": 0.2, "backhand": 0.8}}}},
        {"name": "even", "about": "", "plays": {}},
    ]
    values = [ValueSpec(f"like_{p['name']}", p["name"], {"type": "choice", "instructions": "Which?",
              "criteria": {"lefty": "", "righty": "", "even": ""}, "value_of": p["name"]}) for p in personas]
    events = [tshot(i, side="forehand" if i % 5 else "backhand") for i in range(10)]  # 8 of 10 forehand
    flat = {"answers": {v.name: {"type": "choice", "confidence": 0.34,
                                 "probabilities": {"lefty": 0.33, "righty": 0.33, "even": 0.34}} for v in values}}
    match, _ = tennis_match(events, values, personas)
    read = await watcher.DecisionsWatcher(ask=FakeAsk(flat)).read(match)
    assert max(read["values"], key=read["values"].get) == "like_lefty"
    assert read["values"]["like_lefty"] > 0.6


async def test_a_slow_read_is_tried_once_more(monkeypatch) -> None:
    monkeypatch.setattr(watcher, "READ_TIMEOUT_SECONDS", 0.05)
    calls = []

    async def slow_then_fast(parts, questions):
        calls.append(1)
        if len(calls) == 1:
            await asyncio.sleep(1)
        return fake_reply()

    match, traces = make_match([shot(1)])
    read = await watcher.DecisionsWatcher(ask=slow_then_fast).read(match)
    assert read is not None and len(calls) == 2


async def test_likeness_waits_for_numbers_on_every_persona() -> None:
    personas = [
        {"name": "lefty", "about": "", "plays": {"shot": {"side": {"forehand": 0.8, "backhand": 0.2}}}},
        {"name": "righty", "about": ""},  # a practice player with no numbers yet
    ]
    values = [ValueSpec(f"like_{p['name']}", p["name"], {"type": "choice", "instructions": "Which?",
              "criteria": {"lefty": "", "righty": ""}, "value_of": p["name"]}) for p in personas]
    events = [tshot(i, side="forehand") for i in range(10)]
    reply = {"answers": {v.name: {"type": "choice", "confidence": 0.6,
                                  "probabilities": {"lefty": 0.4, "righty": 0.6}} for v in values}}
    match, _ = tennis_match(events, values, personas)
    read = await watcher.DecisionsWatcher(ask=FakeAsk(reply)).read(match)
    # Both stay on the model's read, so neither is pushed down for lacking numbers.
    assert read["values"] == {"like_lefty": 0.4, "like_righty": 0.6}
    assert "alone" in read["why"]


# ---------------------------------------------------------------- likeness: silence is no opinion

# The practice players of a fresh design of the real game, each speaking on one field.
REAL_PERSONAS: list[dict[str, Any]] = [
    {"name": "forehand_lover", "plays": {"shot": {"side": {"forehand": 0.7, "backhand": 0.3}}}},
    {"name": "baseline_grinder", "plays": {"shot": {"shot_type": {"topspin": 0.8, "slice": 0.15, "dropshot": 0.05}}}},
    {"name": "even", "plays": {"shot": {"side": {"forehand": 0.5, "backhand": 0.5}}}},
    {"name": "forehand_hunter", "plays": {"shot": {"side": {"forehand": 0.8, "backhand": 0.2}}}},
    {"name": "deep_grinder", "plays": {"shot": {"from": {
        "left_deep": 0.3, "middle_deep": 0.4, "right_deep": 0.2,
        "left_short": 0.03, "middle_short": 0.04, "right_short": 0.03}}}},
    {"name": "dropshot_artist", "plays": {"shot": {"shot_type": {"dropshot": 0.55, "slice": 0.3, "topspin": 0.15}}}},
    {"name": "left_corner_shooter", "plays": {"shot": {"lands": {
        "left_deep": 0.55, "left_short": 0.25, "middle_deep": 0.1,
        "middle_short": 0.02, "right_deep": 0.05, "right_short": 0.03}}}},
    {"name": "all_court_balanced", "plays": {"shot": {"side": {"forehand": 0.5, "backhand": 0.5}}}},
]
REAL_ZONES = ["left_short", "middle_short", "right_short", "left_deep", "middle_deep", "right_deep"]
REAL_SETUP: dict[str, Any] = {
    "npcs": {"opponent": {}},
    "lists": {"zone": REAL_ZONES},
    "events": {"shot": {"fields": {
        "side": ["forehand", "backhand"], "shot_type": ["topspin", "flat", "slice", "dropshot", "lob"],
        "from": "zone", "lands": "zone"}}},
}


def real_player(forehand: float, kinds: list[str], n: int = 20) -> list[dict[str, Any]]:
    """n shots, all from deep zones as in the real game, landing all over."""
    return [tshot(
        i,
        side="forehand" if i < round(forehand * n) else "backhand",
        shot_type=kinds[i % len(kinds)],
        **{"from": ["left_deep", "middle_deep", "right_deep"][i % 3]},
        lands=REAL_ZONES[(i * 5) % 6],
    ) for i in range(n)]


def likeness(events: list[dict[str, Any]]) -> dict[str, float]:
    names = [p["name"] for p in REAL_PERSONAS]
    found, _ = anchors.persona_likeness(REAL_SETUP, REAL_PERSONAS, events, names)
    return found


def test_a_forehand_player_is_not_called_a_deep_grinder() -> None:
    found = likeness(real_player(0.7, ["topspin", "slice", "dropshot"]))
    assert max(found, key=found.get) in ("forehand_lover", "forehand_hunter")


def test_a_topspin_player_is_like_the_baseline_grinder() -> None:
    found = likeness(real_player(0.5, ["topspin"] * 4 + ["slice"]))
    assert max(found, key=found.get) == "baseline_grinder"


def test_a_dropshot_player_is_like_the_dropshot_artist() -> None:
    found = likeness(real_player(0.5, ["dropshot"] * 11 + ["topspin"] * 5 + ["slice"] * 4))
    assert max(found, key=found.get) == "dropshot_artist"


def test_a_player_with_no_habit_has_no_clear_likeness() -> None:
    found = likeness(real_player(0.5, ["topspin", "slice", "dropshot"]))
    ranked = sorted(found.values(), reverse=True)
    assert ranked[0] < 0.35
    # No persona stands alone: the top one is within half again of the third.
    # (even and all_court_balanced say the same thing, so they tie at the top.)
    assert ranked[0] <= 1.5 * ranked[2]


async def test_a_read_from_pictures_alone_flags_every_counted_value() -> None:
    frames = {"type": "frames", "round": 1, "t": 2.0,
              "views": {"court": {"mime_type": "image/jpeg", "data": tiny_image("JPEG")}}}
    values = [spec("favors_forehand", "Hits forehands", counts={"event": "shot", "field": "side", "values": ["forehand"]}),
              spec("plays_dropshots", "Plays dropshots", counts=DROPSHOTS)]
    reply = {"answers": {
        "favors_forehand": {"type": "choice", "confidence": 0.9, "probabilities": {"forehand": 0.6, "backhand": 0.4}},
        "plays_dropshots": {"type": "choice", "confidence": 0.9, "probabilities": {"dropshot": 0.2, "topspin": 0.8}},
    }}
    match, _ = tennis_match([], values)
    match.frames = frames
    read = await watcher.DecisionsWatcher(ask=FakeAsk(reply)).read(match)
    assert read["low_confidence"] == ["favors_forehand", "plays_dropshots"]
    assert "No shot events yet" in read["why"]
