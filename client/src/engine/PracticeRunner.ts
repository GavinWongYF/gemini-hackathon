// Headless No-Screen Practice & Proof Runner for Felix & Gavin's Agentic System
// Implements `practice_run` -> `practice_result` (Notion API Design 12:00 PM & 12:15 PM Additions).
// Supports BOTH named scripted players (`forehand_lover`, `baseline_grinder`, `even`)
// AND agent-generated `PracticePersona` objects (`{ name, about, plays }`).
//
// Runs the EXACT same BallFlightEngine + TennisMatchEngine + OpponentBrain (`pick()`) as live play,
// at >500x real-time with zero DOM / Three.js / React dependencies.

import type {
  AgentPracticeRunMessage,
  ArmZone,
  BehaviourJson,
  CourtZone,
  GamePracticeResultMessage,
  HumanShotType,
  PracticePersona,
  StrokeWing,
} from '@shared/contracts';
import {
  TENNIS_COURT_ZONES,
  TENNIS_HUMAN_SHOT_TYPES,
  type OpponentAimChoice,
  type OpponentShotChoice,
} from '@shared/agentProtocol';
import { OpponentBrain } from '../ai/OpponentBrain';
import { PHYSICS } from './BallFlightEngine';
import { TennisMatchEngine } from './TennisMatchEngine';

export interface ScriptedPlayerProfile {
  name: string;
  /** Probability of preferring forehand side (0..1) */
  forehandPref: number;
  /** Baseline standing depth (+Z meters, higher = deeper behind baseline) */
  homeZ: number;
  /** Shot type probability distribution */
  shotTypeWeights: Record<HumanShotType, number>;
  /** Target landing zone probability distribution */
  targetZoneWeights: Record<CourtZone, number>;
  /** Weakness penalty (0..0.55) applied when defending against each opponent shot type */
  shotVulnerability: Partial<Record<OpponentShotChoice, number>>;
  /** Weakness penalty (0..0.55) applied when defending against each opponent aim zone */
  aimVulnerability: Partial<Record<OpponentAimChoice, number>>;
  /** Average swing power (0..1) */
  avgPower: number;
}

export const BUILTIN_SCRIPTED_PLAYERS: Record<string, ScriptedPlayerProfile> = {
  forehand_lover: {
    name: 'forehand_lover',
    forehandPref: 0.78,
    homeZ: 10.9,
    shotTypeWeights: { topspin: 0.72, slice: 0.16, dropshot: 0.12 },
    targetZoneWeights: {
      left_deep: 0.52,
      middle_deep: 0.2,
      right_deep: 0.14,
      left_short: 0.08,
      middle_short: 0.02,
      right_short: 0.04,
    },
    // Strong on forehand/right, clearly vulnerable to deep backhand (left_deep) and low slices!
    shotVulnerability: { slice: 0.34, flat: 0.14, topspin: 0.04, dropshot: 0.18, lob: 0.02 },
    aimVulnerability: { left_deep: 0.44, left_short: 0.28, middle_deep: 0.04, right_deep: 0.0, right_short: 0.08 },
    avgPower: 0.8,
  },
  baseline_grinder: {
    name: 'baseline_grinder',
    forehandPref: 0.58,
    homeZ: 11.4,
    shotTypeWeights: { topspin: 0.8, slice: 0.15, dropshot: 0.05 },
    targetZoneWeights: {
      left_deep: 0.25,
      middle_deep: 0.48,
      right_deep: 0.22,
      left_short: 0.02,
      middle_short: 0.01,
      right_short: 0.02,
    },
    // Rock solid on deep topspin/flat rallies, clearly vulnerable to short dropshots!
    shotVulnerability: { dropshot: 0.64, slice: 0.16, topspin: 0.02, flat: 0.06, lob: 0.0 },
    aimVulnerability: { left_short: 0.56, right_short: 0.56, left_deep: 0.05, middle_deep: 0.02, right_deep: 0.05 },
    avgPower: 0.64,
  },
  even: {
    name: 'even',
    forehandPref: 0.52,
    homeZ: 10.6,
    shotTypeWeights: { topspin: 0.45, slice: 0.3, dropshot: 0.25 },
    targetZoneWeights: {
      left_deep: 0.22,
      middle_deep: 0.24,
      right_deep: 0.22,
      left_short: 0.12,
      middle_short: 0.08,
      right_short: 0.12,
    },
    shotVulnerability: { topspin: 0.1, flat: 0.14, slice: 0.14, dropshot: 0.14, lob: 0.1 },
    aimVulnerability: { left_deep: 0.12, middle_deep: 0.08, right_deep: 0.12, left_short: 0.14, right_short: 0.14 },
    avgPower: 0.7,
  },
};

