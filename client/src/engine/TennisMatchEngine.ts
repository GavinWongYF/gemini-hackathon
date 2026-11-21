// Pure-TypeScript Tennis Match, Rally & Scoring Engine
// Drives BOTH:
//   1. Browser 60 FPS live play (mutating Akhil's `MatchRenderState` ref + consuming Ethan's M5/Webcam hardware)
//   2. Node headless `practice_run` simulation (1000x real-time, zero DOM/React/Three.js imports)
//
// Single AI decision point: every opponent shot calls `OpponentBrain.decideShot()` -> Felix & Gavin's `pick()`.

import {
  COURT,
  type AiShotType,
  type ArmZone,
  type AvatarAnimState,
  type CourtZone,
  type HumanShotType,
  type MatchPhase,
  type MatchRenderState,
  type PlayerControlState,
  type PlayerSwingEvent,
  type PlayerSwingStartEvent,
  type RecordedShot,
  type ShotTiming,
  type StrategyVisualCue,
  type StrokeWing,
  type TrajectoryPoint,
} from '@shared/contracts';
import {
  armZoneToPlayerCourtZone,
  coordsToCourtZone,
  type GameEventMessage,
  type GameRoundEndMessage,
  type OpponentAimChoice,
  type OpponentShotChoice,
  type TennisFacts,
} from '@shared/agentProtocol';
import { OpponentBrain, type OpponentDecisionOutput } from '../ai/OpponentBrain';
import {
  BallFlightEngine,
  PHYSICS,
  isInsidePaintedCourt,
  solveShotLaunch,
  type AnyShotType,
} from './BallFlightEngine';

export interface EngineEventSink {
  onAgentEvent?: (event: Omit<GameEventMessage, 'type' | 'match_id'>) => void;
  onAgentRoundEnd?: (roundEnd: Omit<GameRoundEndMessage, 'type' | 'match_id'>) => void;
  onShotRecorded?: (shot: RecordedShot) => void;
  onPhaseChange?: (phase: MatchPhase) => void;
}

export interface TennisMatchOptions {
  totalDemoPoints?: number;
  breakEvery?: number;
  /** Pause duration (seconds) after point_over before auto-starting next serve (0 in headless) */
  pointOverPauseSec?: number;
  /** Serve windup duration (seconds) */
  serveWindupSec?: number;
  /** Whether to pause in `demo_pause` phase every `breakEvery` points (false in headless practice) */
  enableDemoPauses?: boolean;
  /** Deterministic PRNG for headless practice & proof reproducibility */
  rng?: () => number;
  sink?: EngineEventSink;
}

export interface LastOpponentShotContext {
  shotType: OpponentShotChoice;
  aim: OpponentAimChoice;
  landingX: number;
  landingZ: number;
}

export interface ReturnContactAssessment {
  reachable: boolean;
  quality: number; // 0..1
  lateralGap: number;
  depthGap: number;
  forcedErrorProb: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function createInitialMatchRenderState(totalDemoPoints = 0): MatchRenderState {
  return {
    ball: {
      x: 0,
      y: 1.05,
      z: COURT.PLAYER_START_Z - 0.6,
      vx: 0,
      vy: 0,
      vz: 0,
      active: false,
      bounceCount: 0,
      shotType: 'topspin',
      landingMarker: null,
    },
    player: {
      x: 0,
      z: COURT.PLAYER_START_Z,
      vx: 0,
      vz: 0,
      facingYaw: Math.PI,
      animState: 'idle',
      swingSide: 'forehand',
      swingTriggerId: 0,
      swingShotType: 'topspin',
    },
    opponent: {
      x: 0,
      z: COURT.AI_START_Z,
      vx: 0,
      vz: 0,
      facingYaw: 0,
      animState: 'idle',
      swingSide: 'forehand',
      swingTriggerId: 0,
      swingShotType: 'topspin',
      strategyVisualCue: 'balanced',
    },
    phase: 'ready',
    score: {
      humanPoints: 0,
      aiPoints: 0,
      pointIndex: 1,
      totalDemoPoints,
      lastCall: 'READY',
    },
    replayArcs: [],
  };
}

export class TennisMatchEngine {
  readonly ballEngine = new BallFlightEngine();
  readonly brain: OpponentBrain;

  private renderState: MatchRenderState;
  private opts: Required<Omit<TennisMatchOptions, 'sink' | 'rng'>>;
  private rng: () => number;
  private sink: EngineEventSink;

  // Time & fixed-step accumulator
  private accumulator = 0;
  private matchTimeSec = 0;
  private pointTimeSec = 0;
  private phaseTimerSec = 0;

  // Rally state
  private hitter: 'human' | 'ai' = 'ai';
  private rallyShotCount = 0;
  private pendingOpponentDecision: OpponentDecisionOutput | null = null;
  private opponentTargetPos: { x: number; z: number } = { x: 0, z: COURT.AI_START_Z };
  private opponentHitScheduled = false;
  private opponentReactionDelaySec = 0;
  private opponentAnticipatedMove: string = 'stay';
  private lastHumanShotQuality = 0.7;
  private lastOpponentShot: LastOpponentShotContext | null = null;

  // Player live hardware mirror & latest swing_start features (shared across all picks)
  private playerArmZone: ArmZone = 'center';
  private playerArmX = 0;
  private playerWing: StrokeWing = 'forehand';
  private playerLastSide: StrokeWing = 'forehand';
  private playerLastShotType: HumanShotType = 'topspin';
  private playerHomeZ: number = COURT.PLAYER_START_Z;
  private playerLastSwingStart: {
    earlyGuess: HumanShotType;
    backswing: number;
    initialSpeed: number;
    side: StrokeWing;
    armZone: ArmZone;
  } = {
    earlyGuess: 'topspin',
    backswing: 0.5,
    initialSpeed: 0.5,
    side: 'forehand',
    armZone: 'center',
  };

