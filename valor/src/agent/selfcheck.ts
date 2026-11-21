// ─────────────────────────────────────────────────────────────────────────
// selfcheck.ts — the plan every agent output is checked against BEFORE it is
// applied (Gemini or stand-in alike). Two stages:
//   1. structure: names exist in `setup`, numbers in bounds, cover only at
//      allowed named spots, never near a spawn, never blocking a lane, ≤ N;
//   2. fairness: simulate the next round headlessly (sim.ts) with the candidate
//      vs the current behaviour against a player model fitted to the observed
//      habits; reject if the predicted player win-rate leaves the 35–65% band
//      or moves further from 50% than the current behaviour does.
// Every rejection gets a plain reason (shown in useAgentStatus.rejected + JSON log).
// ─────────────────────────────────────────────────────────────────────────

import type { Brain } from "./brain";
import { makeAdaptiveBrain } from "./adaptiveBrain";
import { mulberry32, type AgentStrategyUpdateMessage, type BehaviourJson, type GameSetupMessage } from "./protocol";
import { COVER_BY_NAME, MAX_COVER_OBJECTS, SETTING_BOUNDS, type AgentSettings } from "./setup";
import { LANE_WIDTH_M, MAP_COVER_PIECES, MIN_PASSABLE_M, SPAWN_CLEARANCE_M, SPAWN_POINTS, laneOf } from "./plaza";
import { habitModel, simulateRound, type Habit, type ScriptedPlayer } from "./sim";

export const FAIR_BAND = { lo: 0.35, hi: 0.65 } as const;

/** Merge an update's `settings` onto the current ones (cover may be a list or "a,b" / "none"). */
export function mergeSettings(cur: AgentSettings, s: Record<string, unknown> | undefined): { settings: AgentSettings; problems: string[] } {
  const out: AgentSettings = { ...cur, cover: cur.cover.slice() };
  const problems: string[] = [];
  for (const [k, v] of Object.entries(s ?? {})) {
    if (k === "cover") {
      const list = Array.isArray(v) ? v.map(String) : typeof v === "string" ? (v === "none" || v === "" ? [] : v.split(",").map((x) => x.trim())) : null;
      if (!list) problems.push(`settings.cover must be a list of spot names, got ${JSON.stringify(v)}`);
      else out.cover = list;
    } else if (k in SETTING_BOUNDS) {
      if (typeof v !== "number" || !Number.isFinite(v)) problems.push(`settings.${k} must be a number, got ${JSON.stringify(v)}`);
      else out[k as keyof typeof SETTING_BOUNDS] = v;
    } else problems.push(`unknown setting "${k}"`);
  }
  return { settings: out, problems };
}

export function checkCover(names: string[]): string[] {
  const r: string[] = [];
  if (names.length > MAX_COVER_OBJECTS) r.push(`cover: ${names.length} objects, at most ${MAX_COVER_OBJECTS} allowed`);
  if (new Set(names).size !== names.length) r.push("cover: the same spot is listed twice");
  const spots = names.map((n) => COVER_BY_NAME[n]);
  names.forEach((n, i) => {
    if (!spots[i]) r.push(`cover: "${n}" is not one of the allowed spots`);
  });
  for (const s of spots.filter(Boolean)) {
    for (const [sx, sz] of SPAWN_POINTS)
      if (Math.hypot(s.x - sx, s.z - sz) < SPAWN_CLEARANCE_M) r.push(`cover: ${s.name} is within ${SPAWN_CLEARANCE_M} m of a spawn`);
    for (const m of MAP_COVER_PIECES) if (Math.hypot(s.x - m.x, s.z - m.z) < 1.0) r.push(`cover: ${s.name} overlaps a permanent block at (${m.x}, ${m.z})`);
    // lane blocking: everything in the same lane within 1 m of depth must leave MIN_PASSABLE_M free
    const band = [...MAP_COVER_PIECES, ...spots.filter(Boolean).map((o) => ({ x: o.x, z: o.z, w: o.widthM, source: "agent" as const, name: o.name }))].filter(
      (p) => laneOf(p.x) === s.lane && Math.abs(p.z - s.z) <= 1.0,
    );
    const width = band.reduce((a, p) => a + p.w, 0);
    if (width > LANE_WIDTH_M[s.lane] - MIN_PASSABLE_M)
      r.push(`cover: ${s.name} would block the ${s.lane} lane (${width.toFixed(1)} m of cover at z≈${s.z} leaves < ${MIN_PASSABLE_M} m to walk through)`);
  }
  return [...new Set(r)];
}

