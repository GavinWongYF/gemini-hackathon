// How easy and how hard can the opponent be made, per practice player?
//
// Plays whole behaviours (weights over every decision, plus simple rules) on
// the game's own headless engine, with no server and no model. For each
// practice player it searches for the easiest and the hardest behaviour,
// builds a ladder of behaviours between them, plays every player's hardest
// behaviour against every other player, and repeats each measurement on
// fresh seeds so the noise is visible.
//
// The search reads the npc, its decisions and their options from the game's
// own `setup` message. Nothing in here names a game-specific option: options
// to keep at zero come in with --zero DECISION.OPTION.
//
//   npx --yes tsx --tsconfig <game-root>/client/tsconfig.json agents/eval/ceiling/ceiling.mts \
//       --game-root <game-root> [--personas <design.json>] [--out <dir>] [--zero shot_type.dropshot]
//
// With no --zero it runs two modes: "all options" and, for every option named
// in --hole (default shot_type.dropshot), a mode with that option fixed at zero.
//
// Flags:
//   --game-root DIR     the game checkout (holds client/ and shared/)
//   --personas FILE     a stored design (or list) whose personas join the practice players
//   --out DIR           where the JSON and Markdown go
//   --hole D.O[,D.O]    options to fix at zero in the second mode (default shot_type.dropshot)
//   --search-points N   points per seed while searching (default 150, two seeds)
//   --confirm-points N  points per seed when confirming (default 300)
//   --seeds N           confirm seeds (default 3)
//   --jobs N            worker processes (default: CPUs - 1)
//   --players a,b       only these players

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
type Weights = Record<string, Record<string, number>>;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = 'true';
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const HERE = import.meta.dirname;

// ---------------------------------------------------------------- the game

interface Game {
  TennisMatchEngine: Any;
  OpponentBrain: Any;
  PHYSICS: { DT: number };
  personaToScriptedProfile: (p: Any) => Any;
  createSeededRng: (seed: number) => () => number;
  runPracticeBatch: (req: Any, seed?: number) => Any;
  setup: Any;
}

async function loadGame(gameRoot: string): Promise<Game> {
  const root = path.resolve(gameRoot);
  const at = (rel: string) => import(pathToFileURL(path.join(root, rel)).href);
  const engine = await at('client/src/engine/TennisMatchEngine.ts');
  const flight = await at('client/src/engine/BallFlightEngine.ts');
  const practice = await at('client/src/engine/PracticeRunner.ts');
  const brain = await at('client/src/ai/OpponentBrain.ts');
  const protocol = await at('shared/agentProtocol.ts');
  hookEngine(engine.TennisMatchEngine);
  // The game describes itself through its own setup builder: find it by shape, not by name.
  const builder = Object.values<Any>(protocol).find(
    (f) => typeof f === 'function' && /Setup$/.test(f.name) && f.length <= 1 && f.name.startsWith('create'),
  );
  const setup = builder({ matchId: 'ceiling', mode: 'practice' });
  return {
    TennisMatchEngine: engine.TennisMatchEngine,
    OpponentBrain: brain.OpponentBrain,
    PHYSICS: flight.PHYSICS,
    personaToScriptedProfile: practice.personaToScriptedProfile,
    createSeededRng: practice.createSeededRng,
    runPracticeBatch: practice.runPracticeBatch,
    setup,
  };
}

/** What the next match should record, and the settings it should start with. */
let RECORDER: null | { event: (e: Any) => void; roundEnd: (r: Any) => void } = null;
let SETTINGS: Record<string, number> | null = null;

/**
 * Lets the game's own practice batch run untouched while this tool listens in.
 * At the start of each match it adds a listener to the engine's event sink and
 * queues any settings, which the engine itself applies before the first serve.
 * Nothing is copied from the game, so this keeps working when the game changes.
 */
