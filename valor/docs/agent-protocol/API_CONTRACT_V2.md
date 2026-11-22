# Game ↔ Agent API Contract — Draft 2 (Sat 21 Nov)

> **Status: draft, not agreed yet.** Draft 1 was written around tennis. This one doesn't name a game.
> Tennis and CS:GO are worked through in full on "API Design examples: tennis and CS:GO".
> **This replaces the HTTP contract in `CONTRACTS.md` / `shared/contracts.ts` once agreed.**

## What this page is

This is the contract between a game and the agent system. For us today that is the game side (Akhil, Ethan) and the agent side (Felix, Gavin). If both sides build to this page, nobody has to wait on anybody.

The short version: the game describes itself once and reports what the player does. The agents send back how the game's NPCs should play.

Nothing here is tied to one game. A game plugs in by describing itself in `setup`, and every other message uses the names it gave there. That is also the pitch:

- **It saves development time.** A studio describes its game once and gets working NPC behaviour back. Nobody hand-tunes every NPC.
- **It keeps players around longer.** The NPCs keep adapting to how each person plays.

## What a game does to plug in

1. It describes itself in `setup`: its NPCs, the choices they make, the things that can happen, and the pictures it can send. That is 50 to 100 lines of JSON, written once.
2. It reports what happens, with `event`, `frames` and `round_end`.
3. It calls one small function, `pick`, wherever an NPC makes a choice. The code is near the bottom of this page.
4. It swaps in each new behaviour between rounds.

The game never writes the questions about the player, the values, the weights or the rules. The agents write all of those from the description.

We decide what an NPC chooses. The game still does the moving, the aiming and the animation.

## How the two sides talk

- There is one WebSocket. The game opens it to the agent backend at `ws://AGENT_HOST:8000/ws`. For the demo both sides run on the same laptop, so `AGENT_HOST` is `localhost`.
- Every message is one JSON object with a `type` and the `match_id`.
- The game never waits on the agents during a round. The NPCs always play with the latest `player_read` and the latest behaviour the game has. If the agents go quiet, the NPCs keep playing.
- The game owns the names. NPCs, decisions, options, events and places are whatever the game says they are in `setup`. The agents send them back spelled exactly the same.
- Left and right always mean left and right as you see them on the game screen.
- A new behaviour is only swapped in between rounds, never in the middle of one.

## Words used here

- The **player** is the human.
- An **NPC** is any character the game controls: an opponent, an enemy, a bot. One NPC entry can also stand for a group that shares one behaviour, like a squad.
- A **round** is one stretch of play with a result. In tennis it's a point. A **break** is a pause between rounds, when we show the dashboard. The game decides how often.
- A **decision** is a choice an NPC makes from a fixed list of **options**.
- An **event** is something that happened in the game and that the game reports.
- A **fact** is something an NPC can check at the moment it decides, like where the player is standing.
- A **value** is a number from 0 to 1 for one habit of this player. 0 means we haven't seen it. 1 means they do it all the time. The agents choose the values for each game.
- The **behaviour** is the JSON that decides how the NPCs choose. The game runs it and the agents rewrite it.
- A **setting** is something about the match that isn't an NPC's choice, like how many enemies there are. A game doesn't have to have any.

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
          "flat": {"base": 0.5},
          "lob": {"base": 0.25, "when": {"comes_to_net": 0.6}},
          "drop": {"base": 0.25, "when": {"stays_deep": -0.2}}
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
| `rules` | array | Checked first, in order. It can be empty. Four at most for each NPC, because more didn't help in our tests. |
| `if` | array | Conditions that must all be true. A condition checks a `fact` or a `value`, using `is`, `in`, `above` or `below`. |
| `do` | object | The decision to force and the option to pick, like `{"shot_type": "lob"}`. |
| `why` | string | One plain line for the dashboard. |

How a pick works:

1. The first rule whose conditions are all true, and whose option is legal right now, decides.
2. Otherwise every legal option gets a score, which is its `base` plus weight times value for each `when` entry. The NPC picks at random in proportion to the scores, so an option with twice the score gets picked twice as often. A score below 0 counts as 0.

## The messages at a glance

| Message | Direction | When | What it's for |
| --- | --- | --- | --- |
| `setup` | game to agents | once, before the match | Describes the game: its NPCs, decisions, events, facts and pictures |
| `ready` | agents to game | once, after `setup` | Names the values the agents will track and gives the first behaviour |
| `event` | game to agents | whenever something the game declared happens | Says what just happened |
| `frames` | game to agents | about once a second during a round | Gives Gemini something to look at |
| `round_end` | game to agents | when a round ends | Says who won and how, and whether a break starts |
| `player_read` | agents to game | during a round, after player events | The latest read of how this player plays |
| `strategy_update` | agents to game | after a round ends | The new behaviour, plus what to show on the dashboard |

## 1. setup

Game to agents, once, before the match.

