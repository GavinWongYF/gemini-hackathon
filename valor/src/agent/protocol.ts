// ─────────────────────────────────────────────────────────────────────────
// protocol.ts — the game↔agent wire types (API_CONTRACT_V2 / Ethan's
// docs/agent-protocol/agentProtocol.ts) and the contract's exact `pick()`.
//
// PURE TypeScript: no DOM / React / three imports, so the same code runs in the
// browser (AgentBridge) and in Node (scripts/proof/run.ts, vitest).
// ─────────────────────────────────────────────────────────────────────────

export type MatchMode = "live" | "practice" | "replay";

// ── Behaviour JSON ───────────────────────────────────────────────────────
export interface BehaviourOption {
  base: number;
  when?: Record<string, number>;
}
export interface BehaviourCondition {
  fact?: string;
  value?: string;
  is?: string | number | boolean;
  in?: Array<string | number | boolean>;
  above?: number;
  below?: number;
}
export interface BehaviourRule {
  if: BehaviourCondition[];
  do: Record<string, string>;
  why?: string;
}
export interface BehaviourNpc {
  decisions: Record<string, Record<string, BehaviourOption>>;
  rules: BehaviourRule[];
}
export interface BehaviourJson {
  version: number;
  npcs: Record<string, BehaviourNpc>;
}

// ── Setup ────────────────────────────────────────────────────────────────
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
  /** A single option, or a LIST of options when `max_picks` is set. */
  now: string | string[];
  /** VALOR extension: the setting takes a LIST of up to `max_picks` options (cover spots). */
  max_picks?: number;
}
export type SetupSettingSpec = SetupRangeSetting | SetupOptionsSetting;

export interface GameSetupMessage {
  type: "setup";
  match_id: string;
  game: string;
  about: string;
  mode: MatchMode;
  goal: string;
  plan: { rounds: number; break_every: number; break_seconds: number; update_seconds?: number };
  lists?: Record<string, string[]>;
  npcs: Record<string, SetupNpcSpec>;
  events: Record<string, SetupEventSpec>;
  facts: Record<string, SetupFieldSchema>;
  views: Record<string, string>;
  settings: Record<string, SetupSettingSpec>;
  practice?: { players?: Record<string, { about: string }>; stand_in?: boolean };
  default_behaviour?: BehaviourJson;
}

// ── Game → agents ────────────────────────────────────────────────────────
export type EventData = Record<string, string | number | boolean | null | undefined>;
export interface GameEventMessage {
  type: "event";
  match_id: string;
  name: string;
  round: number;
  t: number;
  by: string;
  data: EventData;
  picked?: Record<string, string>;
  by_rule?: string[];
}
export interface GameFramesMessage {
  type: "frames";
  match_id: string;
  round: number;
  t: number;
  views: Record<string, { mime_type: "image/jpeg"; data: string }>;
}
export interface GameRoundEndMessage {
  type: "round_end";
  match_id: string;
  round: number;
  t: number;
  winner: string; // "player" | "red" | "none"
  how: string;
  stats?: Record<string, number>;
  score: Record<string, number>;
  break: boolean;
}
export interface GamePracticeResultMessage {
  type: "practice_result";
  match_id: string;
  player: string;
  rounds: number;
  stats: Record<string, number>;
}
export type GameToAgentMessage = GameSetupMessage | GameEventMessage | GameFramesMessage | GameRoundEndMessage | GamePracticeResultMessage;

// ── Agents → game ────────────────────────────────────────────────────────
export interface AgentReadyMessage {
  type: "ready";
  match_id: string;
  values: Record<string, { label: string }>;
  behaviour: BehaviourJson;
}
export interface AgentPlayerReadMessage {
  type: "player_read";
  match_id: string;
  round: number;
  t: number;
  values: Record<string, number>;
  based_on_events: number;
  why: string;
  picture_note?: string;
}
export interface StrategyChangeMsg {
  where: string;
  from: unknown;
  to: unknown;
  why: string;
}
export interface AgentStrategyUpdateMessage {
  type: "strategy_update";
  match_id: string;
  version: number;
  source: "quick" | "full";
  observations: string[];
  plan: string[];
  changes: StrategyChangeMsg[];
  new_values?: Record<string, { label: string }>;
  settings?: Record<string, unknown>;
  behaviour: BehaviourJson;
}
export interface AgentErrorMessage {
  type: "error";
  match_id?: string;
  message: string;
}
export type AgentToGameMessage = AgentReadyMessage | AgentPlayerReadMessage | AgentStrategyUpdateMessage | AgentErrorMessage;