function hookEngine(Engine: Any) {
  const proto = Engine.prototype;
  if (proto.__ceilingHooked) return;
  const start = proto.startMatch;
  proto.startMatch = function (this: Any, ...a: Any[]) {
    const rec = RECORDER;
    if (rec) {
      const s = this.sink ?? {};
      this.sink = {
        ...s,
        onAgentEvent: (e: Any) => {
          s.onAgentEvent?.(e);
          rec.event(e);
        },
        onAgentRoundEnd: (r: Any) => {
          s.onAgentRoundEnd?.(r);
          rec.roundEnd(r);
        },
      };
    }
    if (SETTINGS) this.brain.queueStrategyUpdate({ settings: SETTINGS });
    return start.apply(this, a);
  };
  proto.__ceilingHooked = true;
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

const quant = (xs: number[], q: number) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
};
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** One run of the game's own practice batch, with every point and shot recorded. */
function playPoints(g: Game, player: Any, behaviour: Any, points: number, seed: number) {
  const perPoint: Array<{ winner: string; how: string; exchanges: number; seconds: number }> = [];
  const player_shots = { count: 0, quality_sum: 0, forced_errors: 0, timing: {} as Record<string, number>, result: {} as Record<string, number> };
  const missed: Record<string, number> = {};
  const opp = { count: 0, result: {} as Record<string, number>, picked: {} as Record<string, Record<string, number>>, by_rule: 0 };
  let anticipations = 0;
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  RECORDER = {
    event: (evt: Any) => {
      if (evt.by === 'player') {
        if (evt.name === 'missed_swing') bump(missed, String(evt.data.reason));
        else if (evt.name === 'shot') {
          player_shots.count += 1;
          player_shots.quality_sum += typeof evt.data.quality === 'number' ? evt.data.quality : 0.75;
          bump(player_shots.timing, String(evt.data.timing));
          bump(player_shots.result, String(evt.data.result));
          if (evt.data.result === 'out' || evt.data.result === 'net') player_shots.forced_errors += 1;
        }
      } else if (evt.name === 'shot') {
        opp.count += 1;
        bump(opp.result, String(evt.data.result));
        for (const [d, o] of Object.entries<string>(evt.picked ?? {})) bump((opp.picked[d] ??= {}), o);
        if ((evt.by_rule ?? []).length) opp.by_rule += 1;
      } else if (evt.name === 'anticipate') {
        anticipations += 1;
        for (const [d, o] of Object.entries<string>(evt.picked ?? {})) bump((opp.picked[d] ??= {}), o);
        if ((evt.by_rule ?? []).length) opp.by_rule += 1;
      }
    },
    roundEnd: (re: Any) => {
      perPoint.push({ winner: re.winner, how: re.how, exchanges: re.stats?.rally_length ?? 0, seconds: re.stats?.seconds ?? 0 });
    },
  };
  let rep: Any;
  try {
    rep = g.runPracticeBatch({ run_id: 'ceiling', player, rounds: points, behaviour }, seed).reply;
  } finally {
    RECORDER = null;
  }
  return { score: { player: rep.wins.player, opponent: rep.wins.opponent }, perPoint, player_shots, missed, opp, anticipations, batch: rep.stats };
}

type Run = ReturnType<typeof playPoints>;

/** Several runs on different seeds, pooled into one report. */
function summarise(runs: Run[], seeds: number[]) {
  const shares = runs.map((r) => r.score.player / Math.max(1, r.score.player + r.score.opponent));
  const pts = runs.flatMap((r) => r.perPoint);
  const secs = pts.map((p) => p.seconds);
  const ex = pts.map((p) => p.exchanges);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
  const merge = (ms: Record<string, number>[]) => {
    const o: Record<string, number> = {};
    for (const m of ms) for (const [k, v] of Object.entries(m)) o[k] = (o[k] ?? 0) + v;
    return o;
  };
  const how: Record<string, number> = {};
  for (const p of pts) how[`${p.winner}:${p.how}`] = (how[`${p.winner}:${p.how}`] ?? 0) + 1;
  const pickedAll: Record<string, Record<string, number>> = {};
  for (const r of runs) for (const [d, m] of Object.entries(r.opp.picked)) pickedAll[d] = merge([pickedAll[d] ?? {}, m]);
  const pShots = runs.reduce((a, r) => a + r.player_shots.count, 0);
  const total = runs.reduce((a, r) => a + r.score.player + r.score.opponent, 0);
  if (pts.length === 0) {
    // Batch mode: only the game's own averages exist.
    const avg = (k: string) => r3(mean(runs.map((r: Any) => r.batch?.[k] ?? 0)));
    const missedAll = runs.reduce((a, r) => a + (r.missed.all ?? 0), 0);
    const fe = runs.reduce((a, r) => a + r.player_shots.forced_errors, 0);
    return {
      points: total,
      seeds,
      player_share: r3(mean(shares)),
      player_share_by_seed: shares.map(r3),
      spread_pct_points: r2((Math.max(...shares) - Math.min(...shares)) * 100),
      sd_pct_points: r2(sd(shares) * 100),
      point_seconds: { mean: avg('average_point_seconds'), median: null, p90: null, longest: null },
      exchanges: { mean: avg('average_exchanges'), median: null, p90: null, longest: null },
      per_shot: { player_average_quality: avg('average_quality'), player_missed_swings: missedAll, player_forced_errors: fe },
      how_points_ended: {},
      per_point_rate: { missed_swings: r3(missedAll / Math.max(1, total)), forced_errors: r3(fe / Math.max(1, total)) },
      detail: 'game batch only: no per-point numbers',
    };
  }
  return {
    points: total,
    seeds,
    player_share: r3(mean(shares)),
    player_share_by_seed: shares.map(r3),
    spread_pct_points: r2((Math.max(...shares) - Math.min(...shares)) * 100),
    sd_pct_points: r2(sd(shares) * 100),
    point_seconds: { mean: r2(mean(secs)), median: r2(quant(secs, 0.5)), p90: r2(quant(secs, 0.9)), longest: r2(Math.max(...secs)) },
    exchanges: { mean: r2(mean(ex)), median: quant(ex, 0.5), p90: quant(ex, 0.9), longest: Math.max(...ex) },
    per_shot: {
      player_shots: pShots,
      player_average_quality: r3(runs.reduce((a, r) => a + r.player_shots.quality_sum, 0) / Math.max(1, pShots)),
      player_missed_swings: runs.reduce((a, r) => a + Object.values(r.missed).reduce((x, y) => x + y, 0), 0),
      player_missed_swings_by_reason: merge(runs.map((r) => r.missed)),
      player_forced_errors: runs.reduce((a, r) => a + r.player_shots.forced_errors, 0),
      player_shot_result: merge(runs.map((r) => r.player_shots.result)),
      player_timing: merge(runs.map((r) => r.player_shots.timing)),
      opponent_shots: runs.reduce((a, r) => a + r.opp.count, 0),
      opponent_shot_result: merge(runs.map((r) => r.opp.result)),
      opponent_picks_by_rule: runs.reduce((a, r) => a + r.opp.by_rule, 0),
      opponent_picked: pickedAll,
    },
    how_points_ended: how,
    per_point_rate: {
      missed_swings: r3(runs.reduce((a, r) => a + Object.values(r.missed).reduce((x, y) => x + y, 0), 0) / Math.max(1, total)),
      forced_errors: r3(runs.reduce((a, r) => a + r.player_shots.forced_errors, 0) / Math.max(1, total)),
    },
  };
}