It is the only place where a game says anything about itself. The agents use it to write the questions they'll ask about the player, so the more plainly it describes things, the better.

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | string | `"setup"` |
| `match_id` | string | Any id for this match. Every later message carries it. |
| `game` | string | A short name for the game. |
| `about` | string | Two or three plain sentences on how the game works and who the player is up against. |
| `mode` | string | `"live"` with a real player. `"practice"` with a scripted player and no screen. `"replay"` when a recording is played back through the same messages and nothing gets applied. |
| `goal` | string | One plain sentence on what the NPCs are for. The agents read it every time they rewrite the behaviour. |
| `plan` | object | `rounds` in the match, `break_every` (rounds between breaks) and `break_seconds`. |
| `lists` | object, optional | Lists of names you want to reuse, like the zones of a court. Wherever a list of names is expected, you can write the list's name. |
| `npcs` | object | One entry for each NPC, or for each group that shares one behaviour. Each has `about` and its `decisions`. |
| `decisions` | object, inside each NPC | Each decision has `when`, a plain line on the moment it gets made, and `options`, each with one line that says what it is. |
| `events` | object | Everything the game will report. Each has `about` and its `fields`. |
| `facts` | object | What an NPC can check at the moment it decides. Rules can only use these. |
| `views` | object | The pictures the game can send, each with one line on what it shows. |
| `settings` | object, optional | Things the agents may change between rounds that aren't an NPC's choice. Each has `about`, then `options` or `min` and `max`, and `now`. |
| `default_behaviour` | object, optional | The behaviour the game already has, if it has one. It is also our baseline for the proof. If it's left out, the agents write the first behaviour and the baseline is every option equally likely. |

Each event field and each fact says what kind of thing it is:

| You write | It means |
| --- | --- |
| A list of names, like `["in", "out", "net"]` | One of these names. |
| The name of a list from `lists` | One of the names in that list. |
| `{"min": 0, "max": 1, "about": "..."}` | A number in that range. |
| `"number"` | A count, or a number with no fixed range. |
| `"text"` | Free text. The agents can show it but can't count it. |

This is what lets our code count a player's habits in a game it has never seen.

