// adaptiveBrain.ts — a `Brain` (brain.ts contract) driven by a behaviour JSON.
// Every enemy choice goes through the contract's exact `pick()`. The behaviour
// and settings are FIXED for the lifetime of one brain (= one round); only the
// player_read values may change mid-round (the contract allows that).

import type { Brain, DecisionName, Facts, OptionOf } from "./brain";
import { pick, type BehaviourJson, type FactsBag } from "./protocol";
import { RED, toMatchSettings, type AgentSettings } from "./setup";

export interface AdaptiveBrainInit {
  behaviour: BehaviourJson;
  settings: AgentSettings;
  callout?: string | null;
  /** Latest player_read values (read at every decision). */
  getValues?: () => Record<string, number>;
  rng?: () => number;
  /** Called after every decision (for `picked` / `by_rule` on events and the HUD). */
  onPick?: (decision: DecisionName, choice: string, byRule: boolean, facts: Facts) => void;
}

/** Facts → the bag `pick()` reads. Booleans become 0/1 to match the setup's declared ranges. */
export function factsBag(f: Facts): FactsBag {
  return {
    round: f.round,
    enemy_index: f.enemy_index,
    player_zone: f.player_zone,
    player_in_open: f.player_in_open ? 1 : 0,
    allies_alive: f.allies_alive,
    opponents_alive: f.opponents_alive,
  };
}

export function makeAdaptiveBrain(init: AdaptiveBrainInit): Brain {
  const settings = toMatchSettings(init.settings);
  const rng = init.rng ?? Math.random;
  const getValues = init.getValues ?? (() => ({}));
  return {
    decide<D extends DecisionName>(decision: D, legal: readonly OptionOf<D>[], facts: Facts) {
      const r = pick(RED, decision, legal, init.behaviour, getValues(), factsBag(facts), rng);
      const choice = (legal.includes(r.choice) ? r.choice : legal[0]) as OptionOf<D>;
      init.onPick?.(decision, choice, r.byRule, facts);
      return { choice, byRule: r.byRule };
    },
    getSettings: () => settings,
    getCallout: () => init.callout ?? null,
  };
}
