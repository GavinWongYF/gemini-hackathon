// Single-entry-point AI opponent brain.
// Every opponent choice flows through Felix & Gavin's `pick()` function in one place,
// supporting both live 60 FPS browser play and deterministic headless practice/proof runs.

import type {
  AgentStrategyUpdateMessage,
  BehaviourJson,
  CourtZone,
  StrategyVisualCue,
} from '@shared/contracts';
import {
  DEFAULT_TENNIS_BEHAVIOUR,
  TENNIS_AI_AIM_OPTIONS,
  TENNIS_AI_ANTICIPATE_OPTIONS,
  TENNIS_AI_POSITION_OPTIONS,
  TENNIS_AI_SHOT_TYPES,
  TENNIS_SETTINGS_BOUNDS,
  courtZoneToTarget,
  pick,
  type OpponentAimChoice,
  type OpponentAnticipateChoice,
  type OpponentPositionChoice,
  type OpponentShotChoice,
  type TennisFacts,
} from '@shared/agentProtocol';

export interface OpponentAnticipationOutput {
  move: OpponentAnticipateChoice;
  byRule: boolean;
  ruleWhy?: string;
}

export interface OpponentSettings {
  opponent_speed: number;
}

export interface OpponentDecisionOutput {
  picked: {
    shot_type: OpponentShotChoice;
    aim: OpponentAimChoice;
    position: OpponentPositionChoice;
  };
  byRule: Array<'shot_type' | 'aim' | 'position'>;
  ruleReasons: string[];
  targetCoords: { x: number; z: number };
  recoveryCoords: { x: number; z: number };
  shotSpeedMul: number;
  opponentSpeedMul: number;
  visualCue: StrategyVisualCue;
  /** What the baseline (unchanged) opponent would prefer for dashboard contrast */
  baselineTopChoice: {
    shot_type: OpponentShotChoice;
    aim: OpponentAimChoice;
  };
}

export interface LegalDecisionFilter {
  shot_type?: readonly OpponentShotChoice[];
  aim?: readonly OpponentAimChoice[];
  position?: readonly OpponentPositionChoice[];
}