```json
{
  "type": "setup",
  "match_id": "m_001",
  "game": "tennis",
  "about": "One human player plays single points against one AI opponent. The player is at the bottom of the screen.",
  "mode": "live",
  "goal": "Keep the player in long, close rallies.",
  "plan": {"rounds": 5, "break_every": 1, "break_seconds": 10},
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
            "flat": "Fast and low.",
            "lob": "High and deep.",
            "drop": "Soft and short, just over the net."
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
        "shot_type": ["flat", "lob", "drop"],
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

What comes back: `ready`.

## 2. ready

Agents to game, once, after `setup`.

It names the values the agents will track for this game, and gives the first behaviour. If the game sent a `default_behaviour`, the first behaviour is that default with `when` entries added. If it didn't, the agents write the whole thing from the descriptions.

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | string | `"ready"` |
| `match_id` | string | Same as in `setup`. |
| `values` | object | Every value the agents will send, each with a plain `label` for the dashboard. |
| `behaviour` | object | The first behaviour, version 1. The game starts the match with this. |

```json
{
  "type": "ready",
  "match_id": "m_001",
  "values": {
    "comes_to_net": {"label": "Comes up to the net"},
    "stays_deep": {"label": "Stays back at the baseline"},
    "forehand_goes_cross_court": {"label": "Hits the forehand cross-court"},
    "looks_tired": {"label": "Looks tired on camera"}
  },
  "behaviour": {
    "version": 1,
    "npcs": {
      "opponent": {
        "decisions": {
          "shot_type": {
            "flat": {"base": 0.5},
            "lob": {"base": 0.25, "when": {"comes_to_net": 0.6}},
            "drop": {"base": 0.25, "when": {"stays_deep": -0.2}}
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

The game waits for `ready` before the first round.

## 3. event

Game to agents, whenever something the game declared in `setup` happens.

This is the main stream. It's how the agents know what the player does and what works against them.

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
| `by_rule` | array, optional | The decisions in `picked` that a rule decided, so the dashboard can show when a rule fired. |

A player event:

```json
{
  "type": "event",
  "match_id": "m_001",
  "name": "shot",
  "round": 2,
  "t": 41.8,
  "by": "player",
  "data": {"side": "backhand", "shot_type": "flat", "power": 0.62, "lands": "left_short", "result": "in"}
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

- Send JPEG, about 384 pixels wide. A big PNG took about four times as long for Gemini to read in our tests.
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
| `break` | true or false | True if a break starts now. |

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

What comes back: a `strategy_update`. The game applies it before the next round starts.

## 6. player_read

Agents to game, during a round, after player events. It arrives about once a second at most.

It is the agents' current read of how this player plays. The game doesn't need to understand it. It only plugs the numbers into the behaviour's `when` entries the next time an NPC picks.

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | string | `"player_read"` |
| `match_id` | string | Same as in `setup`. |
| `round` | number | The round it was worked out in. |
| `t` | number | Seconds since the match started. |
| `values` | object | Every value by name, each from 0 to 1. All of them are sent every time. |
| `based_on_events` | number | How many player events it's built on so far. |
| `why` | string | One plain line about what moved, for the on-screen panel. |
| `picture_note` | string, optional | One line about what Gemini saw in the pictures. |

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
- If a `player_read` is late, the game keeps using the last one.

## 7. strategy_update

Agents to game, after a round ends.

It carries the new behaviour and the words for the dashboard: what the agents noticed about the player, and what the NPCs will do differently.

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | string | `"strategy_update"` |
| `match_id` | string | Same as in `setup`. |
| `version` | number | The version of the behaviour inside. |
| `source` | string | `"quick"` or `"full"`. See below. |
| `observations` | array of strings | 2 to 4 short lines on how this player plays. |
| `plan` | array of strings | 2 to 4 short lines on what the NPCs will change. |
| `changes` | array | Each change: `where` it is, what it went `from` and `to`, and `why`. `where` reads like `opponent.position.left_deep`, `opponent.rules` or `settings.enemy_count`. |
| `new_values` | object, optional | Values the agents added at this break, in the same shape as in `ready`. |
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
            "flat": {"base": 0.5},
            "lob": {"base": 0.25, "when": {"comes_to_net": 0.6}},
            "drop": {"base": 0.25, "when": {"stays_deep": -0.2}}
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

- Two can arrive after one round. A `quick` one comes within a couple of seconds, so the dashboard has something to show straight away. A `full` one follows once the bigger model has finished thinking, which takes 20 to 40 seconds. If the pause is shorter than that, it lands during the next round and is applied at the one after. The later one replaces the earlier one.
- The game resumes when the break timer runs out, with whichever behaviour arrived last.
- If nothing arrives, the game carries on with the old behaviour.

## How an NPC picks (game side)

This is the whole change inside the game. `legal` is the list of options the game allows right now. `values` is from the latest `player_read`. `facts` is what the NPC can check at this moment.

```python
import random

def pick(npc, decision, legal, behaviour, values, facts):
    """Returns the option to play, and whether a rule decided it."""
    mine = behaviour["npcs"][npc]
    # 1. Rules first. The first rule that fits and is legal decides.
    for rule in mine["rules"]:
        choice = rule["do"].get(decision)
        if choice in legal and all(holds(c, values, facts) for c in rule["if"]):
            return choice, True
    # 2. Otherwise score every legal option, then pick in proportion to the scores.
    options = mine["decisions"][decision]
    scores = []
    for name in legal:
        option = options.get(name, {})
        score = option.get("base", 0)
        for value_name, weight in option.get("when", {}).items():
            score += weight * values.get(value_name, 0)
        scores.append(max(score, 0))
    if sum(scores) == 0:
        return random.choice(legal), False
    return random.choices(legal, weights=scores)[0], False

def holds(cond, values, facts):
    x = values.get(cond["value"], 0) if "value" in cond else facts.get(cond["fact"])
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

The game calls it once for each choice an NPC makes, like `pick("opponent", "shot_type", ...)`. The examples page shows where tennis and CS:GO call it.

## Timing

| Message | How fast |
| --- | --- |
| `ready` | A few seconds once this game has been set up before. Up to a minute the first time. |
| `player_read` | Usually under a second after the player's event. |
| `strategy_update`, quick | Within 2 seconds of the round ending. |
| `strategy_update`, full | 20 to 40 seconds after the round ends. With a short pause it takes effect one round later. |

## If something goes wrong

- If the socket drops, the game keeps playing with what it has. It reconnects and sends `setup` again with the same `match_id`, and the agents pick up where they were.
- If a behaviour names an NPC, an option or a value the game doesn't know, the game skips that entry and carries on. The same goes for a setting it can't apply.
- A value the game hasn't received yet counts as 0.
- If no `ready` comes within 90 seconds, the game starts with its `default_behaviour`, or with every option equally likely if it has none.

## What each side builds

Game side:

- The `setup` description of the game.
- Every NPC choice goes through `pick`, in one place in the code.
- It sends `event` when something happens, `frames` about once a second and `round_end` on every round.
- It swaps in a new behaviour, and applies any settings, only between rounds.
- The break screen shows `observations`, `plan` and `changes`.
- A practice mode, where a scripted player plays rounds with no screen. The agents use it to test strategies. It also gives us the proof numbers against the baseline, and proof is 25% of the judging.
- The right answer has to pay. If a player really has a habit, the option that answers it should win clearly more often. In our overnight tests the adapting only showed when the right answer was worth about 25% more than the default.

Agent side:

- The WebSocket server.
- `ready`, with the values and the first behaviour, written from the `setup` description alone.
- A `player_read` during each round, built from the events and the frames.
- A `strategy_update` after every round, with the observations and the plan.
- Nothing on this side knows which game it is talking to, and nothing on this side ever blocks the game.

## Open questions

- Do we want `settings` today? The CS:GO ideas about more enemies and new cover need it. Tennis doesn't.
- Does each game already have a default behaviour, or do the agents write the first one?
- How long is the pause between rounds?
- Can each game run a practice mode?
- The questions about each game are on the examples page.
