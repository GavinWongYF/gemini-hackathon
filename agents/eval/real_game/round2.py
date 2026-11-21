"""python -m eval.real_game.round2: an open-ended match, measured.

One command plays an open-ended match on the real engine for each scripted
player, in real time, through the live match runner. There is no cap on
points and no breaks: play stops at the first point that ends after the time
limit. Then it reports, for each player:

  - how many strategy_update messages went out, when each was sent, and how
    long each waited before the game swapped it in,
  - how many added strength, eased, held, or only moved a dial,
  - whether strength was ever added when the player had lost the most recent
    round,
  - how many player_read messages arrived per point and per second, and how
    often the top values changed order or moved a lot within a point,
  - the player's share of points in each time window,
  - for each window, the clearest change and its one line reason.

Every number is a setting: see round2_settings.json beside this file. This
tool only measures. It tunes nothing.

How an update is sorted. Its behaviour is compared with the behaviour sent
just before it, and its settings with the last settings sent:

  held      nothing differs
  added     more rules or more weight tied to the player's habits, or a dial
            moved the harder way (settings: dial_harder)
  eased     fewer rules or less such weight, or a dial moved the easier way
  mixed     some of each
  reshaped  the base weights moved and nothing else did
  dial only the behaviour is the same and a dial moved (counted on top of
            added or eased)

From `agents/`, with an agent server running on a port of your own:

  ./.venv/bin/python -m eval.real_game.round2 --game-root <folder with client/ and shared/> \
      --url ws://localhost:<port>/ws

  --settings FILE   another settings file (default: round2_settings.json here)
  --runs N, --players a,b, --seconds S, --pace P, --parallel N   override the settings file
  --baseline-url U  a server started with --no-adapt: each run is also played against it on
                    the same seed, so a drop in the player's share can be told from luck
  --logs DIR        measure the match logs already in DIR instead of playing
  --label TEXT      a note stored in the JSON, such as which server code this was

It writes one JSON file, round2.json, in the output folder and prints one
short table.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from eval.real_game.proof import tsx

HERE = Path(__file__).resolve().parent

# What the engine cannot do as it stands, for a scripted player meant to stand in for a person.
ENGINE_LIMITS = [
    "A game copy whose plan still has a point cap is played past it, with a very large point count and no "
    "breaks. A copy with an open-ended plan is set up the way its own live view sets it up. Either way the "
    "plan in `setup` is the game's own, and the runner stops on time.",
    "The game swaps a new behaviour in only when the next point starts, never inside a point. So every update "
    "waits out the rest of the point it arrives in.",
    "The runner sends events and round ends, not camera frames. Every player_read counted here was started by "
    "an event. Reads that pictures alone would start are not exercised.",
    "A script cannot steer the player. It sets a home depth and an arm position, and the engine does the "
    "rest (the newest copy runs the player in to short balls by itself). A script cannot choose to run "
    "around its backhand or to stand somewhere new after the opponent changes.",
    "There is no skill setting for the player. Contact quality comes from where the ball is when the swing "
    "happens. The three levels stand in for skill with a miss rate, a flat contact penalty and swing power. "
    "Swinging too early or too late is not modelled: every script swings inside the ideal window.",
    "The player has three shot types (topspin, slice, dropshot) and never serves. The opponent serves every point.",
    "The player that reacts cannot see the opponent's rules. It changes its aim side or its shot mix after "
    "the opponent's behaviour changed and it then lost points, which is what a person could notice.",
]


def play(args: Any, settings: dict[str, Any], settings_path: Path, game_root: Path, out: Path,
         player: str, index: int, stamp: str, twin: bool = False) -> dict[str, Any]:
    # A twin is the same player on the same seed against the unchanged opponent, to tell a drop from luck.
    match_id = f"{'twin' if twin else 'r2'}_{player}_{index}_{stamp}"
    log_path = out / f"{match_id}.jsonl"
    flags = [
        "--url", args.baseline_url if twin else args.url, "--player", player, "--seconds", str(settings["match_seconds"]),
        "--pace", str(settings["pace"]), "--linger", str(settings["linger_seconds"]),
        "--seed", str(settings["seed"] * 1000 + index), "--match-id", match_id, "--log", str(log_path),
        "--player-settings", str(settings_path), "--quiet",
    ]
    if args.personas:
        flags += ["--personas", args.personas]
    done = subprocess.run(tsx(game_root, "live_match.mts", *flags), capture_output=True, text=True)
    if args.verbose:
        print(f"done {match_id} (exit {done.returncode})", file=sys.stderr, flush=True)
    return {"player": player, "run": index, "match_id": match_id, "log": log_path, "twin": twin,
            "exit": done.returncode, "stderr": done.stderr[-2000:]}


# ---- sorting one update ------------------------------------------------------

def without_version(behaviour: dict[str, Any] | None) -> str:
    return json.dumps({k: v for k, v in (behaviour or {}).items() if k != "version"}, sort_keys=True)


def strength(behaviour: dict[str, Any] | None) -> tuple[int, float]:
    """How much of a behaviour is aimed at this player: its rules, and the weight tied to what was read."""
    rules, lift = 0, 0.0
    for npc in ((behaviour or {}).get("npcs") or {}).values():
        rules += len(npc.get("rules") or [])
        for options in (npc.get("decisions") or {}).values():
            for spec in (options or {}).values():
                if isinstance(spec, dict):
                    lift += sum(v for v in (spec.get("when") or {}).values() if isinstance(v, (int, float)))
    return rules, round(lift, 4)


def behaviour_move(before: dict[str, Any] | None, after: dict[str, Any] | None) -> tuple[str, float]:
    if without_version(before) == without_version(after):
        return "same", 0.0
    (rules0, lift0), (rules1, lift1) = strength(before), strength(after)
    d_rules, d_lift = rules1 - rules0, round(lift1 - lift0, 4)
    size = abs(d_rules) + abs(d_lift)
    if d_rules == 0 and d_lift == 0:
        return "reshaped", size
    if d_rules >= 0 and d_lift >= 0:
        return "added", size
    if d_rules <= 0 and d_lift <= 0:
        return "eased", size
    return "mixed", size


def pick_shares(behaviour: dict[str, Any] | None, values: dict[str, Any]) -> dict[tuple[str, str], float]:
    """Each option's share of its decision's picks from the weights alone, at these values. Rules are not counted."""
    shares: dict[tuple[str, str], float] = {}
    for npc in ((behaviour or {}).get("npcs") or {}).values():
        for decision, options in (npc.get("decisions") or {}).items():
            weights = {}
            for option, spec in (options or {}).items():
                if isinstance(spec, dict):
                    lift = sum(w * float(values.get(k) or 0) for k, w in (spec.get("when") or {}).items()
                               if isinstance(w, (int, float)))
                    weights[option] = max(0.0, float(spec.get("base") or 0) + lift)
                elif isinstance(spec, (int, float)):
                    weights[option] = max(0.0, float(spec))
            total = sum(weights.values()) or 1.0
            for option, weight in weights.items():
                shares[(decision, option)] = weight / total
    return shares


def biggest_rise(before: dict[str, Any] | None, after: dict[str, Any] | None, values: dict[str, Any]) -> dict[str, Any] | None:
    old, new = pick_shares(before, values), pick_shares(after, values)
    rises = [(new[key] - old.get(key, 0.0), key) for key in new]
    if not rises:
        return None
    rise, (decision, option) = max(rises)
    return {"rise": round(rise, 3), "decision": decision, "option": option}


def first_text(*candidates: Any) -> str | None:
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
        if isinstance(candidate, list):
            for item in candidate:
                if isinstance(item, str) and item.strip():
                    return item.strip()
    return None


def sort_update(message: dict[str, Any], before: dict[str, Any] | None, dials: dict[str, Any],
                settings: dict[str, Any]) -> dict[str, Any]:
    """What one strategy_update did, judged from what it carries and not from what it says."""
    changes = message.get("changes") or []
    move, size = behaviour_move(before, message.get("behaviour"))
    moved: dict[str, list[Any]] = {}
    parts = set() if move == "same" else {move}
    for name, value in (message.get("settings") or {}).items():
        if dials.get(name) != value:
            moved[name] = [dials.get(name), value]
            harder = settings["dial_harder"].get(name)
            went_up = isinstance(value, (int, float)) and isinstance(dials.get(name), (int, float)) and value > dials[name]
            parts.add("reshaped" if harder not in ("up", "down") or not isinstance(dials.get(name), (int, float))
                      else "added" if went_up == (harder == "up") else "eased")
    if not parts:
        kind = "held"
    elif "mixed" in parts or {"added", "eased"} <= parts:
        kind = "mixed"
    elif "added" in parts:
        kind = "added"
    elif "eased" in parts:
        kind = "eased"
    else:
        kind = "reshaped"

    flag = message.get("holding", message.get("hold"))
    says_holding = bool(flag) or not changes
    setting_changes = [c for c in changes if str(c.get("where", "")).startswith("settings.")]
    other_changes = [c for c in changes if c not in setting_changes]
    if kind == "held":
        reason = first_text(flag, message.get("why"), message.get("reason"), message.get("plan"), message.get("observations"))
    elif other_changes:
        reason = first_text(*[c.get("why") for c in other_changes], message.get("observations"))
    else:
        reason = first_text(*[c.get("why") for c in setting_changes], message.get("observations"))
    if reason and reason.lower().startswith("fairness adjustment:"):
        reason = reason.split(":", 1)[1].strip().capitalize()

    faults = []
    if says_holding and kind != "held":
        faults.append("says it holds (no changes listed) while the behaviour or a setting changed")
    if kind == "held" and changes:
        faults.append("lists changes while nothing changed")
    if kind == "held" and not reason:
        faults.append("holds with no reason given")
    if kind != "held" and any(not c.get("why") for c in changes):
        faults.append("a change with no reason given")

    return {
        "kind": kind, "dial_only": move == "same" and bool(moved), "adds_strength": "added" in parts or move == "mixed",
        "behaviour": move, "size": round(size, 3), "settings_moved": moved,
        "changes_listed": [str(c.get("where")) for c in changes], "says_holding": says_holding,
        "headline": first_text(message.get("plan"), [str(c.get("where")) for c in other_changes or setting_changes]),
        "reason": reason, "faults": faults,
    }


# ---- one run -----------------------------------------------------------------

def boosted(behaviour: dict[str, Any] | None) -> set[tuple[str, str]]:
    """The (decision, option) pairs whose weight grows with something read about the player."""
    found: set[tuple[str, str]] = set()
    for npc in ((behaviour or {}).get("npcs") or {}).values():
        for decision, options in (npc.get("decisions") or {}).items():
            for option, spec in (options or {}).items():
                if isinstance(spec, dict) and spec.get("when"):
                    found.add((decision, option))
    return found


def top(values: dict[str, Any], count: int) -> list[str]:
    numbers = {k: v for k, v in (values or {}).items() if isinstance(v, (int, float))}
    return sorted(numbers, key=lambda k: (-numbers[k], k))[:count]


def measure(match: dict[str, Any], settings: dict[str, Any]) -> dict[str, Any] | None:
    path = Path(match["log"])
    if not path.exists():
        return None
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    summary = next((r["summary"] for r in rows if r["dir"] == "summary"), None)
    if summary is None:
        return None
    pace = summary.get("pace")
    scale = float(pace) if str(pace).replace(".", "", 1).isdigit() else 1.0  # wall seconds to game seconds

    points: dict[int, dict[str, Any]] = {}
    sent: list[tuple[float, dict[str, Any]]] = []
    reads: list[tuple[float, dict[str, Any]]] = []
    ready: dict[str, Any] | None = None
    behaviours: dict[Any, Any] = {}
    dials: dict[str, Any] = {}
    for row in rows:
        message = row.get("message") or {}
        kind = message.get("type")
        if row["dir"] == "out" and kind == "setup":
            dials = {name: spec.get("now") for name, spec in (message.get("settings") or {}).items() if isinstance(spec, dict)}
        elif row["dir"] == "out" and kind == "event":
            here = points.setdefault(message["round"], {})
            data = message.get("data") or {}
            if message["name"] == "shot" and message["by"] == "player":
                here.setdefault("qualities", []).append(data.get("quality"))
            elif message["name"] == "missed_swing":
                here["missed"] = here.get("missed", 0) + 1
            elif message["name"] == "shot" and message["by"] == "opponent":
                here.setdefault("opponent_shots", []).append(message)
        elif row["dir"] == "out" and kind == "round_end":
            points.setdefault(message["round"], {}).update(round=message["round"], winner=message["winner"],
                                                           how=message.get("how"),
                                                           rally=(message.get("stats") or {}).get("rally_length", 0))
        elif row["dir"] == "meta":
            points.setdefault(row["round"], {}).update(start=row.get("wall_start"), end=row.get("wall"),
                                                       version=row.get("version"),
                                                       speed=(row.get("settings") or {}).get("opponent_speed"))
        elif row["dir"] == "in" and kind == "ready":
            ready = message.get("behaviour")
            behaviours[(ready or {}).get("version")] = ready
        elif row["dir"] == "in" and kind == "strategy_update":
            sent.append((row.get("wall") or 0.0, message))
            behaviours[(message.get("behaviour") or {}).get("version", message.get("version"))] = message.get("behaviour")
        elif row["dir"] == "in" and kind == "player_read":
            reads.append((row.get("wall") or 0.0, message.get("values") or {}))

    played = sorted((p for p in points.values() if "winner" in p and p.get("start") is not None), key=lambda p: p["round"])
    if not played:
        return None
    zero, last = played[0]["start"], played[-1]["end"]
    since = lambda wall: round((wall - zero) * scale, 2)  # noqa: E731
    seconds = since(last)
    window = float(settings["window_seconds"])
    # The point in progress when the time is up belongs to the last window, not to a window of its own.
    last_window = max(0, -(-int(float(summary.get("open_ended_seconds") or settings["match_seconds"])) // int(window)) - 1)
    window_of = lambda at: min(last_window, max(0, int(at // window)))  # noqa: E731

    # the updates
    swaps = summary.get("updates") or []
    before = ready
    updates: list[dict[str, Any]] = []
    for index, (wall, message) in enumerate(sent):
        sorted_ = sort_update(message, before, dials, settings)
        for name, (_, value) in sorted_["settings_moved"].items():
            dials[name] = value
        values_then = next((values for at, values in reversed(reads) if at <= wall), {})
        rise = biggest_rise(before, message.get("behaviour"), values_then) if sorted_["behaviour"] != "same" else None
        rules_then = sum(len(npc.get("rules") or []) for npc in ((before or {}).get("npcs") or {}).values())
        rules_now = sum(len(npc.get("rules") or []) for npc in ((message.get("behaviour") or {}).get("npcs") or {}).values())
        if rise and rise["rise"] > settings["max_added_share"] + 1e-9:
            sorted_["faults"].append(f"raises one option by more than {settings['max_added_share']} of its decision's picks")
        before = message.get("behaviour") or before
        swap = swaps[index] if index < len(swaps) else {}
        swapped = swap.get("swapped_wall")
        finished = [p for p in played if p["end"] <= wall]
        in_point = any(p["start"] <= wall <= p["end"] for p in played)
        later = [w for w, _ in sent[index + 1:]]
        next_serve = next((p["start"] for p in played if p["start"] > wall), None)
        entry = {
            "n": index + 1, "version": message.get("version"), "writer": message.get("writer"),
            "source": message.get("source"), "sent_at": since(wall),
            "window": window_of(since(wall)),
            "sent_during": "a point" if in_point else "the gap between points",
            # The game swaps whatever is waiting at the next serve, so that serve ends the wait. When a later
            # update lands first, this one's play goes in under the later version (a holding update repeats it).
            "waited_before_swap_in": round((next_serve - wall) * scale, 2) if next_serve is not None else None,
            "played_under_its_own_version": swapped is not None,
            "first_round_played": swap.get("first_round_played"),
            "never_swapped_in_because": None if next_serve is not None else "the match ended first",
            "replaced_before_the_next_serve": bool(later and next_serve is not None and later[0] < next_serve),
            "biggest_pick_share_rise": rise, "rules_added": rules_now - rules_then,
            "last_round_before": ({"round": finished[-1]["round"], "winner": finished[-1]["winner"]} if finished else None),
            **sorted_,
        }
        entry["added_after_player_lost"] = bool(entry["adds_strength"] and finished and finished[-1]["winner"] != "player")
        updates.append(entry)

    # the reads
    count, move = int(settings["top_values"]), float(settings["value_move"])
    pairs = reordered = moved = 0
    points_with_pairs = points_reordered = points_moved = 0
    per_point: list[int] = []
    for p in played:
        mine = [values for wall, values in reads if p["start"] <= wall <= p["end"]]
        per_point.append(len(mine))
        any_reordered = any_moved = False
        for earlier, later_values in zip(mine, mine[1:]):
            pairs += 1
            names = top(earlier, count)
            if names != top(later_values, count):
                reordered += 1
                any_reordered = True
            if any(abs((later_values.get(n) or 0) - (earlier.get(n) or 0)) > move for n in names):
                moved += 1
                any_moved = True
        if len(mine) >= 2:
            points_with_pairs += 1
            points_reordered += any_reordered
            points_moved += any_moved
    read_stats = {
        "total": len(reads), "in_points": sum(per_point), "points": len(played),
        "points_with_no_read": sum(1 for n in per_point if n == 0),
        "pairs_within_a_point": pairs, "pairs_reordered": reordered, "pairs_moved": moved,
        "points_with_two_or_more": points_with_pairs, "points_reordered": points_reordered, "points_moved": points_moved,
    }

    # the windows
    windows: list[dict[str, Any]] = []
    for index in range(last_window + 1):
        start, end = index * window, (index + 1) * window
        mine = [p for p in played if window_of(since(p["end"])) == index]
        here = [u for u in updates if u["window"] == index]
        if not mine and not here:
            continue
        qualities = [q for p in mine for q in p.get("qualities", []) if isinstance(q, (int, float))]
        opponent_shots = with_counter = 0
        for p in mine:
            lifted = boosted(behaviours.get(p.get("version")))
            for shot in p.get("opponent_shots", []):
                opponent_shots += 1
                picked = shot.get("picked") or {}
                with_counter += bool(shot.get("by_rule") or any((d, o) in lifted for d, o in picked.items()))
        order = {"added": 4, "mixed": 4, "eased": 4, "reshaped": 3, "held": 0}
        ranked = sorted(here, key=lambda u: (0 if u["kind"] == "held" else 1 if u["dial_only"] else 2,
                                             u["size"] if not u["dial_only"] else 0, order[u["kind"]], u["n"]))
        shown = ranked[-1] if ranked else None
        wins = sum(1 for p in mine if p["winner"] == "player")
        # Which practice player the reads said this player was most like when the window closed.
        at_close = next((values for at, values in reversed(reads) if since(at) <= (end if index < last_window else seconds)), {})
        likes = {k[len("like_"):]: v for k, v in at_close.items() if k.startswith("like_") and isinstance(v, (int, float))}
        read_as = max(likes, key=lambda k: likes[k]) if likes else None
        windows.append({
            "read_as": read_as, "read_as_value": likes.get(read_as) if read_as else None,
            "window": index, "from": start, "to": max(end, seconds) if index == last_window else end,
            "points": len(mine), "player_points": wins,
            "player_share": round(wins / len(mine), 3) if mine else None,
            "exchanges": sum(p.get("rally", 0) for p in mine),
            "quality_sum": round(sum(qualities), 3), "player_shots": len(qualities),
            "missed_swings": sum(p.get("missed", 0) for p in mine),
            "opponent_shots": opponent_shots, "opponent_shots_with_counter": with_counter,
            "speeds": sorted({p["speed"] for p in mine if p.get("speed") is not None}),
            "updates": dict(Counter(u["kind"] for u in here)),
            "dial_only": sum(1 for u in here if u["dial_only"]),
            "shown": ({"version": shown["version"], "kind": shown["kind"], "dial_only": shown["dial_only"],
                       "sent_at": shown["sent_at"], "headline": shown["headline"], "reason": shown["reason"]}
                      if shown else None),
        })

    return {
        "player": match["player"], "run": match["run"], "match_id": match["match_id"], "log": str(path),
        "seed": summary.get("seed"), "game_commit": summary.get("game_commit"),
        "seconds": seconds, "points": len(played), "score": summary.get("score"),
        "first_serve_after_connect": round(zero * scale, 2),
        "final_status": summary.get("final_status"), "mock_fallback": summary.get("mock_fallback"),
        "errors": summary.get("errors") or [], "style_changes": summary.get("style_changes"),
        "mid_round_behaviour_changes": summary.get("mid_round_behaviour_changes") or [],
        "game_would_not_apply": summary.get("game_would_not_apply") or [],
        "windows": windows, "updates": updates, "reads": read_stats,
    }


# ---- every run of one player ---------------------------------------------------

def per(total: float, count: float, digits: int = 2) -> float | None:
    return round(total / count, digits) if count else None


def spread(values: list[float]) -> dict[str, float] | None:
    if not values:
        return None
    return {"mean": round(sum(values) / len(values), 2), "min": round(min(values), 2), "max": round(max(values), 2)}


def longest_burst(held: list[dict[str, Any]]) -> int:
    """The most holding updates sent inside any one second."""
    times = sorted(u["sent_at"] for u in held)
    return max((sum(1 for other in times if 0 <= other - at < 1.0) for at in times), default=0)


def combine(runs: list[dict[str, Any]], settings: dict[str, Any]) -> dict[str, Any]:
    updates = [u for r in runs for u in r["updates"]]
    kinds = Counter(u["kind"] for u in updates)
    reads: Counter[str] = Counter()
    for r in runs:
        reads.update(r["reads"])
    seconds = sum(r["seconds"] for r in runs)
    points = sum(r["points"] for r in runs)
    windows = []
    for index in sorted({w["window"] for r in runs for w in r["windows"]}):
        mine = [w for r in runs for w in r["windows"] if w["window"] == index]
        played = sum(w["points"] for w in mine)
        windows.append({
            "window": index, "from": mine[0]["from"], "to": max(w["to"] for w in mine), "runs": len(mine),
            "points": played, "player_share": per(sum(w["player_points"] for w in mine), played, 3),
            "exchanges_per_point": per(sum(w["exchanges"] for w in mine), played),
            "contact_quality": per(sum(w["quality_sum"] for w in mine), sum(w["player_shots"] for w in mine)),
            "missed_swings_per_point": per(sum(w["missed_swings"] for w in mine), played),
            "counter_pick_share": per(sum(w["opponent_shots_with_counter"] for w in mine),
                                      sum(w["opponent_shots"] for w in mine), 3),
            "speeds": sorted({s for w in mine for s in w["speeds"]}),
            "updates": dict(sum((Counter(w["updates"]) for w in mine), Counter())),
            "read_as": [w["read_as"] for w in mine],
            "shown": [w["shown"] for w in mine if w["shown"]],
        })
    shares = [w["player_share"] for w in windows if w["player_share"] is not None]
    broke = [{"run": r["run"], "version": u["version"], "sent_at": u["sent_at"], "last_round_before": u["last_round_before"],
              "kind": u["kind"], "dial_only": u["dial_only"], "headline": u["headline"]}
             for r in runs for u in r["updates"] if u["added_after_player_lost"]]
    return {
        "runs": len(runs), "seconds": round(seconds, 1), "points": points,
        "player_share": per(sum(r["score"]["player"] for r in runs if r.get("score")), points, 3),
        "windows": windows,
        "lowest_window_share": min(shares) if shares else None,
        "windows_under_the_floor": sum(1 for s in shares if s < settings["share_floor"]),
        "updates": {
            "sent": len(updates), "per_run": per(len(updates), len(runs)),
            "added": kinds["added"], "eased": kinds["eased"], "held": kinds["held"],
            "mixed": kinds["mixed"], "reshaped": kinds["reshaped"],
            "dial_only": sum(1 for u in updates if u["dial_only"]),
            "added_strength": sum(1 for u in updates if u["adds_strength"]),
            "added_strength_after_the_player_lost": len(broke), "those": broke,
            "sent_at": [u["sent_at"] for u in updates],
            "first_sent_at": spread([min(u["sent_at"] for u in r["updates"]) for r in runs if r["updates"]]),
            "waited_before_swap_in": spread([u["waited_before_swap_in"] for u in updates if u["waited_before_swap_in"] is not None]),
            "never_swapped_in": dict(Counter(u["never_swapped_in_because"] for u in updates if u["never_swapped_in_because"])),
            "sent_during": dict(Counter(u["sent_during"] for u in updates)),
            "by_writer": dict(Counter(str(u["writer"]) for u in updates)),
            "replaced_before_the_next_serve": sum(1 for u in updates if u["replaced_before_the_next_serve"]),
            "biggest_pick_share_rise": max((u["biggest_pick_share_rise"]["rise"] for u in updates
                                            if u["biggest_pick_share_rise"]), default=None),
            "longest_run_of_holds_in_one_second": longest_burst([u for u in updates if u["kind"] == "held"]),
            "faults": dict(Counter(f for u in updates for f in u["faults"])),
        },
        "reads": {
            "total": reads["total"], "per_point": per(reads["in_points"], points), "per_second": per(reads["total"], seconds),
            "points_with_no_read": reads["points_with_no_read"],
            "pairs_within_a_point": reads["pairs_within_a_point"],
            "top_reordered_share_of_pairs": per(reads["pairs_reordered"], reads["pairs_within_a_point"], 3),
            "top_moved_share_of_pairs": per(reads["pairs_moved"], reads["pairs_within_a_point"], 3),
            "points_with_two_or_more": reads["points_with_two_or_more"],
            "top_reordered_share_of_points": per(reads["points_reordered"], reads["points_with_two_or_more"], 3),
            "top_moved_share_of_points": per(reads["points_moved"], reads["points_with_two_or_more"], 3),
        },
        "style_changes": [r["style_changes"] for r in runs if r.get("style_changes")],
        "runs_with_errors": sum(1 for r in runs if r["errors"]),
        "runs_on_mock": sum(1 for r in runs if r["mock_fallback"]),
        "mid_round_behaviour_changes": sum(len(r["mid_round_behaviour_changes"]) for r in runs),
    }


# ---- the table -----------------------------------------------------------------

def pct(value: float | None) -> str:
    return "-" if value is None else f"{round(value * 100)}%"


def num(value: Any) -> str:
    return "-" if value is None else f"{value:g}" if isinstance(value, (int, float)) else str(value)


def table(players: list[str], by_player: dict[str, Any], settings: dict[str, Any]) -> str:
    window = settings["window_seconds"]
    lines = [
        f"| Player | Points | Player share by {num(window)} s window | Updates | Added | Eased | Held | Dial only "
        "| Added after a lost round | Wait before swap in, s | Reads per point | Reads per second "
        f"| Top {settings['top_values']} reordered | Top {settings['top_values']} moved over {settings['value_move']} |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for player in players:
        s = by_player[player]
        if not s["runs"]:
            continue
        u, r = s["updates"], s["reads"]
        shares = " / ".join(f"{pct(w['player_share'])} ({w['points']})" for w in s["windows"])
        wait = u["waited_before_swap_in"]
        waited = f"{wait['mean']} ({wait['min']} to {wait['max']})" if wait else "-"
        extra = "".join(f", {u[k]} {k}" for k in ("mixed", "reshaped") if u[k])
        lines.append(
            f"| {player} | {s['points']} | {shares} | {u['sent']}{extra} | {u['added']} | {u['eased']} | {u['held']} "
            f"| {u['dial_only']} | {u['added_strength_after_the_player_lost']} of {u['added_strength']} "
            f"| {waited} "
            f"| {num(r['per_point'])} | {num(r['per_second'])} "
            f"| {pct(r['top_reordered_share_of_pairs'])} of {r['pairs_within_a_point']} "
            f"| {pct(r['top_moved_share_of_pairs'])} of {r['pairs_within_a_point']} |"
        )
    lines.append("")
    lines.append("Player share by window shows the points played in brackets. The last window is whatever was left. "
                 "The two right-hand columns count pairs of reads that followed each other inside one point.")
    for player in players:
        s = by_player[player]
        if not s["runs"]:
            continue
        lines.append("")
        twin = s.get("unchanged_twin")
        if twin:
            shares = " / ".join(f"{pct(w['player_share'])} ({w['points']})" for w in twin["windows"])
            lines.append(f"{player}, same seed against the unchanged opponent: {shares}, {pct(twin['player_share'])} of {twin['points']} overall.")
        lines.append(f"{player}, window by window:")
        for w in s["windows"]:
            span = f"{num(w['from'])} to {num(w['to'])} s"
            lines.append(f"- {span}: player share {pct(w['player_share'])} of {w['points']} points, "
                         f"{num(w['exchanges_per_point'])} exchanges per point, contact quality {num(w['contact_quality'])}, "
                         f"{num(w['missed_swings_per_point'])} missed swings per point, "
                         f"{pct(w['counter_pick_share'])} of opponent shots on a counter, "
                         f"speed {', '.join(num(v) for v in w['speeds']) or '-'}. "
                         f"Read as: {', '.join(str(name) for name in w['read_as']) or '-'}.")
            if not w["shown"]:
                lines.append("  No update.")
            for shown in w["shown"]:
                what = "held" if shown["kind"] == "held" else f"{shown['kind']}{', dial only' if shown['dial_only'] else ''}"
                lines.append(f"  Clearest change: v{shown['version']} at {num(shown['sent_at'])} s ({what}). "
                             f"{shown['headline'] or 'No headline.'} Why: {shown['reason'] or 'none given'}")
        notes = []
        u = s["updates"]
        if u["faults"]:
            notes.append("update faults: " + "; ".join(f"{n} x {f}" for f, n in u["faults"].items()))
        if u["never_swapped_in"]:
            notes.append("never swapped in: " + "; ".join(f"{n} because {why}" for why, n in u["never_swapped_in"].items()))
        if u["replaced_before_the_next_serve"]:
            notes.append(f"{u['replaced_before_the_next_serve']} updates were replaced by a later one before the next serve; "
                         f"most holding updates inside one second: {u['longest_run_of_holds_in_one_second']}")
        if u["biggest_pick_share_rise"] is not None:
            notes.append(f"biggest rise in one option's share of picks from one update: {u['biggest_pick_share_rise']}")
        if s["windows_under_the_floor"]:
            notes.append(f"{s['windows_under_the_floor']} windows under a {pct(settings['share_floor'])} player share")
        if s["runs_with_errors"] or s["runs_on_mock"] or s["mid_round_behaviour_changes"]:
            notes.append(f"runs with errors {s['runs_with_errors']}, on the mock {s['runs_on_mock']}, "
                         f"behaviour changes inside a point {s['mid_round_behaviour_changes']}")
        if s["style_changes"]:
            notes.append(f"the player changed style after rounds {[c['after_round'] for run in s['style_changes'] for c in run]}")
        for note in notes:
            lines.append(f"  Note: {note}.")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m eval.real_game.round2",
                                     description="An open-ended match on the real engine, measured.")
    parser.add_argument("--game-root", default=str(HERE.parents[2]), help="folder that holds client/ and shared/")
    parser.add_argument("--url", default=None, help="the agent server, on a port of your own")
    parser.add_argument("--baseline-url", default=None,
                        help="an agent server started with --no-adapt: each run is also played against it on the same seed")
    parser.add_argument("--settings", default=str(HERE / "round2_settings.json"))
    parser.add_argument("--runs", type=int, default=None)
    parser.add_argument("--players", default=None, help="comma-separated players, in place of the settings file's")
    parser.add_argument("--personas", default=None,
                        help="a list of persona objects, or a stored design, for players named persona-NAME")
    parser.add_argument("--seconds", type=float, default=None, help="match length, in place of the settings file's")
    parser.add_argument("--pace", default=None)
    parser.add_argument("--parallel", type=int, default=None)
    parser.add_argument("--logs", default=None, help="measure the match logs in this folder instead of playing")
    parser.add_argument("--label", default=None, help="a note stored in the JSON")
    parser.add_argument("--out", default="data/eval/real_game/round2")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)
    if not args.url and not args.logs:
        parser.error("--url is needed: the agent server to play against")

    settings_path = Path(args.settings).resolve()
    settings = json.loads(settings_path.read_text())
    for name in ("runs", "pace", "parallel"):
        if getattr(args, name) is not None:
            settings[name] = getattr(args, name)
    if args.seconds is not None:
        settings["match_seconds"] = args.seconds
    if args.players:
        settings["players"] = args.players.split(",")
    game_root = Path(args.game_root).resolve()
    stamp = time.strftime("%Y%m%d-%H%M%S")

    if args.logs:
        out = Path(args.logs)
        matches = []
        for path in sorted(list(out.glob("r2_*.jsonl")) + list(out.glob("twin_*.jsonl"))):
            kind, rest = path.stem.split("_", 1)
            player, run, _ = rest.rsplit("_", 2)
            matches.append({"player": player, "run": int(run), "match_id": path.stem, "log": path,
                            "twin": kind == "twin", "exit": 0, "stderr": ""})
        players = [p for p in settings["players"] if any(m["player"] == p for m in matches)]
        players += sorted({m["player"] for m in matches} - set(players))
    else:
        out = Path(args.out) / stamp
        out.mkdir(parents=True, exist_ok=True)
        players = list(settings["players"])
        jobs = [(player, index, twin) for player in players for index in range(int(settings["runs"]))
                for twin in ([False, True] if args.baseline_url else [False])]
        with ThreadPoolExecutor(max_workers=max(1, int(settings["parallel"]))) as pool:
            matches = list(pool.map(lambda job: play(args, settings, settings_path, game_root, out, job[0], job[1], stamp, job[2]), jobs))

    runs: list[dict[str, Any]] = []
    twins: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    for match in matches:
        measured = measure(match, settings)
        if measured is None:
            failed.append({"match_id": match["match_id"], "exit": match["exit"], "stderr": match["stderr"]})
        else:
            (twins if match.get("twin") else runs).append(measured)

    by_player = {player: combine([r for r in runs if r["player"] == player], settings) for player in players}
    for player in players:
        mine = [r for r in twins if r["player"] == player]
        if mine:
            twin = combine(mine, settings)
            by_player[player]["unchanged_twin"] = {
                "runs": twin["runs"], "points": twin["points"], "player_share": twin["player_share"],
                "windows": [{"window": w["window"], "points": w["points"], "player_share": w["player_share"]}
                            for w in twin["windows"]],
            }
    commits = sorted({str(r["game_commit"]) for r in runs})
    report = {
        "what": "An open-ended match on the real engine for each scripted player, measured. Nothing here is tuned.",
        "label": args.label, "stamp": stamp, "url": args.url, "game_commit": commits,
        "settings": settings, "settings_file": settings_path.name,
        "how_an_update_is_sorted": __doc__.split("How an update is sorted.")[1].split("From `agents/`")[0].strip(),
        "engine_limits": ENGINE_LIMITS,
        "by_player": by_player, "runs": runs, "unchanged_twin_runs": twins, "failed_runs": failed,
    }
    target = out / "round2.json"
    target.write_text(json.dumps(report, indent=2))

    print(f"Game commit {', '.join(commits) or 'unknown'}. Server {args.url or 'not played now'}."
          + (f" {args.label}." if args.label else ""))
    print(f"Open-ended match, {num(settings['match_seconds'])} s per player at pace {settings['pace']}, "
          f"{settings['runs']} run(s) per player, no cap on points and no breaks.")
    print()
    print(table(players, by_player, settings))
    print()
    if failed:
        print(f"{len(failed)} runs left no usable log: {', '.join(f['match_id'] for f in failed)}")
    print("What the engine cannot do as it stands:")
    for limit in ENGINE_LIMITS:
        print(f"- {limit}")
    print()
    print(f"JSON: {target}")
    return 0 if runs and not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
