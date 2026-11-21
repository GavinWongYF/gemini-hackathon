"""One place for the model behind each job.

Each job reads its model from the environment, so a job can move to another
model without a code change.
"""
from __future__ import annotations

import os

# The fast loop: reads the player during a round. No output tokens.
WATCHER_MODEL = os.environ.get("NPC_WATCHER_MODEL", "gemini-decision-1")

# Once per game, when a developer registers it: reads `setup`, writes the
# questions and the player personas, and playtests the game. Never runs
# during a match.
DESIGNER_MODEL = os.environ.get("NPC_DESIGNER_MODEL", "gemini-4-carbon")
# At "low" the design comes back in about 20 seconds. At "medium" it took over
# a minute, which is longer than a game should wait to start.
DESIGNER_THINKING = os.environ.get("NPC_DESIGNER_THINKING", "low")

# The larger loop, during a match: writes the next rules and says why. Always
# send an explicit thinking level. At "low" a rule table comes back in time to
# land inside a short match.
ADAPTER_MODEL = os.environ.get("NPC_ADAPTER_MODEL", "gemini-4-neon")
ADAPTER_THINKING = os.environ.get("NPC_ADAPTER_THINKING", "low")

# The larger loop does not wait for a round to end. The first call starts this
# many seconds into a match, on the counts so far, and the next one starts as
# soon as the last has landed.
ADAPTER_FIRST_DELAY_SECONDS = float(os.environ.get("NPC_ADAPTER_FIRST_DELAY_SECONDS", "6"))

# When a look at the match ends with nothing to change, the next look waits
# this long, so a quiet stretch does not turn into a look on every event.
ADAPTER_REST_SECONDS = float(os.environ.get("NPC_ADAPTER_REST_SECONDS", "4"))

# A call that takes longer than this is dropped and the current rules stay.
ADAPTER_TIMEOUT_SECONDS = float(os.environ.get("NPC_ADAPTER_TIMEOUT_SECONDS", "25"))

# How deep the larger loop goes is set by the game, not by us. A developer
# says in setup["plan"] how long the game can wait: `update_seconds` for a
# routine update while play goes on, and `break_seconds` for a break. The
# longer the wait, the more a writer can do before it answers.
DEFAULT_UPDATE_SECONDS = float(os.environ.get("NPC_DEFAULT_UPDATE_SECONDS", "20"))

# (the wait must be at least this many seconds, the writer that fits it)
WRITER_TIERS: list[tuple[float, str]] = [
    (0, "fast"),       # one call to FAST_WRITER_MODEL at low thinking
    (10, "standard"),  # one call to ADAPTER_MODEL at low thinking
    (100, "deep"),     # a managed agent writes rule sets and tests them in its sandbox
    (120, "deepest"),  # the same run with room for the most rule sets
]

FAST_WRITER_MODEL = os.environ.get("NPC_FAST_WRITER_MODEL", "gemini-4-hydrogen")
MANAGED_AGENT = os.environ.get("NPC_MANAGED_AGENT", "antigravity-preview-09-2026")
MANAGED_AGENT_MODEL = os.environ.get("NPC_MANAGED_AGENT_MODEL", "gemini-4-neon")


def writer_for(seconds: float, override: str | None = None) -> str:
    """The name of the writer that fits a wait of `seconds`.

    `override` is setup["plan"]["writer"] when the developer wants to pick
    the writer themselves.
    """
    names = [name for _, name in WRITER_TIERS]
    if override in names:
        return override
    chosen = WRITER_TIERS[0][1]
    for at_least, name in WRITER_TIERS:
        if seconds >= at_least:
            chosen = name
    return chosen


# A managed agent run spends about this long before its first rule set is
# tested, and about this long on each one after that. From these the server
# works out how many rule sets fit a wait, so a developer never has to. As
# measured, a run takes about a minute and a half whether it tries one rule
# set or four, so nearly all of the time is the run itself.
MANAGED_OVERHEAD_SECONDS = float(os.environ.get("NPC_MANAGED_OVERHEAD_SECONDS", "85"))
MANAGED_SECONDS_PER_CANDIDATE = float(os.environ.get("NPC_MANAGED_SECONDS_PER_CANDIDATE", "5"))
MANAGED_MAX_CANDIDATES = int(os.environ.get("NPC_MANAGED_MAX_CANDIDATES", "6"))


