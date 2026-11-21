"""Reading the matchup table."""
from __future__ import annotations

from server import matchups
from server.interfaces import Matchup


def table() -> list[Matchup]:
    return [
        matchups.baseline_row("net_rusher", "opponent", 20, 8),
        Matchup("net_rusher", "opponent", "shot_type", "lob", 20, 15),
        Matchup("net_rusher", "opponent", "shot_type", "drop", 20, 9),     # better, but not clearly
        Matchup("net_rusher", "opponent", "shot_type", "flat", 20, 11),    # a quarter better, but 20 rounds can't tell
        matchups.baseline_row("baseliner", "opponent", 20, 10),
        Matchup("baseliner", "opponent", "shot_type", "drop", 20, 16),
        Matchup("baseliner", "opponent", "shot_type", "lob", 20, 6),
        Matchup("nobody", "opponent", "shot_type", "lob", 20, 20),         # no baseline, so no claim
    ]


def test_baseline_and_win_rate():
    base = matchups.baseline(table(), "net_rusher", "opponent")
    assert base is not None and matchups.is_baseline(base) and matchups.win_rate(base) == 0.4
    assert matchups.baseline(table(), "net_rusher", "someone_else") is None
    assert matchups.players(table()) == ["net_rusher", "baseliner", "nobody"]


def test_a_counter_must_beat_the_baseline_by_a_clear_margin():
    found = matchups.counters(table(), "net_rusher")
    assert [(c["option"], c["gap"]) for c in found] == [("lob", 0.35)]
    longer = [matchups.baseline_row("p", "opponent", 200, 80), Matchup("p", "opponent", "shot_type", "flat", 200, 110)]
    assert [c["option"] for c in matchups.counters(longer, "p")] == ["flat"]      # the same edge over 200 rounds is clear
    assert matchups.counters(table(), "nobody") == []
    assert not matchups.beats(0.05, 0.0)               # a baseline near zero doesn't turn noise into a counter
    assert matchups.beats(0.5, 0.4) and not matchups.beats(0.45, 0.4)


def test_best_counters_follow_who_the_player_resembles():
    like_rusher = matchups.likeness({"like_net_rusher": 0.8, "like_baseliner": 0.2}, ["net_rusher", "baseliner"])
    assert like_rusher == {"net_rusher": 0.8, "baseliner": 0.2}
    best = matchups.best_counters(table(), like_rusher)
    assert (best[0]["option"], best[0]["against"], best[0]["edge"], best[0]["likeness"]) == ("lob", "net_rusher", 0.35, 0.8)

    like_baseliner = matchups.likeness({"like_net_rusher": 0.1, "like_baseliner": 0.9}, ["net_rusher", "baseliner"])
    assert matchups.best_counters(table(), like_baseliner)[0]["option"] == "drop"

    unknown = matchups.likeness({}, ["net_rusher", "baseliner"])
    assert unknown == {"net_rusher": 0.5, "baseliner": 0.5}
    assert matchups.best_counters([], unknown) == []


def test_describe_reads_as_one_plain_line():
    line = matchups.describe(matchups.counters(table(), "net_rusher")[0])
    assert line == "lob for shot type against net rusher: opponent won 15 of 20, up from 8 of 20."