/** Stage 1 — structure. Returns plain reasons; empty = ok. */
export function validateStructure(update: Pick<AgentStrategyUpdateMessage, "behaviour" | "settings">, setup: GameSetupMessage, knownValues: string[], cur: AgentSettings): { reasons: string[]; settings: AgentSettings } {
  const reasons: string[] = [];
  const b: BehaviourJson | undefined = update.behaviour;
  if (!b || typeof b !== "object" || !b.npcs) reasons.push("behaviour is missing or has no npcs");
  else {
    for (const [npcId, npc] of Object.entries(b.npcs)) {
      const spec = setup.npcs[npcId];
      if (!spec) {
        reasons.push(`unknown npc "${npcId}"`);
        continue;
      }
      for (const [dec, opts] of Object.entries(npc.decisions ?? {})) {
        const ds = spec.decisions[dec];
        if (!ds) {
          reasons.push(`unknown decision "${npcId}.${dec}"`);
          continue;
        }
        for (const [opt, o] of Object.entries(opts)) {
          if (!(opt in ds.options)) reasons.push(`unknown option "${npcId}.${dec}.${opt}"`);
          if (typeof o?.base !== "number" || !Number.isFinite(o.base) || o.base < 0) reasons.push(`${npcId}.${dec}.${opt}: base must be a number ≥ 0`);
          for (const [v, w] of Object.entries(o?.when ?? {})) {
            if (!knownValues.includes(v)) reasons.push(`${npcId}.${dec}.${opt}: unknown value "${v}"`);
            if (typeof w !== "number" || !Number.isFinite(w) || Math.abs(w) > 5) reasons.push(`${npcId}.${dec}.${opt}: weight for "${v}" must be a number in [-5, 5]`);
          }
        }
        const sum = Object.values(opts).reduce((a, o) => a + Math.max(0, o?.base ?? 0), 0);
        if (sum <= 0 && !Object.values(opts).some((o) => o?.when)) reasons.push(`${npcId}.${dec}: every option has base 0 (would pick at random)`);
      }
      const rules = npc.rules ?? [];
      if (rules.length > 4) reasons.push(`${npcId}: ${rules.length} rules, at most 4`);
      for (const r of rules) {
        for (const c of r.if ?? []) {
          if (c.fact !== undefined && !(c.fact in setup.facts)) reasons.push(`rule uses unknown fact "${c.fact}"`);
          if (c.value !== undefined && !knownValues.includes(c.value)) reasons.push(`rule uses unknown value "${c.value}"`);
        }
        for (const [dec, opt] of Object.entries(r.do ?? {})) {
          if (!spec.decisions[dec]) reasons.push(`rule forces unknown decision "${dec}"`);
          else if (!(opt in spec.decisions[dec].options)) reasons.push(`rule forces unknown option "${dec} = ${opt}"`);
        }
      }
    }
  }
  const { settings, problems } = mergeSettings(cur, update.settings);
  reasons.push(...problems);
  for (const [k, bd] of Object.entries(SETTING_BOUNDS)) {
    const v = settings[k as keyof typeof SETTING_BOUNDS];
    if (v < bd.min || v > bd.max) reasons.push(`settings.${k} = ${v} is outside ${bd.min}–${bd.max}`);
  }
  reasons.push(...checkCover(settings.cover));
  return { reasons, settings };
}

export interface FairnessResult {
  ok: boolean;
  pCandidate: number;
  pCurrent: number;
  n: number;
  reason?: string;
  model: string;
}

