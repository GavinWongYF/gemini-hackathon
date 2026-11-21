// Shared pieces for the headless runs on the real tennis engine.
//
// Nothing here copies the game's code. It loads the engine, the opponent
// brain, the socket client and the practice helpers from the game root at run
// time, and drives a scripted player through the engine's own headless hooks
// (setPlayerStance, handlePlayerSwingStart, handlePlayerSwing), tick by tick,
// the way the game's practice runner does.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Any = any;

export interface Game {
  root: string;
  TennisMatchEngine: Any;
  OpponentBrain: Any;
  AgentClient: Any;
  PHYSICS: { DT: number };
  personaToScriptedProfile: (player: Any) => Any;
  createSeededRng: (seed: number) => () => number;
  runPracticeBatch: (req: Any, seed?: number) => Any;
  protocol: Any;
  /** The court's measurements, from the game's shared contracts. */
  COURT: Any;
  /**
   * Which scripted-player loop the game's practice runner has. The scripted
   * player here follows that loop step for step, so it has to follow the
   * right one: 1 is the first loop, 2 the one with the reworked strike zone
   * and weakness rule, 3 the one for a player who stands still.
   */
  scriptedLoop: 1 | 2 | 3;
}

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = 'true';
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

/** The repo root: the folder that holds `agents/`, where `client/` and `shared/` sit. */
export function defaultGameRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..', '..');
}

export async function loadGame(gameRoot: string): Promise<Game> {
  const root = path.resolve(gameRoot);
  const at = (rel: string) => import(pathToFileURL(path.join(root, rel)).href);
  try {
    const engine = await at('client/src/engine/TennisMatchEngine.ts');
    const flight = await at('client/src/engine/BallFlightEngine.ts');
    const practice = await at('client/src/engine/PracticeRunner.ts');
    const brain = await at('client/src/ai/OpponentBrain.ts');
    const client = await at('client/src/ai/AgentClient.ts');
    const protocol = await at('shared/agentProtocol.ts');
    const contracts = await at('shared/contracts.ts');
    const practiceSource = fs.readFileSync(path.join(root, 'client/src/engine/PracticeRunner.ts'), 'utf8');
    return {
      root,
      TennisMatchEngine: engine.TennisMatchEngine,
      OpponentBrain: brain.OpponentBrain,
      AgentClient: client.AgentClient,
      PHYSICS: flight.PHYSICS,
      personaToScriptedProfile: practice.personaToScriptedProfile,
      createSeededRng: practice.createSeededRng,
      runPracticeBatch: practice.runPracticeBatch,
      protocol,
      COURT: contracts.COURT,
      scriptedLoop: practiceSource.includes('isBalancedPlayer') ? 3 : practiceSource.includes('rawWeakness') ? 2 : 1,
    };
  } catch (err) {
    console.error(
      `Could not load the game from ${root}. Run with the game's own tsconfig so its "@shared/*" imports resolve:\n` +
        `  npx --yes tsx --tsconfig "${path.join(root, 'client', 'tsconfig.json')}" <script> --game-root "${root}" ...`,
    );
    throw err;
  }
}

function sampleWeighted(weights: Record<string, number>, rng: () => number): string {
  const entries = Object.entries(weights);
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

/** Personas from a file: a list of persona objects, or a stored design that holds one. */
export function loadPersonas(file: string | undefined): Any[] {
  if (!file) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(data) ? data : (data.design?.personas ?? data.personas ?? []);
  return Array.isArray(list) ? list : Object.values(list);
}

/**
 * Players closer to a person at the webcam: forehand first, standing at the
 * baseline, at three skill levels. `miss_rate` is how often a swing misses the
 * ball outright, `extra_penalty` is added to the game's own weakness penalty
 * (lower contact quality, more forced errors), `power` is the average swing.
 * `reactive` plays at one level and changes what it does after the opponent
 * changes and it then loses `react_after_losses` points.
 * Every number here is a default: a settings file can replace any of them.
 */
export const PERSON_DEFAULTS: Any = {
  person: {
    beginner: {
      forehand: 0.85, miss_rate: 0.25, extra_penalty: 0.18, power: 0.6,
      shot_type: { topspin: 0.8, slice: 0.15, dropshot: 0.05 },
      lands: { middle_deep: 0.5, left_deep: 0.2, right_deep: 0.2, middle_short: 0.1 },
    },
    club: {
      forehand: 0.85, miss_rate: 0.12, extra_penalty: 0.08, power: 0.75,
      shot_type: { topspin: 0.75, slice: 0.2, dropshot: 0.05 },
      lands: { left_deep: 0.4, middle_deep: 0.3, right_deep: 0.25, left_short: 0.05 },
    },
    strong: {
      forehand: 0.85, miss_rate: 0.05, extra_penalty: 0.0, power: 0.85,
      shot_type: { topspin: 0.7, slice: 0.2, dropshot: 0.1 },
      lands: { left_deep: 0.45, right_deep: 0.35, middle_deep: 0.15, left_short: 0.05 },
    },
  },
  reactive: { level: 'club', react_after_losses: 2 },
};

/** The person settings: the defaults, with anything in the settings file laid over them. */
export function loadPersonSettings(file: string | undefined): Any {
  const settings = structuredClone(PERSON_DEFAULTS);
  if (!file) return settings;
  const given = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [level, spec] of Object.entries<Any>(given.person ?? {})) {
    settings.person[level] = { ...(settings.person[level] ?? {}), ...spec };
  }
  Object.assign(settings.reactive, given.reactive ?? {});
  return settings;
}

