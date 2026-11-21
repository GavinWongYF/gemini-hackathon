// Canonical Game <-> Agentic System Protocol (Felix & Gavin — Notion "API Design" Draft 2)
// Pure TypeScript with ZERO DOM/React/Three.js imports so the exact same code runs
// both in the 60 FPS browser client and in Node headless practice/proof mode.

import {
  COURT,
  type AgentErrorMessage,
  type AgentPlayerReadMessage,
  type AgentPracticeRunMessage,
  type AgentReadyMessage,
  type AgentStrategyUpdateMessage,
  type AiShotType,
  type ArmZone,
  type BehaviourCondition,
  type BehaviourJson,
  type CourtZone,
  type GamePracticeResultMessage,
  type HumanShotType,
  type PracticePersona,
  type StrokeWing,
} from './contracts';

export type {
  AgentErrorMessage,
  AgentPracticeRunMessage,
  GamePracticeResultMessage,
  PracticePersona,
};

// ---- Outbound Messages (Game -> Agents over ws://AGENT_HOST:8000/ws) ----

export type MatchMode = 'live' | 'practice' | 'replay';

export interface SetupRangeField {
  min: number;
  max: number;
  about: string;
}

export type SetupFieldSchema = string | string[] | SetupRangeField;

export interface SetupDecisionSpec {
  when: string;
  options: Record<string, string>;
}

export interface SetupNpcSpec {
  about: string;
  decisions: Record<string, SetupDecisionSpec>;
}

export interface SetupEventSpec {
  about: string;
  fields: Record<string, SetupFieldSchema>;
}

export interface SetupRangeSetting {
  about: string;
  min: number;
  max: number;
  now: number;
}

export interface SetupOptionsSetting {
  about: string;
  options: string[];
  now: string;
}

export type SetupSettingSpec = SetupRangeSetting | SetupOptionsSetting;

export interface PracticePlayerSpec {
  about: string;
}

export interface PracticeSetupSpec {
  players?: Record<string, PracticePlayerSpec>;
  stand_in?: boolean;
}

export interface GameSetupMessage {
  type: 'setup';
  match_id: string;
  game: string;
  about: string;
  mode: MatchMode;
  goal: string;
  plan: {
    rounds: number;
    break_every: number;
    break_seconds: number;
    update_seconds?: number;
    writer?: 'fast' | 'standard' | 'deep' | 'deepest';
    max_candidates?: number;
  };
  lists?: Record<string, string[]>;
  npcs: Record<string, SetupNpcSpec>;
  events: Record<string, SetupEventSpec>;
  facts: Record<string, SetupFieldSchema>;
  views: Record<string, string>;
  settings: Record<string, SetupSettingSpec>;
  practice?: PracticeSetupSpec;
  default_behaviour?: BehaviourJson;
}

export interface GameEventMessage {
  type: 'event';
  match_id: string;
  name: string;
  round: number;
  t: number;
  by: 'player' | string;
  data: Record<string, string | number | boolean | null | undefined>;
  picked?: Record<string, string>;
  by_rule?: string[];
}

export interface FrameViewPayload {
  mime_type: 'image/jpeg';
  data: string;
}

export interface GameFramesMessage {
  type: 'frames';
  match_id: string;
  round: number;
  t: number;
  views: Record<string, FrameViewPayload>;
}

export interface GameRoundEndMessage {
  type: 'round_end';
  match_id: string;
  round: number;
  t: number;
  winner: 'player' | 'none' | string;
  how: string;
  stats?: Record<string, number>;
  score: Record<string, number>;
  break: boolean;
}

export type GameToAgentMessage =
  | GameSetupMessage
  | GameEventMessage
  | GameFramesMessage
  | GameRoundEndMessage
  | GamePracticeResultMessage;

export type AgentToGameMessage =
  | AgentReadyMessage
  | AgentPlayerReadMessage
  | AgentStrategyUpdateMessage
  | AgentPracticeRunMessage
  | AgentErrorMessage;

