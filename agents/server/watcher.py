"""The watcher: the fast read of the player.

Each read turns the last few seconds of events into plain counts, adds the
latest frames, and asks the Decisions API every question the designer wrote.
The answers are blended into a running read of the player, so one odd event
doesn't swing the values.

Nothing here knows which game it is reading. Everything it says about the
game comes from the game's own `setup`.
"""
from __future__ import annotations

import asyncio
import base64
import io
import os
import time
from collections import Counter
from typing import Any, Awaitable, Callable

from server import anchors, config, decisions_client
from server.interfaces import MatchState, Message, PlayerState, ValueSpec, trace_message

Ask = Callable[[list[dict[str, Any]], dict[str, dict[str, Any]]], Awaitable[dict[str, Any]]]

# How far each read moves a value toward the new reading, at full confidence.
# 1.0 means trust the latest read completely. 0.5 means meet it halfway.
BLEND = float(os.environ.get("NPC_WATCHER_BLEND", "0.5"))

# Also write the previous values into the input as one line of text.
# Off by default: the carry-over then lives only in our code.
FEED_BACK_STATE = os.environ.get("NPC_WATCHER_FEED_BACK", "0").lower() in ("1", "true", "yes")

# A read that takes longer than this is tried once more. Good reads take
# 250 to 450 ms, so a slow one is usually stuck rather than thinking.
READ_TIMEOUT_SECONDS = float(os.environ.get("NPC_WATCHER_READ_TIMEOUT", "1.2"))

# Keys our questions may carry that the Decisions API itself doesn't take.
_LOCAL_KEYS = ("value_of",)

# How many raw readings to keep in player.memory.
_KEEP_READINGS = 50

# Frames are sent about 384 pixels wide, as the contract asks.
_FRAME_WIDTH = 384

# Each number field declared in `setup` is also broken down by the named
# fields where it differs most between groups: at most _MAX_GROUPINGS of them,
# only named fields with at most _MAX_GROUP_OPTIONS options, and only groups
# of at least _MIN_GROUP_USES events. A gap between groups smaller than
# _MIN_GAP_SHARE of the number's scale isn't worth the tokens.
_MAX_GROUPINGS = 2
_MAX_GROUP_OPTIONS = 5
_MIN_GROUP_USES = 2
_MIN_GAP_SHARE = 0.1


# ---------------------------------------------------------------- the input


def field_kind(setup: Message, event_name: str, field_name: str, sample: Any = None) -> tuple[str, Any]:
    """What kind of field this is: ("names", [options]), ("number", spec) or ("skip", None).

    Reads the declaration in `setup`. An undeclared field is judged by its value.
    """
    spec = setup.get("events", {}).get(event_name, {}).get("fields", {}).get(field_name)
    if isinstance(spec, list):
        return "names", spec
    if isinstance(spec, str):
        named = setup.get("lists", {}).get(spec)
        if isinstance(named, list):
            return "names", named
        if spec == "number":
            return "number", None
        return "skip", None  # "text", or a list name we don't know
    if isinstance(spec, dict) and ("min" in spec or "max" in spec):
        return "number", spec
    if spec is None:
        if isinstance(sample, bool):
            return "names", []
        if isinstance(sample, (int, float)):
            return "number", None
        if isinstance(sample, str):
            return "names", []
    return "skip", None


def window(events: list[Message], seconds: float) -> list[Message]:
    """The events from the last `seconds` of play, measured from the newest event."""
    if not events:
        return []
    newest = max(float(e.get("t") or 0) for e in events)
    return [e for e in events if float(e.get("t") or 0) >= newest - seconds]


def _fmt(x: float) -> str:
    return f"{x:.2f}".rstrip("0").rstrip(".") if x != int(x) else str(int(x))


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _declared_number(setup: Message, event_name: str, field_name: str) -> bool:
    """Whether `setup` itself declares this field as a number."""
    spec = setup.get("events", {}).get(event_name, {}).get("fields", {}).get(field_name)
    return spec == "number" or (isinstance(spec, dict) and ("min" in spec or "max" in spec))


