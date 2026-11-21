# Examples: tennis and CS:GO

[api.md](api.md) is the contract, and it doesn't name any game. This page shows two games using it. Tennis is the live demo. CS:GO is the recorded one. Their `setup` files are [../examples/tennis/setup.json](../examples/tennis/setup.json) and [../examples/csgo/setup.json](../examples/csgo/setup.json).

Both games send and receive the same messages. The only thing that differs is what each game says about itself in `setup`.

| | Tennis | CS:GO |
| --- | --- | --- |
| A round | One point | One round |
| NPCs | `opponent` | `enemies`, a squad that shares one behaviour |
| Decisions | `shot_type`, `aim`, `position`, and `anticipate` from the early sign | `formation`, `on_contact`, `on_gunfire` |
| Events | `swing_start` (the early sign), `anticipate`, `shot`, `missed_swing` | `round_start`, `entered`, `spotted`, `kill` |
| Facts | where the player stands, their last shot, which side their racket arm is on, the rally length, and what the start of the swing shows | where the player was last seen, enemies alive, seconds into the round |
| Views | `court`, `player_cam` | `screen`, `player_cam` |
| Settings | `opponent_speed` | `enemy_count`, `loadout`, `extra_cover` |
| Default behaviour | sent by the game | left out, so the agents write the first one |
| Goal | take away the player's habits one at a time, until points are about even | every round close |

## Tennis (the live demo)

### What it is

One player with a racket controller plays points against one AI opponent for as long as the session runs. There is no fixed number of points. A round is one point. The opponent makes three choices every time it hits the ball, and a fourth, `anticipate`, the moment the player starts a swing.

### setup