// ---- Canonical Tennis Setup & Default Behaviour ----

export const TENNIS_COURT_ZONES: readonly CourtZone[] = [
  'left_short',
  'middle_short',
  'right_short',
  'left_deep',
  'middle_deep',
  'right_deep',
] as const;

export const TENNIS_HUMAN_SHOT_TYPES: readonly HumanShotType[] = [
  'topspin',
  'slice',
  'dropshot',
] as const;

/** Opponent shot types used by `pick("opponent", "shot_type", ...)` */
export type OpponentShotChoice = Exclude<AiShotType, 'volley'>;

export const TENNIS_AI_SHOT_TYPES: readonly OpponentShotChoice[] = [
  'topspin',
  'flat',
  'slice',
  'dropshot',
  'lob',
] as const;

export type OpponentAimChoice =
  | 'left_deep'
  | 'middle_deep'
  | 'right_deep'
  | 'left_short'
  | 'right_short';

export const TENNIS_AI_AIM_OPTIONS: readonly OpponentAimChoice[] = [
  'left_deep',
  'middle_deep',
  'right_deep',
  'left_short',
  'right_short',
] as const;

export type OpponentPositionChoice =
  | 'middle_deep'
  | 'left_deep'
  | 'right_deep'
  | 'middle_short';

export const TENNIS_AI_POSITION_OPTIONS: readonly OpponentPositionChoice[] = [
  'middle_deep',
  'left_deep',
  'right_deep',
  'middle_short',
] as const;

export interface TennisFacts {
  player_position: CourtZone;
  player_arm_zone: ArmZone;
  player_last_side: StrokeWing;
  player_last_shot_type: HumanShotType;
  rally_length: number;
  [key: string]: string | number | boolean | undefined;
}

export const TENNIS_SETTINGS_BOUNDS = {
  opponent_speed: { min: 0.65, max: 1.25, default: 0.85 },
} as const;

export const DEFAULT_TENNIS_BEHAVIOUR: BehaviourJson = {
  version: 0,
  npcs: {
    opponent: {
      decisions: {
        shot_type: {
          topspin: { base: 0.36 },
          flat: { base: 0.24 },
          slice: { base: 0.2 },
          dropshot: { base: 0.12 },
          lob: { base: 0.08 },
        },
        aim: {
          left_deep: { base: 0.22 },
          middle_deep: { base: 0.34 },
          right_deep: { base: 0.22 },
          left_short: { base: 0.11 },
          right_short: { base: 0.11 },
        },
        position: {
          middle_deep: { base: 0.7 },
          left_deep: { base: 0.1 },
          right_deep: { base: 0.1 },
          middle_short: { base: 0.1 },
        },
      },
      rules: [],
    },
  },
};

export interface TennisSetupOptions {
  matchId: string;
  mode?: MatchMode;
  rounds?: number;
  breakEvery?: number;
  breakSeconds?: number;
  updateSeconds?: number;
  goal?: string;
  includePractice?: boolean;
}

/**
 * Builds the exact `setup` message matching our real hardware (M5 IMU + Webcam Arm Tracking)
 * and Felix & Gavin's Notion API Design Draft 2 + 12:00 PM Additions.
 */