def _describes_other_side(setup: Message, field_name: str) -> bool:
    """Whether a field describes an NPC rather than the player, like `other_position`."""
    prefixes = config.NOT_A_HABIT_PREFIXES + tuple(f"{npc}_" for npc in (setup.get("npcs") or {}))
    return field_name.startswith(prefixes)


def grouping_fields(setup: Message, event_name: str, group: list[Message], field_names: list[str]) -> list[str]:
    """The named fields with few options that a number can be grouped by."""
    found: list[str] = []
    for field_name in field_names:
        if _describes_other_side(setup, field_name):
            continue
        values = [(e.get("data") or {}).get(field_name) for e in group]
        values = [v for v in values if v is not None]
        if not values:
            continue
        kind, spec = field_kind(setup, event_name, field_name, values[0])
        if kind != "names":
            continue
        options = len(spec) if spec else len({str(v) for v in values})
        if options <= _MAX_GROUP_OPTIONS:
            found.append(field_name)
    return found


def group_means(group: list[Message], number_field: str, by_field: str) -> list[tuple[str, float, int]]:
    """The number's mean for each value of `by_field` with enough events, biggest group first."""
    numbers: dict[str, list[float]] = {}
    for event in group:
        data = event.get("data") or {}
        number, name = data.get(number_field), data.get(by_field)
        if _is_number(number) and name is not None:
            numbers.setdefault(str(name), []).append(float(number))
    kept = [(name, sum(xs) / len(xs), len(xs)) for name, xs in numbers.items() if len(xs) >= _MIN_GROUP_USES]
    return sorted(kept, key=lambda item: -item[2])


def number_groupings(group: list[Message], number_field: str, candidates: list[str], scale: float) -> list[str]:
    """Lines like "power mean by side: forehand 0.8 (5), backhand 0.3 (3)", for the
    named fields where the number differs most between groups.

    `scale` is the number's range. A gap under _MIN_GAP_SHARE of it is left out.
    """
    scored: list[tuple[float, int, str, list[tuple[str, float, int]]]] = []
    for order, by_field in enumerate(candidates):
        means = group_means(group, number_field, by_field)
        if len(means) < 2:
            continue
        gap = max(m for _, m, _ in means) - min(m for _, m, _ in means)
        if round(gap, 2) > 0 and gap >= _MIN_GAP_SHARE * scale:
            scored.append((-gap, order, by_field, means))
    lines = []
    for _, _, by_field, means in sorted(scored, key=lambda item: item[:2])[:_MAX_GROUPINGS]:
        parts = ", ".join(f"{name} {_fmt(mean)} ({n})" for name, mean, n in means)
        lines.append(f"  - {number_field} mean by {by_field}: {parts}")
    return lines


def summarise_events(setup: Message, events: list[Message]) -> str:
    """Turn events into counts written as numbers. No adjectives.

    Player events get a line per field: how often each name was chosen, or the
    mean, minimum and maximum of a number. A number declared in `setup` also
    gets its mean for each value of the one or two named fields where it
    differs most. NPC events get one count each.
    """
    player = [e for e in events if e.get("by") == "player"]
    lines: list[str] = []

    by_name: dict[str, list[Message]] = {}
    for event in player:
        by_name.setdefault(str(event.get("name")), []).append(event)

    for name, group in by_name.items():
        about = setup.get("events", {}).get(name, {}).get("about")
        head = f"Player `{name}` events: {len(group)}"
        lines.append(f"{head} ({about})" if about else head)

        field_names: list[str] = list(setup.get("events", {}).get(name, {}).get("fields", {}).keys())
        for event in group:
            for key in (event.get("data") or {}):
                if key not in field_names:
                    field_names.append(key)

        group_by = grouping_fields(setup, name, group, field_names)

        for field_name in field_names:
            values = [(e.get("data") or {}).get(field_name) for e in group]
            values = [v for v in values if v is not None]
            if not values:
                continue
            kind, spec = field_kind(setup, name, field_name, values[0])
            if kind == "names":
                counts = Counter(str(v) for v in values)
                options = [str(o) for o in spec] or sorted(counts)
                extra = [o for o in counts if o not in options]
                parts = [f"{o} {counts.get(o, 0)} of {len(values)}" for o in options + extra]
                lines.append(f"- {field_name}: " + ", ".join(parts))
            elif kind == "number":
                numbers = [float(v) for v in values if _is_number(v)]
                if not numbers:
                    continue
                mean = sum(numbers) / len(numbers)
                line = f"- {field_name}: mean {_fmt(mean)}, min {_fmt(min(numbers))}, max {_fmt(max(numbers))}"
                if isinstance(spec, dict):
                    scale = f"scale {_fmt(spec.get('min', 0))} to {_fmt(spec.get('max', 1))}"
                    line += f" ({scale}: {spec['about']})" if spec.get("about") else f" ({scale})"
                lines.append(line)
                if _declared_number(setup, name, field_name):
                    if isinstance(spec, dict) and "min" in spec and "max" in spec:
                        scale = float(spec["max"]) - float(spec["min"])
                    else:
                        scale = max(numbers) - min(numbers)
                    lines.extend(number_groupings(group, field_name, group_by, scale))

    npc_counts = Counter(
        (str(e.get("by")), str(e.get("name"))) for e in events if e.get("by") not in (None, "player")
    )
    if npc_counts:
        lines.append(
            "NPC events: " + ", ".join(f"{by} `{name}` {n}" for (by, name), n in sorted(npc_counts.items()))
        )
    return "\n".join(lines)