/**
 * Deterministic fast PRNG (Mulberry32) so proof benchmarks are 100% reproducible.
 */
export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Converts an agent-generated `PracticePersona` (Notion 12:15 PM spec) into a concrete
 * `ScriptedPlayerProfile` whose strengths/weaknesses emerge naturally from its `plays` habits.
 */
export function personaToScriptedProfile(player: string | PracticePersona): ScriptedPlayerProfile {
  if (typeof player === 'string') {
    return BUILTIN_SCRIPTED_PLAYERS[player] ?? BUILTIN_SCRIPTED_PLAYERS.even;
  }

  // If the persona matches a built-in name and has no plays override, start from it
  const base = BUILTIN_SCRIPTED_PLAYERS[player.name] ?? BUILTIN_SCRIPTED_PLAYERS.even;
  const shotPlays = player.plays?.shot ?? {};

  const fhWeight = shotPlays.side?.forehand ?? base.forehandPref;
  const bhWeight = shotPlays.side?.backhand ?? 1 - fhWeight;
  const forehandPref = fhWeight / Math.max(0.01, fhWeight + bhWeight);

  // Build shot_type distribution (spread evenly for any omitted option)
  const shotTypeWeights: Record<HumanShotType, number> = {
    topspin: 0,
    slice: 0,
    dropshot: 0,
  };
  const declaredShots = shotPlays.shot_type ?? {};
  const hasShotPlays = Object.keys(declaredShots).length > 0;
  for (const st of TENNIS_HUMAN_SHOT_TYPES) {
    shotTypeWeights[st] = hasShotPlays ? (declaredShots[st] ?? 0.05) : 1 / TENNIS_HUMAN_SHOT_TYPES.length;
  }

  // Build landing zone distribution (spread evenly for any omitted zone)
  const targetZoneWeights = {} as Record<CourtZone, number>;
  const declaredLands = shotPlays.lands ?? {};
  const hasLandPlays = Object.keys(declaredLands).length > 0;
  for (const z of TENNIS_COURT_ZONES) {
    targetZoneWeights[z] = hasLandPlays ? (declaredLands[z] ?? 0.02) : 1 / TENNIS_COURT_ZONES.length;
  }

  // Derive realistic vulnerabilities directly from the persona's habits + `about` text:
  // - Heavy forehand lean (>0.6) -> weaker on left_deep backhand + low slices
  // - Heavy deep-staying habit -> weaker on short dropshots
  // - Heavy net/short habit -> weaker on deep lobs
  const fromPlays = shotPlays.from ?? {};
  const shortFrom = (fromPlays.left_short ?? 0) + (fromPlays.middle_short ?? 0) + (fromPlays.right_short ?? 0);
  const deepFrom = (fromPlays.left_deep ?? 0) + (fromPlays.middle_deep ?? 0) + (fromPlays.right_deep ?? 0);
  const aboutLower = (player.about ?? '').toLowerCase();

  const prefersNet = shortFrom > deepFrom + 0.15 || aboutLower.includes('net') || aboutLower.includes('short');
  const staysDeep = !prefersNet && (deepFrom > 0.5 || aboutLower.includes('deep') || aboutLower.includes('baseline'));
  const fhSkew = Math.max(0, forehandPref - 0.5) * 2; // 0..1

  const shotVulnerability: Partial<Record<OpponentShotChoice, number>> = {
    slice: 0.12 + fhSkew * 0.26,
    dropshot: staysDeep ? 0.44 : 0.14,
    lob: prefersNet ? 0.48 : 0.06,
    flat: 0.12 + (prefersNet ? 0.1 : 0.04),
    topspin: 0.06,
  };

  const aimVulnerability: Partial<Record<OpponentAimChoice, number>> = {
    left_deep: 0.12 + fhSkew * 0.36,
    right_deep: 0.12 + Math.max(0, 0.5 - forehandPref) * 0.72,
    middle_deep: 0.05,
    left_short: staysDeep ? 0.38 : 0.12,
    right_short: staysDeep ? 0.38 : 0.12,
  };

  return {
    name: player.name,
    forehandPref,
    homeZ: prefersNet ? 7.2 : staysDeep ? 11.3 : 10.6,
    shotTypeWeights,
    targetZoneWeights,
    shotVulnerability,
    aimVulnerability,
    avgPower: 0.74,
  };
}