export function createTennisSetup(opts: TennisSetupOptions): GameSetupMessage {
  const mode = opts.mode ?? 'live';
  const includePractice = opts.includePractice ?? mode === 'practice';
  return {
    type: 'setup',
    match_id: opts.matchId,
    game: 'tennis',
    about:
      'One human player plays single points against one AI opponent. The player stands near the bottom baseline swinging a physical M5 IMU racket controller while a webcam tracks their dominant arm side (left/center/right, forehand/backhand). The opponent is at the top half of the screen and picks shot_type, aim, and recovery position on every hit.',
    mode,
    goal:
      opts.goal ??
      'Start beatable. Work out what this player relies on to win points and take it away, one habit at a time, until the player wins about half the points. Win by choosing better shots, never by hitting harder or faster.',
    plan: {
      rounds: opts.rounds ?? 6,
      break_every: opts.breakEvery ?? 1,
      break_seconds: opts.breakSeconds ?? 5,
      update_seconds: opts.updateSeconds ?? 20,
    },
    lists: {
      zone: [...TENNIS_COURT_ZONES],
      human_shot_type: [...TENNIS_HUMAN_SHOT_TYPES],
      ai_shot_type: [...TENNIS_AI_SHOT_TYPES],
      arm_zone: ['left', 'center', 'right'],
    },
    npcs: {
      opponent: {
        about: 'The AI tennis player on the far side of the net.',
        decisions: {
          shot_type: {
            when: 'Each time the opponent hits the ball.',
            options: {
              topspin: 'Heavy arcing topspin with high bounce and strong margin.',
              flat: 'Fast, low, penetrating drive that rushes the player timing.',
              slice: 'Low-skidding backspin ball that stays low and forces upward lift.',
              dropshot: 'Soft, short ball landing just over the net that punishes deep positioning.',
              lob: 'High deep arc over the player head that resets the rally or punishes forward reach.',
            },
          },
          aim: {
            when: 'Each time the opponent hits the ball.',
            options: {
              left_deep: 'Deep to the left side of the player half (right-hander backhand side).',
              middle_deep: 'Deep down the middle of the player baseline.',
              right_deep: 'Deep to the right side of the player half (right-hander forehand side).',
              left_short: 'Short angle to the left side near the service line.',
              right_short: 'Short angle to the right side near the service line.',
            },
          },
          position: {
            when: 'Right after the opponent hits the ball.',
            options: {
              middle_deep: 'Recover to the middle of the far baseline.',
              left_deep: 'Shade left on the far baseline to cover shots to screen-left.',
              right_deep: 'Shade right on the far baseline to cover shots to screen-right.',
              middle_short: 'Step forward toward the net to take the next ball early.',
            },
          },
        },
      },
    },
    events: {
      shot: {
        about: 'Either side hit the ball (emitted once per shot at racket-ball contact with solved landing zone and result).',
        fields: {
          rally: 'number',
          side: ['forehand', 'backhand'],
          arm_zone: 'arm_zone',
          shot_type: ['topspin', 'flat', 'slice', 'dropshot', 'lob'],
          power: { min: 0, max: 1, about: 'How hard the swing was (M5 IMU peak accel + gyro).' },
          rotation: {
            min: -1,
            max: 1,
            about: 'Spin fused from racket face + webcam vertical path. Below 0 is backspin/slice, above 0 is topspin.',
          },
          angle: {
            min: -1,
            max: 1,
            about: 'Horizontal aim direction from gyro yaw. -1 is far left on screen, 1 is far right (noisier than lands zone).',
          },
          confidence: {
            min: 0,
            max: 1,
            about: 'Classifier + webcam pose confidence in the player shot_type and side labels.',
          },
          timing: ['early', 'on_time', 'late'],
          quality: {
            min: 0,
            max: 1,
            about: 'Contact quality based on lateral/depth reach and ball height (low when stretched or jammed).',
          },
          from: 'zone',
          other_position: 'zone',
          lands: 'zone',
          result: ['in', 'out', 'net'],
        },
      },
      missed_swing: {
        about: 'The player swung the physical racket during a rally but missed the ball.',
        fields: {
          side: ['forehand', 'backhand'],
          arm_zone: 'arm_zone',
          shot_type: 'human_shot_type',
          power: { min: 0, max: 1, about: 'How hard the missed swing was.' },
          reason: ['unreachable', 'too_early', 'too_late'],
        },
      },
    },
    facts: {
      player_position: 'zone',
      player_arm_zone: 'arm_zone',
      player_last_side: ['forehand', 'backhand'],
      player_last_shot_type: 'human_shot_type',
      rally_length: 'number',
    },
    views:
      mode === 'practice'
        ? {}
        : {
            court: 'The 3D game screen showing both halves of the tennis court.',
            player_cam: 'Unmirrored webcam on the player showing upper body and racket arm.',
          },
    settings: {
      opponent_speed: {
        about:
          'Multiplier on how quickly the AI opponent moves across the court (court coverage only; does not change ball speed).',
        min: TENNIS_SETTINGS_BOUNDS.opponent_speed.min,
        max: TENNIS_SETTINGS_BOUNDS.opponent_speed.max,
        now: TENNIS_SETTINGS_BOUNDS.opponent_speed.default,
      },
    },
    ...(includePractice
      ? {
          practice: {
            players: {
              forehand_lover: {
                about: 'Hits about 70% forehands, mostly cross-court. Weak on deep balls to the backhand.',
              },
              baseline_grinder: {
                about: 'Stays deep behind the baseline and hits heavy topspin. Struggles with short dropshots.',
              },
              even: {
                about: 'Balanced player with no strong habit. Spreads shots evenly.',
              },
            },
          },
        }
      : {}),
    default_behaviour: DEFAULT_TENNIS_BEHAVIOUR,
  };
}

