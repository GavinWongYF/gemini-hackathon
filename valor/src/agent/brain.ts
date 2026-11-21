// ─────────────────────────────────────────────────────────────────────────
// brain.ts — SHARED CONTRACT between the enemy team AI (src/game) and the
// adaptive agent system (src/agent). The game NEVER hard-codes enemy choices:
// every enemy decision goes through `decide()`, and every tunable comes from
// `getSettings()`. The agent bridge swaps the behaviour in BETWEEN ROUNDS.
//
// Mirrors docs/agent-protocol (API_CONTRACT_V2.md + Ethan's agentProtocol.ts):
// decisions/options are the names declared in VALOR's `setup`; `pick()` is the
// same rules-then-weighted-random function the tennis game uses.
//
// Default implementation below = the BASELINE (fixed behaviour, no adaptation).
// src/agent/ replaces it via `setBrain()` with the adaptive one.
// ─────────────────────────────────────────────────────────────────────────

/** Enemy decisions (keys) and their legal options. Names are part of `setup`. */
export const DECISIONS = {
  /** Where an enemy holds/patrols this round. */
  position: ["hold_mid", "watch_left_flank", "watch_right_flank", "push_forward", "hold_cover"],
  /** Which target an enemy prefers when several are visible. */
  target: ["nearest", "player_first", "weakest"],
  /** How an enemy fights once engaged. */
  style: ["stand_and_shoot", "strafe_and_shoot", "retreat_to_cover"],
} as const;

export type DecisionName = keyof typeof DECISIONS;
export type OptionOf<D extends DecisionName> = (typeof DECISIONS)[D][number];

/** Things an enemy can check at the moment it decides (rules can only use these). */
export interface Facts {
  round: number;
  enemy_index: number; // 0..2 — which red bot is deciding
  player_zone: "left" | "mid" | "right" | "unknown";
  player_in_open: boolean;
  allies_alive: number; // red team alive
  opponents_alive: number; // blue team alive
}

/** Match settings the agents may change between rounds (not an NPC choice). */
export interface MatchSettings {
  enemy_accuracy: number; // 0.15..0.7  base hit chance
  enemy_reaction_sec: number; // 0.4..1.6
  enemy_damage: number; // 6..20 per hit
  /** Extra cover objects the agents add to the map, e.g. after "died running into the open". */
  cover: Array<{ kind: "tree" | "crate" | "wall"; x: number; z: number; yaw?: number }>;
}

export const BASELINE_SETTINGS: MatchSettings = {
  enemy_accuracy: 0.4,
  enemy_reaction_sec: 1.0,
  enemy_damage: 10,
  cover: [],
};

export interface Brain {
  decide<D extends DecisionName>(decision: D, legal: readonly OptionOf<D>[], facts: Facts): { choice: OptionOf<D>; byRule: boolean };
  getSettings(): MatchSettings;
  /** Short line for the HUD ("Watching your left flank — you won 2 rounds there"). */
  getCallout(): string | null;
}

/** Baseline: always the same, never adapts. */
const baselineBrain: Brain = {
  decide(decision, legal) {
    const preferred: Record<DecisionName, string> = { position: "hold_mid", target: "nearest", style: "strafe_and_shoot" };
    const want = preferred[decision] as (typeof legal)[number];
    return { choice: legal.includes(want) ? want : legal[0], byRule: false };
  },
  getSettings: () => BASELINE_SETTINGS,
  getCallout: () => null,
};

let active: Brain = baselineBrain;
export const getBrain = (): Brain => active;
export const setBrain = (b: Brain | null) => {
  active = b ?? baselineBrain;
};
export { baselineBrain };