function sampleWeighted<T extends string>(weights: Record<T, number>, rng: () => number): T {
  const entries = Object.entries(weights) as Array<[T, number]>;
  let total = 0;
  for (const [, w] of entries) total += Math.max(0, w);
  if (total <= 0) return entries[0][0];

  let r = rng() * total;
  for (const [key, w] of entries) {
    r -= Math.max(0, w);
    if (r <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

export interface PracticeBatchResult {
  reply: Omit<GamePracticeResultMessage, 'type' | 'match_id'>;
  durationMs: number;
}

/**
 * Executes a full `practice_run` batch headlessly using the real physics & `OpponentBrain` (`pick()`).
 */
export function runPracticeBatch(
  req: Pick<AgentPracticeRunMessage, 'run_id' | 'player' | 'rounds' | 'behaviour'>,
  seed = 1337,
): PracticeBatchResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const rng = createSeededRng(seed);
  const profile = personaToScriptedProfile(req.player);

  const brain = new OpponentBrain(req.behaviour, rng);
  let totalExchanges = 0;
  let totalPointSeconds = 0;
  let completedRounds = 0;

  const engine = new TennisMatchEngine(brain, {
    totalDemoPoints: req.rounds,
    breakEvery: req.rounds + 1,
    pointOverPauseSec: 0,
    serveWindupSec: 0,
    enableDemoPauses: false,
    rng,
    sink: {
      onAgentRoundEnd: (roundEnd) => {
        completedRounds += 1;
        totalExchanges += roundEnd.stats?.rally_length ?? 0;
        totalPointSeconds += roundEnd.stats?.seconds ?? 0;
      },
    },
  });

  engine.startMatch();

  // Bias the scripted player's default resting position toward their preferred side
  const restArmX = (profile.forehandPref - 0.5) * 1.1; // right-handed forehand leans slightly right (+X)
  const restArmZone: ArmZone = restArmX > 0.2 ? 'right' : restArmX < -0.2 ? 'left' : 'center';
  engine.setPlayerStance(restArmZone, restArmX, profile.forehandPref >= 0.5 ? 'forehand' : 'backhand', profile.homeZ);

  const maxTicks = req.rounds * 60 * 35; // safety ceiling
  let swingAttemptedForBounceKey = -1;
  let swingStartEmittedForBounceKey = -1;

  for (let tick = 0; tick < maxTicks && engine.getRenderState().phase !== 'match_over'; tick++) {
    engine.stepFixed(PHYSICS.DT);

    // Guide the scripted player's lateral stance toward the incoming ball as it approaches
    const b = engine.ballEngine.state;
    const land = engine.getRenderState().ball.landingMarker;
    if (b.active && land && engine.getRenderState().phase === 'rally') {
      const targetArmX = Math.max(-1, Math.min(1, land.x / 3.4));
      const targetArmZone: ArmZone = targetArmX < -0.25 ? 'left' : targetArmX > 0.25 ? 'right' : 'center';
      const targetWing: StrokeWing = land.x < -0.4 ? 'backhand' : 'forehand';
      engine.setPlayerStance(targetArmZone, targetArmX, targetWing, profile.homeZ);
    }

    if (engine.isBallReturnableByPlayer()) {
      const bounceKey = engine.getRenderState().score.pointIndex * 1000 + engine.getCurrentRallyShotCount();
      // ~120ms before contact (as ball bounces/approaches), emit `swing_start` so `anticipate` rules work in headless runs too!
      const inWindupZone = b.bounceCount === 1 || b.z >= engine.getRenderState().player.z - 3.6;
      if (inWindupZone && swingStartEmittedForBounceKey !== bounceKey) {
        swingStartEmittedForBounceKey = bounceKey;
        const ballOnLeft = b.x < -0.4;
        const wing: StrokeWing = ballOnLeft
          ? rng() < Math.max(0, profile.forehandPref - 0.55)
            ? 'forehand'
            : 'backhand'
          : 'forehand';
        const armZone: ArmZone = b.x < -1.6 ? 'left' : b.x > 1.6 ? 'right' : 'center';
        const previewShot = sampleWeighted(profile.shotTypeWeights, rng);
        engine.handlePlayerSwingStart({
          earlyGuess: previewShot,
          confidence: 0.78,
          backswing: previewShot === 'dropshot' ? 0.28 : wing === 'forehand' ? 0.82 : 0.55,
          initialSpeed: previewShot === 'dropshot' ? 0.25 : profile.avgPower,
          wing,
          armZone,
        });
      }

      // Wait until the ball is in the natural hitting zone (after bounce peak or near player depth)
      const inStrikeZone =
        (b.bounceCount === 1 && (b.z >= engine.getRenderState().player.z - 2.2 || b.vy < 0.8)) ||
        (b.bounceCount === 0 && b.z >= engine.getRenderState().player.z - 1.2);
      if (inStrikeZone && swingAttemptedForBounceKey !== bounceKey) {
        swingAttemptedForBounceKey = bounceKey;

        const oppCtx = engine.getLastOpponentShot();
        const ballOnLeft = b.x < -0.4;
        const wing: StrokeWing = ballOnLeft
          ? rng() < Math.max(0, profile.forehandPref - 0.55)
            ? 'forehand' // runs around backhand occasionally
            : 'backhand'
          : 'forehand';
        const armZone: ArmZone = b.x < -1.6 ? 'left' : b.x > 1.6 ? 'right' : 'center';
        const armX = Math.max(-1, Math.min(1, b.x / 3.4));

        // Compute realistic vulnerability from opponent's chosen shot & aim!
        const shotVuln = oppCtx ? (profile.shotVulnerability[oppCtx.shotType] ?? 0.06) : 0.04;
        const aimVuln = oppCtx ? (profile.aimVulnerability[oppCtx.aim] ?? 0.06) : 0.04;
        const weaknessPenalty = Math.min(0.68, shotVuln * 0.65 + aimVuln * 0.7);

        // If ball hits a strong vulnerability, the scripted player may fail to get a clean swing off
        const missRoll = rng();
        const forceMiss = weaknessPenalty > 0.28 && missRoll < (weaknessPenalty - 0.12) * 0.72;

        const chosenShot = sampleWeighted(profile.shotTypeWeights, rng);
        const chosenTarget = sampleWeighted(profile.targetZoneWeights, rng);

        engine.setPlayerStance(armZone, armX, wing, profile.homeZ);
        engine.handlePlayerSwing(
          {
            shotType: chosenShot,
            wing,
            armZone,
            armX,
            power: Math.max(0.3, Math.min(1, profile.avgPower + (rng() * 2 - 1) * 0.14)),
            rotation: chosenShot === 'slice' ? -0.65 : chosenShot === 'topspin' ? 0.65 : -0.25,
            angle: chosenTarget.startsWith('left_') ? -0.65 : chosenTarget.startsWith('right_') ? 0.65 : 0,
          },
          {
            targetZoneOverride: chosenTarget,
            weaknessPenalty,
            forceMiss,
          },
        );
      }
    }
  }

  const score = engine.getRenderState().score;
  const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  const roundsPlayed = Math.max(1, completedRounds);

  return {
    reply: {
      run_id: req.run_id,
      player: profile.name,
      rounds: req.rounds,
      wins: {
        player: score.humanPoints,
        opponent: score.aiPoints,
      },
      stats: {
        average_exchanges: Math.round((totalExchanges / roundsPlayed) * 100) / 100,
        average_point_seconds: Math.round((totalPointSeconds / roundsPlayed) * 100) / 100,
      },
    },
    durationMs: Math.round(elapsedMs * 100) / 100,
  };
}

/**
 * Convenience helper for quick baseline-vs-adapted proof comparison over N rounds.
 */
export function compareBehavioursHeadless(
  player: string | PracticePersona,
  baseline: BehaviourJson,
  adapted: BehaviourJson,
  rounds = 60,
) {
  const baseRes = runPracticeBatch(
    { run_id: 'proof_base', player, rounds, behaviour: baseline },
    1001,
  );
  const adaptRes = runPracticeBatch(
    { run_id: 'proof_adapt', player, rounds, behaviour: adapted },
    2002,
  );

  const baseOppWinRate = baseRes.reply.wins.opponent / Math.max(1, rounds);
  const adaptOppWinRate = adaptRes.reply.wins.opponent / Math.max(1, rounds);

  return {
    player: typeof player === 'string' ? player : player.name,
    rounds,
    baselineOppWinRate: Math.round(baseOppWinRate * 1000) / 10,
    adaptedOppWinRate: Math.round(adaptOppWinRate * 1000) / 10,
    deltaPctPoints: Math.round((adaptOppWinRate - baseOppWinRate) * 1000) / 10,
    baselineAvgExchanges: baseRes.reply.stats?.average_exchanges ?? 0,
    adaptedAvgExchanges: adaptRes.reply.stats?.average_exchanges ?? 0,
    totalDurationMs: Math.round((baseRes.durationMs + adaptRes.durationMs) * 100) / 100,
  };
}