// ---- Exact 1:1 Port of Felix & Gavin's `pick()` + `holds()` ----

export interface PickResult<T extends string = string> {
  choice: T;
  byRule: boolean;
  ruleWhy?: string;
  scores: Record<string, number>;
}

export function holds(
  cond: BehaviourCondition,
  values: Record<string, number>,
  facts: Record<string, string | number | boolean | undefined>,
): boolean {
  const x =
    'value' in cond && cond.value !== undefined
      ? (values[cond.value] ?? 0)
      : cond.fact !== undefined
        ? facts[cond.fact]
        : undefined;

  if ('is' in cond && cond.is !== undefined) {
    return x === cond.is;
  }
  if ('in' in cond && Array.isArray(cond.in)) {
    return x !== undefined && x !== null && (cond.in as unknown[]).includes(x);
  }
  if (x === undefined || x === null || typeof x !== 'number') {
    return false;
  }
  if ('above' in cond && cond.above !== undefined) {
    return x > cond.above;
  }
  if ('below' in cond && cond.below !== undefined) {
    return x < cond.below;
  }
  return false;
}

/**
 * Direct TypeScript port of `pick()` from Felix & Gavin's Notion "API Design"
 * (matches `agents/sdk/js/pick.js` semantics, including rng=0 zero-weight skipping and empty `if` rules).
 * Once `agents/sdk/js/pick.js` is pushed, validate against `agents/sdk/test-vectors.json` or re-export it directly.
 */
export function pick<T extends string>(
  npc: string,
  decision: string,
  legal: readonly T[],
  behaviour: BehaviourJson,
  values: Record<string, number> = {},
  facts: Record<string, string | number | boolean | undefined> = {},
  rng: () => number = Math.random,
): PickResult<T> {
  if (legal.length === 0) {
    throw new Error(`pick(${npc}, ${decision}) called with empty legal options`);
  }

  const mine = behaviour?.npcs?.[npc];
  const legalSet = new Set<string>(legal);

  // 1. Rules first. The first rule whose conditions all hold and whose choice is legal decides.
  if (mine && Array.isArray(mine.rules)) {
    for (const rule of mine.rules) {
      const choice = rule?.do?.[decision];
      const conds = Array.isArray(rule?.if) ? rule.if : [];
      if (choice && legalSet.has(choice) && conds.every((c) => holds(c, values, facts))) {
        return {
          choice: choice as T,
          byRule: true,
          ruleWhy: rule.why,
          scores: { [choice]: 1 },
        };
      }
    }
  }

  // 2. Otherwise score every legal option: base + sum(weight * value), clamped at >= 0.
  const options = mine?.decisions?.[decision] ?? {};
  const scoreMap: Record<string, number> = {};
  const weights: number[] = [];
  let total = 0;

  for (const name of legal) {
    const opt = options[name];
    let score = typeof opt?.base === 'number' && Number.isFinite(opt.base) ? opt.base : 0;
    if (opt?.when) {
      for (const [valueName, weight] of Object.entries(opt.when)) {
        if (typeof weight === 'number' && Number.isFinite(weight)) {
          const val = values[valueName] ?? 0;
          score += weight * val;
        }
      }
    }
    const clamped = Math.max(score, 0);
    scoreMap[name] = clamped;
    weights.push(clamped);
    total += clamped;
  }

  // Uniform fallback if all scores are <= 0 (or missing decision/NPC)
  if (total <= 0) {
    const idx = Math.min(legal.length - 1, Math.floor(rng() * legal.length));
    return { choice: legal[idx], byRule: false, scores: scoreMap };
  }

  // Strict `<` skips zero-weight options even when rng() === 0 (matches Python random.choices)
  let r = rng() * total;
  let lastPositiveIdx = legal.length - 1;
  for (let i = 0; i < legal.length; i++) {
    if (weights[i] > 0) {
      lastPositiveIdx = i;
      if (r < weights[i]) {
        return { choice: legal[i], byRule: false, scores: scoreMap };
      }
      r -= weights[i];
    }
  }

  return { choice: legal[lastPositiveIdx], byRule: false, scores: scoreMap };
}

