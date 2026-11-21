// ─────────────────────────────────────────────────────────────────────────
// setup.ts — VALOR described ONCE for the agent system (the contract's `setup`).
//
// This file is the ONLY place VALOR explains itself to the agents. Nothing on
// the agent side knows it is a shooter: Carbon/Neon read this text and design
// the values, the behaviour and the cover from it. Same message for practice
// and live (TEAM_SYNC §3.1) so the server can reuse its cached design.
//
// Also holds the plaza geometry (lanes, named cover spots, spawns) shared by the
// adaptive brain, the self-check and the headless simulator. Pure TS.
// ─────────────────────────────────────────────────────────────────────────

import { BASELINE_SETTINGS, DECISIONS, type DecisionName, type MatchSettings } from "./brain";
import type { BehaviourJson, GameSetupMessage, MatchMode } from "./protocol";
import { DYN_WIDTH, LANES, laneOf, type CoverKind, type Lane } from "./plaza";

export const RED = "red"; // the one NPC group id (3 enemy bots share one behaviour)

// ── Cover spots the agents may use (geometry lives in plaza.ts) ──────────
export { LANES, type Lane } from "./plaza";
export const MAX_COVER_OBJECTS = 4;

export interface CoverSpot {
  name: string;
  lane: Lane;
  x: number;
  z: number;
  kind: CoverKind;
  widthM: number;
  about: string;
}
const spot = (name: string, kind: CoverKind, x: number, z: number, about: string): CoverSpot => ({
  name,
  lane: laneOf(x),
  x,
  z,
  kind,
  widthM: DYN_WIDTH[kind],
  about,
});

/** The ONLY places the agents may add cover (kept off the permanent blocks and spawns). */
export const COVER_SPOTS: CoverSpot[] = [
  spot("left_tree_near", "tree", 6.5, -12.2, "Tree just outside the blue spawn, left lane."),
  spot("left_crate_mid", "crate", 6.2, -18.5, "Crate on the open stretch of the left lane, at the halfway line."),
  spot("left_wall_mid", "wall", 5.8, -19.0, "Low wall across the left lane at the halfway line (wide)."),
  spot("left_crate_far", "crate", 7.2, -20.3, "Crate on the left lane, close to the enemy side."),
  spot("mid_crate_near", "crate", 11.0, -13.0, "Crate in the middle, just outside the blue spawn."),
  spot("mid_tree_center", "tree", 13.5, -16.8, "Tree near the centre of the plaza."),
  spot("mid_wall_front", "wall", 12.0, -19.0, "Low wall in the middle, just past the permanent centre wall (wide)."),
  spot("mid_crate_front", "crate", 12.4, -20.2, "Crate in the open middle, right in front of the enemy line."),
  spot("right_crate_near", "crate", 17.2, -12.0, "Crate just outside the blue spawn, right lane."),
  spot("right_tree_mid", "tree", 17.5, -18.0, "Tree on the right lane at the halfway line."),
  spot("right_crate_far", "crate", 17.0, -22.5, "Crate on the right lane, close to the enemy side."),
];
export const COVER_BY_NAME: Record<string, CoverSpot> = Object.fromEntries(COVER_SPOTS.map((c) => [c.name, c]));

export const coverToWorld = (c: CoverSpot): MatchSettings["cover"][number] => ({
  kind: c.kind,
  x: c.x,
  z: c.z,
  yaw: c.kind === "wall" ? 0 : undefined,
});

// ── Numeric settings bounds (match brain.ts MatchSettings comments) ──────
export const SETTING_BOUNDS = {
  enemy_accuracy: { min: 0.15, max: 0.7 },
  enemy_reaction_sec: { min: 0.4, max: 1.6 },
  enemy_damage: { min: 6, max: 20 },
} as const;
export type NumericSetting = keyof typeof SETTING_BOUNDS;