/** A person-like profile. The game itself turns the habits into strengths and weaknesses. */
export function personProfile(game: Game, name: string, level: string, settings: Any): Any {
  const spec = settings.person[level];
  if (!spec) throw new Error(`No person level "${level}". The levels are: ${Object.keys(settings.person).join(', ')}`);
  const profile = game.personaToScriptedProfile({
    name,
    about: 'Forehand first. Stands at the baseline, as a person at the webcam does.',
    plays: {
      shot: {
        side: { forehand: spec.forehand, backhand: 1 - spec.forehand },
        shot_type: spec.shot_type,
        lands: spec.lands,
      },
    },
  });
  return {
    ...profile,
    name,
    avgPower: spec.power,
    missRate: spec.miss_rate,
    extraPenalty: spec.extra_penalty,
    // A person at the webcam does not walk up the court: stay where the game starts the player.
    homeZ: game.COURT.PLAYER_START_Z,
  };
}

/**
 * The reactive player's next style. It only uses what a person could see:
 * that the opponent changed and that the points then went against it.
 * Style 1 hits to the other side, style 2 slices more, style 3 does both.
 */
export function reactStyle(base: Any, reactions: number): Any {
  const p = structuredClone(base);
  const style = reactions % 4;
  if (style === 1 || style === 3) {
    const swapped: Record<string, number> = {};
    for (const [zone, weight] of Object.entries<number>(base.targetZoneWeights)) {
      const other = zone.startsWith('left_') ? zone.replace('left_', 'right_') : zone.startsWith('right_') ? zone.replace('right_', 'left_') : zone;
      swapped[other] = weight;
    }
    for (const zone of Object.keys(p.targetZoneWeights)) p.targetZoneWeights[zone] = swapped[zone] ?? 0;
  }
  if (style === 2 || style === 3) {
    p.shotTypeWeights = { ...base.shotTypeWeights, topspin: base.shotTypeWeights.slice, slice: base.shotTypeWeights.topspin };
  }
  return p;
}

const RANDOM_PERSONA = { name: 'random', about: 'Picks every option with equal chance.', plays: {} };

/**
 * What to hand the game's own practice batch for this player: a built-in
 * name, a persona object, or null when the batch cannot play it.
 */
export function batchPlayer(name: string, personas: Any[]): Any {
  if (name === 'random') return RANDOM_PERSONA;
  if (name === 'never_swings' || name === 'contrarian' || name.startsWith('person-')) return null;
  if (name.startsWith('persona-')) {
    const wanted = name.slice('persona-'.length);
    const found = personas.find((p) => p.name === wanted);
    if (!found) throw new Error(`No persona "${wanted}" in the personas file. It has: ${personas.map((p) => p.name).join(', ') || 'none'}`);
    return found;
  }
  return name;
}

/**
 * The scripted profile for a player name. Beyond the game's built-in players:
 *   random         every option with equal chance
 *   never_swings   stands there and never swings
 *   contrarian     starts even, then plays against each behaviour it sees (see againstBehaviour)
 *   persona-NAME   a persona from the personas file, turned into a profile by the game itself
 *   person-LEVEL   forehand first with a miss rate: beginner, club or strong (see PERSON_DEFAULTS)
 *   person-reactive  a person who changes style after the opponent changes (see reactStyle)
 */