def previous_values_line(player: PlayerState) -> str:
    """The running read as one line of text, for the feed-back switch."""
    if not player.values:
        return ""
    parts = ", ".join(f"{name} {player.values[name]:.2f}" for name in sorted(player.values))
    return f"Our previous read of this player, each from 0 to 1: {parts}."


def _as_jpeg(view: dict[str, Any]) -> str | None:
    """The view's picture as base64 JPEG about 384 pixels wide, or None if it can't be read."""
    data = view.get("data")
    if not isinstance(data, str) or not data:
        return None
    mime = str(view.get("mime_type", "image/jpeg")).lower()
    if mime in ("image/jpeg", "image/jpg"):
        return data
    from PIL import Image  # only needed when a game sends something other than JPEG

    image = Image.open(io.BytesIO(base64.b64decode(data))).convert("RGB")
    if image.width > _FRAME_WIDTH:
        image = image.resize((_FRAME_WIDTH, round(image.height * _FRAME_WIDTH / image.width)))
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=80)
    return base64.b64encode(out.getvalue()).decode("ascii")


def build_input(
    match: MatchState, recent: list[Message], *, feed_back: bool
) -> tuple[list[dict[str, Any]], list[str]]:
    """The Decisions API input for one read, and the names of the views it used."""
    setup = match.setup
    seconds = config.WATCH_WINDOW_SECONDS
    rounds = sorted({e.get("round") for e in recent if e.get("round") is not None})
    head = [f"Game: {setup.get('about', setup.get('game', 'unknown'))}"]
    head.append(
        f"The last {_fmt(seconds)} seconds of play"
        + (f" (round {', '.join(str(r) for r in rounds)})" if rounds else "")
        + ", as exact counts. Questions are about the human player."
    )
    text = "\n".join(head) + "\n\n" + (summarise_events(setup, recent) or "No player events yet.")
    if feed_back:
        line = previous_values_line(match.player)
        if line:
            text += "\n\n" + line
    parts: list[dict[str, Any]] = [{"type": "text", "text": text}]

    used: list[str] = []
    frames = match.frames or {}
    for view_name, view in (frames.get("views") or {}).items():
        jpeg = _as_jpeg(view) if isinstance(view, dict) else None
        if jpeg is None:
            continue
        described = setup.get("views", {}).get(view_name)
        label = f"Latest `{view_name}` frame" + (f": {described}" if described else ".")
        parts.append({"type": "text", "text": label})
        parts.append({"type": "image", "mime_type": "image/jpeg", "data": jpeg, "resolution": "low"})
        used.append(view_name)
    return parts, used


# ---------------------------------------------------------------- the answers


def api_questions(values: list[ValueSpec]) -> dict[str, dict[str, Any]]:
    """The designer's questions, without the keys only our code reads."""
    return {
        spec.name: {k: v for k, v in spec.question.items() if k not in _LOCAL_KEYS}
        for spec in values
    }