```json
{
  "type": "setup",
  "match_id": "m_001",
  "game": "tennis",
  "about": "One human player plays single points against one AI opponent. The player stands stationary at the center baseline swinging a physical M5 IMU racket controller while a webcam tracks their stroke side (forehand/backhand) and swing path. Because player court movement is fixed, focus habit reads and counter-strategies on the player shot_type (topspin, slice, dropshot), side (forehand, backhand), swing_start tells (early_guess, backswing, initial_speed), and shot placement (lands): low slice to backhand disrupts heavy topspin habits, short dropshots/slices disrupt pure topspin grinders, and moving in (middle_short / anticipate move_in) with flat drives punishes dropshot habits. Serves are topspin, flat, or slice. Message timestamps t measure active play time in seconds.",
  "mode": "live",
  "goal": "Start beatable. Work out what this player relies on to win points and take it away, one habit at a time, until the player wins about half the points. Win by choosing better shots, never by hitting harder or faster.",
  "plan": {
    "break_every": 0,
    "break_seconds": 0,
    "update_seconds": 20
  },
  "lists": {
    "zone": [
      "left_short",
      "middle_short",
      "right_short",
      "left_deep",
      "middle_deep",
      "right_deep"
    ],
    "human_shot_type": [
      "topspin",
      "slice",
      "dropshot"
    ],
    "ai_shot_type": [
      "topspin",
      "flat",
      "slice",
      "dropshot",
      "lob"
    ],
    "arm_zone": [
      "left",
      "center",
      "right"
    ]
  },
  "npcs": {
    "opponent": {
      "about": "The AI tennis player on the far side of the net.",
      "decisions": {
        "shot_type": {
          "when": "Each time the opponent hits the ball.",
          "options": {
            "topspin": "Heavy arcing topspin with high bounce and strong margin.",
            "flat": "Fast, low, penetrating drive that rushes the player timing.",
            "slice": "Low-skidding backspin ball that stays low and forces upward lift.",
            "dropshot": "Soft, short ball landing just over the net that punishes deep positioning.",
            "lob": "High deep arc over the player head that resets the rally or punishes forward reach."
          }
        },
        "aim": {
          "when": "Each time the opponent hits the ball.",
          "options": {
            "left_deep": "Deep to the left side of the player half (right-hander backhand side).",
            "middle_deep": "Deep down the middle of the player baseline.",
            "right_deep": "Deep to the right side of the player half (right-hander forehand side).",
            "left_short": "Short angle to the left side near the service line.",
            "right_short": "Short angle to the right side near the service line."
          }
        },
        "position": {
          "when": "Right after the opponent hits the ball.",
          "options": {
            "middle_deep": "Recover to the middle of the far baseline.",
            "left_deep": "Shade left on the far baseline to cover shots to screen-left.",
            "right_deep": "Shade right on the far baseline to cover shots to screen-right.",
            "middle_short": "Step forward toward the net to take the next ball early."
          }
        },
        "anticipate": {
          "when": "The moment the player starts a swing (~100-160ms before ball contact).",
          "options": {
            "stay": "Hold current position until the ball is hit.",
            "lean_left": "Start moving early toward screen-left.",
            "lean_right": "Start moving early toward screen-right.",
            "move_in": "Start moving forward toward the net to cover a short ball.",
            "move_back": "Start moving deeper behind the baseline."
          }
        }
      }
    }
  },
  "events": {
    "swing_start": {
      "about": "The player started a swing (~85-160ms before ball contact). High reliability on side and arm_zone (~92%); medium-high on backswing, initial_speed, and early_guess (~75-80% match with final shot — compare with shot to spot disguised tells).",
      "fields": {
        "early_guess": "human_shot_type",
        "confidence": {
          "min": 0,
          "max": 1,
          "about": "Reliable. Classifier confidence in early_guess before contact."
        },
        "backswing": {
          "min": 0,
          "max": 1,
          "about": "Reliable. Pre-swing windup/takeback size (0 = compact/no windup, 1 = big windup)."
        },
        "initial_speed": {
          "min": 0,
          "max": 1,
          "about": "Reliable. Swing onset speed in first 25ms (separates gentle dropshot taps from hard drives)."
        },
        "side": [
          "forehand",
          "backhand"
        ],
        "arm_zone": "arm_zone"
      }
    },
    "anticipate": {
      "about": "The opponent reacted to swing_start before ball contact.",
      "fields": {
        "move": [
          "stay",
          "lean_left",
          "lean_right",
          "move_in",
          "move_back"
        ]
      }
    },
    "shot": {
      "about": "Either side hit the ball (emitted once per shot at racket-ball contact with solved landing zone and result). High-reliability labels: side, arm_zone, shot_type, timing, from, lands, result. For shot direction, use lands rather than angle.",
      "fields": {
        "rally": "number",
        "side": [
          "forehand",
          "backhand"
        ],
        "arm_zone": "arm_zone",
        "shot_type": [
          "topspin",
          "flat",
          "slice",
          "dropshot",
          "lob"
        ],
        "power": {
          "min": 0,
          "max": 1,
          "about": "High reliability. Normalized swing effort from M5 peak dynamic accel + gyro (0 = soft touch, 1 = max rip)."
        },
        "rotation": {
          "min": -1,
          "max": 1,
          "about": "Medium-high reliability (slightly noisy near 0). Spin from webcam vertical path + racket face; below -0.25 is slice, above +0.2 is topspin."
        },
        "angle": {
          "min": -1,
          "max": 1,
          "about": "Noisy (gyro yaw can drift if feet shift mid-point) — weight lightly; use lands zone for shot direction."
        },
        "confidence": {
          "min": 0,
          "max": 1,
          "about": "High reliability. Classifier + pose confidence in the shot_type and side labels."
        },
        "timing": [
          "early",
          "on_time",
          "late"
        ],
        "quality": {
          "min": 0,
          "max": 1,
          "about": "High reliability. Contact quality from lateral/depth reach and ball height (low when stretched or jammed, high when comfortable)."
        },
        "from": "zone",
        "other_position": "zone",
        "lands": "zone",
        "result": [
          "in",
          "out",
          "net"
        ]
      }
    },
    "missed_swing": {
      "about": "High reliability. The player physically swung the racket during a rally and missed the ball (strong signal of being fooled by a dropshot or stretched out of reach).",
      "fields": {
        "side": [
          "forehand",
          "backhand"
        ],
        "arm_zone": "arm_zone",
        "shot_type": "human_shot_type",
        "power": {
          "min": 0,
          "max": 1,
          "about": "High reliability. Effort of the missed swing."
        },
        "reason": [
          "unreachable",
          "too_early",
          "too_late"
        ]
      }
    }
  },
  "facts": {
    "player_position": "zone",
    "player_arm_zone": "arm_zone",
    "player_last_side": [
      "forehand",
      "backhand"
    ],
    "player_last_shot_type": "human_shot_type",
    "rally_length": "number",
    "swing_early_guess": "human_shot_type",
    "swing_backswing": {
      "min": 0,
      "max": 1,
      "about": "Reliable. How big the player backswing was on the latest swing_start (passed to anticipate and to the opponent return picks on that shot)."
    },
    "swing_initial_speed": {
      "min": 0,
      "max": 1,
      "about": "Reliable. How fast the player swing started in the first 25ms on the latest swing_start (passed to anticipate and to the opponent return picks on that shot)."
    },
    "swing_side": [
      "forehand",
      "backhand"
    ],
    "swing_arm_zone": "arm_zone"
  },
  "views": {
    "court": "Broadcast view of both halves of the tennis court showing player, AI opponent, and ball positions (3D stadium court, or 2D tactical court fallback).",
    "player_cam": "Unmirrored webcam on the player showing upper body and racket arm."
  },
  "settings": {
    "opponent_speed": {
      "about": "Fairness dial controlling how quickly the AI opponent split-steps, sprints across the court, and sets its feet before hitting (0.65 = sluggish/error-prone under pace, 0.85 = balanced default, 1.25 = fast/rock-solid wall; never changes ball speed).",
      "min": 0.65,
      "max": 1.25,
      "now": 0.85
    }
  },
  "practice": {
    "players": {
      "forehand_lover": {
        "about": "Hits about 70% forehands, mostly cross-court. Weak on deep balls to the backhand."
      },
      "baseline_grinder": {
        "about": "Stays deep behind the baseline and hits heavy topspin. Struggles with short dropshots."
      },
      "even": {
        "about": "Balanced player with no strong habit. Spreads shots evenly."
      }
    }
  },
  "default_behaviour": {
    "version": 0,
    "npcs": {
      "opponent": {
        "decisions": {
          "shot_type": {
            "topspin": {
              "base": 0.42
            },
            "flat": {
              "base": 0.24
            },
            "slice": {
              "base": 0.2
            },
            "dropshot": {
              "base": 0.06
            },
            "lob": {
              "base": 0.08
            }
          },
          "aim": {
            "left_deep": {
              "base": 0.22
            },
            "middle_deep": {
              "base": 0.34
            },
            "right_deep": {
              "base": 0.22
            },
            "left_short": {
              "base": 0.11
            },
            "right_short": {
              "base": 0.11
            }
          },
          "position": {
            "middle_deep": {
              "base": 0.7
            },
            "left_deep": {
              "base": 0.1
            },
            "right_deep": {
              "base": 0.1
            },
            "middle_short": {
              "base": 0.1
            }
          },
          "anticipate": {
            "stay": {
              "base": 0.68
            },
            "lean_left": {
              "base": 0.08
            },
            "lean_right": {
              "base": 0.08
            },
            "move_in": {
              "base": 0.08
            },
            "move_back": {
              "base": 0.08
            }
          }
        },
        "rules": []
      }
    }
  }
}
```