// ── pick() — exact port of the contract (and of agentProtocol.ts) ───────
export type FactsBag = Record<string, string | number | boolean | undefined>;

export interface PickResult<T extends string = string> {
  choice: T;
  byRule: boolean;
  ruleWhy?: string;
  scores: Record<string, number>;
}

export function holds(cond: BehaviourCondition, values: Record<string, number>, facts: FactsBag): boolean {
  const x = cond.value !== undefined ? (values[cond.value] ?? 0) : cond.fact !== undefined ? facts[cond.fact] : undefined;
  if (cond.is !== undefined) return x === cond.is;
  if (Array.isArray(cond.in)) return x !== undefined && x !== null && (cond.in as unknown[]).includes(x);
  if (x === undefined || x === null || typeof x !== "number") return false;
  if (cond.above !== undefined) return x > cond.above;
  if (cond.below !== undefined) return x < cond.below;
  return false;
}

/**
 * The contract's `pick()`:
 *  1. the first rule whose conditions all hold and whose `do[decision]` is legal decides;
 *  2. otherwise every legal option scores base + Σ weight×value (values default 0),
 *     clamped ≥ 0, and one is drawn in proportion to the scores (uniform if all 0).
 */
export function pick<T extends string>(
  npc: string,
  decision: string,
  legal: readonly T[],
  behaviour: BehaviourJson | null | undefined,
  values: Record<string, number> = {},
  facts: FactsBag = {},
  rng: () => number = Math.random,
): PickResult<T> {
  if (legal.length === 0) return { choice: "" as T, byRule: false, scores: {} };
  const mine = behaviour?.npcs?.[npc];
  if (!mine) {
    const idx = Math.min(legal.length - 1, Math.floor(rng() * legal.length));
    return { choice: legal[idx], byRule: false, scores: {} };
  }
  const legalSet = new Set<string>(legal);
  for (const rule of Array.isArray(mine.rules) ? mine.rules : []) {
    const choice = rule?.do?.[decision];
    const conds = Array.isArray(rule?.if) ? rule.if : [];
    if (choice && legalSet.has(choice) && conds.every((c) => holds(c, values, facts))) {
      return { choice: choice as T, byRule: true, ruleWhy: rule.why, scores: { [choice]: 1 } };
    }
  }
  const options = mine.decisions?.[decision] ?? {};
  const scores: Record<string, number> = {};
  const weights: number[] = [];
  let total = 0;
  for (const name of legal) {
    const opt = options[name];
    let s = typeof opt?.base === "number" && Number.isFinite(opt.base) ? opt.base : 0;
    for (const [v, w] of Object.entries(opt?.when ?? {})) {
      if (typeof w === "number" && Number.isFinite(w)) s += w * (values[v] ?? 0);
    }
    const c = Math.max(s, 0);
    scores[name] = c;
    weights.push(c);
    total += c;
  }
  if (total <= 0) {
    const idx = Math.min(legal.length - 1, Math.floor(rng() * legal.length));
    return { choice: legal[idx], byRule: false, scores };
  }
  let r = rng() * total;
  let last = legal.length - 1;
  for (let i = 0; i < legal.length; i++) {
    if (weights[i] > 0) {
      last = i;
      if (r < weights[i]) return { choice: legal[i], byRule: false, scores };
      r -= weights[i];
    }
  }
  return { choice: legal[last], byRule: false, scores };
}

/** Deterministic seeded RNG (mulberry32) — used by the sim, the self-check and tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const deepClone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