  // Recorded shots & arcs for dashboard / replay
  private activeShotArc: TrajectoryPoint[] = [];
  private activeShotRecord: RecordedShot | null = null;
  private shotHistory: RecordedShot[] = [];
  private shotSeq = 0;

  constructor(brain: OpponentBrain, options: TennisMatchOptions = {}) {
    this.brain = brain;
    this.opts = {
      totalDemoPoints: options.totalDemoPoints ?? 0,
      breakEvery: options.breakEvery ?? 0,
      pointOverPauseSec: options.pointOverPauseSec ?? 1.4,
      serveWindupSec: options.serveWindupSec ?? 0.65,
      enableDemoPauses: options.enableDemoPauses ?? false,
    };
    this.rng = options.rng ?? Math.random;
    this.sink = options.sink ?? {};
    this.renderState = createInitialMatchRenderState(this.opts.totalDemoPoints);
  }

  getRenderState(): MatchRenderState {
    return this.renderState;
  }

  getShotHistory(): RecordedShot[] {
    return this.shotHistory;
  }

  getLastOpponentShot(): LastOpponentShotContext | null {
    return this.lastOpponentShot;
  }

  getCurrentRallyShotCount(): number {
    return this.rallyShotCount;
  }

  getMatchTimeSec(): number {
    return this.matchTimeSec;
  }

  /** Copies live state into Akhil's `matchStateRef.current` without allocating React state. */
  syncToRenderState(target: MatchRenderState) {
    Object.assign(target.ball, this.renderState.ball);
    Object.assign(target.player, this.renderState.player);
    Object.assign(target.opponent, this.renderState.opponent);
    target.phase = this.renderState.phase;
    Object.assign(target.score, this.renderState.score);
    target.replayArcs = this.renderState.replayArcs;
  }

  /** Resets court and score into `ready` waiting state before `ready` arrives from the server. */
  resetToReady() {
    this.matchTimeSec = 0;
    this.pointTimeSec = 0;
    this.phaseTimerSec = 0;
    this.rallyShotCount = 0;
    this.shotHistory = [];
    this.shotSeq = 0;
    this.activeShotArc = [];
    this.activeShotRecord = null;
    this.opponentHitScheduled = false;
    this.pendingOpponentDecision = null;
    this.lastOpponentShot = null;
    this.renderState = createInitialMatchRenderState(this.opts.totalDemoPoints);
    this.renderState.score.lastCall = 'WAITING FOR READY';
    this.sink.onPhaseChange?.('ready');
  }

  /** Starts a fresh match from point 1. */
  startMatch() {
    this.matchTimeSec = 0;
    this.pointTimeSec = 0;
    this.shotHistory = [];
    this.shotSeq = 0;
    this.renderState = createInitialMatchRenderState(this.opts.totalDemoPoints);
    this.startNextPoint();
  }

  /** Resumes play after `demo_pause` (swapping in any newly arrived agent strategy first). */
  resumeFromDemoPause() {
    if (this.renderState.phase !== 'demo_pause') return;
    const hasPointCap = Number.isFinite(this.opts.totalDemoPoints) && this.opts.totalDemoPoints > 0;
    if (hasPointCap && this.renderState.score.pointIndex > this.opts.totalDemoPoints) {
      this.setPhase('match_over');
      return;
    }
    this.startNextPoint();
  }

  /** Triggers an on-demand demo pause (e.g. presenter hits `P`). */
  triggerManualDemoPause() {
    if (this.renderState.phase === 'rally' || this.renderState.phase === 'serving') {
      this.renderState.replayArcs = this.shotHistory.slice(-8);
      this.setPhase('demo_pause');
    }
  }

  /** Updates player avatar lateral stance from Ethan's M5 + Webcam HardwareInputManager (60Hz). */
  applyPlayerControl(ctrl: PlayerControlState) {
    this.playerArmZone = ctrl.arm.armZone;
    this.playerArmX = ctrl.arm.armX;
    this.playerWing = ctrl.arm.wing;
  }

  /** Allows headless scripted players to position laterally/depth-wise explicitly. */
  setPlayerStance(armZone: ArmZone, armX: number, wing: StrokeWing, z: number = COURT.PLAYER_START_Z) {
    this.playerArmZone = armZone;
    this.playerArmX = clamp(armX, -1, 1);
    this.playerWing = wing;
    this.playerHomeZ = clamp(z, 4.5, 12.2);
  }

  /**
   * Checks whether an incoming ball is currently in the human player's hitting window.
   */
  isBallReturnableByPlayer(): boolean {
    if (this.renderState.phase !== 'rally') return false;
    if (this.hitter !== 'ai') return false;
    const b = this.ballEngine.state;
    if (!b.active || b.bounceCount >= 2) return false;
    // Allow return once ball has crossed to player side (z > 1.5) and is within hitting reach
    if (b.z < 1.5) return false;
    // Either bounced once on human side, or close enough to baseline/net to volley
    if (b.bounceCount === 1) return true;
    return b.z > 5.2 && b.y < 2.2;
  }