def candidates_for(seconds: float, cap: int | None = None) -> int:
    """How many rule sets a managed agent run can write and test in `seconds`.

    `cap` is setup["plan"]["max_candidates"] when the developer set one.
    """
    fits = int((seconds - MANAGED_OVERHEAD_SECONDS) // MANAGED_SECONDS_PER_CANDIDATE)
    limit = min(cap, MANAGED_MAX_CANDIDATES) if cap else MANAGED_MAX_CANDIDATES
    return max(1, min(fits, limit))


# A match starts on the game's own default behaviour, so the NPCs begin
# beatable and every change after that is one the larger loop made and
# explained. What setup learned (the matchup table, the personas) is kept for
# the larger loop to draw on. Set to 0 to start on the designed behaviour.
START_ON_GAME_DEFAULT = os.environ.get("NPC_START_ON_GAME_DEFAULT", "1") not in ("0", "false", "no")

# A habit is something the player chooses. A field that reports how an action
# turned out, or what the other side was doing, is not one, so it is never
# counted as a habit. Field names are matched whole, prefixes at the start.
NOT_A_HABIT_FIELDS = tuple(
    name for name in os.environ.get("NPC_NOT_A_HABIT_FIELDS", "result,outcome,winner,hit,success,timing,quality,confidence,reason").split(",") if name
)
NOT_A_HABIT_PREFIXES = tuple(
    name for name in os.environ.get("NPC_NOT_A_HABIT_PREFIXES", "other_,opponent_,enemy_,npc_").split(",") if name
)

# The watcher reads the player at most this often.
WATCH_MIN_INTERVAL_SECONDS = float(os.environ.get("NPC_WATCH_MIN_INTERVAL_SECONDS", "0.3"))

# Below this confidence a value is tracked but not acted on.
MIN_CONFIDENCE = float(os.environ.get("NPC_MIN_CONFIDENCE", "0.6"))

# With no player event for this long, fresh pictures alone start a read.
WATCH_IDLE_SECONDS = float(os.environ.get("NPC_WATCH_IDLE_SECONDS", "3"))

# How many seconds of events the watcher looks back over.
WATCH_WINDOW_SECONDS = float(os.environ.get("NPC_WATCH_WINDOW_SECONDS", "20"))


def api_key() -> str:
    """The Gemini API key in use right now. See server/keys.py for where it comes from."""
    from server import keys

    return keys.active_key()


# ---------------------------------------------------------------- wording, habits, early signs, counters

# The most words in any line a player or a judge reads, and in a value's label.
MAX_LINE_WORDS = int(os.environ.get("NPC_MAX_LINE_WORDS", "12"))
MAX_ABOUT_WORDS = int(os.environ.get("NPC_MAX_ABOUT_WORDS", "8"))

# Fields that say how an action turned out. When two events repeat the same
# field, the habit is counted on the event that carries one of these.
OUTCOME_FIELDS = tuple(
    name for name in os.environ.get("NPC_OUTCOME_FIELDS", "result,outcome,winner,hit,success").split(",") if name
)

# A field with one of these words in its name is a guess at another field, so it is never a habit.
GUESS_WORDS = tuple(name for name in os.environ.get("NPC_GUESS_WORDS", "guess,predicted,estimate").split(",") if name)

# Early signs. One player event followed by a different player event in the
# same round, inside this many seconds, is an early sign and what really happened.
TELL_WINDOW_SECONDS = float(os.environ.get("NPC_TELL_WINDOW_SECONDS", "1.0"))
# A sign holds up when it was seen this often, and was followed by the same thing this share of the time.
TELL_MIN_PAIRS = int(os.environ.get("NPC_TELL_MIN_PAIRS", "5"))
TELL_MIN_SHARE = float(os.environ.get("NPC_TELL_MIN_SHARE", "0.7"))
# It must also beat how often that same thing follows anyway by this much, or the sign says nothing new.
TELL_MIN_LIFT = float(os.environ.get("NPC_TELL_MIN_LIFT", "0.1"))

# The most the weight of a general counter (one that beats every practice player) may rise in one update.
GENERAL_COUNTER_STEP = float(os.environ.get("NPC_GENERAL_COUNTER_STEP", "0.15"))

# Set NPC_ADAPTER_WRITERS=0 to keep the fairness check and switch the rule writers off,
# so a test can measure what fairness alone does.
ADAPTER_WRITERS = os.environ.get("NPC_ADAPTER_WRITERS", "1") not in ("0", "false", "no")

# A rule that decided this share of a decision's picks since it went in (over at least this many picks)
# is always on. It is no rule about a situation, so the next look takes it off.
ALWAYS_ON_SHARE = float(os.environ.get("NPC_ALWAYS_ON_SHARE", "0.8"))
ALWAYS_ON_MIN_PICKS = int(os.environ.get("NPC_ALWAYS_ON_MIN_PICKS", "5"))

# The plan a proposal is checked against before it is sent: the player's estimated share of rounds,
# worked out from the practice table, must stay at or above this.
FAIR_SHARE_FLOOR = float(os.environ.get("NPC_FAIR_SHARE_FLOOR", "0.42"))
# How often a rule with conditions is taken to fire, for that estimate.
RULE_FIRE_SHARE = float(os.environ.get("NPC_RULE_FIRE_SHARE", "0.5"))
# An option is general when it clearly beats the default against this share of the practice players.
GENERAL_COUNTER_SHARE = float(os.environ.get("NPC_GENERAL_COUNTER_SHARE", "0.75"))

# The player's share of rounds a counter is sized for: the middle of the fair band.
FAIR_TARGET_SHARE = float(os.environ.get("NPC_FAIR_TARGET_SHARE", "0.5"))
# An option that wins this often against every practice player is a hole in the game, not a counter. It is never raised.
HOLE_WIN_RATE = float(os.environ.get("NPC_HOLE_WIN_RATE", "0.9"))

# How much more of its picks the best counter gets, in one step, when the player keeps winning and nothing else was added.
DOSE_STEP = float(os.environ.get("NPC_DOSE_STEP", "0.1"))

# Fairness is judged on evidence. The practice table's estimate counts as this many rounds beside the rounds played.
FAIR_BLEND_ROUNDS = float(os.environ.get("NPC_FAIR_BLEND_ROUNDS", "8"))
# The top of the fair band for the player's blended share. The bottom is NPC_FAIR_SHARE_FLOOR.
FAIR_SHARE_CEILING = float(os.environ.get("NPC_FAIR_SHARE_CEILING", "0.58"))
# The emergency brake: the player lost this many rounds in a row, so the opponent eases whatever the blended share says.
FAIR_BRAKE_LOSSES = int(os.environ.get("NPC_FAIR_BRAKE_LOSSES", "5"))
# After any change in strength, no move the other way for this many rounds. The emergency brake is excepted.
FAIR_NO_FLAP_ROUNDS = int(os.environ.get("NPC_FAIR_NO_FLAP_ROUNDS", "3"))

# Every look that completes sends an update. When nothing changes it is a holding update: the play as it stands, a new version.
SEND_HOLDING_UPDATES = os.environ.get("NPC_SEND_HOLDING_UPDATES", "1").strip().lower() not in ("0", "false", "no", "off")
# Strength is added only when the player won the most recent round at the moment the update is sent.
ADD_ONLY_AFTER_WIN = os.environ.get("NPC_ADD_ONLY_AFTER_WIN", "1").strip().lower() not in ("0", "false", "no", "off")

# The most of its decision's picks one option may gain in a single update, so strength climbs in steps. 1 means no cap.
DOSE_MAX_STEP = float(os.environ.get("NPC_DOSE_MAX_STEP", "0.15"))

# Never two updates for one match inside this many seconds.
MIN_UPDATE_GAP_SECONDS = float(os.environ.get("NPC_MIN_UPDATE_GAP_SECONDS", "1.0"))

# The step cap grows with the gap: NPC_DOSE_MAX_STEP at the top of the band, rising in a straight line to this
# when the player's blended share is at or above NPC_FAIR_FAR_SHARE.
DOSE_MAX_STEP_FAR = float(os.environ.get("NPC_DOSE_MAX_STEP_FAR", "0.35"))
FAIR_FAR_SHARE = float(os.environ.get("NPC_FAIR_FAR_SHARE", "0.70"))
# Far above the band, and with at least this many rounds played, a fairness dial moves beside what the writer added.
FAIR_FAR_ROUNDS = int(os.environ.get("NPC_FAIR_FAR_ROUNDS", "6"))

# After an ease, the next ease waits until this many more rounds the player played in have finished. 0 means no wait.
FAIR_EASE_GAP_ROUNDS = int(os.environ.get("NPC_FAIR_EASE_GAP_ROUNDS", "2"))

# A step held back only because the player just lost a round is kept ready for this long, or for 3 more played rounds.
PENDING_STEP_SECONDS = float(os.environ.get("NPC_PENDING_STEP_SECONDS", "25"))

# ---------------------------------------------------------------- pace of the two loops

# While a round is being played (an event came in within WATCH_RALLY_SECONDS), fresh pictures also ask for a
# read, once the last read started at least this long ago. So the read moves between the player's own events.
WATCH_FRAME_INTERVAL_SECONDS = float(os.environ.get("NPC_WATCH_FRAME_INTERVAL_SECONDS", "0.6"))
WATCH_RALLY_SECONDS = float(os.environ.get("NPC_WATCH_RALLY_SECONDS", "2"))
# How often the server says how many reads it started and how fast they came back.
WATCH_REPORT_SECONDS = float(os.environ.get("NPC_WATCH_REPORT_SECONDS", "10"))

# The first look of the larger loop starts once the player has done this many things, or after
# ADAPTER_FIRST_DELAY_SECONDS, whichever comes first.
ADAPTER_FIRST_EVENTS = int(os.environ.get("NPC_ADAPTER_FIRST_EVENTS", "3"))
# Up to this many looks can be in flight for one match. 1 means one at a time, which is the default: every
# change stops the game, so one look for each stretch of play is enough. 2 adds a second look as a hedge.
ADAPTER_PARALLEL = int(os.environ.get("NPC_ADAPTER_PARALLEL", "1"))
# A second look starts only when the one in flight started at least this long ago, and there is news since.
ADAPTER_STAGGER_SECONDS = float(os.environ.get("NPC_ADAPTER_STAGGER_SECONDS", "8"))
# Two updates never go to the game closer together than this.
ADAPTER_UPDATE_GAP_SECONDS = float(os.environ.get("NPC_ADAPTER_UPDATE_GAP_SECONDS", "1"))

# The quick writers ask a smaller question: a shorter prompt and a shorter answer, so a look ends sooner. 0 asks the long way.
WRITER_COMPACT = os.environ.get("NPC_WRITER_COMPACT", "1").strip().lower() not in ("0", "false", "no", "off")

# A tab left open with nobody playing must not pay for reads forever. Reads started by pictures stop once no
# player event has arrived for this long, and start again with the next player event.
WATCH_AWAY_SECONDS = float(os.environ.get("NPC_WATCH_AWAY_SECONDS", "20"))

# The step a landing may take grows with the time since the last landing that added strength: the usual
# cap times (seconds since then / this many seconds), never under the smallest step and never over the cap.
# The first landing of a match gets the whole cap. 0 seconds here turns the timing off.
DOSE_SECONDS = float(os.environ.get("NPC_DOSE_SECONDS", "10"))
DOSE_MIN_STEP = float(os.environ.get("NPC_DOSE_MIN_STEP", "0.05"))

# 0 keeps the fairness dial from ever joining a change of play for a player far above the fair band.
FAIR_DIAL_JOINS = os.environ.get("NPC_FAIR_DIAL_JOINS", "1").strip().lower() not in ("0", "false", "no", "off")

# ---------------------------------------------------------------- the play clock and real updates

# A match's play clock adds the time between two `event` or `round_end` messages when it is under this.
# A longer gap is a pause, or nobody there, and adds nothing.
PLAY_GAP_SECONDS = float(os.environ.get("NPC_PLAY_GAP_SECONDS", "3.0"))
# After an update that changes something, the next look waits for a player event and this much play.
# 0 starts it at the first player event after the update, so a slow look can run through the game's stop.
ADAPTER_RESUME_PLAY_SECONDS = float(os.environ.get("NPC_ADAPTER_RESUME_PLAY_SECONDS", "0"))
# Two updates that change something are never sent with less play than this between them. Each one stops the game.
UPDATE_MIN_PLAY_SECONDS = float(os.environ.get("NPC_UPDATE_MIN_PLAY_SECONDS", "10"))
# The game stops at the end of the point for every update that changes something. Set this to 0 for a game
# that does not: then no result is dropped, and looks and updates follow the stagger alone.
UPDATES_STOP_PLAY = os.environ.get("NPC_UPDATES_STOP_PLAY", "1").strip().lower() not in ("0", "false", "no", "off")

# The game stops and shows each real update, so its two lists are kept short. On a real update the observations
# are built in code with their counts (at most 3 lines of 10 words) and the plan is cut to 3 lines of 8 words.
PAUSE_LISTS = os.environ.get("NPC_PAUSE_LISTS", "1").strip().lower() not in ("0", "false", "no", "off")

# A real update must be a change a person can see. A step that moves less than this share of every decision's
# picks goes out as a holding update with the reason. 0 turns this off.
MIN_VISIBLE_STEP = float(os.environ.get("NPC_MIN_VISIBLE_STEP", "0.03"))

# 1, the default: after an update that changes something, the next look waits until the game has resumed, which
# shows as a player event in a later round than any seen when the update went out. The game stops to show each
# change, and no look runs while it is stopped. 0: the look starts at the first player event after the update,
# so a slow look can work through the game's stop.
ADAPTER_LOOK_AFTER_RESUME = os.environ.get("NPC_ADAPTER_LOOK_AFTER_RESUME", "1").strip().lower() in ("1", "true", "yes", "on")

# The fair band reads the player's share of the last rounds. Above the high mark the next look adds strength,
# under the low mark the very next look eases in code, and in between it holds. While fewer rounds than the
# window have finished, the missing ones are filled from the table's estimate. 0 rounds goes back to the blend.
FAIR_WINDOW_ROUNDS = int(float(os.environ.get("NPC_FAIR_WINDOW_ROUNDS", "8")))
FAIR_LOW = float(os.environ.get("NPC_FAIR_LOW", "0.40"))
FAIR_HIGH = float(os.environ.get("NPC_FAIR_HIGH", "0.60"))
FAIR_HIGH_FAR = float(os.environ.get("NPC_FAIR_HIGH_FAR", "0.80"))
# An ease takes back the latest step that added strength: half of it, or all of it under this share.
FAIR_EASE_ALL_UNDER = float(os.environ.get("NPC_FAIR_EASE_ALL_UNDER", "0.25"))
# The latest step is also judged alone: this few wins in at least this many rounds since it means it was too much.
FAIR_LAST_STEP_ROUNDS = int(float(os.environ.get("NPC_FAIR_LAST_STEP_ROUNDS", "4")))
FAIR_LAST_STEP_WINS = int(float(os.environ.get("NPC_FAIR_LAST_STEP_WINS", "1")))
# More strength waits until this many rounds that started after the last real update have finished.
FAIR_PROOF_ROUNDS = int(float(os.environ.get("NPC_FAIR_PROOF_ROUNDS", "2")))
# A kept step is dropped once this many rounds that started after the last real update have finished.
PENDING_STEP_ROUNDS = int(float(os.environ.get("NPC_PENDING_STEP_ROUNDS", "4")))

# The first real update of a match must not wait for luck: it may go out once the window reads this share
# or more and the player has sent at least 3 events. Every later step up keeps the high mark.
FAIR_FIRST_HIGH = float(os.environ.get("NPC_FAIR_FIRST_HIGH", "0.50"))

# An update is only sent on the heels of a game message: an `event` or `round_end` within this many seconds.
# A stopped game sends neither, so a result that lands during a stop waits and goes out when play picks up
# again. 0 turns the wait off.
SEND_WHILE_PLAYING_SECONDS = float(os.environ.get("NPC_SEND_WHILE_PLAYING_SECONDS", "1.5"))