/** Tuple wrapper matching `agents/sdk/js/pick.js` signature: returns `[option, byRule]`. */
export function pickTuple<T extends string>(
  npc: string,
  decision: string,
  legal: readonly T[],
  behaviour: BehaviourJson,
  values: Record<string, number> = {},
  facts: Record<string, string | number | boolean | undefined> = {},
  rng: () => number = Math.random,
): [T, boolean] {
  const res = pick(npc, decision, legal, behaviour, values, facts, rng);
  return [res.choice, res.byRule];
}

// ---- Bidirectional Court Coordinates <-> 6 Named Zones ----
// Screen left = -X, screen right = +X.
// Human side = +Z (0 .. +11.5), Opponent side = -Z (-11.5 .. 0).

const LATERAL_SPLIT_X = COURT.PAINTED_HALF_W / 3; // ~1.833m
const DEPTH_SPLIT_Z = COURT.SERVICE_LINE_Z; // 7.0m

export function coordsToCourtZone(x: number, z: number): CourtZone {
  const col = x < -LATERAL_SPLIT_X ? 'left' : x > LATERAL_SPLIT_X ? 'right' : 'middle';
  const depth = Math.abs(z) < DEPTH_SPLIT_Z ? 'short' : 'deep';
  return `${col}_${depth}` as CourtZone;
}

export function armZoneToPlayerCourtZone(armZone: ArmZone, playerZ: number = COURT.PLAYER_START_Z): CourtZone {
  const col = armZone === 'left' ? 'left' : armZone === 'right' ? 'right' : 'middle';
  const depth = Math.abs(playerZ) < DEPTH_SPLIT_Z ? 'short' : 'deep';
  return `${col}_${depth}` as CourtZone;
}

/**
 * Converts a discrete zone into a clean playable (x, z) target coordinate.
 * @param targetSide 'human' lands on +Z half; 'opponent' lands on -Z half.
 */
export function courtZoneToTarget(
  zone: CourtZone,
  targetSide: 'human' | 'opponent',
  jitter = 0,
  rng: () => number = Math.random,
): { x: number; z: number } {
  const signZ = targetSide === 'human' ? 1 : -1;
  const randOffset = () => (jitter > 0 ? (rng() * 2 - 1) * jitter : 0);

  const baseX = zone.startsWith('left_')
    ? -3.55
    : zone.startsWith('right_')
      ? 3.55
      : 0;

  const baseAbsZ = zone.endsWith('_short') ? 4.4 : 9.1;

  return {
    x: Math.max(-4.85, Math.min(4.85, baseX + randOffset() * 0.65)),
    z: signZ * Math.max(2.6, Math.min(10.6, baseAbsZ + randOffset() * 0.75)),
  };
}