  /**
   * Evaluates reach/timing quality for a player swing against the current incoming ball.
   * Ensures named opponent shot choices (`dropshot`, wide `slice`, fast `flat`, deep `lob`)
   * produce a genuine ≥25% difficulty differential depending on player stance & weakness.
   */
  assessPlayerContact(wing: StrokeWing, weaknessPenalty = 0): ReturnContactAssessment {
    const b = this.ballEngine.state;
    const p = this.renderState.player;
    const lateralGap = Math.abs(b.x - p.x);
    const depthGap = Math.abs(b.z - p.z);

    // Effective reach window for a stationary webcam player with lateral arm reach + step-in assist.
    // Neutral rally balls are very returnable so the player starts off winning (~65-70% vs baseline);
    // targeted counter-shots (dropshot vs deep player, wide slice to weak backhand) create real stretch!
    const oppShot = this.lastOpponentShot?.shotType ?? 'topspin';
    const maxLateral = oppShot === 'slice' ? 3.2 : oppShot === 'flat' ? 3.45 : 3.95;
    const maxDepth = oppShot === 'dropshot' ? 3.25 : 4.35;

    if (lateralGap > maxLateral + 1.55 || depthGap > maxDepth + 1.5) {
      return { reachable: false, quality: 0, lateralGap, depthGap, forcedErrorProb: 1 };
    }

    const latStress = clamp(Math.max(0, lateralGap - 0.95) / maxLateral, 0, 1);
    const depthStress = clamp(Math.max(0, depthGap - 1.15) / maxDepth, 0, 1);
    const heightStress = oppShot === 'slice' && b.y < 0.32 ? 0.1 : oppShot === 'lob' && b.y > 2.3 ? 0.14 : 0;
    const wingPenalty = wing === 'backhand' ? 0.03 : 0;
    // Alert players already inside the court (< 8.2m) handle dropshots cleanly on the rise!
    const shortCourtBonus = oppShot === 'dropshot' && p.z < 8.2 ? 0.16 : 0;

    const quality = clamp(
      1 + shortCourtBonus - 0.25 * latStress - 0.28 * depthStress - heightStress - wingPenalty - weaknessPenalty,
      0.16,
      1.0,
    );

    // Comfortable shots stay in play reliably (~2.5-3.5 player shots per point); counters create real pressure without 100% free points!
    const forcedErrorProb =
      weaknessPenalty < 0.14 && quality > 0.72
        ? 0.065
        : clamp(0.05 + (1 - quality) * 0.56 + weaknessPenalty * 0.68, 0.065, 0.78);
    return { reachable: true, quality, lateralGap, depthGap, forcedErrorProb };
  }

  /**
   * Handles `swing_start` (~100-160ms BEFORE ball contact):
   *  1. Sends player `swing_start` event to agents (so they learn tells vs actual `shot`).
   *  2. Immediately calls `brain.decideAnticipation()` via `pick("opponent", "anticipate", ...)`
   *     so the opponent starts moving during the windup with zero cloud latency!
   */
  handlePlayerSwingStart(
    swingStart: Pick<
      PlayerSwingStartEvent,
      'earlyGuess' | 'confidence' | 'backswing' | 'initialSpeed' | 'wing' | 'armZone'
    >,
  ) {
    if (this.renderState.phase !== 'rally' || this.hitter !== 'ai' || !this.ballEngine.state.active) {
      return;
    }

    this.sink.onAgentEvent?.({
      name: 'swing_start',
      round: this.renderState.score.pointIndex,
      t: round2(this.matchTimeSec),
      by: 'player',
      data: {
        early_guess: swingStart.earlyGuess,
        confidence: round2(swingStart.confidence),
        backswing: round2(swingStart.backswing),
        initial_speed: round2(swingStart.initialSpeed),
        side: swingStart.wing,
        arm_zone: swingStart.armZone,
      },
    });

    this.playerLastSwingStart = {
      earlyGuess: swingStart.earlyGuess,
      backswing: round2(swingStart.backswing),
      initialSpeed: round2(swingStart.initialSpeed),
      side: swingStart.wing,
      armZone: swingStart.armZone,
    };

    const facts: TennisFacts = this.buildFacts();

    const ant = this.brain.decideAnticipation(facts);
    this.opponentAnticipatedMove = ant.move;

    // Shift opponent target position immediately during player windup!
    const cur = this.opponentTargetPos;
    if (ant.move === 'lean_left') {
      this.opponentTargetPos = { x: clamp(cur.x - 2.6, -4.4, 4.4), z: cur.z };
    } else if (ant.move === 'lean_right') {
      this.opponentTargetPos = { x: clamp(cur.x + 2.6, -4.4, 4.4), z: cur.z };
    } else if (ant.move === 'move_in') {
      this.opponentTargetPos = { x: cur.x, z: -4.8 };
      this.renderState.opponent.strategyVisualCue = 'net_rush';
    } else if (ant.move === 'move_back') {
      this.opponentTargetPos = { x: cur.x, z: -10.6 };
    }

    this.sink.onAgentEvent?.({
      name: 'anticipate',
      round: this.renderState.score.pointIndex,
      t: round2(this.matchTimeSec),
      by: 'opponent',
      picked: { anticipate: ant.move },
      by_rule: ant.byRule ? ['anticipate'] : [],
      data: { move: ant.move },
    });
  }