/** Stage 2 — fairness via headless simulation with common random numbers. */
export function fairnessCheck(
  cand: { behaviour: BehaviourJson; settings: AgentSettings },
  cur: { behaviour: BehaviourJson; settings: AgentSettings } | { brain: Brain },
  habit: Habit,
  opts: { n?: number; seed?: number; round?: number; values?: Record<string, number> } = {},
): FairnessResult {
  const n = opts.n ?? 120;
  const seed = opts.seed ?? 12345;
  const player: ScriptedPlayer = habitModel(habit);
  const run = (mk: (rng: () => number) => Brain) => {
    const rng = mulberry32(seed);
    const brain = mk(rng);
    let w = 0;
    for (let i = 0; i < n; i++) if (simulateRound({ brain, player, round: opts.round ?? 2, rng }).winner === "blue") w++;
    return w / n;
  };
  const values = opts.values ?? {};
  const pCandidate = run((rng) => makeAdaptiveBrain({ behaviour: cand.behaviour, settings: cand.settings, rng, getValues: () => values }));
  const pCurrent = run((rng) => ("brain" in cur ? cur.brain : makeAdaptiveBrain({ behaviour: cur.behaviour, settings: cur.settings, rng, getValues: () => values })));
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const inBand = pCandidate >= FAIR_BAND.lo && pCandidate <= FAIR_BAND.hi;
  const dCand = Math.abs(pCandidate - 0.5);
  const dCur = Math.abs(pCurrent - 0.5);
  let reason: string | undefined;
  if (dCand > dCur + 0.02)
    reason = `worse at countering the habit than the current behaviour: predicted player win-rate ${pct(pCandidate)} vs ${pct(pCurrent)} now (target 50%)`;
  else if (!inBand) reason = `predicted player win-rate ${pct(pCandidate)} is outside the ${pct(FAIR_BAND.lo)}–${pct(FAIR_BAND.hi)} fairness band (now ${pct(pCurrent)})`;
  return { ok: !reason, pCandidate, pCurrent, n, reason, model: player.about };
}

export interface CheckLogEntry {
  round: number;
  version: number;
  source: string;
  label: string;
  accepted: boolean;
  stage: "structure" | "fairness" | "ok";
  reasons: string[];
  pCandidate?: number;
  pCurrent?: number;
  ms: number;
}

/**
 * Run the full self-check over a ladder of candidates (strongest first) and
 * return the first that passes. An out-of-band candidate that still moves the
 * prediction clearly toward 50% is kept as a fallback if nothing lands in band.
 */
export function chooseCandidate<C extends { label: string; update: Pick<AgentStrategyUpdateMessage, "behaviour" | "settings" | "version" | "source"> }>(
  candidates: C[],
  ctx: { setup: GameSetupMessage; knownValues: string[]; current: { behaviour: BehaviourJson; settings: AgentSettings }; habit: Habit; round: number; n?: number; seed?: number; now?: () => number; values?: Record<string, number> },
): { chosen: (C & { settings: AgentSettings; fairness: FairnessResult }) | null; log: CheckLogEntry[] } {
  const now = ctx.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const log: CheckLogEntry[] = [];
  let fallback: (C & { settings: AgentSettings; fairness: FairnessResult }) | null = null;
  let fallbackIdx = -1;
  for (const c of candidates) {
    const t0 = now();
    const s = validateStructure(c.update, ctx.setup, ctx.knownValues, ctx.current.settings);
    const base = { round: ctx.round, version: c.update.version, source: c.update.source, label: c.label };
    if (s.reasons.length) {
      log.push({ ...base, accepted: false, stage: "structure", reasons: s.reasons, ms: now() - t0 });
      continue;
    }
    const f = fairnessCheck({ behaviour: c.update.behaviour, settings: s.settings }, ctx.current, ctx.habit, { n: ctx.n, seed: ctx.seed, round: ctx.round + 1, values: ctx.values });
    const entry: CheckLogEntry = { ...base, accepted: f.ok, stage: f.ok ? "ok" : "fairness", reasons: f.reason ? [f.reason] : [], pCandidate: f.pCandidate, pCurrent: f.pCurrent, ms: now() - t0 };
    log.push(entry);
    if (f.ok) return { chosen: { ...c, settings: s.settings, fairness: f }, log };
    const improves = Math.abs(f.pCandidate - 0.5) < Math.abs(f.pCurrent - 0.5) - 0.05;
    if (improves && (!fallback || Math.abs(f.pCandidate - 0.5) < Math.abs(fallback.fairness.pCandidate - 0.5))) {
      fallback = { ...c, settings: s.settings, fairness: f };
      fallbackIdx = log.length - 1;
    }
  }
  if (fallback) {
    log[fallbackIdx] = { ...log[fallbackIdx], accepted: true, stage: "ok", reasons: [`accepted as best available: still outside the band but closer to 50% (${log[fallbackIdx].reasons[0]})`] };
  }
  return { chosen: fallback, log };
}