/** Settings as the agents speak them: numbers + cover as a list of spot NAMES. */
export interface AgentSettings {
  enemy_accuracy: number;
  enemy_reaction_sec: number;
  enemy_damage: number;
  cover: string[];
}
export const BASELINE_AGENT_SETTINGS: AgentSettings = {
  enemy_accuracy: BASELINE_SETTINGS.enemy_accuracy,
  enemy_reaction_sec: BASELINE_SETTINGS.enemy_reaction_sec,
  enemy_damage: BASELINE_SETTINGS.enemy_damage,
  cover: [],
};
export function toMatchSettings(s: AgentSettings): MatchSettings {
  return {
    enemy_accuracy: s.enemy_accuracy,
    enemy_reaction_sec: s.enemy_reaction_sec,
    enemy_damage: s.enemy_damage,
    cover: s.cover.map((n) => COVER_BY_NAME[n]).filter(Boolean).map(coverToWorld),
  };
}

// ── The baseline behaviour (== baselineBrain in brain.ts, as JSON) ───────
/** Version 0, sent as default_behaviour. Identical choices to brain.ts baselineBrain. */
export function baselineBehaviour(): BehaviourJson {
  const zeroes = (d: DecisionName, keep: string) =>
    Object.fromEntries(DECISIONS[d].map((o) => [o, { base: o === keep ? 1 : 0 }]));
  return {
    version: 0,
    npcs: {
      [RED]: {
        decisions: {
          position: zeroes("position", "hold_mid"),
          target: zeroes("target", "nearest"),
          style: zeroes("style", "strafe_and_shoot"),
        },
        rules: [],
      },
    },
  };
}

// ── setup ─────────────────────────────────────────────────────────────────
export const VALOR_PLAN = { rounds: 7, break_every: 1, break_seconds: 3.5, update_seconds: 20 } as const;