def to_value(question: dict[str, Any], answer: dict[str, Any]) -> tuple[float, float]:
    """Turn one Decisions API answer into (value from 0 to 1, confidence)."""
    kind = answer.get("type") or question.get("type")
    confidence = float(answer.get("confidence", 0.0))
    if kind == "noul":
        value = float(answer.get("noul", 0.0))
    elif kind == "score":
        criteria = question.get("criteria") or answer.get("legend") or []
        levels = len(criteria)
        value = float(answer.get("score", 0.0)) / (levels - 1) if levels > 1 else 0.0
    elif kind == "choice":
        probabilities = {str(k): float(p) for k, p in (answer.get("probabilities") or {}).items()}
        wanted = question.get("value_of")
        if wanted is not None:
            value = probabilities.get(str(wanted), 0.0)
        else:
            value = max(probabilities.values(), default=0.0)
    else:
        raise ValueError(f"unknown answer type {kind!r}")
    return min(max(value, 0.0), 1.0), min(max(confidence, 0.0), 1.0)


def blend(old: float | None, reading: float, confidence: float, factor: float) -> float:
    """Move `old` toward `reading` by `factor` times `confidence`. A first reading is taken as is."""
    if old is None:
        return reading
    step = min(max(factor * confidence, 0.0), 1.0)
    return old + step * (reading - old)


def update_player(
    player: PlayerState, readings: dict[str, tuple[float, float]], factor: float
) -> dict[str, float | None]:
    """Blend readings into the running state in place. Returns each value's old number."""
    before: dict[str, float | None] = {}
    for name, (reading, confidence) in readings.items():
        old = player.values.get(name)
        before[name] = old
        player.values[name] = round(blend(old, reading, confidence, factor), 4)
        old_conf = player.confidence.get(name)
        player.confidence[name] = round(blend(old_conf, confidence, 1.0, factor), 4)
    player.reads += 1
    return before


def events_phrase(recent: list[Message]) -> str:
    """How to name the player's recent events: "9 shot events", or "9 player events" for a mix."""
    names = [str(e.get("name")) for e in recent if e.get("by") == "player"]
    kinds = set(names)
    kind = next(iter(kinds)).replace("_", " ") if len(kinds) == 1 else "player"
    return f"{len(names)} {kind} event" + ("" if len(names) == 1 else "s")


def explain(
    before: dict[str, float | None],
    player: PlayerState,
    labels: dict[str, str],
    rests_on: dict[str, str],
) -> str:
    """One short line naming the biggest change and what it rests on, in plain words.

    The numbers travel in `values`, so the line carries counts but no 0 to 1 scores.
    `labels` maps each value to its plain `about` line. `rests_on` says, for
    each value, what the value rests on.
    """
    names = [n for n in player.values if n in rests_on]
    if not names:
        return "No values were read."

    def label(name: str) -> str:
        text = (labels.get(name) or name.replace("_", " ")).strip().rstrip(".")
        return text[:1].upper() + text[1:]

    if all(before.get(n) is None for n in names):
        name = max(names, key=lambda n: player.values[n])
        return f"{label(name)}: strongest on the first read. {rests_on[name]}"
    name = max(names, key=lambda n: abs(player.values[n] - (before.get(n) or 0.0)))
    change = player.values[name] - (before.get(name) or 0.0)
    word = "steady" if abs(change) < 0.005 else ("stronger" if change > 0 else "weaker")
    return f"{label(name)}: {word}. {rests_on[name]}"


# ---------------------------------------------------------------- the watcher