// ---------------------------------------------------------------- behaviours

interface Space {
  npc: string;
  decisions: Record<string, string[]>;
  zero: Set<string>; // "decision.option"
  facts: Array<{ fact: string; values: string[] }>;
}

function spaceFrom(setup: Any, zero: string[]): Space {
  const npc = Object.keys(setup.npcs)[0];
  const decisions: Record<string, string[]> = {};
  for (const [d, spec] of Object.entries<Any>(setup.npcs[npc].decisions)) decisions[d] = Object.keys(spec.options);
  const facts: Array<{ fact: string; values: string[] }> = [];
  for (const [f, schema] of Object.entries<Any>(setup.facts ?? {})) {
    if (Array.isArray(schema)) facts.push({ fact: f, values: schema });
    else if (typeof schema === 'string' && setup.lists?.[schema]) facts.push({ fact: f, values: setup.lists[schema] });
  }
  for (const z of zero) {
    const [d, o] = z.split('.');
    if (!decisions[d]?.includes(o)) throw new Error(`--zero ${z}: no such decision.option in the setup`);
  }
  return { npc, decisions, zero: new Set(zero), facts };
}

function weightsFromBehaviour(space: Space, b: Any): Weights {
  const w: Weights = {};
  for (const [d, opts] of Object.entries(space.decisions)) {
    w[d] = {};
    for (const o of opts) w[d][o] = Math.max(0, b?.npcs?.[space.npc]?.decisions?.[d]?.[o]?.base ?? 0);
  }
  return normalise(space, w);
}

function normalise(space: Space, w: Weights): Weights {
  const out: Weights = {};
  for (const [d, opts] of Object.entries(space.decisions)) {
    out[d] = {};
    let t = 0;
    for (const o of opts) {
      const v = space.zero.has(`${d}.${o}`) ? 0 : Math.max(0, w[d]?.[o] ?? 0);
      out[d][o] = v;
      t += v;
    }
    const live = opts.filter((o) => !space.zero.has(`${d}.${o}`));
    for (const o of opts) out[d][o] = t > 0 ? r3(out[d][o] / t) : live.includes(o) ? r3(1 / live.length) : 0;
  }
  return out;
}

function toBehaviour(space: Space, w: Weights, rules: Any[] = [], version = 1): Any {
  const decisions: Any = {};
  for (const [d, opts] of Object.entries(w)) {
    decisions[d] = {};
    for (const [o, v] of Object.entries(opts)) decisions[d][o] = { base: v };
  }
  return { version, npcs: { [space.npc]: { decisions, rules } } };
}

/** How many picks went to an option that must stay at zero (a game fallback can still choose one). */
function zeroLeaks(space: Space, runs: Run[]): number {
  let n = 0;
  for (const r of runs) for (const [d, m] of Object.entries(r.opp.picked)) for (const [o, c] of Object.entries(m)) if (space.zero.has(`${d}.${o}`)) n += c;
  return n;
}

// ---------------------------------------------------------------- search

interface Ctx {
  g: Game;
  space: Space;
  player: Any;
  searchSeeds: number[];
  searchPoints: number;
  confirmSeeds: number[];
  confirmPoints: number;
  evals: number;
}