export function valorSetup(opts: { matchId: string; mode?: MatchMode }): GameSetupMessage {
  return {
    type: "setup",
    match_id: opts.matchId,
    game: "valor",
    about:
      "A first-person shooter on one open city plaza, played with keyboard and mouse. The human player and two ally bots (team blue) fight three enemy bots (team red) in rounds: a round ends when one team is all dead, there is no respawn inside a round, and the first team to win 4 rounds wins the match. Blue starts at the near end of the plaza and red at the far end; three lanes (left, mid, right as seen on the player's screen) run between them, dotted with chest-high blocks and crates; there are long stretches of open ground on the left lane and in front of the red line in the middle.",
    mode: opts.mode ?? "live",
    goal:
      "Start beatable. Work out what this player relies on to win rounds and take it away one habit at a time; when the player keeps dying in open ground, give them cover instead. Keep the player winning about half the rounds. Win by positioning and reading the player, never by superhuman aim.",
    plan: { ...VALOR_PLAN },
    lists: {
      lane: [...LANES],
      cover_spot: COVER_SPOTS.map((c) => c.name),
    },
    npcs: {
      [RED]: {
        about: "The three enemy bots. They share one behaviour; each one decides for itself using its enemy_index (0, 1 or 2).",
        decisions: {
          position: {
            when: "Once per enemy at the start of each round.",
            options: {
              hold_mid: "Stand at the far end of the middle lane and watch the middle.",
              watch_left_flank: "Stand at the far end of the left lane and watch for players coming up the left.",
              watch_right_flank: "Stand at the far end of the right lane and watch for players coming up the right.",
              push_forward: "Walk up the middle towards the blue side to meet the player early, in the open.",
              hold_cover: "Hide behind the nearest existing cover in its own lane and wait.",
            },
          },
          target: {
            when: "Whenever it sees more than one blue target.",
            options: {
              nearest: "Shoot the closest visible target.",
              player_first: "Shoot the human player if visible, before the ally bots.",
              weakest: "Shoot the visible target with the least health.",
            },
          },
          style: {
            when: "When it starts a fight.",
            options: {
              stand_and_shoot: "Stand still and shoot; more accurate but easier to hit.",
              strafe_and_shoot: "Step side to side while shooting.",
              retreat_to_cover: "Back off to cover first, then shoot.",
            },
          },
        },
      },
    },
    events: {
      round_start: {
        about: "A round began. Sent once per enemy (by red) with that enemy's picked options.",
        fields: { enemy_index: { min: 0, max: 2, about: "Which enemy." }, lane: "lane" },
      },
      player_lane_change: {
        about: "The player moved into a different lane (left, mid or right as seen on screen).",
        fields: { lane: "lane", from: "lane", seconds_into_round: "number" },
      },
      shot: {
        about: "The player fired. hit says whether it hit an enemy.",
        fields: { hit: ["yes", "no"], distance_m: "number", lane: "lane" },
      },
      kill: {
        about: "The player killed an enemy.",
        fields: { lane: "lane", distance_m: "number", enemy_index: { min: 0, max: 2, about: "Which enemy died." }, enemy_was_watching: "lane" },
      },
      death: {
        about: "The player died.",
        fields: {
          lane: "lane",
          in_open: ["yes", "no"],
          killer_index: { min: 0, max: 2, about: "Which enemy got the kill." },
          seconds_into_round: "number",
        },
      },
      died_in_open: {
        about: "The player died while standing or running in open ground, away from any cover.",
        fields: { lane: "lane", nearest_cover_m: "number" },
      },
    },
    facts: {
      player_zone: ["left", "mid", "right", "unknown"],
      player_in_open: { min: 0, max: 1, about: "1 while the player is in open ground, 0 behind cover." },
      allies_alive: { min: 0, max: 3, about: "Red enemies still alive (the deciding enemy's own team)." },
      opponents_alive: { min: 0, max: 3, about: "Blue players still alive (player plus ally bots)." },
      round: "number",
      enemy_index: { min: 0, max: 2, about: "Which enemy is deciding: 0, 1 or 2." },
    },
    views: {
      game:
        "The player's own first-person screen, 384 px wide JPEG, about once a second during a round. The crosshair is in the centre. You can see which lane the player is in (left/mid/right edges of the plaza), whether they are standing in open paving or pressed against cover (trees, crates, walls, the parked bus on the right), whether they peek out around cover or stand fully exposed, how many red enemies are on screen and where, and the health bar at the bottom left.",
    },
    settings: {
      enemy_accuracy: {
        about: "Enemy hit chance at point-blank against a standing target (falls off with distance and if the player moves).",
        min: SETTING_BOUNDS.enemy_accuracy.min,
        max: SETTING_BOUNDS.enemy_accuracy.max,
        now: BASELINE_AGENT_SETTINGS.enemy_accuracy,
      },
      enemy_reaction_sec: {
        about: "Seconds an enemy needs after first seeing the player before its first shot.",
        min: SETTING_BOUNDS.enemy_reaction_sec.min,
        max: SETTING_BOUNDS.enemy_reaction_sec.max,
        now: BASELINE_AGENT_SETTINGS.enemy_reaction_sec,
      },
      enemy_damage: {
        about: "Damage per enemy hit (the player has 100 health).",
        min: SETTING_BOUNDS.enemy_damage.min,
        max: SETTING_BOUNDS.enemy_damage.max,
        now: BASELINE_AGENT_SETTINGS.enemy_damage,
      },
      cover: {
        about: `Extra cover added to the plaza for the next round: a list of up to ${MAX_COVER_OBJECTS} spot names from cover_spot, or none. Cover can never block a lane completely or sit on a spawn.`,
        options: COVER_SPOTS.map((c) => c.name),
        now: "none",
        max_picks: MAX_COVER_OBJECTS,
      },
    },
    practice: {
      players: {
        flank_left_always: { about: "Always goes up the left lane and shoots the enemies from the side." },
        rush_open_mid: { about: "Sprints straight up the open middle and fights wherever they stop." },
        mixed_random: { about: "Picks a random lane each round; uses cover half the time." },
      },
    },
    default_behaviour: baselineBehaviour(),
  };
}