- `side`, `power`, `rotation` and `angle` come straight from the racket hardware, so only player shots carry them. The opponent's `shot` carries no `power` or `rotation`.
- `swing_start` is the early sign. The game sends it when the player starts a swing, before `shot`. The `swing_*` facts repeat its fields, so a rule on `anticipate` can react to it. [api.md](api.md#early-signs) explains how the agent side decides whether a sign holds up.
- The `practice` block names the three scripted players the game's no-screen mode can run: `forehand_lover`, `baseline_grinder` and `even`. [api.md](api.md#practice-runs) describes how practice works.
- The opponent hits five kinds of shot, but the player only hits three: `topspin`, `slice` and `dropshot`. That is why the player's lists use `human_shot_type` and the opponent's use `ai_shot_type`.
- `opponent_speed` is the one setting. The agents can use it to pace the rounds.

### What the game sends

A player shot:

```json
{
  "type": "event",
  "match_id": "m_001",
  "name": "shot",
  "round": 2,
  "t": 41.8,
  "by": "player",
  "data": {
    "rally": 3,
    "side": "backhand",
    "shot_type": "topspin",
    "power": 0.62,
    "rotation": 0.1,
    "angle": -0.4,
    "from": "left_deep",
    "arm_zone": "left",
    "other_position": "middle_deep",
    "lands": "left_short",
    "result": "in"
  }
}
```

An opponent shot. `picked` holds the three choices it made for this shot. `anticipate` is not in it, because it arrives as its own event the moment the player starts a swing, with `by_rule` when a rule decided it:

```json
{
  "type": "event",
  "match_id": "m_001",
  "name": "shot",
  "round": 2,
  "t": 43.1,
  "by": "opponent",
  "picked": {"shot_type": "dropshot", "aim": "right_short", "position": "middle_deep"},
  "by_rule": [],
  "data": {
    "rally": 4,
    "shot_type": "dropshot",
    "from": "middle_deep",
    "other_position": "left_deep",
    "lands": "right_short",
    "result": "in"
  }
}
```

Frames, about once a second during a point:

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

The end of a point. `how` is one of `out`, `net`, `not_reached` or `timeout`. `break` says whether a pause starts now. This game's plan has `break_every: 0`, so it never breaks by itself, and no deeper rewrite waits on a break:

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

### What comes back

`ready`, once, before the first point. By default the match starts on the game's own `default_behaviour`, unchanged. This example shows the designed behaviour instead, the game's default with `when` entries added, which is what `ready` carries when `NPC_START_ON_GAME_DEFAULT` is 0. Each value also carries its `kind`, and the `event` and `field` it counts when it counts one. They are left out here to keep the example short. [api.md](api.md#what-each-value-is) explains them:

```json
{
  "type": "ready",
  "match_id": "m_001",
  "values": {
    "weak_backhand": {"label": "Loses points on the backhand side"},
    "stays_deep": {"label": "Stays back at the baseline"},
    "comes_to_net": {"label": "Comes up to the net"},
    "forehand_goes_cross_court": {"label": "Hits the forehand cross-court"},
    "likes_dropshots": {"label": "Plays a lot of dropshots"},
    "hits_hard": {"label": "Swings hard on most shots"},
    "slow_to_recover": {"label": "Slow to get back to the middle after a shot"},
    "looks_tired": {"label": "Looks tired on camera"}
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
          "aim": {
            "left_deep": {"base": 0.25, "when": {"weak_backhand": -0.15}},
            "middle_deep": {"base": 0.3},
            "right_deep": {"base": 0.25},
            "left_short": {"base": 0.1},
            "right_short": {"base": 0.1}
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

The goal says to start beatable, so this opponent eases off the player's weak side and only leans a little toward covering the favourite shot. With a goal like "win as fast as you can", the same values would get the opposite weights.

`player_read`, after each player shot:

```json
{
  "type": "player_read",
  "match_id": "m_001",
  "round": 2,
  "t": 42.5,
  "values": {
    "weak_backhand": 0.72,
    "stays_deep": 0.8,
    "comes_to_net": 0.05,
    "forehand_goes_cross_court": 0.6,
    "likes_dropshots": 0.1,
    "hits_hard": 0.55,
    "slow_to_recover": 0.4,
    "looks_tired": 0.2
  },
  "based_on_events": 9,
  "why": "3 of 4 backhands landed short or out.",
  "picture_note": "Late getting the racket back on the backhand side."
}
```

`strategy_update`, during the match. The game swaps it in before the next serve. A real update like this one also carries `seen` and `changing`, the same lines with what each is about, and is kept to 3 short lines in each list. [api.md](api.md#a-real-update-and-what-a-game-can-do-with-it) explains when one is sent:

```json
{
  "type": "strategy_update",
  "match_id": "m_001",
  "version": 2,
  "source": "full",
  "observations": [
    "Stays at the baseline almost every point.",
    "The forehand nearly always goes cross-court. 5 of 6 did.",
    "The backhand is the weak side. 3 of 4 backhands landed short or out."
  ],
  "plan": [
    "Wait on the left of the baseline, where the cross-court forehand lands, so more of their shots come back.",
    "Send fewer balls to the backhand for now, so the player still wins some points.",
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
  "new_values": {
    "runs_around_backhand": {"label": "Steps around the backhand to hit a forehand"}
  },
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
          "aim": {
            "left_deep": {"base": 0.25, "when": {"weak_backhand": -0.15}},
            "middle_deep": {"base": 0.3},
            "right_deep": {"base": 0.25},
            "left_short": {"base": 0.1},
            "right_short": {"base": 0.1}
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

### Where the game calls pick

Three times for each opponent shot: `pick("opponent", "shot_type", ...)`, `pick("opponent", "aim", ...)` and `pick("opponent", "position", ...)`. Once more when the player starts a swing: `pick("opponent", "anticipate", ...)`, with the `swing_*` facts filled in.

### How the demo runs

1. The game sends `setup` and waits for `ready`.
2. A judge plays point 1 against the game's own default behaviour. The game sends `swing_start` and `shot` on every swing, `anticipate` when the opponent reacts, and `frames` about once a second.
3. After each player shot a `player_read` comes back, and the opponent's next pick uses its values.
4. The point ends and the game sends `round_end`. The break screen shows `observations`, `plan` and `changes` from the `strategy_update`.
5. The game swaps in the newest behaviour it holds before the next serve.
6. This repeats point after point until the session stops. The player should win the early points, and over time the points should even out.

## CS:GO (the recorded demo)

### What it is

One player attacks a site that a squad of AI enemies defends, for three or four rounds. The match is recorded, and about 45 seconds of highlights are shown. After each round a screen shows what the agents noticed and what they changed. The squad shares one behaviour and makes three choices: how to set up, what to do on first contact, and what to do when shots are heard somewhere else.

### setup

```json
{
  "type": "setup",
  "match_id": "cs_001",
  "game": "csgo",
  "about": "One human player attacks a site that a squad of AI enemies defends. A round ends when the player dies or every enemy is down.",
  "mode": "live",
  "goal": "Make every round close. Whatever worked for the player last round should be harder in the next one.",
  "plan": {"rounds": 4, "break_every": 2, "break_seconds": 150, "update_seconds": 8},
  "lists": {
    "place": ["main", "mid", "flank", "site"],
    "weapon": ["pistol", "rifle", "sniper", "grenade", "knife"]
  },
  "npcs": {
    "enemies": {
      "about": "The whole enemy squad. They share one behaviour.",
      "decisions": {
        "formation": {
          "when": "At the start of each round.",
          "options": {
            "all_on_site": "Everyone holds the site.",
            "spread_out": "One enemy on each way in.",
            "watch_flank": "One enemy stays back to watch the flank and the rest hold the site."
          }
        },
        "on_contact": {
          "when": "The moment any enemy sees the player.",
          "options": {
            "hold": "Stay in cover and wait.",
            "push": "Move toward the player together.",
            "fall_back": "Retreat to the site."
          }
        },
        "on_gunfire": {
          "when": "When shots are heard in another part of the map.",
          "options": {
            "stay": "Nobody moves.",
            "send_one": "The nearest enemy goes to help.",
            "everyone": "The whole squad goes."
          }
        }
      }
    }
  },
  "events": {
    "round_start": {
      "about": "A round began.",
      "fields": {}
    },
    "entered": {
      "about": "The player walked into a named part of the map.",
      "fields": {"place": "place"}
    },
    "spotted": {
      "about": "An enemy saw the player.",
      "fields": {"place": "place"}
    },
    "kill": {
      "about": "Someone went down.",
      "fields": {"place": "place", "weapon": "weapon", "from_behind": ["yes", "no"]}
    }
  },
  "facts": {
    "player_last_seen": "place",
    "enemies_alive": "number",
    "seconds_into_round": "number"
  },
  "views": {
    "screen": "The player's own screen.",
    "player_cam": "A webcam on the player."
  },
  "settings": {
    "enemy_count": {"about": "How many enemies start the round.", "min": 3, "max": 6, "now": 4},
    "loadout": {"about": "What the enemies carry.", "options": ["pistols", "rifles", "rifles_and_a_sniper"], "now": "rifles"},
    "extra_cover": {"about": "Extra cover the game can add.", "options": ["none", "crates_on_site", "wall_at_flank"], "now": "none"}
  }
}
```

- There is no `default_behaviour`, so the agents write the first behaviour from the descriptions. The baseline to compare against is then every option equally likely.
- The settings cover the changes that aren't an enemy's choice: more enemies, different loadouts and new cover.

### What the game sends

The round starts. The squad's `formation` choice rides on this event:

```json
{
  "type": "event",
  "match_id": "cs_001",
  "name": "round_start",
  "round": 2,
  "t": 61.0,
  "by": "enemies",
  "picked": {"formation": "all_on_site"},
  "by_rule": [],
  "data": {}
}
```

The player walks into the flank:

```json
{
  "type": "event",
  "match_id": "cs_001",
  "name": "entered",
  "round": 2,
  "t": 73.4,
  "by": "player",
  "data": {"place": "flank"}
}
```

The player gets a kill from behind:

```json
{
  "type": "event",
  "match_id": "cs_001",
  "name": "kill",
  "round": 2,
  "t": 82.9,
  "by": "player",
  "data": {"place": "site", "weapon": "rifle", "from_behind": "yes"}
}
```

Frames, about once a second during a round:

```json
{
  "type": "frames",
  "match_id": "cs_001",
  "round": 2,
  "t": 74.0,
  "views": {
    "screen": {"mime_type": "image/jpeg", "data": "BASE64_JPEG"},
    "player_cam": {"mime_type": "image/jpeg", "data": "BASE64_JPEG"}
  }
}
```

The end of a round:

```json
{
  "type": "round_end",
  "match_id": "cs_001",
  "round": 2,
  "t": 99.0,
  "winner": "player",
  "how": "all_enemies_down",
  "stats": {"seconds": 38, "player_health_left": 62, "enemies_down": 4},
  "score": {"player": 2, "enemies": 0},
  "break": true
}
```

### What comes back

`ready`, once, before the first round. There is no default, so the agent server writes this behaviour from the `setup` description:

```json
{
  "type": "ready",
  "match_id": "cs_001",
  "values": {
    "flanks": {"label": "Goes around the side"},
    "rushes_main": {"label": "Runs straight in through main"},
    "plays_slow": {"label": "Waits and checks corners"},
    "uses_grenades": {"label": "Throws grenades before going in"},
    "holds_long_angles": {"label": "Fights from far away"},
    "repeats_last_route": {"label": "Takes the same way in as last round"}
  },
  "behaviour": {
    "version": 1,
    "npcs": {
      "enemies": {
        "decisions": {
          "formation": {
            "all_on_site": {"base": 0.5},
            "spread_out": {"base": 0.3, "when": {"plays_slow": 0.3}},
            "watch_flank": {"base": 0.2, "when": {"flanks": 0.8}}
          },
          "on_contact": {
            "hold": {"base": 0.5, "when": {"rushes_main": 0.4}},
            "push": {"base": 0.3, "when": {"plays_slow": 0.4}},
            "fall_back": {"base": 0.2}
          },
          "on_gunfire": {
            "stay": {"base": 0.4, "when": {"flanks": 0.3}},
            "send_one": {"base": 0.4},
            "everyone": {"base": 0.2, "when": {"rushes_main": 0.5}}
          }
        },
        "rules": []
      }
    }
  }
}
```

`player_read`, during a round:

```json
{
  "type": "player_read",
  "match_id": "cs_001",
  "round": 2,
  "t": 83.5,
  "values": {
    "flanks": 0.85,
    "rushes_main": 0.05,
    "plays_slow": 0.6,
    "uses_grenades": 0.1,
    "holds_long_angles": 0.3,
    "repeats_last_route": 0.9
  },
  "based_on_events": 14,
  "why": "Came through the flank again and got the kill from behind.",
  "picture_note": "Checks the corner on the left before every push."
}
```

`strategy_update`, during the match. The game swaps it in before the next round. This one changes a rule, a weight and a setting:

```json
{
  "type": "strategy_update",
  "match_id": "cs_001",
  "version": 2,
  "source": "full",
  "observations": [
    "Came through the flank in both rounds and got 3 of 4 kills from behind.",
    "Never came through main.",
    "Takes the enemies on one at a time."
  ],
  "plan": [
    "Leave one enemy watching the flank.",
    "When shots are heard, send one enemy to help so nobody fights alone.",
    "Add a fifth enemy."
  ],
  "changes": [
    {
      "where": "enemies.rules",
      "from": null,
      "to": "If this player keeps flanking, start the round with one enemy watching the flank.",
      "why": "Came through the flank in both rounds."
    },
    {
      "where": "enemies.on_gunfire.send_one",
      "from": {"base": 0.4},
      "to": {"base": 0.4, "when": {"picks_off_one_at_a_time": 0.6}},
      "why": "Every kill so far was against an enemy standing alone."
    },
    {
      "where": "settings.enemy_count",
      "from": 4,
      "to": 5,
      "why": "Won both rounds with more than half health left."
    }
  ],
  "new_values": {
    "picks_off_one_at_a_time": {"label": "Takes the enemies on one at a time"}
  },
  "settings": {"enemy_count": 5},
  "behaviour": {
    "version": 2,
    "npcs": {
      "enemies": {
        "decisions": {
          "formation": {
            "all_on_site": {"base": 0.5},
            "spread_out": {"base": 0.3, "when": {"plays_slow": 0.3}},
            "watch_flank": {"base": 0.2, "when": {"flanks": 0.8}}
          },
          "on_contact": {
            "hold": {"base": 0.5, "when": {"rushes_main": 0.4}},
            "push": {"base": 0.3, "when": {"plays_slow": 0.4}},
            "fall_back": {"base": 0.2}
          },
          "on_gunfire": {
            "stay": {"base": 0.4, "when": {"flanks": 0.3}},
            "send_one": {"base": 0.4, "when": {"picks_off_one_at_a_time": 0.6}},
            "everyone": {"base": 0.2, "when": {"rushes_main": 0.5}}
          }
        },
        "rules": [
          {
            "if": [{"value": "flanks", "above": 0.6}],
            "do": {"formation": "watch_flank"},
            "why": "Came through the flank in both rounds."
          }
        ]
      }
    }
  }
}
```

### Where the game calls pick

Once at the start of each round, `pick("enemies", "formation", ...)`. Once when an enemy first sees the player, `pick("enemies", "on_contact", ...)`. Once when shots are heard somewhere else, `pick("enemies", "on_gunfire", ...)`.

### How the demo runs

1. The game sends `setup` and waits for `ready`.
2. Someone plays a round while the screen and the webcam are recorded. The game sends its events and `frames`, exactly as in tennis.
3. The round ends and the game sends `round_end`. The screen between rounds shows `observations`, `plan` and `changes`.
4. The game applies the new behaviour and any settings, and the next round is recorded.
5. After three or four rounds, about 45 seconds of highlights are cut: the player winning one way, the screen that explains the change, and the next round where that way is covered.

If the game can't take a new behaviour while it runs, send `"mode": "replay"` and play the recorded rounds back through the same messages. The agents answer in the same way, and someone applies the change by hand before the next round is recorded.

## Adding a third game

A new game writes seven things in `setup` and changes nothing else in the contract. [../examples/README.md](../examples/README.md) puts the two `setup` files side by side.

1. Who the NPCs are, with one plain line each.
2. The decisions each NPC makes, with when it makes them and the options.
3. The events it will report and their fields.
4. The facts an NPC can check when it decides.
5. The pictures it can send.
6. Any settings the agents may change between rounds.
7. Its pacing in `plan`, which sets how deep the updates go.