function evalShare(ctx: Ctx, b: Any): { share: number; leaks: number } {
  const runs = ctx.searchSeeds.map((s) => playPoints(ctx.g, ctx.player, b, ctx.searchPoints, s));
  ctx.evals += 1;
  let p = 0;
  let t = 0;
  for (const r of runs) {
    p += r.score.player;
    t += r.score.player + r.score.opponent;
  }
  return { share: p / Math.max(1, t), leaks: zeroLeaks(ctx.space, runs) };
}

function mulberry(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Coordinate search, then random local moves, then single rules. dir=+1 easiest (max player share), -1 hardest. */
function search(ctx: Ctx, dir: 1 | -1, start: Weights, opt = { passes: 2, moves: 30, rules: 24 }) {
  const { space } = ctx;
  const rnd = mulberry(dir === 1 ? 7 : 11);
  const score = (b: Any) => {
    const e = evalShare(ctx, b);
    return { obj: e.leaks > 0 ? -Infinity : dir * e.share, share: e.share, leaks: e.leaks };
  };
  let cur = normalise(space, start);
  let curS = score(toBehaviour(space, cur));
  const trace: Any[] = [{ step: 'start', share: r3(curS.share) }];

  // 1. Coordinate search: for each decision try each option alone, the best two halved, and the current mix.
  for (let pass = 0; pass < opt.passes; pass++) {
    for (const [d, opts] of Object.entries(space.decisions)) {
      const live = opts.filter((o) => !space.zero.has(`${d}.${o}`));
      const cands: Record<string, number>[] = [];
      for (const o of live) cands.push(Object.fromEntries(opts.map((x) => [x, x === o ? 1 : 0])));
      for (const o of live) cands.push(Object.fromEntries(opts.map((x) => [x, x === o ? 0.7 : live.includes(x) ? 0.3 / (live.length - 1) : 0])));
      cands.push(Object.fromEntries(opts.map((x) => [x, live.includes(x) ? 1 : 0])));
      for (const c of cands) {
        const w = normalise(space, { ...cur, [d]: c });
        const s = score(toBehaviour(space, w));
        if (s.obj > curS.obj + 0.004) {
          cur = w;
          curS = s;
        }
      }
      trace.push({ step: `coord pass ${pass + 1} ${d}`, share: r3(curS.share) });
    }
  }

  // 2. Random local moves: jiggle every weight, sometimes drop or revive an option.
  for (let i = 0; i < opt.moves; i++) {
    const w: Weights = {};
    for (const [d, opts] of Object.entries(space.decisions)) {
      w[d] = {};
      for (const o of opts) {
        let v = cur[d][o];
        if (rnd() < 0.15) v = v > 0 ? 0 : 0.15 + rnd() * 0.3;
        else v = v * Math.exp((rnd() * 2 - 1) * 0.8);
        w[d][o] = v;
      }
    }
    const nw = normalise(space, w);
    const s = score(toBehaviour(space, nw));
    if (s.obj > curS.obj + 0.01) {
      cur = nw;
      curS = s;
    }
  }
  trace.push({ step: 'random moves', share: r3(curS.share) });
  const weightsOnly = { weights: cur, share: curS.share };

  // 3. Rules: try single if/then rules built from the setup's facts and decisions.
  let rules: Any[] = [];
  const pool: Any[] = [];
  for (const f of space.facts)
    for (const v of f.values)
      for (const [d, opts] of Object.entries(space.decisions))
        for (const o of opts) if (!space.zero.has(`${d}.${o}`)) pool.push({ if: [{ fact: f.fact, is: v }], do: { [d]: o }, why: `${f.fact} is ${v}: ${d} ${o}` });
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  for (const rule of pool.slice(0, opt.rules)) {
    if (rules.length >= 3) break;
    const s = score(toBehaviour(space, cur, [...rules, rule]));
    if (s.obj > curS.obj + 0.02) {
      rules = [...rules, rule];
      curS = s;
    }
  }
  trace.push({ step: 'rules', share: r3(curS.share), rules: rules.length });
  return { weights: cur, rules, searchShare: curS.share, weightsOnly, trace };
}

function confirm(ctx: Ctx, b: Any) {
  const runs = ctx.confirmSeeds.map((s) => playPoints(ctx.g, ctx.player, b, ctx.confirmPoints, s));
  return { ...summarise(runs, ctx.confirmSeeds), zero_option_picks: zeroLeaks(ctx.space, runs) };
}

function blend(space: Space, a: Weights, b: Weights, t: number): Weights {
  const w: Weights = {};
  for (const [d, opts] of Object.entries(space.decisions)) {
    w[d] = {};
    for (const o of opts) w[d][o] = (1 - t) * a[d][o] + t * b[d][o];
  }
  return normalise(space, w);
}

// ---------------------------------------------------------------- tasks

function playerName(p: Any) {
  return typeof p === 'string' ? p : p.name;
}

async function runTask(task: Any) {
  const g = await loadGame(task.gameRoot);
  const space = spaceFrom(g.setup, task.zero);
  const ctx: Ctx = {
    g,
    space,
    player: task.player,
    searchSeeds: task.searchSeeds,
    searchPoints: task.searchPoints,
    confirmSeeds: task.confirmSeeds,
    confirmPoints: task.confirmPoints,
    evals: 0,
  };
  SETTINGS = null;
  const t0 = performance.now();
  if (task.kind === 'search') {
    const def = weightsFromBehaviour(space, g.setup.default_behaviour);
    const defaultConfirm = confirm(ctx, toBehaviour(space, def, [], 0));
    const easy = search(ctx, 1, def);
    const hard = search(ctx, -1, def);
    // Keep whichever of (weights + rules) and (weights only) holds up on fresh seeds.
    const pickBetter = (s: Any, dir: number) => {
      const withRules = confirm(ctx, toBehaviour(space, s.weights, s.rules));
      if (s.rules.length === 0) return { weights: s.weights, rules: [], result: withRules };
      const plain = confirm(ctx, toBehaviour(space, s.weights, []));
      return dir * withRules.player_share >= dir * plain.player_share + 0.01
        ? { weights: s.weights, rules: s.rules, result: withRules, without_rules_share: plain.player_share }
        : { weights: s.weights, rules: [], result: plain, rules_tried_but_dropped: s.rules, with_rules_share: withRules.player_share };
    };
    const easiest = pickBetter(easy, 1);
    const hardest = pickBetter(hard, -1);

    // Ladder: blend the easiest weights into the hardest, then pick blends near each target share.
    const grid: Any[] = [];
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      const w = blend(space, easiest.weights, hardest.weights, t);
      const e = evalShare({ ...ctx, searchSeeds: [task.confirmSeeds[0]], searchPoints: task.confirmPoints }, toBehaviour(space, w));
      grid.push({ t, share: e.share });
    }
    const targets = [0.75, 0.675, 0.6, 0.525, 0.45];
    const ladder: Any[] = [];
    for (const target of targets) {
      let t = grid[0].share >= target ? 1 : 0;
      for (let k = 0; k < grid.length - 1; k++) {
        const a = grid[k];
        const b = grid[k + 1];
        if ((a.share - target) * (b.share - target) <= 0 && a.share !== b.share) {
          t = a.t + ((target - a.share) / (b.share - a.share)) * (b.t - a.t);
          break;
        }
      }
      if (grid.every((x) => x.share > target)) t = 1;
      if (grid.every((x) => x.share < target)) t = 0;
      const w = blend(space, easiest.weights, hardest.weights, t);
      const res = confirm(ctx, toBehaviour(space, w));
      ladder.push({
        target,
        blend_t: r3(t),
        reachable: !(grid.every((x) => x.share > target + 0.03) || grid.every((x) => x.share < target - 0.03)),
        weights: w,
        player_share: res.player_share,
        spread_pct_points: res.spread_pct_points,
        point_seconds: res.point_seconds,
        exchanges: res.exchanges,
        per_point_rate: res.per_point_rate,
      });
    }
    // The settings dial: the default and the hardest behaviour at each setting value.
    const dial: Any[] = [];
    if (task.dial) {
      for (const v of task.dial.values) {
        SETTINGS = { [task.dial.name]: v };
        const atDefault = confirm(ctx, toBehaviour(space, def, [], 0));
        const re = search(ctx, -1, hardest.weights, { passes: 1, moves: 0, rules: 0 });
        const fromMain = confirm(ctx, toBehaviour(space, hardest.weights, hardest.rules));
        const polished = confirm(ctx, toBehaviour(space, re.weights, []));
        const best = polished.player_share < fromMain.player_share ? { weights: re.weights, rules: [], result: polished } : { weights: hardest.weights, rules: hardest.rules, result: fromMain };
        dial.push({
          [task.dial.name]: v,
          default_player_share: atDefault.player_share,
          default_spread_pct_points: atDefault.spread_pct_points,
          default_point_seconds: atDefault.point_seconds,
          main_hardest_player_share: fromMain.player_share,
          hardest_player_share: best.result.player_share,
          hardest_spread_pct_points: best.result.spread_pct_points,
          hardest_weights: best.weights,
          hardest_rules: best.rules,
          hardest_point_seconds: best.result.point_seconds,
          hardest_exchanges: best.result.exchanges,
          hardest_per_point_rate: best.result.per_point_rate,
        });
      }
      SETTINGS = null;
    }
    return {
      kind: 'search',
      dial,
      player: playerName(task.player),
      mode: task.mode,
      zero: task.zero,
      default: { weights: def, result: defaultConfirm },
      easiest: { ...easiest, search_trace: easy.trace, weights_only_search_share: r3(easy.weightsOnly.share) },
      hardest: { ...hardest, search_trace: hard.trace, weights_only_search_share: r3(hard.weightsOnly.share) },
      ladder_grid: grid.map((x) => ({ t: x.t, share: r3(x.share) })),
      ladder,
      evals: ctx.evals,
      seconds: r2((performance.now() - t0) / 1000),
    };
  }
  if (task.kind === 'row') {
    // One behaviour against every player.
    const cells: Any[] = [];
    for (const p of task.players) {
      const c = { ...ctx, player: p };
      const res = confirm(c, task.behaviour);
      cells.push({ against: playerName(p), player_share: res.player_share, by_seed: res.player_share_by_seed, spread_pct_points: res.spread_pct_points });
    }
    return { kind: 'row', tuned_for: task.tunedFor, mode: task.mode, cells, seconds: r2((performance.now() - t0) / 1000) };
  }
  if (task.kind === 'check') {
    // The copied loop must give the game's own practice batch numbers exactly.
    const out: Any[] = [];
    for (const p of task.players) {
      const mine = playPoints(g, p, g.setup.default_behaviour, 60, 1337);
      const theirs = g.runPracticeBatch({ run_id: 'check', player: p, rounds: 60, behaviour: g.setup.default_behaviour }, 1337).reply;
      out.push({ player: playerName(p), mine: mine.score, batch: theirs.wins, points_recorded: mine.perPoint.length, same: mine.score.player === theirs.wins.player && mine.score.opponent === theirs.wins.opponent && mine.perPoint.length === 60 });
    }
    const t1 = performance.now();
    playPoints(g, task.players[0], g.setup.default_behaviour, 300, 1);
    return { kind: 'check', out, ms_per_point: r2((performance.now() - t1) / 300) };
  }
  throw new Error(`unknown task ${task.kind}`);
}

