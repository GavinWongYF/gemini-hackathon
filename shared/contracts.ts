// Shared contracts across:
// - Ethan (Hardware + Engine + Utility AI + Dashboard)
// - Akhil (3D Scene + Blender Assets)
// - Felix & Gavin (Agentic System WebSocket API — Notion API Design Draft 2)

export const COURT = {
  PAINTED_HALF_W: 5.5,
  DOUBLES_HALF_W: 6.5,
  BASELINE_Z: 11.5,
  SERVICE_LINE_Z: 7.0,
  NET_HEIGHT: 1.07,
  NET_POST_X: 6.4,
  LINE_TOLERANCE: 0.25,
  BALL_RADIUS: 0.0335,
  VISUAL_BALL_RADIUS: 0.085,
  PLAYER_START_Z: 11.2,
  AI_START_Z: -9.5,
} as const;

export type HumanShotType = 'topspin' | 'slice' | 'dropshot';
export type AiShotType = 'topspin' | 'flat' | 'slice' | 'dropshot' | 'lob' | 'volley';
export type StrokeWing = 'forehand' | 'backhand';
export type ArmZone = 'left' | 'center' | 'right';
export type CourtZone =
  | 'left_short'
  | 'middle_short'
  | 'right_short'
  | 'left_deep'
  | 'middle_deep'
  | 'right_deep';

export type AvatarAnimState =
  | 'idle'
  | 'run_left'
  | 'run_right'
  | 'run_forward'
  | 'run_back'
  | 'forehand'
  | 'backhand'
  | 'slice'
  | 'dropshot'
  | 'serve'
  | 'celebrate';

export type StrategyVisualCue =
  | 'balanced'
  | 'aggressive'
  | 'net_rush'
  | 'defensive_wall'
  | 'slice_trap';

// ---- Hardware (M5 IMU + Webcam Arm Tracking) -> Engine ----

export interface RawImuSample {
  /** Accelerometer in g */
  ax: number;
  ay: number;
  az: number;
  /** Gyroscope in deg/s */
  gx: number;
  gy: number;
  gz: number;
  /** Device millisecond timestamp */
  t?: number;
  /** M5 Button A pressed (trigger recenter) */
  recenter?: boolean;
  /** Optional board/IMU metadata */
  board?: string;
  imu?: string;
}

export interface GyroReading {
  /** Normalized swing power 0..1 */
  power: number;
  /** Spin / wrist rotation bias -1..+1 (negative = backspin/slice, positive = topspin) */
  rotation: number;
  /** Horizontal aim angle -1 (far left) .. +1 (far right) */
  angle: number;
  /** Live linear acceleration magnitude (gravity removed, in g) */
  linearAccelG: number;
  /** Live gyro angular rate magnitude (deg/s) */
  gyroRateDps: number;
  /** Raw pitch/roll/yaw degrees */
  rawPitchDeg?: number;
  rawRollDeg?: number;
  rawYawDeg?: number;
}

export interface WebcamArmState {
  /** Whether webcam pose tracking is actively receiving landmarks */
  active: boolean;
  /** Coarse lateral arm position relative to torso */
  armZone: ArmZone;
  /** Continuous normalized lateral wrist offset (-1 = far left, +1 = far right) */
  armX: number;
  /** Continuous normalized wrist height (0 = bottom, 1 = top) */
  armY: number;
  /** Inferred forehand vs backhand based on arm side & handedness */
  wing: StrokeWing;
  /** Dominant hand setting */
  handedness: 'right' | 'left';
  /** Landmark confidence 0..1 */
  confidence: number;
  /** Last pose inference timestamp (performance.now()) */
  lastUpdateMs: number;
}

export type HardwareSource = 'keyboard' | 'm5_ble' | 'm5_serial' | 'm5_ws';
export type CalibrationPhase = 'needs_zero' | 'zeroing' | 'ready';

export interface PlayerControlState {
  /** Stationary player: arm lateral reach from webcam (or A/D fallback) */
  arm: WebcamArmState;
  /** Active/last auto-classified shot type */
  shotType: HumanShotType;
  /** Live M5 IMU telemetry */
  gyro: GyroReading;
  /** Raw latest IMU sample (for calibration/diagnostics) */
  rawImu: RawImuSample | null;
  /** Active IMU transport */
  source: HardwareSource;
  /** True when M5 IMU packets are arriving live */
  imuConnected: boolean;
  /** M5 racket zeroing state: player holds racket across body & presses ZERO before play */
  calibration: CalibrationPhase;
  /** Progress 0..1 while sampling during 'zeroing' */
  calibrationProgress: number;
  /** Detected M5 board/IMU name if reported */
  deviceInfo: string | null;
  /** Packet rate in Hz */
  imuHz: number;
}

export type ShotTiming = 'early' | 'on_time' | 'late';

export interface PlayerSwingStartEvent {
  id: number;
  timestampMs: number;
  earlyGuess: HumanShotType;
  confidence: number;
  /** Pre-swing windup/takeback amplitude 0..1 */
  backswing: number;
  /** Swing onset speed in the first ~25ms (0..1) */
  initialSpeed: number;
  wing: StrokeWing;
  armZone: ArmZone;
  armX: number;
  source: HardwareSource;
}