  /**
   * Handles a discrete player swing (from M5 IMU, Keyboard Space, or Headless Scripted Player).
   * Returns true if the swing connected with the ball.
   */
  handlePlayerSwing(
    swing: Pick<
      PlayerSwingEvent,
      'shotType' | 'wing' | 'armZone' | 'armX' | 'power' | 'rotation' | 'angle' | 'confidence'
    >,
    opts?: {
      /** Optional explicit target zone (used by headless scripted persona) */
      targetZoneOverride?: CourtZone;
      /** Extra weakness penalty (0..0.55) for scripted player weaknesses */
      weaknessPenalty?: number;
      /** Force miss (e.g. scripted player couldn't reach) */
      forceMiss?: boolean;
    },
  ): boolean {
    const p = this.renderState.player;
    const b = this.ballEngine.state;
    const isAirVolley = this.isBallReturnableByPlayer() && b.bounceCount === 0 && b.z < 9.5;
    p.swingSide = swing.wing;
    p.swingShotType = isAirVolley ? 'volley' : swing.shotType;
    p.swingTriggerId += 1;

    if (!this.isBallReturnableByPlayer() || opts?.forceMiss) {
      if (this.renderState.phase === 'rally' && this.hitter === 'ai' && b.active) {
        const missReason: 'unreachable' | 'too_early' | 'too_late' = opts?.forceMiss
          ? 'unreachable'
          : b.z < 1.5
            ? 'too_early'
            : b.bounceCount >= 2 || b.z > p.z + 1.2
              ? 'too_late'
              : 'unreachable';
        this.sink.onAgentEvent?.({
          name: 'missed_swing',
          round: this.renderState.score.pointIndex,
          t: round2(this.matchTimeSec),
          by: 'player',
          data: {
            side: swing.wing,
            arm_zone: swing.armZone,
            shot_type: swing.shotType,
            power: round2(swing.power),
            reason: missReason,
          },
        });
      }
      return false;
    }

    const assessment = this.assessPlayerContact(swing.wing, opts?.weaknessPenalty ?? 0);
    if (!assessment.reachable) {
      this.sink.onAgentEvent?.({
        name: 'missed_swing',
        round: this.renderState.score.pointIndex,
        t: round2(this.matchTimeSec),
        by: 'player',
        data: {
          side: swing.wing,
          arm_zone: swing.armZone,
          shot_type: swing.shotType,
          power: round2(swing.power),
          reason: 'unreachable',
        },
      });
      return false;
    }

    // Compute early / on_time / late relative to ideal strike plane (~0.85m in front of player)
    const idealContactZ = p.z - 0.85;
    const timingOffsetZ = b.z - idealContactZ;
    const timing: ShotTiming =
      timingOffsetZ < -0.65 ? 'early' : timingOffsetZ > 0.55 ? 'late' : 'on_time';

    this.playerLastSide = swing.wing;
    this.playerLastShotType = swing.shotType;
    this.rallyShotCount += 1;

    // Close out opponent's previous shot record
    this.finalizeActiveShot('in_play');

    const contactPos = {
      x: this.ballEngine.state.x,
      y: clamp(this.ballEngine.state.y, 0.55, 1.85),
      z: clamp(this.ballEngine.state.z, 2.0, COURT.BASELINE_Z + 1.2),
    };

    // Decide whether low contact quality causes a realistic forced error (net or slightly wide/long)
    const isForcedError = this.rng() < assessment.forcedErrorProb;
    let targetX: number;
    let targetZ: number;

    if (opts?.targetZoneOverride) {
      const colX = opts.targetZoneOverride.startsWith('left_')
        ? -3.55
        : opts.targetZoneOverride.startsWith('right_')
          ? 3.55
          : 0;
      const depthZ =
        swing.shotType === 'dropshot' || opts.targetZoneOverride.endsWith('_short')
          ? -4.6
          : swing.shotType === 'slice'
            ? -7.5
            : -8.5;
      targetX = colX + (this.rng() * 2 - 1) * 0.5;
      targetZ = depthZ + (this.rng() * 2 - 1) * 0.45;
    } else {
      targetX = clamp(swing.angle * 4.4 + (this.rng() * 2 - 1) * 0.35, -4.85, 4.85);
      const baseDepth =
        swing.shotType === 'dropshot'
          ? -(3.8 + swing.power * 1.4)
          : swing.shotType === 'slice'
            ? -(7.15 + swing.power * 1.05)
            : -(7.4 + swing.power * 1.9);
      targetZ = clamp(baseDepth, -9.6, -3.5);
    }

    let forcedNet = false;
    if (isForcedError) {
      if (this.rng() < 0.52) {
        // Forced error into the net
        forcedNet = true;
        targetZ = -1.2;
      } else {
        // Forced error wide or long
        targetX = (targetX >= 0 ? 1 : -1) * (COURT.PAINTED_HALF_W + 0.85 + this.rng() * 0.8);
        targetZ = -(COURT.BASELINE_Z + 0.7 + this.rng() * 0.9);
      }
    }

    const rpm =
      swing.shotType === 'topspin'
        ? 2100 + Math.max(0, swing.rotation) * 1200
        : swing.shotType === 'slice'
          ? -(1900 + Math.abs(swing.rotation) * 1200)
          : -1400;

    const speedScale = clamp((0.88 + swing.power * 0.26) * (0.8 + 0.2 * assessment.quality), 0.74, 1.15);
    const flightShotType = isAirVolley ? 'volley' : swing.shotType;

    const sol = solveShotLaunch(contactPos, { x: targetX, z: targetZ }, flightShotType, {
      actor: 'human',
      speedScale,
      rpmOverride: isAirVolley ? -350 : rpm,
      allowNetError: forcedNet,
    });

    if (forcedNet) {
      // Lower vy slightly so the ball physically clips the tape
      sol.vy *= 0.45;
    }

    this.ballEngine.launch(
      contactPos,
      { x: sol.vx, y: sol.vy, z: sol.vz },
      { x: sol.wx, y: sol.wy, z: sol.wz },
      swing.shotType,
    );
    this.hitter = 'human';
    this.opponentHitScheduled = false;
    this.pendingOpponentDecision = null;
    this.lastHumanShotQuality = assessment.quality;
    // Opponent split-step reaction delay scales with `opponent_speed` fairness dial (0.65..1.25)
    // Tuned for fast 23-26 m/s player shots (~0.82-0.95s court crossing):
    // - At 0.65: sluggish 0.24s reaction + slower sprint -> corner drives beat it cleanly
    // - At 0.85: balanced 0.12s reaction -> ~55-62% player win against unadapted baseline
    // - At 1.25: crisp 0.03s tour reaction -> tracks down nearly everything!
    const speedMul = this.brain.getSettings().opponent_speed;
    const speedNorm = (speedMul - 0.85) / 0.4; // -0.5 at 0.65, 0 at 0.85, +1.0 at 1.25
    const baseDelay = clamp(0.08 - speedNorm * 0.16 + assessment.quality * 0.03, 0.01, 0.28);
    this.opponentReactionDelaySec =
      this.opponentAnticipatedMove !== 'stay' ? Math.max(0.01, baseDelay * 0.25) : baseDelay;
    this.opponentAnticipatedMove = 'stay';
    this.renderState.ball.landingMarker = null;

    const fromZone = armZoneToPlayerCourtZone(swing.armZone, p.z);
    const otherZone = coordsToCourtZone(this.renderState.opponent.x, this.renderState.opponent.z);
    const landZone = coordsToCourtZone(sol.landingPoint.x, sol.landingPoint.z);
    const expectedResult: 'in' | 'out' | 'net' = forcedNet
      ? 'net'
      : isInsidePaintedCourt(sol.landingPoint.x, sol.landingPoint.z)
        ? 'in'
        : 'out';

    this.beginShotRecord({
      actor: 'human',
      shotType: swing.shotType,
      wing: swing.wing,
      power: swing.power,
      rotation: swing.rotation,
      angle: swing.angle,
      contactPos,
      playerPosAtShot: { x: p.x, z: p.z },
    });

    // Emit Felix & Gavin Draft 2 player `shot` event immediately at contact
    this.sink.onAgentEvent?.({
      name: 'shot',
      round: this.renderState.score.pointIndex,
      t: round2(this.matchTimeSec),
      by: 'player',
      data: {
        rally: this.rallyShotCount,
        side: swing.wing,
        arm_zone: swing.armZone,
        shot_type: swing.shotType,
        power: round2(swing.power),
        rotation: round2(swing.rotation),
        angle: round2(swing.angle),
        confidence: round2(swing.confidence ?? 0.85),
        timing,
        quality: round2(assessment.quality),
        from: fromZone,
        other_position: otherZone,
        lands: landZone,
        result: expectedResult,
      },
    });

    return true;
  }