// ---------------------------------------------------------------- orchestration

function runWorker(taskFile: string, outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, path.join(HERE, 'ceiling.mts'), '--worker', taskFile, '--result', outFile], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${taskFile} exited ${code}`))));
  });
}

async function pool<T>(items: T[], jobs: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

function loadPersonas(file: string | undefined): Any[] {
  if (!file) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(data) ? data : (data.design?.personas ?? data.personas ?? []);
  return Array.isArray(list) ? list : Object.values(list);
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const wtxt = (w: Weights) =>
  Object.entries(w)
    .map(([d, m]) => `${d}: ${Object.entries(m).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([o, v]) => `${o} ${Math.round(v * 100)}`).join(', ')}`)
    .join('; ');

function markdown(report: Any): string {
  const L: string[] = [];
  L.push(`# Opponent ceiling and floor per practice player`);
  L.push('');
  L.push(`Measured ${report.measured_at} on the game at ${report.game_root}.`);
  L.push(`Each number is the player's share of points over ${report.confirm_points} points on each of ${report.confirm_seeds.length} fresh seeds (${report.confirm_points * report.confirm_seeds.length} points), not the search seeds.`);
  L.push('');
  for (const mode of report.modes) {
    L.push(`## ${mode.name}${mode.zero.length ? ` (fixed at zero: ${mode.zero.join(', ')})` : ''}`);
    L.push('');
    L.push('| Player | Default | Easiest | Hardest | Range | Hardest spread (3 seeds) | Hardest: sec median / p90 / max | Hardest: exchanges median / p90 / max | Hardest: missed swings per point | Hardest: player forced errors per point | Hardest: quality |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const s of mode.players) {
      const h = s.hardest.result;
      L.push(
        `| ${s.player} | ${pct(s.default.result.player_share)} | ${pct(s.easiest.result.player_share)} | ${pct(h.player_share)} | ${Math.round((s.easiest.result.player_share - h.player_share) * 100)} pts | ${h.spread_pct_points} pts | ${h.point_seconds.median} / ${h.point_seconds.p90} / ${h.point_seconds.longest} | ${h.exchanges.median} / ${h.exchanges.p90} / ${h.exchanges.longest} | ${h.per_point_rate.missed_swings} | ${h.per_point_rate.forced_errors} | ${h.per_shot.player_average_quality} |`,
      );
    }
    L.push('');
    L.push('Easiest point lengths (sec median / p90 / max, exchanges median / p90 / max):');
    L.push('');
    for (const s of mode.players) {
      const e = s.easiest.result;
      L.push(`- ${s.player}: ${e.point_seconds.median} / ${e.point_seconds.p90} / ${e.point_seconds.longest} s, ${e.exchanges.median} / ${e.exchanges.p90} / ${e.exchanges.longest} exchanges, quality ${e.per_shot.player_average_quality}, missed swings per point ${e.per_point_rate.missed_swings}`);
    }
    L.push('');
    L.push('Weights:');
    L.push('');
    for (const s of mode.players) {
      L.push(`- ${s.player} easiest: ${wtxt(s.easiest.weights)}${s.easiest.rules.length ? ` | rules: ${s.easiest.rules.map((r: Any) => r.why).join('; ')}` : ''}`);
      L.push(`- ${s.player} hardest: ${wtxt(s.hardest.weights)}${s.hardest.rules.length ? ` | rules: ${s.hardest.rules.map((r: Any) => r.why).join('; ')}` : ''}`);
    }
    L.push('');
    L.push('### Ladder (player share, target in brackets)');
    L.push('');
    L.push('| Player | Step 1 (75%) | Step 2 (67.5%) | Step 3 (60%) | Step 4 (52.5%) | Step 5 (45%) |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    for (const s of mode.players) {
      L.push(`| ${s.player} | ${s.ladder.map((l: Any) => `${pct(l.player_share)}${l.reachable ? '' : ' (out of range)'}`).join(' | ')} |`);
    }
    L.push('');
    L.push('Each ladder step blends the easiest weights (t = 0) into the hardest weights (t = 1). Rules are left out of the ladder.');
    L.push('');
    for (const s of mode.players) {
      L.push(`- ${s.player}: ${s.ladder.map((l: Any) => `t=${l.blend_t} -> ${pct(l.player_share)}`).join(', ')}`);
    }
    L.push('');
    if (report.dial && mode.players[0]?.dial?.length) {
      const dn = report.dial.name;
      L.push(`### The ${dn} dial (player share; the main search ran at the default ${dn} ${report.dial.now})`);
      L.push('');
      L.push(`| Player | ${report.dial.values.map((v: number) => `Default @ ${v}`).join(' | ')} | ${report.dial.values.map((v: number) => `Hardest @ ${v}`).join(' | ')} |`);
      L.push(`| --- | ${report.dial.values.map(() => '---').join(' | ')} | ${report.dial.values.map(() => '---').join(' | ')} |`);
      for (const s of mode.players) {
        L.push(`| ${s.player} | ${s.dial.map((d: Any) => pct(d.default_player_share)).join(' | ')} | ${s.dial.map((d: Any) => pct(d.hardest_player_share)).join(' | ')} |`);
      }
      L.push('');
    }
    L.push('### Hardest behaviour for one player, played against every player (player share)');
    L.push('');
    const names = mode.players.map((s: Any) => s.player);
    L.push(`| Tuned for \\ played against | ${names.join(' | ')} | Own player vs mean of others |`);
    L.push(`| --- | ${names.map(() => '---').join(' | ')} | --- |`);
    for (const row of mode.matrix) {
      const own = row.cells.find((c: Any) => c.against === row.tuned_for);
      const others = row.cells.filter((c: Any) => c.against !== row.tuned_for);
      const meanOthers = others.reduce((a: number, c: Any) => a + c.player_share, 0) / Math.max(1, others.length);
      L.push(
        `| ${row.tuned_for} | ${names.map((n: string) => {
          const c = row.cells.find((x: Any) => x.against === n);
          return c ? (n === row.tuned_for ? `**${pct(c.player_share)}**` : pct(c.player_share)) : '-';
        }).join(' | ')} | ${Math.round((meanOthers - own.player_share) * 100)} pts harder for its own player |`,
      );
    }
    L.push('');
  }
  return L.join('\n');
}