export function resolveProfile(game: Game, name: string, personas: Any[], personSettings?: Any): Any {
  if (name.startsWith('person-')) {
    const settings = personSettings ?? PERSON_DEFAULTS;
    const level = name.slice('person-'.length);
    return personProfile(game, name, level === 'reactive' ? settings.reactive.level : level, settings);
  }
  if (name === 'never_swings') return { ...game.personaToScriptedProfile('even'), name, neverSwings: true };
  if (name === 'contrarian') return { ...structuredClone(game.personaToScriptedProfile('even')), name };
  return game.personaToScriptedProfile(batchPlayer(name, personas));
}

/**
 * The contrarian's answer to a behaviour: stop doing what a rule keys on, and
 * hit away from where the opponent now waits.
 */
export function againstBehaviour(base: Any, behaviour: Any, values: Record<string, number>): Any {
  const p = structuredClone(base);
  const opp = behaviour?.npcs?.opponent ?? {};
  const named = (cond: Any): string[] => (cond.is !== undefined ? [cond.is] : Array.isArray(cond.in) ? cond.in : []);
  const waits = (option: string) => {
    const spec = opp.decisions?.position?.[option] ?? {};
    let score = typeof spec.base === 'number' ? spec.base : 0;
    for (const [value, weight] of Object.entries<Any>(spec.when ?? {})) score += weight * (values[value] ?? 0);
    return Math.max(0, score);
  };
  let coversLeft = waits('left_deep') - waits('right_deep');
  for (const rule of Array.isArray(opp.rules) ? opp.rules : []) {
    for (const cond of Array.isArray(rule?.if) ? rule.if : []) {
      if (cond.fact === 'player_last_shot_type' || cond.fact === 'swing_early_guess') {
        for (const shot of named(cond)) if (shot in p.shotTypeWeights) p.shotTypeWeights[shot] = 0.02;
      }
      if (cond.fact === 'player_last_side' || cond.fact === 'swing_side') {
        for (const side of named(cond)) p.forehandPref = side === 'forehand' ? 0.15 : 0.95;
      }
    }
    if (rule?.do?.position === 'left_deep' || rule?.do?.anticipate === 'lean_left') coversLeft += 1;
    if (rule?.do?.position === 'right_deep' || rule?.do?.anticipate === 'lean_right') coversLeft -= 1;
  }
  if (Math.abs(coversLeft) > 0.05) {
    const open = coversLeft > 0 ? 'right_' : 'left_';
    const covered = coversLeft > 0 ? 'left_' : 'right_';
    for (const zone of Object.keys(p.targetZoneWeights)) {
      p.targetZoneWeights[zone] = zone.startsWith(open) ? 0.4 : zone.startsWith(covered) ? 0.03 : 0.1;
    }
  }
  if (Object.values<number>(p.shotTypeWeights).every((w) => w <= 0.02)) p.shotTypeWeights = { ...base.shotTypeWeights };
  return p;
}

/** "a-to-b" is a player who plays as `a`, then changes style to `b` part way through the match. */
export function splitPlayer(name: string): { first: string; second: string | null } {
  const [first, second] = name.split('-to-');
  return { first, second: second ?? null };
}

/**
 * A scripted player standing in for the person. Call the returned function
 * once after every engine tick. It follows the game's practice runner step
 * for step: same stance guidance, same swing_start window, same strike zone,
 * same weakness and miss rolls, read from the same scripted profile.
 */
export type ScriptedTick = (() => void) & {
  /** What the script itself did, which the game's events do not tell apart. */
  counts: { swings: number; own_misses: number; weakness_misses: number };
};