  /**
   * Advances simulation by `dtSec` (real frame delta in browser, or `PHYSICS.DT` in headless mode).
   */
  step(dtSec: number) {
    this.accumulator += Math.min(dtSec, PHYSICS.DT * 8);
    let ticks = 0;
    while (this.accumulator >= PHYSICS.DT - 1e-9 && ticks < 8) {
      this.stepFixed(PHYSICS.DT);
      this.accumulator -= PHYSICS.DT;
      ticks += 1;
    }
  }

  /** Runs exactly one fixed 1/60s simulation tick (used directly by headless practice mode). */
  stepFixed(dt = PHYSICS.DT) {
    const phase = this.renderState.phase;
    if (phase === 'ready' || phase === 'demo_pause' || phase === 'match_over') {
      return;
    }

    this.matchTimeSec += dt;
    this.pointTimeSec += dt;
    this.phaseTimerSec += dt;

    this.updatePlayerMovement(dt);
    this.updateOpponentMovement(dt);

    if (phase === 'serving') {
      if (this.phaseTimerSec >= this.opts.serveWindupSec) {
        this.launchOpponentServe();
      }
      this.syncBallToRenderState();
      return;
    }

    if (phase === 'point_over') {
      if (this.phaseTimerSec >= this.opts.pointOverPauseSec) {
        this.advanceAfterPointOver();
      }
      this.syncBallToRenderState();
      return;
    }

    // phase === 'rally'
    const res = this.ballEngine.stepFixed(dt);
    const b = this.ballEngine.state;

    // Sample 3D arc for dashboard & 3D replay
    if (b.active && this.activeShotArc.length < 90 && (this.activeShotArc.length === 0 || Math.hypot(b.x - this.activeShotArc[this.activeShotArc.length - 1].x, b.z - this.activeShotArc[this.activeShotArc.length - 1].z) > 0.45)) {
      this.activeShotArc.push({ x: b.x, y: b.y, z: b.z });
    }

    // 1. Net fault ends point immediately
    if (res.hitNet) {
      this.finalizeActiveShot('net');
      const winner = this.hitter === 'human' ? 'opponent' : 'player';
      this.endPoint(winner, 'net');
      this.syncBallToRenderState();
      return;
    }

    // 2. Bounce line calls & double bounce check
    if (res.bounced && res.bouncePoint) {
      if (this.activeShotRecord && !this.activeShotRecord.bouncePos) {
        this.activeShotRecord.bouncePos = { ...res.bouncePoint };
      }

      if (b.bounceCount === 1) {
        const landedOnOwnSide =
          (this.hitter === 'human' && res.bouncePoint.z >= 0) ||
          (this.hitter === 'ai' && res.bouncePoint.z <= 0);
        const isOut = !isInsidePaintedCourt(res.bouncePoint.x, res.bouncePoint.z);

        if (landedOnOwnSide || isOut) {
          this.finalizeActiveShot('out');
          const winner = this.hitter === 'human' ? 'opponent' : 'player';
          this.endPoint(winner, 'out');
          this.syncBallToRenderState();
          return;
        }
      } else if (b.bounceCount >= 2) {
        // Receiver failed to return before second bounce -> hitter wins!
        this.finalizeActiveShot('winner');
        const winner = this.hitter === 'human' ? 'player' : 'opponent';
        this.endPoint(winner, 'not_reached');
        this.syncBallToRenderState();
        return;
      }
    }

    // 3. Ball flew completely past court bounds without bouncing inside
    if (Math.abs(b.z) > 16.5 || Math.abs(b.x) > 10.5) {
      if (b.bounceCount === 0) {
        this.finalizeActiveShot('out');
        const winner = this.hitter === 'human' ? 'opponent' : 'player';
        this.endPoint(winner, 'out');
      } else {
        this.finalizeActiveShot('winner');
        const winner = this.hitter === 'human' ? 'player' : 'opponent';
        this.endPoint(winner, 'not_reached');
      }
      this.syncBallToRenderState();
      return;
    }

    // 4. Opponent AI return check when human hit the ball toward -Z
    if (this.hitter === 'human' && b.active) {
      if (this.opponentReactionDelaySec > 0) {
        this.opponentReactionDelaySec = Math.max(0, this.opponentReactionDelaySec - dt);
      } else if (b.z < 1.5) {
        this.maybeExecuteOpponentReturn();
      }
    }

    // Safety cap on extremely long rallies (keeps points crisp for demo)
    if (this.pointTimeSec > 38) {
      const winner = this.hitter === 'human' ? 'player' : 'opponent';
      this.endPoint(winner, 'timeout');
    }

    this.syncBallToRenderState();
  }