export interface PlayerSwingEvent {
  id: number;
  timestampMs: number;
  shotType: HumanShotType;
  wing: StrokeWing;
  armZone: ArmZone;
  armX: number;
  /** Normalized swing power 0..1 */
  power: number;
  /** Normalized spin -1..+1 (negative = backspin/slice, positive = topspin) */
  rotation: number;
  /** Normalized horizontal aim -1 (far left) .. +1 (far right) */
  angle: number;
  /** Classifier + pose confidence 0..1 in the shotType/wing label */
  confidence?: number;
  /** Peak linear acceleration in g during the swing */
  peakAccelG: number;
  /** Peak angular velocity in deg/s during the swing */
  peakGyroDps: number;
  source: HardwareSource;
}

// ---- Engine -> 3D Scene (Akhil) ----

export interface BallRenderState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  active: boolean;
  bounceCount: number;
  shotType: AiShotType | HumanShotType;
  landingMarker: { x: number; z: number } | null;
}

export interface AthleteRenderState {
  x: number;
  z: number;
  vx: number;
  vz: number;
  facingYaw: number;
  animState: AvatarAnimState;
  swingSide: StrokeWing;
  swingTriggerId: number;
  swingShotType: AiShotType | HumanShotType;
  strategyVisualCue?: StrategyVisualCue;
}

export type MatchPhase =
  | 'ready'
  | 'serving'
  | 'rally'
  | 'point_over'
  | 'demo_pause'
  | 'match_over';

export interface TrajectoryPoint {
  x: number;
  y: number;
  z: number;
}

export interface RecordedShot {
  id: string;
  pointIndex: number;
  t: number;
  actor: 'human' | 'ai';
  shotType: AiShotType | HumanShotType;
  wing: StrokeWing;
  power: number;
  rotation: number;
  angle: number;
  contactPos: { x: number; y: number; z: number };
  bouncePos: { x: number; z: number } | null;
  playerPosAtShot: { x: number; z: number };
  arc: TrajectoryPoint[];
  outcome?: 'in_play' | 'winner' | 'out' | 'net';
}

export interface MatchRenderState {
  ball: BallRenderState;
  player: AthleteRenderState;
  opponent: AthleteRenderState;
  phase: MatchPhase;
  score: {
    humanPoints: number;
    aiPoints: number;
    pointIndex: number;
    totalDemoPoints: number;
    lastCall: string;
    /** Real tennis scoring, one set (Sportacle): games [player, ai], the game call ("30-15", "DEUCE", "AD PLAYER"). */
    tennis?: { games: [number, number]; call: string; setWinner: 'player' | 'opponent' | null };
  };
  replayArcs: RecordedShot[];
}

// ---- Agentic System WebSocket Contract (Felix & Gavin — Notion API Design Draft 2) ----

export interface BehaviourOption {
  base: number;
  when?: Record<string, number>;
}

export interface BehaviourCondition {
  fact?: string;
  value?: string;
  is?: string | number | boolean;
  in?: Array<string | number>;
  above?: number;
  below?: number;
}

export interface BehaviourRule {
  if: BehaviourCondition[];
  do: Record<string, string>;
  why: string;
}

export interface NpcBehaviour {
  decisions: Record<string, Record<string, BehaviourOption>>;
  rules: BehaviourRule[];
}

export interface BehaviourJson {
  version: number;
  npcs: Record<string, NpcBehaviour>;
}

export interface AgentReadyMessage {
  type: 'ready';
  match_id: string;
  values: Record<string, { label: string }>;
  behaviour: BehaviourJson;
}

export interface AgentPlayerReadMessage {
  type: 'player_read';
  match_id: string;
  round: number;
  t: number;
  values: Record<string, number>;
  based_on_events: number;
  why: string;
  picture_note?: string;
}

export interface StrategyChangeItem {
  where: string;
  from: unknown;
  to: unknown;
  why: string;
  expect?: string;
}

export interface StrategyCheckItem {
  version: number;
  said: string;
  measure: string;
  before: number;
  after: number;
  held: boolean;
}

export interface AgentStrategyUpdateMessage {
  type: 'strategy_update';
  match_id: string;
  version: number;
  source: 'quick' | 'full';
  observations: string[];
  plan: string[];
  changes: StrategyChangeItem[];
  checks?: StrategyCheckItem[];
  new_values?: Record<string, { label: string }>;
  settings?: Record<string, unknown>;
  behaviour: BehaviourJson;
}

export interface PracticePersona {
  name: string;
  about: string;
  /** eventName -> fieldName -> optionValue -> probability (0..1) */
  plays: Record<string, Record<string, Record<string, number>>>;
}

export interface AgentPracticeRunMessage {
  type: 'practice_run';
  match_id: string;
  run_id: string;
  /** Either a player name from setup.practice.players or an agent-written persona */
  player: string | PracticePersona;
  rounds: number;
  behaviour: BehaviourJson;
}

export interface GamePracticeResultMessage {
  type: 'practice_result';
  match_id: string;
  run_id: string;
  player: string;
  rounds: number;
  wins: Record<string, number>;
  stats?: Record<string, number>;
}

export interface AgentErrorMessage {
  type: 'error';
  match_id: string;
  about: string;
  where?: string;
  got?: unknown;
}