export function makeScriptedPlayer(engine: Any, profileOrGetter: Any, rng: () => number, game?: Game): ScriptedTick {
  const loop = game?.scriptedLoop ?? 1;
  const startZ = game?.COURT?.PLAYER_START_Z ?? 11.2;
  // A getter lets the scripted player change style in the middle of a match.
  const getProfile: () => Any = typeof profileOrGetter === 'function' ? profileOrGetter : () => profileOrGetter;
  let profile = getProfile();
  const restArmX = (profile.forehandPref - 0.5) * 1.1;
  const restArmZone = restArmX > 0.2 ? 'right' : restArmX < -0.2 ? 'left' : 'center';
  engine.setPlayerStance(
    restArmZone,
    restArmX,
    profile.forehandPref >= 0.5 ? 'forehand' : 'backhand',
    profile.homeZ,
  );

  let swingAttemptedFor = -1;
  let swingStartFor = -1;
  const counts = { swings: 0, own_misses: 0, weakness_misses: 0 };

  const tick = () => {
    profile = getProfile();
    if (profile.neverSwings) return;
    const state = engine.getRenderState();
    const b = engine.ballEngine.state;
    const land = state.ball.landingMarker;
    if (b.active && land && state.phase === 'rally') {
      const targetArmX = Math.max(-1, Math.min(1, land.x / 3.4));
      const targetArmZone = targetArmX < -0.25 ? 'left' : targetArmX > 0.25 ? 'right' : 'center';
      const targetWing = land.x < -0.4 ? 'backhand' : 'forehand';
      engine.setPlayerStance(targetArmZone, targetArmX, targetWing, profile.homeZ);
    }

    if (!engine.isBallReturnableByPlayer()) return;
    const bounceKey = state.score.pointIndex * 1000 + engine.getCurrentRallyShotCount();
    const pickWing = () =>
      b.x < -0.4
        ? rng() < Math.max(0, profile.forehandPref - 0.55)
          ? 'forehand'
          : 'backhand'
        : 'forehand';
    const armZone = b.x < -1.6 ? 'left' : b.x > 1.6 ? 'right' : 'center';

    const inWindupZone = b.bounceCount === 1 || b.z >= state.player.z - 3.6;
    if (inWindupZone && swingStartFor !== bounceKey) {
      swingStartFor = bounceKey;
      const wing = pickWing();
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

    const pZ = state.player.z;
    const inStrikeZone =
      loop === 3
        ? (b.bounceCount === 1 && (b.z >= 7.2 || b.vy < 0.6)) || (b.bounceCount === 0 && b.z >= startZ - 1.1)
        : loop === 2
          ? (b.bounceCount === 1 && (Math.abs(b.z - pZ) <= 1.35 || b.z >= pZ - 1.1 || (b.vy < -1.8 && b.y < 0.38))) ||
            (b.bounceCount === 0 && b.z >= pZ - 1.1)
          : (b.bounceCount === 1 && (b.z >= pZ - 2.2 || b.vy < 0.8)) || (b.bounceCount === 0 && b.z >= pZ - 1.2);
    if (inStrikeZone && swingAttemptedFor !== bounceKey) {
      swingAttemptedFor = bounceKey;
      const oppCtx = engine.getLastOpponentShot();
      const wing = pickWing();
      const armX = Math.max(-1, Math.min(1, b.x / 3.4));
      const shotVuln = oppCtx ? (profile.shotVulnerability[oppCtx.shotType] ?? 0.06) : 0.04;
      const baseAimVuln = oppCtx ? (profile.aimVulnerability[oppCtx.aim] ?? 0.06) : 0.04;
      // The game's own penalty for a shot the player is weak against, as in its practice runner.
      let gamePenalty: number;
      let cap: number;
      if (loop === 3) {
        const aimVuln =
          oppCtx?.shotType === 'dropshot' ? Math.max(baseAimVuln, profile.aimVulnerability.left_short ?? 0.1) : baseAimVuln;
        gamePenalty = Math.min(0.58, shotVuln * 0.58 + aimVuln * 0.58);
        cap = 0.58;
      } else if (loop === 2) {
        // A dropshot lands short wherever it was aimed, and loses its surprise on a player already inside the court.
        const aimVuln =
          oppCtx?.shotType === 'dropshot' ? Math.max(baseAimVuln, profile.aimVulnerability.left_short ?? 0.1) : baseAimVuln;
        const raw = Math.min(0.62, shotVuln * 0.62 + aimVuln * 0.62);
        gamePenalty = oppCtx?.shotType === 'dropshot' && pZ < 8.2 ? raw * 0.25 : raw;
        cap = 0.62;
      } else {
        gamePenalty = Math.min(0.68, shotVuln * 0.65 + baseAimVuln * 0.7);
        cap = 0.68;
      }
      // A less skilled person makes worse contact on every shot: the extra only lowers contact quality.
      const weaknessPenalty = Math.min(cap, gamePenalty + (profile.extraPenalty ?? 0));
      // The third loop only rolls for a miss when the penalty is high enough, so the draws stay in step with it.
      const weaknessMiss =
        loop === 3
          ? gamePenalty > 0.36 && rng() < (gamePenalty - 0.24) * 0.5
          : loop === 2
            ? ((roll: number) => gamePenalty > 0.34 && roll < (gamePenalty - 0.2) * 0.55)(rng())
            : ((roll: number) => gamePenalty > 0.28 && roll < (gamePenalty - 0.12) * 0.72)(rng());
      // A person also just misses sometimes. The extra roll is only made for players with a miss rate,
      // so the game's own scripted players keep exactly the draws they have in its practice runner.
      const ownMiss = profile.missRate ? rng() < profile.missRate : false;
      const forceMiss = ownMiss || weaknessMiss;
      counts.swings += 1;
      if (weaknessMiss) counts.weakness_misses += 1;
      else if (ownMiss) counts.own_misses += 1;
      // In the third loop the game's balanced player answers a dropshot or a slice in kind. The others keep their habit.
      const balanced = loop === 3 && profile.name === 'even';
      const chosenShot =
        balanced && oppCtx?.shotType === 'dropshot'
          ? rng() < 0.65
            ? 'slice'
            : 'dropshot'
          : balanced && oppCtx?.shotType === 'slice' && rng() < 0.55
            ? 'slice'
            : sampleWeighted(profile.shotTypeWeights, rng);
      const chosenTarget = sampleWeighted(profile.targetZoneWeights, rng);
      const confidence =
        loop >= 2 ? { confidence: Math.max(0.58, Math.min(0.96, 0.88 - gamePenalty * 0.25 + (rng() * 2 - 1) * 0.06)) } : {};

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
          ...confidence,
        },
        { targetZoneOverride: chosenTarget, weaknessPenalty, forceMiss },
      );
    }
  };
  return Object.assign(tick, { counts });
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export interface PlayOptions {
  rounds: number;
  /** Simulated seconds per wall-clock second. Infinity plays as fast as it can. */
  pace: number;
  /** Seconds a break lasts before play resumes (wall clock, divided by pace). */
  breakSeconds: number;
  /** An open-ended match: stop at the first point that ends after this many simulated seconds. */
  stopAfterSeconds?: number | null;
  /** Called when a break starts, with the points played so far and how long it will last. */
  onBreak?: (pointsPlayed: number, seconds: number) => void;
}