  private startNextPoint() {
    // Per Notion API Design: swap in any queued strategy_update ONLY between rounds!
    this.brain.applyPendingBetweenRounds();

    this.pointTimeSec = 0;
    this.phaseTimerSec = 0;
    this.rallyShotCount = 0;
    this.opponentHitScheduled = false;
    this.pendingOpponentDecision = null;
    this.lastOpponentShot = null;
    this.activeShotArc = [];
    this.activeShotRecord = null;

    const p = this.renderState.player;
    p.x = 0;
    p.z = this.playerHomeZ;
    p.vx = 0;
    p.vz = 0;
    p.animState = 'idle';

    const opp = this.renderState.opponent;
    opp.x = 0;
    opp.z = COURT.AI_START_Z;
    opp.vx = 0;
    opp.vz = 0;
    opp.animState = 'serve';
    this.opponentTargetPos = { x: 0, z: COURT.AI_START_Z };

    this.ballEngine.reset({ x: 0.25, y: 1.5, z: COURT.AI_START_Z + 0.4 });
    this.renderState.ball.active = true;
    this.renderState.ball.landingMarker = null;
    this.renderState.score.lastCall = `POINT ${this.renderState.score.pointIndex}`;
    this.setPhase('serving');
  }

  private launchOpponentServe() {
    const opp = this.renderState.opponent;
    const facts = this.buildFacts();

    // Serves are strictly topspin, flat, or slice (never dropshot or lob)
    const decision = this.brain.decideShot(facts, {
      shot_type: ['topspin', 'flat', 'slice'],
    });

    this.executeOpponentShot(decision, true);
    opp.animState = 'serve';
    this.setPhase('rally');
  }

  private maybeExecuteOpponentReturn() {
    const b = this.ballEngine.state;
    const opp = this.renderState.opponent;

    // Chase the predicted landing / current ball position
    const chaseX = clamp(b.firstBouncePoint?.x ?? b.x, -5.2, 5.2);
    const chaseZ = clamp((b.firstBouncePoint?.z ?? b.z) - 0.9, -11.4, -2.5);
    this.opponentTargetPos = { x: chaseX, z: chaseZ };

    if (this.opponentHitScheduled) return;

    // Opponent lunge reach & footwork readiness scale cleanly with `opponent_speed` (0.65..1.25)
    const speedMul = this.brain.getSettings().opponent_speed;
    const speedNorm = (speedMul - 0.85) / 0.4;
    const dist = Math.hypot(b.x - opp.x, b.z - opp.z);
    const reachRadius = clamp(
      2.15 + speedNorm * 0.55 - Math.max(0, this.lastHumanShotQuality - 0.72) * 0.35,
      1.45,
      2.75,
    );
    const readyByBounce = b.bounceCount === 1 && b.vy <= 3.6 && b.z < -2.0;
    const readyByVolley = b.bounceCount === 0 && opp.z > -5.8 && b.z < -2.0 && dist < 2.0;

    if ((readyByBounce || readyByVolley) && dist <= reachRadius) {
      this.opponentHitScheduled = true;
      const facts = this.buildFacts();
      const decision = this.brain.decideShot(facts);
      this.executeOpponentShot(decision, false);
    }
  }