async function main() {
  if (args.worker) {
    const task = JSON.parse(fs.readFileSync(args.worker, 'utf8'));
    const res = await runTask(task);
    fs.writeFileSync(args.result, JSON.stringify(res));
    return;
  }
  const gameRoot = path.resolve(args['game-root'] ?? '.');
  const outDir = path.resolve(args.out ?? 'ceiling-out');
  const partsDir = path.join(outDir, 'parts');
  fs.mkdirSync(partsDir, { recursive: true });
  const g = await loadGame(gameRoot);
  const builtins = Object.keys(g.setup.practice?.players ?? {});
  const seen = new Set<string>(builtins);
  const personas: Any[] = [];
  for (const file of (args.personas ?? '').split(',').filter(Boolean)) {
    for (const p of loadPersonas(file)) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      personas.push(p);
    }
  }
  let players: Any[] = [...builtins, ...personas];
  if (args.players) {
    const want = args.players.split(',');
    players = players.filter((p) => want.includes(playerName(p)));
  }
  const holes = (args.hole ?? 'shot_type.dropshot').split(',').filter(Boolean);
  const modes = args.zero
    ? [{ name: `zero ${args.zero}`, zero: args.zero.split(',') }]
    : [
        { name: 'all options', zero: [] as string[] },
        { name: `without ${holes.join(', ')}`, zero: holes },
      ];
  const common = {
    gameRoot,
    searchSeeds: [101, 102],
    searchPoints: Number(args['search-points'] ?? 120),
    confirmSeeds: Array.from({ length: Number(args.seeds ?? 3) }, (_, i) => 1001 + i),
    confirmPoints: Number(args['confirm-points'] ?? 300),
  };
  const jobs = Number(args.jobs ?? Math.max(1, os.cpus().length - 1));
  // The dial: a range setting from the setup (--dial NAME, default the first one), at --dial-steps evenly spaced values.
  const ranges = Object.entries<Any>(g.setup.settings ?? {}).filter(([, v]) => typeof v.min === 'number' && typeof v.max === 'number');
  const dialName = args.dial ?? ranges[0]?.[0];
  const dialSpec = ranges.find(([k]) => k === dialName)?.[1];
  const steps = Number(args['dial-steps'] ?? 4);
  const dial =
    dialSpec && args.dial !== 'none'
      ? { name: dialName, now: dialSpec.now, values: Array.from({ length: steps }, (_, i) => r2(dialSpec.min + (i * (dialSpec.max - dialSpec.min)) / (steps - 1))) }
      : null;
  (common as Any).dial = dial;
  const t0 = performance.now();

  // 0. Check the copied practice loop against the game's own batch.
  const checkFile = path.join(partsDir, 'check.task.json');
  fs.writeFileSync(checkFile, JSON.stringify({ ...common, kind: 'check', zero: [], players, mode: 'check', player: players[0] }));
  await runWorker(checkFile, path.join(partsDir, 'check.json'));
  const check = JSON.parse(fs.readFileSync(path.join(partsDir, 'check.json'), 'utf8'));
  const same = check.out.every((c: Any) => c.same);
  console.log(`check against the game's own batch: ${same ? 'identical, every point recorded' : 'DIFFERENT, look at check_against_game_batch'}; ${check.ms_per_point} ms per point`);

  // 1. Search per player and mode.
  const searchTasks = modes.flatMap((m) => players.map((p) => ({ ...common, kind: 'search', zero: m.zero, mode: m.name, player: p })));
  const searchResults: Any[] = new Array(searchTasks.length);
  await pool(searchTasks, jobs, async (task, i) => {
    const tf = path.join(partsDir, `search-${i}.task.json`);
    const rf = path.join(partsDir, `search-${i}.json`);
    fs.writeFileSync(tf, JSON.stringify(task));
    await runWorker(tf, rf);
    searchResults[i] = JSON.parse(fs.readFileSync(rf, 'utf8'));
    const s = searchResults[i];
    console.log(`[${s.mode}] ${s.player}: default ${pct(s.default.result.player_share)}, easiest ${pct(s.easiest.result.player_share)}, hardest ${pct(s.hardest.result.player_share)} (${s.evals} tries, ${s.seconds}s)`);
  });

  // 2. Each player's hardest behaviour against every player.
  const rowTasks = searchResults.map((s) => {
    const m = modes.find((x) => x.name === s.mode)!;
    const space = spaceFrom(g.setup, m.zero);
    return { ...common, kind: 'row', zero: m.zero, mode: s.mode, tunedFor: s.player, players, player: players[0], behaviour: toBehaviour(space, s.hardest.weights, s.hardest.rules) };
  });
  const rows: Any[] = new Array(rowTasks.length);
  await pool(rowTasks, jobs, async (task, i) => {
    const tf = path.join(partsDir, `row-${i}.task.json`);
    const rf = path.join(partsDir, `row-${i}.json`);
    fs.writeFileSync(tf, JSON.stringify(task));
    await runWorker(tf, rf);
    rows[i] = JSON.parse(fs.readFileSync(rf, 'utf8'));
  });

  const report = {
    measured_at: new Date().toString(),
    game_root: gameRoot,
    commit: fs.existsSync(path.join(gameRoot, 'COMMIT')) ? fs.readFileSync(path.join(gameRoot, 'COMMIT'), 'utf8').trim() : null,
    check_against_game_batch: check,
    scores_from: "the game's own practice batch, with a listener on its event sink",
    dial,
    search_seeds: common.searchSeeds,
    search_points_per_seed: common.searchPoints,
    confirm_seeds: common.confirmSeeds,
    confirm_points: common.confirmPoints,
    modes: modes.map((m) => ({
      name: m.name,
      zero: m.zero,
      players: searchResults.filter((s) => s.mode === m.name),
      matrix: rows.filter((r) => r.mode === m.name),
    })),
    wall_seconds: r2((performance.now() - t0) / 1000),
  };
  fs.writeFileSync(path.join(outDir, 'ceiling.json'), JSON.stringify(report, null, 1));
  fs.writeFileSync(path.join(outDir, 'ceiling.md'), markdown(report));
  fs.rmSync(partsDir, { recursive: true, force: true });
  console.log(`wrote ${path.join(outDir, 'ceiling.json')} and ceiling.md in ${report.wall_seconds}s`);
}

await main();