const SHOT_SPEED_MULTIPLIERS: Record<OpponentShotChoice, number> = {
  flat: 1.0,
  topspin: 1.0,
  slice: 1.0,
  dropshot: 1.0,
  lob: 1.0,
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class OpponentBrain {
  private baselineBehaviour: BehaviourJson;
  private activeBehaviour: BehaviourJson;
  private pendingBehaviour: BehaviourJson | null = null;

  private activeSettings: OpponentSettings = {
    opponent_speed: TENNIS_SETTINGS_BOUNDS.opponent_speed.default,
  };
  private pendingSettings: Partial<OpponentSettings> | null = null;

  private latestValues: Record<string, number> = {};
  private rng: () => number;

  constructor(initialBehaviour: BehaviourJson = DEFAULT_TENNIS_BEHAVIOUR, rng: () => number = Math.random) {
    this.baselineBehaviour = structuredClone(initialBehaviour);
    this.activeBehaviour = structuredClone(initialBehaviour);
    this.rng = rng;
  }

  /** Reset brain back to baseline behaviour, default settings, and empty values for a new match. */
  resetToBaseline() {
    this.activeBehaviour = structuredClone(this.baselineBehaviour);
    this.pendingBehaviour = null;
    this.activeSettings = {
      opponent_speed: TENNIS_SETTINGS_BOUNDS.opponent_speed.default,
    };
    this.pendingSettings = null;
    this.latestValues = {};
  }

  /** Set the initial version-1 behaviour received in `ready` (before round 1). */
  applyReadyBehaviour(behaviour: BehaviourJson) {
    this.activeBehaviour = structuredClone(behaviour);
    this.pendingBehaviour = null;
  }

  /** Update latest smoothed player habit values from `player_read` (takes effect on next pick). */
  updatePlayerValues(values: Record<string, number>) {
    this.latestValues = { ...values };
  }

  /**
   * Queue a new behaviour/settings from `strategy_update`.
   * Per Notion API Design: NEVER swap mid-round — call `applyPendingBetweenRounds()` before the next serve.
   */
  queueStrategyUpdate(update: Pick<AgentStrategyUpdateMessage, 'behaviour' | 'settings'>) {
    if (update.behaviour) {
      this.pendingBehaviour = structuredClone(update.behaviour);
    }
    if (update.settings && typeof update.settings.opponent_speed === 'number') {
      this.pendingSettings = {
        ...this.pendingSettings,
        opponent_speed: clamp(
          update.settings.opponent_speed,
          TENNIS_SETTINGS_BOUNDS.opponent_speed.min,
          TENNIS_SETTINGS_BOUNDS.opponent_speed.max,
        ),
      };
    }
  }

  /** Apply any queued behaviour & settings between rounds (never mid-rally). Returns true if swapped. */
  applyPendingBetweenRounds(): boolean {
    let changed = false;
    if (this.pendingBehaviour) {
      this.activeBehaviour = this.pendingBehaviour;
      this.pendingBehaviour = null;
      changed = true;
    }
    if (this.pendingSettings) {
      if (typeof this.pendingSettings.opponent_speed === 'number') {
        this.activeSettings.opponent_speed = this.pendingSettings.opponent_speed;
      }
      this.pendingSettings = null;
      changed = true;
    }
    return changed;
  }

  getActiveBehaviour(): BehaviourJson {
    return this.activeBehaviour;
  }

  getBaselineBehaviour(): BehaviourJson {
    return this.baselineBehaviour;
  }

  getSettings(): OpponentSettings {
    return { ...this.activeSettings };
  }

  getLatestValues(): Record<string, number> {
    return { ...this.latestValues };
  }

  /**
   * Called at `swing_start` (~100-160ms before ball contact) so the opponent can read
   * pre-swing tells (`swing_early_guess`, `swing_backswing`, `swing_side`, `swing_arm_zone`)
   * and start moving immediately with zero network delay!
   */
  decideAnticipation(
    facts: TennisFacts,
    legal: readonly OpponentAnticipateChoice[] = TENNIS_AI_ANTICIPATE_OPTIONS,
  ): OpponentAnticipationOutput {
    const res = pick(
      'opponent',
      'anticipate',
      legal,
      this.activeBehaviour,
      this.latestValues,
      facts,
      this.rng,
    );
    return {
      move: res.choice,
      byRule: res.byRule,
      ruleWhy: res.ruleWhy,
    };
  }

  /**
   * THE SINGLE PLACE where the opponent chooses shot_type, aim, and recovery position.
   * Calls Felix & Gavin's exact `pick()` algorithm for all three decisions.
   */
  decideShot(facts: TennisFacts, legal?: LegalDecisionFilter): OpponentDecisionOutput {
    const legalShots = legal?.shot_type ?? TENNIS_AI_SHOT_TYPES;
    const legalAims = legal?.aim ?? TENNIS_AI_AIM_OPTIONS;
    const legalPositions = legal?.position ?? TENNIS_AI_POSITION_OPTIONS;

    const shotRes = pick(
      'opponent',
      'shot_type',
      legalShots,
      this.activeBehaviour,
      this.latestValues,
      facts,
      this.rng,
    );
    const aimRes = pick(
      'opponent',
      'aim',
      legalAims,
      this.activeBehaviour,
      this.latestValues,
      facts,
      this.rng,
    );
    const posRes = pick(
      'opponent',
      'position',
      legalPositions,
      this.activeBehaviour,
      this.latestValues,
      facts,
      this.rng,
    );

    const byRule: Array<'shot_type' | 'aim' | 'position'> = [];
    const ruleReasons: string[] = [];
    if (shotRes.byRule) {
      byRule.push('shot_type');
      if (shotRes.ruleWhy) ruleReasons.push(shotRes.ruleWhy);
    }
    if (aimRes.byRule) {
      byRule.push('aim');
      if (aimRes.ruleWhy) ruleReasons.push(aimRes.ruleWhy);
    }
    if (posRes.byRule) {
      byRule.push('position');
      if (posRes.ruleWhy) ruleReasons.push(posRes.ruleWhy);
    }

    const targetCoords = this.computeTargetCoords(shotRes.choice, aimRes.choice);
    const recoveryCoords = courtZoneToTarget(posRes.choice as CourtZone, 'opponent', 0.2, this.rng);

    const visualCue = this.deriveVisualCue(shotRes.choice, posRes.choice);
    const baselineTopChoice = {
      shot_type: this.topOptionByBase(this.baselineBehaviour, 'shot_type', legalShots),
      aim: this.topOptionByBase(this.baselineBehaviour, 'aim', legalAims),
    };

    return {
      picked: {
        shot_type: shotRes.choice,
        aim: aimRes.choice,
        position: posRes.choice,
      },
      byRule,
      ruleReasons,
      targetCoords,
      recoveryCoords,
      shotSpeedMul: SHOT_SPEED_MULTIPLIERS[shotRes.choice],
      opponentSpeedMul: this.activeSettings.opponent_speed,
      visualCue,
      baselineTopChoice,
    };
  }

  private computeTargetCoords(shotType: OpponentShotChoice, aim: OpponentAimChoice): { x: number; z: number } {
    // Dropshots always land short on the human half; lobs always land deep
    let effectiveZone: CourtZone = aim;
    if (shotType === 'dropshot' && aim.endsWith('_deep')) {
      effectiveZone = aim.replace('_deep', '_short') as CourtZone;
    } else if (shotType === 'lob' && aim.endsWith('_short')) {
      effectiveZone = aim.replace('_short', '_deep') as CourtZone;
    }
    const base = courtZoneToTarget(effectiveZone, 'human', 0.4, this.rng);
    // Calibrated solo readable landing depths (keeps `lands` zone contract: <7.0 = short, >=7.0 = deep!)
    if (shotType === 'dropshot') {
      base.z = 4.85 + this.rng() * 0.65; // 4.85..5.50m (short, returnable on sprint!)
    } else if (shotType === 'slice') {
      base.z = effectiveZone.endsWith('_short') ? 5.6 + this.rng() * 0.7 : 7.15 + this.rng() * 0.55;
    } else if (shotType === 'lob') {
      base.z = 8.6 + this.rng() * 1.1;
    } else if (effectiveZone.endsWith('_deep')) {
      base.z = 7.25 + this.rng() * 0.85; // 7.25..8.10m: low arc + generous post-bounce glide to baseline!
    } else {
      base.z = 5.6 + this.rng() * 0.8;
    }
    return base;
  }

  private deriveVisualCue(
    shotType: OpponentShotChoice,
    position: OpponentPositionChoice,
  ): StrategyVisualCue {
    if (position === 'middle_short') return 'net_rush';
    if (shotType === 'slice' || shotType === 'dropshot') return 'slice_trap';
    if (shotType === 'flat') return 'aggressive';
    if (shotType === 'lob') return 'defensive_wall';
    return 'balanced';
  }

  private topOptionByBase<T extends string>(
    behaviour: BehaviourJson,
    decision: string,
    legal: readonly T[],
  ): T {
    const opts = behaviour.npcs?.opponent?.decisions?.[decision] ?? {};
    let best = legal[0];
    let bestScore = -Infinity;
    for (const opt of legal) {
      const score = opts[opt]?.base ?? 0;
      if (score > bestScore) {
        bestScore = score;
        best = opt;
      }
    }
    return best;
  }
}