  private executeOpponentShot(decision: OpponentDecisionOutput, isServe: boolean) {
    const opp = this.renderState.opponent;
    const b = this.ballEngine.state;

    if (!isServe) {
      this.finalizeActiveShot('in_play');
    }

    this.rallyShotCount += 1;
    this.pendingOpponentDecision = decision;

    const contactPos = isServe
      ? { x: opp.x + 0.25, y: 2.45, z: opp.z + 0.35 }
      : { x: b.x, y: clamp(b.y, 0.65, 1.95), z: clamp(b.z, -11.4, -2.0) };

    // Realistic footwork/stretch error curve controlled by `opponent_speed` (keeps rallies ~2.5-3.5 shots!)
    const speedMul = this.brain.getSettings().opponent_speed;
    const speedNorm = (speedMul - 0.85) / 0.4; // -0.5 at 0.65, 0 at 0.85, +1.0 at 1.25
    const stretchDist = isServe ? 0 : Math.hypot(b.x - opp.x, b.z - opp.z);
    const baseErr = clamp(0.11 - speedNorm * 0.13, 0.01, 0.24);
    const stretchErr = Math.max(0, stretchDist - 0.75) * clamp(0.19 - speedNorm * 0.12, 0.03, 0.3);
    const paceErr =
      Math.max(0, this.lastHumanShotQuality - 0.8) * clamp(0.22 - speedNorm * 0.16, 0.03, 0.36);
    const oppErrProb = isServe ? 0 : clamp(baseErr + stretchErr + paceErr, 0.01, 0.58);
    const oppForcedErr = !isServe && this.rng() < oppErrProb;

    const target = isServe
      ? {
          x: clamp(decision.targetCoords.x * 0.72, -3.1, 3.1),
          z: 5.2 + this.rng() * 0.85, // Service box landing -> flat downward trajectory + comfortable post-bounce glide
        }
      : { ...decision.targetCoords };
    if (oppForcedErr) {
      target.x = (target.x >= 0 ? 1 : -1) * (COURT.PAINTED_HALF_W + 0.9);
    }

    const sol = solveShotLaunch(contactPos, target, decision.picked.shot_type, {
      actor: 'ai',
      isServe,
      speedScale: decision.shotSpeedMul,
    });

    this.ballEngine.launch(
      contactPos,
      { x: sol.vx, y: sol.vy, z: sol.vz },
      { x: sol.wx, y: sol.wy, z: sol.wz },
      decision.picked.shot_type,
    );
    this.hitter = 'ai';

    // Update Akhil's 3D opponent visual cues & stroke trigger
    opp.swingSide = contactPos.x >= opp.x ? 'backhand' : 'forehand';
    opp.swingShotType = decision.picked.shot_type;
    opp.swingTriggerId += 1;
    opp.strategyVisualCue = decision.visualCue;
    this.opponentTargetPos = decision.recoveryCoords;

    // Show golden landing ring on human half for crisp visual readability
    this.renderState.ball.landingMarker = { ...sol.landingPoint };
    this.lastOpponentShot = {
      shotType: decision.picked.shot_type,
      aim: decision.picked.aim,
      landingX: sol.landingPoint.x,
      landingZ: sol.landingPoint.z,
    };

    const fromZone = coordsToCourtZone(opp.x, opp.z);
    const otherZone = armZoneToPlayerCourtZone(this.playerArmZone, this.renderState.player.z);
    const landZone = coordsToCourtZone(sol.landingPoint.x, sol.landingPoint.z);
    const result: 'in' | 'out' | 'net' = !sol.clearedNet
      ? 'net'
      : isInsidePaintedCourt(sol.landingPoint.x, sol.landingPoint.z)
        ? 'in'
        : 'out';

    this.beginShotRecord({
      actor: 'ai',
      shotType: decision.picked.shot_type,
      wing: opp.swingSide,
      power: clamp(decision.shotSpeedMul / 1.2, 0.3, 1),
      rotation: decision.picked.shot_type === 'slice' ? -0.7 : decision.picked.shot_type === 'topspin' ? 0.7 : 0.1,
      angle: clamp(sol.landingPoint.x / COURT.PAINTED_HALF_W, -1, 1),
      contactPos,
      playerPosAtShot: { x: opp.x, z: opp.z },
    });

    // Emit Felix & Gavin Draft 2 opponent `shot` event with exact `picked` + `by_rule`
    this.sink.onAgentEvent?.({
      name: 'shot',
      round: this.renderState.score.pointIndex,
      t: round2(this.matchTimeSec),
      by: 'opponent',
      picked: { ...decision.picked },
      by_rule: [...decision.byRule],
      data: {
        rally: this.rallyShotCount,
        shot_type: decision.picked.shot_type,
        from: fromZone,
        other_position: otherZone,
        lands: landZone,
        result,
      },
    });
  }

  private endPoint(winner: 'player' | 'opponent', how: string) {
    const score = this.renderState.score;
    const finishedRound = score.pointIndex;

    if (winner === 'player') {
      score.humanPoints += 1;
      score.lastCall = how === 'out' ? 'OUT — PLAYER POINT' : how === 'net' ? 'NET — PLAYER POINT' : 'WINNER!';
      this.renderState.player.animState = 'celebrate';
      this.renderState.opponent.animState = 'idle';
    } else {
      score.aiPoints += 1;
      score.lastCall = how === 'out' ? 'OUT — AI POINT' : how === 'net' ? 'NET — AI POINT' : 'AI WINNER';
      this.renderState.opponent.animState = 'celebrate';
      this.renderState.player.animState = 'idle';
    }

    const hasPointCap = Number.isFinite(this.opts.totalDemoPoints) && this.opts.totalDemoPoints > 0;
    const willBreak =
      this.opts.enableDemoPauses &&
      ((this.opts.breakEvery > 0 && finishedRound % this.opts.breakEvery === 0) ||
        (hasPointCap && finishedRound >= this.opts.totalDemoPoints));

    this.sink.onAgentRoundEnd?.({
      round: finishedRound,
      t: round2(this.matchTimeSec),
      winner,
      how,
      stats: {
        rally_length: this.rallyShotCount,
        seconds: round2(this.pointTimeSec),
      },
      score: {
        player: score.humanPoints,
        opponent: score.aiPoints,
      },
      break: willBreak,
    });

    score.pointIndex += 1;
    this.ballEngine.state.active = false;
    this.renderState.ball.landingMarker = null;
    this.phaseTimerSec = 0;

    if (this.opts.pointOverPauseSec <= 0) {
      this.advanceAfterPointOver();
    } else {
      this.setPhase('point_over');
    }
  }

  private advanceAfterPointOver() {
    const finishedRound = this.renderState.score.pointIndex - 1;
    const hasPointCap = Number.isFinite(this.opts.totalDemoPoints) && this.opts.totalDemoPoints > 0;
    const isBreak =
      this.opts.enableDemoPauses &&
      ((this.opts.breakEvery > 0 && finishedRound % this.opts.breakEvery === 0) ||
        (hasPointCap && finishedRound >= this.opts.totalDemoPoints));

    if (isBreak) {
      this.renderState.replayArcs = this.shotHistory.slice(-10);
      this.setPhase('demo_pause');
      return;
    }

    if (hasPointCap && this.renderState.score.pointIndex > this.opts.totalDemoPoints) {
      this.setPhase('match_over');
      return;
    }

    this.startNextPoint();
  }

