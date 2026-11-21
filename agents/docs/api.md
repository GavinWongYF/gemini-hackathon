# API

This is the contract between a game and the agent server. A game that follows this page can plug in without any other code from us.

The short version: the game describes itself once and reports what the player does. The agent server sends back how the game's NPCs should play.

Nothing here is tied to one game. A game plugs in by describing itself in `setup`, and every other message uses the names it gave there. Tennis and CS:GO are worked through in full in [examples.md](examples.md), and their `setup` files are in [../examples/](../examples/).

## What a game does to plug in

1. It describes itself in `setup`: its NPCs, the choices they make, the things that can happen, and the pictures it can send. That is 50 to 100 lines of JSON, written once.
2. It reports what happens, with `event`, `frames` and `round_end`.
3. It calls one small function, `pick`, wherever an NPC makes a choice. The code is in [How an NPC picks](#how-an-npc-picks-game-side) below, and in the SDKs under `sdk/`.
4. It swaps in each new behaviour between rounds.

The game never writes the questions about the player, the values, the weights or the rules. The agent server writes all of those from the description.

The agent server decides what an NPC chooses. The game still does the moving, the aiming and the animation.

## How the two sides talk

- There is one WebSocket. The game opens it to the agent server at `ws://AGENT_HOST:8000/ws`. When both run on one machine, `AGENT_HOST` is `localhost`.
- Every message is one JSON object with a `type` and the `match_id`.
- The game never waits on the agent server during a round. The NPCs always play with the latest `player_read` and the latest behaviour the game has. If the agent server goes quiet, the NPCs keep playing.
- The game owns the names. NPCs, decisions, options, events and places are whatever the game says they are in `setup`. The agent server sends them back spelled exactly the same.
- Left and right always mean left and right as you see them on the game screen.
- A new behaviour is only swapped in between rounds, never in the middle of one.

## Words used here

- The **player** is the human.
- An **NPC** is any character the game controls: an opponent, an enemy, a bot. One NPC entry can also stand for a group that shares one behaviour, like a squad.
- A **round** is one stretch of play with a result. In tennis it's a point. A **break** is a pause between rounds, when the game can show what changed. The game decides how often.
- A **decision** is a choice an NPC makes from a fixed list of **options**.
- An **event** is something that happened in the game and that the game reports.
- A **fact** is something an NPC can check at the moment it decides, like where the player is standing.
- A **value** is a number from 0 to 1 for one habit of this player. 0 means it hasn't been seen. 1 means the player does it all the time. The agent server chooses the values for each game.
- The **behaviour** is the JSON that decides how the NPCs choose. The game runs it and the agent server rewrites it.
- A **setting** is something about the match that isn't an NPC's choice, like how many enemies there are. A game doesn't have to have any.
- A **practice run** is a batch of rounds the game plays with no screen against a scripted player, when the agent server asks for it.
- A **persona** is a scripted player the agent server writes itself, as a set of numbers for how often it picks each option.

The examples on this page come from a cut-down tennis game with one NPC, two decisions and one event, so the shapes are easy to see.

## The behaviour JSON

The behaviour has one entry for each NPC. Inside it, each decision lists its options.

Every option has a `base` number. That is how much the NPC likes the option when it knows nothing about the player.

An option can also have `when` entries. Each one names a value and a weight. The weight times the value gets added to the option's score. So `"when": {"forehand_goes_cross_court": 0.9}` on `left_deep` means the more this player hits the forehand cross-court, the more the opponent waits where that ball lands.

`rules` are for the clear-cut cases. A rule says that if certain things are true, the NPC does one specific thing. Rules are checked first, in order.

```json
{
  "version": 2,
  "npcs": {
    "opponent": {
      "decisions": {
        "shot_type": {
          "topspin": {"base": 0.35},
          "flat": {"base": 0.3},
          "slice": {"base": 0.15},
          "dropshot": {"base": 0.1, "when": {"stays_deep": -0.2}},
          "lob": {"base": 0.1, "when": {"comes_to_net": 0.6}}
        },
        "position": {
          "middle_deep": {"base": 0.7},
          "left_deep": {"base": 0.1, "when": {"forehand_goes_cross_court": 0.9}},
          "right_deep": {"base": 0.1},
          "middle_short": {"base": 0.1}
        }
      },
      "rules": [
        {
          "if": [{"fact": "player_position", "in": ["left_short", "middle_short", "right_short"]}],
          "do": {"shot_type": "lob"},
          "why": "Came to the net twice and won both points with a volley."
        }
      ]
    }
  }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | number | Goes up by one with every `strategy_update`. A default behaviour sent by the game is 0. |
| `npcs` | object | One entry for each NPC id from `setup`. |
| `decisions` | object | One entry for each decision that NPC makes. Each holds the options it may pick. |
| `base` | number, 0 or more | How much the NPC likes this option before it knows the player. |
| `when` | object, optional | A value name and a weight. Each one adds weight times value to the option's score. A weight can be negative. |
| `rules` | array | Checked first, in order. It can be empty. Four at most for each NPC. |
| `if` | array | Conditions that must all be true. A condition checks a `fact` or a `value`, using `is`, `in`, `above` or `below`. |
| `do` | object | The decision to force and the option to pick, like `{"shot_type": "lob"}`. |
| `why` | string | One plain line for the break screen. |

How a pick works:

1. The first rule whose conditions are all true, and whose option is legal right now, decides.
2. Otherwise every legal option gets a score, which is its `base` plus weight times value for each `when` entry. The NPC picks at random in proportion to the scores, so an option with twice the score gets picked twice as often. A score below 0 counts as 0.
3. If every score is 0, or the behaviour has no entry for this NPC, the NPC picks one of the legal options with equal chance.

How a condition is checked:

- A `value` condition reads the latest `player_read`. A value the game hasn't received yet counts as 0.
- A `fact` condition reads the facts the game passes in. A fact the game didn't pass is missing.
- `is` is true when the value or fact equals the given one. `in` is true when it is one of the given list.
- `above` and `below` compare numbers, and are false when the fact is missing.

## The messages at a glance

| Message | Direction | When | What it's for |
| --- | --- | --- | --- |
| `setup` | game to agents | once, when the socket opens | Describes the game: its NPCs, decisions, events, facts and pictures |
| `practice_run` | agents to game | in practice mode, before `ready` | Asks the game to play rounds with no screen against a scripted player or a persona |
| `practice_result` | game to agents | once for each `practice_run` | Says how those rounds went |
| `ready` | agents to game | once, after `setup` | Names the values the agents will track and gives the first behaviour |
| `event` | game to agents | whenever something the game declared happens | Says what just happened |
| `frames` | game to agents | about once a second during a round | Gives Gemini something to look at |
| `round_end` | game to agents | when a round ends | Says who won and how, and whether a break starts |
| `player_read` | agents to game | during a round, after player events | The latest read of how this player plays |
| `strategy_update` | agents to game | any time during a match | The new behaviour, plus what to show on the break screen. The game swaps it in at the next gap between rounds. |
| `error` | agents to game | when a message doesn't fit `setup` | Says exactly what is wrong. The socket stays open. |

## 1. setup

Game to agents, once, when the socket opens.

It is the only place where a game says anything about itself. The agent server uses it to write the questions it'll ask about the player, so the more plainly it describes things, the better.

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | string | `"setup"` |
| `match_id` | string | Any id for this match. Every later message carries it. |
| `game` | string | A short name for the game. What the agent server learns in practice is stored under this name. |
| `about` | string | Two or three plain sentences on how the game works and who the player is up against. |
| `mode` | string | `"live"` with a real player. `"practice"` when the game is here to play practice runs with no screen. `"replay"` when a recording is played back through the same messages and nothing gets applied. |
| `goal` | string | One plain sentence on what the NPCs are for. The agent server reads it every time it rewrites the behaviour. |
| `plan` | object | The game's pacing: `rounds` in the match (optional), `break_every` (rounds between breaks) and `break_seconds`, plus the optional `update_seconds`, `writer` and `max_candidates`. See [The plan sets how deep updates go](#the-plan-sets-how-deep-updates-go). |
| `lists` | object, optional | Lists of names you want to reuse, like the zones of a court. Wherever a list of names is expected, you can write the list's name. |
| `npcs` | object | One entry for each NPC, or for each group that shares one behaviour. Each has `about` and its `decisions`. |
| `decisions` | object, inside each NPC | Each decision has `when`, a plain line on the moment it gets made, and `options`, each with one line that says what it is. |
| `events` | object | Everything the game will report. Each has `about` and its `fields`. |
| `facts` | object | What an NPC can check at the moment it decides. Rules can only use these. |
| `views` | object | The pictures the game can send, each with one line on what it shows. |
| `settings` | object, optional | Things the agent server may change between rounds that aren't an NPC's choice. Each has `about`, then `options` or `min` and `max`, and `now`. |
| `default_behaviour` | object, optional | The behaviour the game already has, if it has one. It is also the baseline the adapted NPCs are compared against. If it's left out, the agent server writes the first behaviour and the baseline is every option equally likely. |
| `practice` | object, optional | The scripted players the game can run with no screen. See [Practice runs](#practice-runs). |

Each event field and each fact says what kind of thing it is:

| You write | It means |
| --- | --- |
| A list of names, like `["in", "out", "net"]` | One of these names. |
| The name of a list from `lists` | One of the names in that list. |
| `{"min": 0, "max": 1, "about": "..."}` | A number in that range. |
| `"number"` | A count, or a number with no fixed range. |
| `"text"` | Free text. The agent server can show it but can't count it. |

This is what lets the agent server count a player's habits in a game it has never seen.

```json
{
  "type": "setup",
  "match_id": "m_001",
  "game": "tennis",
  "about": "One human player plays single points against one AI opponent. The player stands stationary at the center baseline swinging a physical M5 IMU racket controller while a webcam tracks their stroke side (forehand/backhand) and swing path.",
  "mode": "live",
  "goal": "Start beatable. Work out what this player relies on to win points and take it away, one habit at a time, until the player wins about half the points. Win by choosing better shots, never by hitting harder or faster.",
  "plan": {"rounds": 5, "break_every": 1, "break_seconds": 3, "update_seconds": 20},
  "lists": {
    "zone": ["left_short", "middle_short", "right_short", "left_deep", "middle_deep", "right_deep"]
  },
  "npcs": {
    "opponent": {
      "about": "The AI on the other side of the net.",
      "decisions": {
        "shot_type": {
          "when": "Each time it hits the ball.",
          "options": {
            "topspin": "Heavy spin that dips late and kicks up.",
            "flat": "Fast and low.",
            "slice": "Backspin that stays low and skids.",
            "dropshot": "Soft and short, just over the net.",
            "lob": "High and deep."
          }
        },
        "position": {
          "when": "Right after it hits the ball.",
          "options": {
            "middle_deep": "Wait at the middle of the baseline.",
            "left_deep": "Wait on the left of the baseline.",
            "right_deep": "Wait on the right of the baseline.",
            "middle_short": "Come up to the net."
          }
        }
      }
    }
  },
  "events": {
    "shot": {
      "about": "Either side hit the ball.",
      "fields": {
        "side": ["forehand", "backhand"],
        "shot_type": ["topspin", "flat", "slice", "dropshot", "lob"],
        "power": {"min": 0, "max": 1, "about": "How hard the swing was."},
        "lands": "zone",
        "result": ["in", "out", "net"]
      }
    }
  },
  "facts": {
    "player_position": "zone",
    "rally_length": "number"
  },
  "views": {
    "court": "The game screen, with both halves of the court.",
    "player_cam": "A webcam on the player."
  },
  "settings": {}
}
```

What comes back: `ready`. In practice mode, `practice_run` messages come first.

### The plan sets how deep updates go

The developer states the game's pacing in `plan`. The agent server chooses how deep each rewrite goes to fit it. So the same server suits a short tennis match and a long shooter match.

```json
"plan": {
  "rounds": 5,
  "break_every": 1,
  "break_seconds": 3,
  "update_seconds": 20
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `rounds` | number, optional | Rounds in the match. Leave it out for an open-ended match that plays until someone stops it. |
| `break_every` | number | Rounds between breaks. 0 means the game never breaks by itself. |
| `break_seconds` | number | How long a break lasts. When a `round_end` says a break starts and the break is long enough, the agent server also runs a deeper rewrite that fits inside it. |
| `update_seconds` | number, optional | How long the game is happy to wait for a routine update while play goes on. 20 if left out. |
| `writer` | string, optional | Picks the depth directly: `"fast"`, `"standard"`, `"deep"` or `"deepest"`. `deep` and `deepest` both mean a managed agent run, and differ only in how many rule sets it has time to write and test. Leave it out and the agent server picks from the wait. |
| `max_candidates` | number, optional | The most rule sets a deep rewrite may try. |

How the wait maps to what writes the rules:

| The game can wait | Writer | What writes the rules |
| --- | --- | --- |
| under 10 seconds | `fast` | One fast model call, Gemini 4 Hydrogen at low thinking. Measured today, Hydrogen took 4.6 to 6.0 seconds, and 2 of 4 calls missed a 5 second window. |
| 10 to 100 seconds | `standard` | One Gemini 4 Neon call at low thinking. |
| 100 to 120 seconds | `deep` | A managed agent running Neon writes a few rule sets, tests each in its sandbox and keeps the best. |
| 2 minutes or more | `deepest` | The same run with room for the most rule sets, six unless the game sets a lower `max_candidates`. |

The thresholds and the models are settings in `server/config.py` (`WRITER_TIERS`), not part of the contract.

Tennis sets `update_seconds` to 20 and never breaks by itself, so every update is one Neon call. The CS:GO example sets `update_seconds` to 8 and one long break mid-match, so it gets fast calls between rounds and a managed agent run at the break.

## Practice runs

The agent server learns which NPC option works against which kind of player by asking the game to play rounds with no screen. The developer doesn't write that table by hand.

**In `setup`, a game that can do this adds `practice`:**

```json
"practice": {
  "players": {
    "forehand_lover": {"about": "Hits about 70% forehands, mostly cross-court. Weak on deep balls to the backhand."},
    "net_rusher": {"about": "Comes to the net early. Weak against lobs."},
    "even": {"about": "No clear habit. Spreads shots evenly."}
  }
}
```

- `players` names the scripted players the game can run. Each has one plain line in `about`. It can be left empty, because the agent server also writes its own personas.
- `stand_in` is optional. Set `"stand_in": true` when the thing answering practice runs is a simulator and not the real game. What the agent server learns that way is marked provisional.
- A game with no `practice` block still works. The agent server then starts from `default_behaviour` and learns only from live play.

**When it happens.** The game opens the socket with `"mode": "practice"` in `setup`. The agent server sends its practice runs, stores what it learned under the game's name, and sends `ready`. A later `"mode": "live"` match for the same game gets `ready` right away from the stored result. When the design is stored, the server closes the practice socket with code 1000, so the game's practice runner knows it can stop.

### practice_run

Agents to game. Play these rounds now, with no screen, as fast as you can.

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | string | `"practice_run"` |
| `match_id` | string | Same as in `setup`. |
| `run_id` | string | An id for this run. The reply carries it. |
| `player` | string or object | The name of a scripted player from `setup.practice.players`, or a persona object the agent server wrote. See [Personas](#personas). |
| `rounds` | number | How many rounds to play. |
| `behaviour` | object | A whole behaviour in the usual shape. The NPCs use it for every round of this run. |

```json
{
  "type": "practice_run",
  "match_id": "m_001",
  "run_id": "p_014",
  "player": "forehand_lover",
  "rounds": 20,
  "behaviour": {"version": 0, "npcs": {"opponent": {"decisions": {}, "rules": []}}}
}
```

- To test one option, the agent server sends a behaviour that puts all the weight on it. The game needs no special case.
- The game uses `pick` exactly as it does in a live round.

### Personas

The agent server writes its own scripted players at setup, along with the questions it will ask about the player. So `player` in a `practice_run` can be a persona object instead of a name:

```json
"player": {
  "name": "forehand_lover",
  "about": "Leans on the forehand and goes cross-court.",
  "plays": {
    "shot": {
      "side": {"forehand": 0.7, "backhand": 0.3},
      "lands": {"left_deep": 0.5, "right_deep": 0.2, "middle_deep": 0.3}
    }
  }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | A short name. `practice_result.player` repeats it. |
| `about` | string | One plain line on how this player plays. |
| `plays` | object | Keyed by event name, then field name, then option. Each number is how often the scripted player should choose that option. Only fields that are lists of names appear. |

- The game drives its scripted player from those numbers.
- Anything a persona leaves out, the game spreads evenly.
- A game can still name its own scripted players in `setup.practice.players`. The agent server uses both.
- Every practice player gets `plays` numbers, the game's own included. A game's player that came without them gets numbers the designer writes from its `about` line. They are used to judge which practice player the live player is most like. The game still runs its own players by name.

### practice_result

Game to agents. One reply for each `practice_run`.

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | string | `"practice_result"` |
| `match_id` | string | Same as in `setup`. |
| `run_id` | string | The `run_id` of the run this answers. |
| `player` | string | The scripted player that played. For a persona, its `name`. |
| `rounds` | number | How many rounds were played. |
| `wins` | object | Rounds won, keyed by `"player"` and by NPC id, the same names `round_end.score` uses. |
| `stats` | object, optional | Any numbers the game wants to report. |

```json
{
  "type": "practice_result",
  "match_id": "m_001",
  "run_id": "p_014",
  "player": "forehand_lover",
  "rounds": 20,
  "wins": {"player": 13, "opponent": 7},
  "stats": {"average_exchanges": 4.2}
}
```

The game sends no `event`, `frames` or `round_end` for practice rounds.

If the game doesn't know the player in a `practice_run`, it may answer with an `error` whose `where` is `"practice_run.player"`. The server drops that player and the playtest carries on.

## 2. ready

Agents to game, once, after `setup`.

It names the values the agent server will track for this game, and gives the first behaviour.

- **A game with a `default_behaviour`** starts the match on it, unchanged. So the NPCs begin beatable, and every change after that is one the agent server made and explained. What setup learned is kept for the larger loop to draw on.
- **A game without one** gets a first behaviour the agent server writes from the descriptions.
- **A game whose design isn't stored yet** gets `ready` within a few seconds anyway, with its default behaviour. The design follows later as a `strategy_update` with `new_values`.

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | string | `"ready"` |
| `match_id` | string | Same as in `setup`. |
| `values` | object | Every value the agent server will send. Each has a plain `label`, its `kind`, and the `event` and `field` it counts. See [What each value is](#what-each-value-is). |
| `behaviour` | object | The first behaviour, version 1. The game starts the match with this. |

```json
{
  "type": "ready",
  "match_id": "m_001",
  "values": {
    "comes_to_net": {"label": "Comes up to the net", "kind": "camera"},
    "stays_deep": {"label": "Stays back at the baseline", "kind": "camera"},
    "forehand_goes_cross_court": {"label": "Hits the forehand cross-court", "kind": "share", "event": "shot", "field": "lands"},
    "swings_hard": {"label": "Swings hard", "kind": "level", "event": "shot", "field": "power"},
    "like_forehand_lover": {"label": "Plays like the forehand lover", "kind": "likeness"},
    "looks_tired": {"label": "Looks tired on camera", "kind": "camera"}
  },
  "behaviour": {
    "version": 1,
    "npcs": {
      "opponent": {
        "decisions": {
          "shot_type": {
            "topspin": {"base": 0.35},
            "flat": {"base": 0.3},
            "slice": {"base": 0.15},
            "dropshot": {"base": 0.1, "when": {"stays_deep": -0.2}},
            "lob": {"base": 0.1, "when": {"comes_to_net": 0.6}}
          },
          "position": {
            "middle_deep": {"base": 0.7},
            "left_deep": {"base": 0.1, "when": {"forehand_goes_cross_court": 0.6}},
            "right_deep": {"base": 0.1},
            "middle_short": {"base": 0.1}
          }
        },
        "rules": []
      }
    }
  }
}
```

### What each value is

Each value is a number from 0 to 1. Its `kind` says what sort of read it is.

| `kind` | What it reads | Tennis | Another game |
| --- | --- | --- | --- |
| `share` | How often the player picks some options of one field. | How often the shot is a slice. | In a shooter, how often the player comes in through the flank. |
| `level` | How big a number field usually is, for a field declared with `min` and `max`. | How hard the player swings. | In a racing game, how fast the player takes corners. |
| `camera` | Something only the pictures show. | Stands side-on to the camera. | In a shooter, leans in close to the screen. |
| `likeness` | How much the player plays like one practice player. | Plays like `forehand_lover`. | In a shooter, plays like a rusher. |

- `event` and `field` name what a `share` or `level` value counts, using the game's own names.
- They are left out for `camera` and `likeness` values, which count nothing.

### What setup writes

At setup, the designer writes the values and the practice players from the `setup` description alone.

- **8 to 10 values that aren't likeness.** At most two of them count the same field.
- **At least two camera values** when a view shows the player.
- **A level value** for a player field declared with `min` and `max`.
- **No value on something the player doesn't choose.** A field that reports how an action turned out, or what the other side did, is never a habit.
- **The game's own practice players keep their numbers.** When `setup.practice.players.<name>.plays` is there, it is used as given.
- **The written practice players cover every main option.** For each main option nobody else leans on, one practice player makes it their main choice.

The game waits for `ready` before the first round. If play starts early anyway, the server holds up to 500 `event`, `frames` and `round_end` messages that arrive before `ready`, and takes them in once `ready` is sent. Only the newest `frames` is kept.

## 3. event

Game to agents, whenever something the game declared in `setup` happens.

This is the main stream. It's how the agent server knows what the player does and what works against them.

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | string | `"event"` |
| `match_id` | string | Same as in `setup`. |
| `name` | string | One of the event names from `setup`. |
| `round` | number | Which round this is, starting at 1. |
| `t` | number | Seconds since the match started. |
| `by` | string | `"player"`, or the id of the NPC that did it. |
| `data` | object | The fields declared for this event. A field that doesn't apply can be left out or null. |
| `picked` | object, optional | NPC events only. The options the NPC just chose, by decision. |
| `by_rule` | array, optional | The decisions in `picked` that a rule decided, so the break screen can show when a rule fired. |

A player event:

```json
{
  "type": "event",
  "match_id": "m_001",
  "name": "shot",
  "round": 2,
  "t": 41.8,
  "by": "player",
  "data": {"side": "backhand", "shot_type": "topspin", "power": 0.62, "lands": "left_short", "result": "in"}
}
```

An NPC event:

```json
{
  "type": "event",
  "match_id": "m_001",
  "name": "shot",
  "round": 2,
  "t": 43.1,
  "by": "opponent",
  "picked": {"shot_type": "lob", "position": "middle_deep"},
  "by_rule": ["shot_type"],
  "data": {"shot_type": "lob", "lands": "right_deep", "result": "in"}
}
```

- Send the events that say something about how the player plays. A few a second is plenty.
- **Added 12:35 PM: what to put in an event.** Send one event for each thing that happened, like a shot or a kill. Give it both kinds of field wherever the game has them:
  - **The game's own label** for what happened, like `shot_type`. Labels are what the agents count, write rules on, script practice players with and learn matchups from.
  - **A few numbers measured for that one action**, like `power`, `rotation` and `angle`, each declared with its `min` and `max`. The numbers keep what the label leaves out, and they tell apart two actions that got the same label.
- Don't send raw sensor samples, like 60 accelerometer readings a second. Boil them down to one number per action on the game side. Nothing on the agent side can use a raw stream.
- Two optional fields that help when they are cheap to send, declared like any other field: `confidence` from 0 to 1 when a label comes from a classifier, and a timing field such as `early`, `on_time` or `late`.
- If an NPC makes a choice that isn't tied to anything else you report, declare an event for that moment, like `round_start`, and put `picked` on it.

Nothing comes straight back. A `player_read` follows player events.

## 4. frames

Game to agents, about once a second while a round is being played.

This is what Gemini looks at. Pictures carry what events can't: where everything is on the screen, and how the player looks and moves on camera.

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | string | `"frames"` |
| `match_id` | string | Same as in `setup`. |
| `round` | number | Which round this is. |
| `t` | number | Seconds since the match started. |
| `views` | object | One picture for each view named in `setup`. Each has `mime_type` and base64 `data`. |

```json
{
  "type": "frames",
  "match_id": "m_001",
  "round": 2,
  "t": 42.0,
  "views": {
    "court": {"mime_type": "image/jpeg", "data": "BASE64_JPEG"},
    "player_cam": {"mime_type": "image/jpeg", "data": "BASE64_JPEG"}
  }
}
```

- Send JPEG, about 384 pixels wide. Large PNGs are slower for Gemini to read.
- Don't mirror a camera picture.
- No frames are needed in practice mode.

Nothing comes straight back. The frames feed the next `player_read`.

## 5. round_end

Game to agents, when a round ends.

It says who won the round and how. It also says whether a break starts now.

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | string | `"round_end"` |
| `match_id` | string | Same as in `setup`. |
| `round` | number | The round that just ended. |
| `t` | number | Seconds since the match started. |
| `winner` | string | `"player"`, the id of the NPC that won, or `"none"`. |
| `how` | string | A short name for how it ended. The game picks the names. |
| `stats` | object, optional | Numbers about the round, like how long it lasted. |
| `score` | object | Rounds won so far, by `player` and by each NPC id. |
| `break` | true or false | True if a break starts now. It may be true after the last round too. |

```json
{
  "type": "round_end",
  "match_id": "m_001",
  "round": 3,
  "t": 92.4,
  "winner": "opponent",
  "how": "not_reached",
  "stats": {"rally_length": 5, "seconds": 11.2},
  "score": {"player": 1, "opponent": 2},
  "break": true
}
```

Nothing comes straight back. Before the next round starts, the game swaps in the newest `strategy_update` it holds.

## 6. player_read

Agents to game, during play. A read starts after every player event, never closer together than `NPC_WATCH_MIN_INTERVAL_SECONDS`, and pictures start reads too.

It is the agent server's current read of how this player plays. The game doesn't need to understand it. It only plugs the numbers into the behaviour's `when` entries the next time an NPC picks.

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | string | `"player_read"` |
| `match_id` | string | Same as in `setup`. |
| `round` | number | The round it was worked out in. |
| `t` | number | Seconds since the match started. |
| `values` | object | Every value by name, each from 0 to 1. All of them are sent every time. |
| `based_on_events` | number | How many player events it's built on so far. It can be 0 when the read came from pictures alone. |
| `why` | string | One plain line about what moved and what it rests on, for the on-screen panel. |
| `picture_note` | string, optional | One line about what Gemini saw in the pictures. |
| `low_confidence` | array of strings, optional | The names of the values this read is unsure about. |

```json
{
  "type": "player_read",
  "match_id": "m_001",
  "round": 2,
  "t": 42.5,
  "values": {
    "comes_to_net": 0.05,
    "stays_deep": 0.8,
    "forehand_goes_cross_court": 0.6,
    "looks_tired": 0.2
  },
  "based_on_events": 9,
  "why": "5 of 6 forehands went cross-court.",
  "picture_note": "Sets up early on the forehand side."
}
```

- The values are smoothed, so one odd event doesn't swing them.
- A value can say what it counts: one field of one event, and which of its options count. Such a value is blended with the counted share from the player's events, and its `why` says what it rests on. This lives in the design, not on the wire.
- **One call carries every question.** Each read sends the counts from the player's last 20 events, the newest frames, and every question the designer wrote.
- **Pictures start reads in a rally.** While the player's last event was under 2 seconds ago, fresh frames start a read once the last one is 0.6 seconds old.
- **A quiet player is still read.** After 3 seconds with no player event, fresh frames alone start a read.
- **Reads pause when nobody plays.** After 20 seconds with no player event, frames start no reads until the player acts again.
- A read that takes longer than 1.2 seconds is tried once more.
- If a `player_read` is late, the game keeps using the last one.

## 7. strategy_update

Agents to game, at any time during a match.

It carries the new behaviour and the words for the break screen: what the agent server noticed about the player, and what the NPCs will do differently.

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | string | `"strategy_update"` |
| `match_id` | string | Same as in `setup`. |
| `version` | number | The version of the behaviour inside. |
| `source` | string | `"quick"` for a routine update written while play goes on. `"full"` for a deeper rewrite written at a break, when the break is long enough. Either can arrive at any time. |
| `writer` | string, optional | What wrote it: `"fast"`, `"standard"`, `"deep"` or `"deepest"`, or `"fairness"` for a fairness adjustment. |
| `observations` | array of strings | 2 or 3 lines on how this player plays. On a real update they are at most 3 counted lines, of at most 10 words, about what the player did since the last real update. |
| `plan` | array of strings | At most 3 lines on what the NPCs will change, of at most 8 words each. The change of play comes first, and a setting that moves comes second with its reason, in a longer line. |
| `seen` | array, optional | On a real update, the same lines as `observations`, each as `{"text", "event", "field"}`, so a screen can show what each line is about. |
| `changing` | array, optional | On a real update, the same lines as `plan`, each as `{"text", "where"}`. |
| `holding` | true, optional | Set on a holding update, which changes nothing. |
| `changes` | array | Each change: `where` it is, what it went `from` and `to`, and `why`. `where` reads like `opponent.position.left_deep`, `opponent.rules` or `settings.enemy_count`. A change may also carry `expect`, one plain sentence on what should happen next, `measure`, what that will be judged by (like `player_win_rate`), and `kind`, which is `"fairness"` for a fairness adjustment. |
| `checks` | array, optional | One for each earlier `expect` that can now be judged. See [Did the last change work?](#did-the-last-change-work) |
| `tested` | object, optional | Sent when a managed agent wrote the update. It says what was measured, the target, which rule set was kept and how close it came, and every rule set it tried. |
| `new_values` | object, optional | Values the agent server added, in the same shape as in `ready`: `label`, `kind`, and `event` and `field` when it counts one. |
| `settings` | object, optional | The settings to change, by name. The game applies them when the next round starts. |
| `behaviour` | object | The whole new behaviour. It replaces the old one. |

```json
{
  "type": "strategy_update",
  "match_id": "m_001",
  "version": 2,
  "source": "full",
  "observations": [
    "Stays at the baseline almost every point.",
    "The forehand nearly always goes cross-court. 5 of 6 did."
  ],
  "plan": [
    "Wait on the left of the baseline, where the cross-court forehand lands.",
    "Lob when they come to the net."
  ],
  "changes": [
    {
      "where": "opponent.position.left_deep",
      "from": {"base": 0.1, "when": {"forehand_goes_cross_court": 0.6}},
      "to": {"base": 0.1, "when": {"forehand_goes_cross_court": 0.9}},
      "why": "5 of 6 forehands went cross-court and two of them were winners."
    },
    {
      "where": "opponent.rules",
      "from": null,
      "to": "If the player is at the net, lob.",
      "why": "Came to the net twice and won both points with a volley."
    }
  ],
  "behaviour": {
    "version": 2,
    "npcs": {
      "opponent": {
        "decisions": {
          "shot_type": {
            "topspin": {"base": 0.35},
            "flat": {"base": 0.3},
            "slice": {"base": 0.15},
            "dropshot": {"base": 0.1, "when": {"stays_deep": -0.2}},
            "lob": {"base": 0.1, "when": {"comes_to_net": 0.6}}
          },
          "position": {
            "middle_deep": {"base": 0.7},
            "left_deep": {"base": 0.1, "when": {"forehand_goes_cross_court": 0.9}},
            "right_deep": {"base": 0.1},
            "middle_short": {"base": 0.1}
          }
        },
        "rules": [
          {
            "if": [{"fact": "player_position", "in": ["left_short", "middle_short", "right_short"]}],
            "do": {"shot_type": "lob"},
            "why": "Came to the net twice and won both points with a volley."
          }
        ]
      }
    }
  }
}
```

- It doesn't wait for a round to end. The agent server starts its first rewrite about 10 seconds into a match. It starts the next one as soon as the last has landed and there has been a new player event or a round has ended. Each fits inside the game's `update_seconds`, which is 20 if left out.
- A long break can bring one more, from a deeper rewrite that fits inside `break_seconds`.
- The game keeps the newest one it has received. It swaps it in at the next gap between rounds, never in the middle of one.
- A newer one replaces an older one that hasn't been swapped in yet.
- The game resumes when the break timer runs out, with the newest behaviour it holds.
- Every look that completes sends an update. When nothing changes, it is a holding update: `changes` is empty, `"holding": true`, the play is the same, the version is new, and `plan` says why.
- If nothing arrives, the game carries on with the old behaviour.
- A numeric setting that a game marks as a difficulty or pacing dial, such as how fast the NPC moves, is changed by the agent server only as a fairness adjustment. It slows the NPC when the player is losing too many points and speeds it up when the player is winning too many, in small steps inside the setting's `min` and `max`. It is never used to answer a habit. The `changes` item for it says it is a fairness adjustment. It arrives in `settings`, as above. No shapes change.

### Did the last change work?

Every `strategy_update` can say what it expects, and a later one reports whether that happened. This is how the agent server checks its own changes.

- Each item in `changes` may carry `expect`: one plain sentence on what should happen next.
- `strategy_update` may carry `checks`, one for each earlier expectation that can now be judged.

```json
"checks": [
  {
    "version": 2,
    "said": "Your cross-court forehand should win you fewer points.",
    "measure": "habit_payoff",
    "before": 0.8,
    "after": 0.33,
    "held": true
  }
]
```

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | number | The behaviour version whose `expect` this judges. |
| `said` | string | The `expect` line, as it was sent. |
| `measure` | string | What was measured. `habit_payoff` is how often the player's favourite play comes in a round they win. |
| `before` | number | The measure before that version. |
| `after` | number | The measure since that version. |
| `held` | true or false | Whether the expectation came true. |

A game can ignore both fields. They are there for the break screen and the second screen.

## Early signs

Some games can see what the player is about to do a moment before they do it. In tennis, the racket starts its swing a fraction of a second before it hits the ball. The contract handles this with parts it already has.

- **An early event** is a player event the game sends before the main action, like tennis's `swing_start` before `shot`. It carries what the game can read at that moment, like `early_guess` for the coming shot type.
- **Early facts** repeat those fields for the NPC at the moment it decides. Name each one `<event>_<field>` or `<first word of the event>_<field>`, like `swing_early_guess`, so the agent server can tell which event it came from.
- **A decision made from the early sign** is an ordinary NPC decision, like tennis's `anticipate`. The game picks it the moment the early event arrives, and reports it as its own NPC event with `picked`, plus `by_rule` when a rule decided it.
- **A rule on an early sign stays only when the sign holds up.** The agent server pairs each early event with the player event that follows it in the same round within a second. A sign holds up when it was seen at least 5 times, was followed by the same thing at least 70% of the time, and beats how often that thing follows anyway by at least 10 points. A player who disguises their swing gets no rule on it. These thresholds are settings.

## How counters are chosen

Practice runs show which option wins more often against which practice player. That is the matchup table, and the larger loop draws on it.

- **An option counts as a counter** when it beats the baseline against that practice player by a clear margin. The margin is at least 25% of the baseline rate, at least 10 points of win rate, and two standard errors wide.
- **Counters are ranked by how specific they are to this player.** That is the edge against the practice player this player most looks like, minus the average edge against the others.
- **An option that clearly beats the default against at least 75% of the practice players is general.** It says nothing about this player, so it gets no new rule, and its weight rises by at most 0.15 in one update.
- **An option that wins 90% or more against every practice player is a hole in the game.** It is never raised.

## A real update, and what a game can do with it

- **A real update is a `strategy_update` whose `changes` is not empty.** A holding update has `changes: []` and `"holding": true`, and leaves the play as it is.
- **A game that stops to show each change tests `changes`.** The tennis demo does: at the end of the point it pauses and shows the change. A game that doesn't stop should run the server with `NPC_UPDATES_STOP_PLAY=0`.
- **The play clock only runs while events arrive.** The time between two `event` or `round_end` messages counts when it is under 3 seconds. A longer gap is a pause.
- **The first look starts after 3 player events**, or after 6 seconds, whichever comes first.
- **After a real update, the next look starts at the first player event that follows.** No real update goes out within 10 seconds of play after the last one. Looks written before a real update are dropped, because they were written for the old play.
- **An update goes out only while the game is playing**, within 1.5 seconds of an `event` or `round_end`. One that lands during a stop waits until play picks up again.
- **Strength waits for proof.** A strengthening written before the last change has been played is kept. It is sent only once 2 rounds that started after the last real update have finished and the player won the last one. It is dropped after 4 such rounds.
- **Every finished round counts**, including one the player never touched.

## Fairness

- **The measure is the player's share of the last 8 finished rounds.** While fewer have finished, the missing ones are filled from the practice table's estimate.
- **Above 60%, the next look adds strength.** The first real update of a match may go out from 50%, once the player has sent at least 3 events.
- **Under 40%, the very next look takes strength back.** It is done in code with no model call, and the update says so. An ease takes back half of the latest step, or all of it when the share is under 25%.
- **In between, it holds.**
- **The emergency brake** eases after 5 losses in a row, whatever the share says.
- **Eases are spaced out.** After an ease, the next one waits until 2 more rounds have finished.
- **The step is capped.** One update adds at most 0.15 of a decision's picks to an option, and the cap widens up to 0.35 when the player is far above the band.
- **The latest step is also judged alone.** If the player won 1 round or fewer in at least 4 rounds since it, it was too much.
- **Nothing whose estimate falls under 0.42 is sent.** Such a counter goes in as a weight sized to leave the player about half, not as a rule.
- **A rule fairness took off never comes back as a rule.** Its option's weight stays capped under what it was.
- **A rule that decides almost every pick** (80% or more over at least 5 picks) isn't about a situation any more, so the next look takes it off.
- These thresholds are settings. [running.md](running.md#settings) lists them.

## 8. error

Agents to game, when a message doesn't fit what `setup` declared. The agent server says exactly what is wrong and carries on. The socket stays open.

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | string | `"error"` |
| `match_id` | string | Same as in `setup`. |
| `about` | string | One plain line on what is wrong. |
| `where` | string | Where in the message the problem is, like `event.data.spin`. |
| `got` | any | The value that didn't fit. |

```json
{
  "type": "error",
  "match_id": "m_001",
  "about": "The event `shot` has a field that `setup` did not declare.",
  "where": "event.data.spin",
  "got": "topspin"
}
```

## How an NPC picks (game side)

This is the whole change inside the game. `legal` is the list of options the game allows right now. `values` is from the latest `player_read`. `facts` is what the NPC can check at this moment.

```py
import random

def pick(npc, decision, legal, behaviour, values, facts, rng=None):
    """Returns the option to play, and whether a rule decided it."""
    rng = rng or random
    mine = behaviour.get("npcs", {}).get(npc)
    if not mine or not legal:
        return (rng.choice(legal) if legal else "", False)
    # 1. Rules first. The first rule that fits and is legal decides.
    for rule in mine.get("rules", []):
        choice = rule.get("do", {}).get(decision)
        if choice in legal and all(holds(c, values, facts) for c in rule.get("if", [])):
            return choice, True
    # 2. Otherwise score every legal option, then pick in proportion to the scores.
    options = mine.get("decisions", {}).get(decision, {})
    scores = []
    for name in legal:
        option = options.get(name, {})
        score = option.get("base", 0)
        for value_name, weight in option.get("when", {}).items():
            score += weight * values.get(value_name, 0)
        scores.append(max(score, 0))
    if sum(scores) == 0:
        return rng.choice(legal), False
    return rng.choices(legal, weights=scores)[0], False

def holds(cond, values, facts):
    x = values.get(cond["value"], 0) if "value" in cond else facts.get(cond.get("fact"))
    if "is" in cond:
        return x == cond["is"]
    if "in" in cond:
        return x in cond["in"]
    if x is None:
        return False
    if "above" in cond:
        return x > cond["above"]
    if "below" in cond:
        return x < cond["below"]
    return False
```

The game calls it once for each choice an NPC makes, like `pick("opponent", "shot_type", ...)`. [examples.md](examples.md) shows where tennis and CS:GO call it.

The same function ships in both SDKs:

- **Python** is `sdk/python/adaptive_npc/pick.py`. It takes an optional `rng` so tests can fix the random choices.
- **JavaScript** is `sdk/js/pick.js`, an ES module that runs in a browser and in Node. It takes an optional `rng` function that returns a number from 0 to 1.
- **The shared test cases** are in `sdk/test-vectors.json`. Both SDKs must give the same answer on every case whose answer doesn't depend on chance.

The code above handles each of these cases. They are spelled out for anyone writing `pick` in another language, and the 36 shared test cases in `sdk/test-vectors.json` check most of them:

- A rule whose option isn't legal right now is skipped. The next rule that holds decides, or scoring does if none holds.
- A rule with no `do`, or whose `do` doesn't name this decision, doesn't decide it. One rule can force more than one decision.
- A rule with an empty or missing `if` always holds. Otherwise every condition in its `if` must hold.
- A condition with none of `is`, `in`, `above` or `below` never holds. If a condition has more than one, only the first of `is`, `in`, `above`, `below`, in that order, counts.
- Only legal options are scored, so an option that isn't legal is never picked, whatever its weight.
- A legal option that the behaviour doesn't list scores 0. An option with no `base` starts from 0.
- A score below 0 counts as 0. When every legal option scores 0, the NPC picks one of them with equal chance, and no rule decided it.
- A value the game hasn't received counts as 0, in a `when` entry and in a rule. So a rule asking whether it `is` 0 holds.
- `above` and `below` work on values and on number facts, and they are strict. A value or fact equal to the limit doesn't count.
- A fact the game doesn't have doesn't equal any name, and never holds for `in`, `above` or `below`.
- An NPC the behaviour doesn't know, or an empty entry for the NPC, picks one of the legal options with equal chance, and no rule decides.
- A decision the behaviour doesn't list still has its rules checked first. If none decides, the NPC picks one of the legal options with equal chance.
- An entry for the NPC with no `rules` or no `decisions` works as if that part were empty.
- With no legal options, `pick` returns an empty name, and no rule decides.

## Timing

These are the targets the agent server is built for. The game should never depend on them, because it never waits.

| Message | Target |
| --- | --- |
| `ready` | Within a few seconds. A game whose design isn't stored yet gets its default behaviour first, and the design follows as a `strategy_update`. |
| `player_read` | Under a second after the player's event. |
| `strategy_update` | The first rewrite starts about 10 seconds into a match. Each fits inside `update_seconds` (20 if left out), and the next starts as soon as the last has landed. The game swaps in the newest at the next gap between rounds. |

## If something goes wrong

- If the socket drops, the game keeps playing with what it has. It reconnects and sends `setup` again with the same `match_id`, and the agent server picks up where it was.
- If a behaviour names an NPC, an option or a value the game doesn't know, the game skips that entry and carries on. The same goes for a setting it can't apply.
- A value the game hasn't received yet counts as 0.
- If no `ready` comes within 90 seconds, the game starts with its `default_behaviour`, or with every option equally likely if it has none.
- If an `error` arrives, the game can log it and carry on. Nothing else changes.

## What each side builds

The game:

- **The `setup` description** of the game, written once.
- **One call to `pick`** for every NPC choice, in one place in the code.
- **The reports:** `event` when something happens, `frames` about once a second and `round_end` on every round.
- **The swap:** a new behaviour, and any settings, go in only between rounds.
- **The break screen**, which shows `observations`, `plan` and `changes`.
- **A practice mode**, if it can, where a scripted player plays rounds with no screen. The agent server uses it to learn which options answer which habits. It also gives a baseline to compare the adapted NPCs against.
- **Options that matter.** If a player really has a habit, the option that answers it should win clearly more often. Aim for the right answer to be worth about 25% more than the default.

The agent server:

- **The WebSocket server** at `/ws`, and the viewer stream at `/watch`.
- **Practice runs** at setup, when the game offers them, against the game's own scripted players and the personas the agent server wrote.
- **`ready`**, with the values and the first behaviour, written from the `setup` description alone.
- **A `player_read`** during each round, built from the events and the frames.
- **A `strategy_update`** whenever the larger loop finishes a rewrite, with the observations and the plan.
- **Nothing game-specific.** Nothing on this side knows which game it is talking to, and nothing on this side ever blocks the game.

## The viewer stream

This one is not for the game. A second socket at `ws://AGENT_HOST:8000/watch` sends everything that happens in a match, for a second screen, for recordings and for the side panels a game page can embed (see [running.md](running.md#put-the-side-panels-in-a-game-page)).

Each line is one JSON object:

```json
{"dir": "in", "t": 12.4, "at": 1795294812.305, "match": "m_001", "message": {"type": "event", "match_id": "m_001", "name": "shot"}}
```

- `dir` is `"in"` for game to agents, `"out"` for agents to game, and `"trace"` for something the agent server did.
- `t` is seconds since the match started.
- `at` is the clock time, in seconds since 1970.
- `match` is the match id, so a viewer can tell matches apart.
- On connect, a viewer that names no match is first sent every match that spoke in the last two minutes, the one that spoke last at the end. Then everything comes live.
- `/watch?match_id=<id>` sends only that match.
- When a game's socket closes, the stream carries one closing trace for that match: stage `server`, status `done`, about `The game left.` and `data` `{"game": "left"}`.

A trace message looks like this:

```json
{"type": "trace", "stage": "watcher", "status": "done", "about": "Read the player from 9 events and 1 frame.", "model": "gemini-decision-1", "ms": 312, "data": {}}
```

- `stage` is `server`, `designer`, `playtest`, `watcher`, `adapter` or `measures`.
- `status` is `start`, `done` or `error`.
- After each round the server sends a `measures` trace whose `data` holds the player's top habits, each habit's payoff, and the player's share of rounds won.
- About every 10 seconds a `server` trace reports the reads: how many started, how many came back, their median time and reads per second.
- At each real update a `server` trace gives the play seconds and the clock seconds since the last change.