/**
 * Steps the engine at its fixed 1/60 s tick until the match is over, keeping
 * simulated time in step with the wall clock. Socket callbacks run between
 * ticks, so a behaviour that arrives mid-point is queued and the engine swaps
 * it in itself before the next serve.
 */
export async function playToEnd(game: Game, engine: Any, afterTick: () => void, opts: PlayOptions): Promise<{ maxLagMs: number }> {
  const dt = game.PHYSICS.DT;
  const fast = !Number.isFinite(opts.pace);
  const maxTicks = opts.stopAfterSeconds ? (opts.stopAfterSeconds + 120) / dt : opts.rounds * 60 * 45;
  let ticks = 0;
  let wallStart = performance.now();
  let maxLagMs = 0; // how far play ever fell behind the wall clock: it never waits on the server

  while (engine.getRenderState().phase !== 'match_over' && ticks < maxTicks) {
    const phase = engine.getRenderState().phase;
    if (opts.stopAfterSeconds && ticks * dt >= opts.stopAfterSeconds && phase !== 'rally' && phase !== 'serving') break;
    if (phase === 'demo_pause') {
      const pausedAt = performance.now();
      const pointsPlayed = engine.getRenderState().score.pointIndex - 1;
      const seconds = opts.breakSeconds;
      opts.onBreak?.(pointsPlayed, seconds);
      await sleep(fast ? 0 : (seconds * 1000) / opts.pace);
      engine.resumeFromDemoPause();
      wallStart += performance.now() - pausedAt;
      continue;
    }
    engine.stepFixed(dt);
    afterTick();
    ticks += 1;
    if (fast) {
      if (ticks % 20 === 0) await yieldToLoop();
    } else {
      const simMs = (ticks * dt * 1000) / opts.pace;
      const wallMs = performance.now() - wallStart;
      if (wallMs - simMs > maxLagMs) maxLagMs = wallMs - simMs;
      if (simMs > wallMs + 2) await sleep(simMs - wallMs);
    }
  }
  return { maxLagMs: Math.round(maxLagMs) };
}