  private updatePlayerMovement(dt: number) {
    const p = this.renderState.player;
    let targetX = this.playerArmX * 3.1;
    let targetZ = this.playerHomeZ;
    let maxSpeed = 3.0; // smooth recovery speed back toward preferred homeZ after hitting

    if (this.renderState.phase === 'rally' && this.hitter === 'ai' && this.ballEngine.state.active) {
      const land = this.renderState.ball.landingMarker;
      const b = this.ballEngine.state;
      // Deep-planted baseline grinders react late to disguised short dropshots (after first bounce / mid-court),
      // whereas alert/all-court players read short balls early and sprint right onto them!
      const deepGrinderLateRead = this.playerHomeZ >= 11.3 && Boolean(land && land.z < 5.6) && b.z < 2.8;
      const isShortBall = Boolean(land && land.z < 6.2);
      maxSpeed =
        isShortBall && this.playerHomeZ >= 11.3
          ? 3.15
          : this.playerHomeZ >= 11.3
            ? 5.2
            : 6.7;
      if (land && !deepGrinderLateRead) {
        targetX = clamp(this.playerArmX * 2.5 + land.x * 0.45, -4.8, 4.8);
        if (land.z < 7.5) {
          targetZ = clamp(land.z + 1.15, 4.8, this.playerHomeZ);
        } else if (land.z > 9.2 && p.z < 9.0) {
          targetZ = clamp(land.z + 0.9, 8.8, this.playerHomeZ);
        } else {
          targetZ = p.z;
        }
      }
    }

    const dx = targetX - p.x;
    const dz = targetZ - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.04) {
      const step = Math.min(dist, maxSpeed * dt);
      p.vx = (dx / dist) * (step / dt);
      p.vz = (dz / dist) * (step / dt);
      p.x += (dx / dist) * step;
      p.z += (dz / dist) * step;
      if (this.renderState.phase === 'rally') {
        p.animState = Math.abs(p.vx) > Math.abs(p.vz) ? (p.vx > 0 ? 'run_right' : 'run_left') : p.vz < 0 ? 'run_forward' : 'run_back';
      }
    } else {
      p.vx = 0;
      p.vz = 0;
      if (this.renderState.phase === 'rally') {
        p.animState = 'idle';
      }
    }
  }

  private updateOpponentMovement(dt: number) {
    const opp = this.renderState.opponent;
    const speedMul = this.brain.getSettings().opponent_speed;
    // Scales smoothly across [0.65..1.25]: 3.75 m/s at 0.65 -> 5.75 m/s at 0.85 -> 8.1 m/s at 1.25
    const maxSpeed = 6.75 * Math.pow(speedMul / 0.85, 1.35) * 0.85;

    const dx = this.opponentTargetPos.x - opp.x;
    const dz = this.opponentTargetPos.z - opp.z;
    const dist = Math.hypot(dx, dz);

    if (dist > 0.05) {
      const step = Math.min(dist, maxSpeed * dt);
      opp.vx = (dx / dist) * (step / dt);
      opp.vz = (dz / dist) * (step / dt);
      opp.x += (dx / dist) * step;
      opp.z += (dz / dist) * step;
      if (this.renderState.phase === 'rally') {
        opp.animState =
          Math.abs(opp.vx) > Math.abs(opp.vz)
            ? opp.vx < 0
              ? 'run_right'
              : 'run_left'
            : opp.vz > 0
              ? 'run_forward'
              : 'run_back';
      }
    } else {
      opp.vx = 0;
      opp.vz = 0;
      if (this.renderState.phase === 'rally') {
        opp.animState = 'idle';
      }
    }
  }

  private buildFacts(): TennisFacts {
    return {
      player_position: armZoneToPlayerCourtZone(this.playerArmZone, this.renderState.player.z),
      player_arm_zone: this.playerArmZone,
      player_last_side: this.playerLastSide,
      player_last_shot_type: this.playerLastShotType,
      rally_length: this.rallyShotCount,
      swing_early_guess: this.playerLastSwingStart.earlyGuess,
      swing_backswing: this.playerLastSwingStart.backswing,
      swing_initial_speed: this.playerLastSwingStart.initialSpeed,
      swing_side: this.playerLastSwingStart.side,
      swing_arm_zone: this.playerLastSwingStart.armZone,
    };
  }

  private beginShotRecord(params: {
    actor: 'human' | 'ai';
    shotType: AnyShotType;
    wing: StrokeWing;
    power: number;
    rotation: number;
    angle: number;
    contactPos: { x: number; y: number; z: number };
    playerPosAtShot: { x: number; z: number };
  }) {
    this.activeShotArc = [{ ...params.contactPos }];
    this.activeShotRecord = {
      id: `shot_${++this.shotSeq}`,
      pointIndex: this.renderState.score.pointIndex,
      t: round2(this.matchTimeSec),
      actor: params.actor,
      shotType: params.shotType,
      wing: params.wing,
      power: params.power,
      rotation: params.rotation,
      angle: params.angle,
      contactPos: { ...params.contactPos },
      bouncePos: null,
      playerPosAtShot: { ...params.playerPosAtShot },
      arc: this.activeShotArc,
    };
  }

  private finalizeActiveShot(outcome: 'in_play' | 'winner' | 'out' | 'net') {
    if (!this.activeShotRecord) return;
    this.activeShotRecord.outcome = outcome;
    this.shotHistory.push(this.activeShotRecord);
    this.sink.onShotRecorded?.(this.activeShotRecord);
    this.activeShotRecord = null;
  }

  private syncBallToRenderState() {
    const b = this.ballEngine.state;
    const rb = this.renderState.ball;
    rb.x = b.x;
    rb.y = b.y;
    rb.z = b.z;
    rb.vx = b.vx;
    rb.vy = b.vy;
    rb.vz = b.vz;
    rb.active = b.active;
    rb.bounceCount = b.bounceCount;
    rb.shotType = b.shotType;
  }

  private setPhase(next: MatchPhase) {
    if (this.renderState.phase === next) return;
    this.renderState.phase = next;
    this.sink.onPhaseChange?.(next);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