class DecisionsWatcher:
    """Implements interfaces.Watcher with the Gemini Decisions API."""

    def __init__(
        self,
        blend_factor: float | None = None,
        feed_back_state: bool | None = None,
        ask: Ask | None = None,
    ) -> None:
        self.blend_factor = BLEND if blend_factor is None else blend_factor
        self.feed_back_state = FEED_BACK_STATE if feed_back_state is None else feed_back_state
        self._ask: Ask = ask or decisions_client.ask
        self._busy: set[str] = set()

    async def warm(self) -> None:
        """Open the connection with one tiny real call, so a match's first read
        doesn't pay for it. Call it when `setup` arrives. Never raises."""
        try:
            await self._ask(
                [{"type": "text", "text": "Connection check."}],
                {"ok": {"type": "noul", "instructions": "Is this text a connection check?"}},
            )
        except Exception:
            pass

    async def _ask_with_retry(
        self, parts: list[dict[str, Any]], questions: dict[str, dict[str, Any]]
    ) -> dict[str, Any]:
        """Ask once, and once more if the first try is slow or fails. A spent credit isn't retried."""
        try:
            return await asyncio.wait_for(self._ask(parts, questions), timeout=READ_TIMEOUT_SECONDS)
        except Exception as error:
            if "402" in str(error):
                raise
            return await asyncio.wait_for(self._ask(parts, questions), timeout=READ_TIMEOUT_SECONDS)

    async def read(self, match: MatchState) -> Message | None:
        """Read the player. Never raises: on any error it traces and returns None."""
        if match.match_id in self._busy:
            return None  # a read for this match is still running
        self._busy.add(match.match_id)
        started = time.perf_counter()
        model = config.WATCHER_MODEL
        try:
            return await self._read(match, started, model)
        except Exception as error:  # the game must never see an error from here
            ms = (time.perf_counter() - started) * 1000
            try:
                match.trace(trace_message(
                    "watcher", "error", f"The player read failed: {type(error).__name__}: {error}"[:300],
                    model=model, ms=ms,
                ))
            except Exception:
                pass
            return None
        finally:
            self._busy.discard(match.match_id)

    async def _read(self, match: MatchState, started: float, model: str) -> Message | None:
        specs = match.design.values
        if not specs:
            return None
        player_events = sum(1 for e in match.events if e.get("by") == "player")
        frames_t = (match.frames or {}).get("t")
        memory = match.player.memory
        # Nothing new since the last read: the answer would be the same.
        if player_events == memory.get("seen_player_events", 0) and frames_t == memory.get("seen_frames_t"):
            return None
        if player_events == 0 and not match.frames:
            return None

        recent = window(match.events, config.WATCH_WINDOW_SECONDS)
        recent_player = sum(1 for e in recent if e.get("by") == "player")
        parts, views_used = build_input(match, recent, feed_back=self.feed_back_state)
        frame_word = "frame" if len(views_used) == 1 else "frames"
        match.trace(trace_message(
            "watcher", "start",
            f"Reading the player from {recent_player} events and {len(views_used)} {frame_word}.",
            model=model,
        ))

        targets = {spec.name: anchors.target_for(match.setup, spec) for spec in specs}
        targets = {n: (anchors.resolve(t, match.events) if t else None) for n, t in targets.items()}
        questions = api_questions(specs)
        for name, target in targets.items():
            if target is not None:
                questions[name] = anchors.next_action_question(target)
        reply = await self._ask_with_retry(parts, questions)
        answers = reply.get("answers") or {}

        readings: dict[str, tuple[float, float]] = {}
        for spec in specs:
            answer = answers.get(spec.name)
            if not isinstance(answer, dict):
                continue
            target = targets[spec.name]
            if target is not None:
                readings[spec.name] = anchors.share_from_answer(target, answer)
            else:
                readings[spec.name] = to_value(spec.question, answer)
        if not readings:
            raise ValueError("the reply had no answers for our questions")

        before: dict[str, float | None] = {n: match.player.values.get(n) for n in readings}
        looked = (" and the latest " + " and ".join(views_used) + " " + frame_word) if views_used else ""
        read_words = f"the model's read of the last {events_phrase(recent)}{looked}"
        liked = [spec.name[len(anchors.LIKE):] for spec in specs if spec.name.startswith(anchors.LIKE)]
        likeness, liked_over = anchors.persona_likeness(match.setup, match.design.personas, match.events, liked)
        thin: set[str] = set()  # anchored values with too few events to call a habit yet
        rests_on: dict[str, str] = {}
        anchored: dict[str, tuple[float, float]] = {}
        for spec in specs:
            if spec.name not in readings:
                continue
            reading, confidence = readings[spec.name]
            target = targets[spec.name]
            persona = spec.name[len(anchors.LIKE):] if spec.name.startswith(anchors.LIKE) else None
            if target is not None:
                share, uses, n = anchors.counted_share(match.events, target)
                weight = anchors.count_weight(n)
                if n < anchors.MIN_EVENTS:
                    thin.add(spec.name)
                # A count is sure of itself: confidence grows with the events behind it.
                anchored[spec.name] = (weight * share + (1 - weight) * reading, weight + (1 - weight) * confidence)
                what = " or ".join(o.replace("_", " ") for o in target.options)
                field = target.field.replace("_", " ")
                event = target.event.replace("_", " ")
                if n == 0:
                    rests_on[spec.name] = f"No {event} events yet, so this rests on {read_words}."
                elif weight >= 0.5:
                    rests_on[spec.name] = (f"{uses} of the last {n} {event} events had {field} {what}, "
                                           f"so this rests mostly on that count.")
                else:
                    so_far = f"{n} {event} event" + ("" if n == 1 else "s")
                    rests_on[spec.name] = (f"Only {so_far} so far ({uses} with {field} {what}), "
                                           f"so this rests mostly on {read_words}.")
            elif persona is not None and persona in likeness:
                weight = anchors.count_weight(liked_over)
                if liked_over < anchors.MIN_EVENTS:
                    thin.add(spec.name)
                anchored[spec.name] = (weight * likeness[persona] + (1 - weight) * reading,
                                       weight + (1 - weight) * confidence)
                lead = "mostly on how well" if weight >= 0.5 else "partly on how well"
                rests_on[spec.name] = (f"This rests {lead} this kind of player explains the player's "
                                       f"counted choices over {liked_over} events, and on {read_words}.")
            elif persona is not None:
                rests_on[spec.name] = (f"This rests on {read_words} alone: this kind of player "
                                       f"has no numbers to compare the counts with yet.")
            else:
                rests_on[spec.name] = f"This rests on {read_words}."
        unanchored = {n: r for n, r in readings.items() if n not in anchored}
        update_player(match.player, unanchored, self.blend_factor)  # also counts this read
        for name, (value, confidence) in anchored.items():
            match.player.values[name] = round(value, 4)
            old_conf = match.player.confidence.get(name)
            match.player.confidence[name] = round(blend(old_conf, confidence, 1.0, self.blend_factor), 4)
        memory["seen_player_events"] = player_events
        memory["seen_frames_t"] = frames_t
        history = memory.setdefault("readings", [])
        history.append({
            "t": _latest_t(match),
            "values": {n: round(v, 4) for n, (v, _) in readings.items()},
            "confidence": {n: round(c, 4) for n, (_, c) in readings.items()},
        })
        del history[:-_KEEP_READINGS]

        low = sorted(
            spec.name for spec in specs
            if match.player.confidence.get(spec.name, 0.0) < config.MIN_CONFIDENCE or spec.name in thin
        )
        message: Message = {
            "type": "player_read",
            "match_id": match.match_id,
            "round": _latest_round(match),
            "t": _latest_t(match),
            "values": {spec.name: round(match.player.values.get(spec.name, 0.0), 3) for spec in specs},
            "based_on_events": player_events,
            "why": explain(before, match.player, {spec.name: spec.about for spec in specs}, rests_on),
            "low_confidence": low,
        }
        if views_used:
            message["picture_note"] = f"Looked at the latest {' and '.join(views_used)} {frame_word}."

        ms = (time.perf_counter() - started) * 1000
        tokens = (reply.get("usage") or {}).get("total_input_tokens")
        match.trace(trace_message(
            "watcher", "done",
            f"Read the player from {recent_player} events and {len(views_used)} {frame_word}.",
            model=model, ms=ms,
            data={"values": message["values"], "low_confidence": low, "input_tokens": tokens},
        ))
        return message


def _latest_t(match: MatchState) -> float:
    times = [float(e.get("t") or 0) for e in match.events]
    if match.frames and match.frames.get("t") is not None:
        times.append(float(match.frames["t"]))
    return max(times, default=0.0)


def _latest_round(match: MatchState) -> int:
    if match.events:
        return int(match.events[-1].get("round") or 0)
    if match.frames:
        return int(match.frames.get("round") or 0)
    return 0
