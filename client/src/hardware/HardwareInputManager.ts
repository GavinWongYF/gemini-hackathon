import type {
  ArmZone,
  HumanShotType,
  PlayerControlState,
  PlayerSwingEvent,
  PlayerSwingStartEvent,
  RawImuSample,
  StrokeWing,
} from '@shared/contracts';
import {
  ImuSwingClassifier,
  type ImuClassifierConfig,
  type RawClassifiedSwing,
} from './ImuSwingClassifier';
import type { DetectedWebcamSwing } from './TennisSwingDetector';
import { WebcamArmTracker } from './WebcamArmTracker';

type SwingListener = (evt: PlayerSwingEvent) => void;
type SwingStartListener = (evt: PlayerSwingStartEvent) => void;
type StateListener = (state: PlayerControlState) => void;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// BLE GATT UUIDs matching m5_tennis_imu.ino
const M5_BLE_SERVICE_UUID = '19b10000-e8f2-537e-4f6c-d104768a1214';
const M5_BLE_IMU_CHAR_UUID = '19b10001-e8f2-537e-4f6c-d104768a1214';
const M5_BLE_CMD_CHAR_UUID = '19b10002-e8f2-537e-4f6c-d104768a1214';

interface IncomingPacket {
  type?: 'imu' | 'info' | 'control' | 'swing' | 'ping' | 'cmd';
  cmd?: string;
  ax?: number;
  ay?: number;
  az?: number;
  gx?: number;
  gy?: number;
  gz?: number;
  t?: number;
  recenter?: boolean | number;
  board?: string;
  imu?: string;
  ble?: string;
}

interface SerialPortLike {
  open: (opts: { baudRate: number; bufferSize?: number }) => Promise<void>;
  close?: () => Promise<void>;
  readable: ReadableStream<BufferSource> | null;
  writable: WritableStream<Uint8Array> | null;
}

interface BleCharacteristicLike extends EventTarget {
  value?: DataView;
  startNotifications: () => Promise<BleCharacteristicLike>;
  writeValueWithoutResponse?: (v: BufferSource) => Promise<void>;
  writeValue?: (v: BufferSource) => Promise<void>;
}

interface BleDeviceLike extends EventTarget {
  name?: string;
  watchAdvertisements?: () => Promise<void>;
  gatt?: {
    connected: boolean;
    connect: () => Promise<{
      getPrimaryService: (uuid: string) => Promise<{
        getCharacteristic: (uuid: string) => Promise<BleCharacteristicLike>;
      }>;
    }>;
    disconnect: () => void;
  };
}

/**
 * Real-Time Tennis Hardware Manager (Zero React Thrashing):
 *  - Wireless M5Stack BLE (13-byte binary GATT notify @ 100 Hz, <10 ms latency, battery-powered!)
 *  - USB-C Serial fallback (115200 baud compact CSV @ 100 Hz)
 *  - WebSocket relay fallback (/ws-hardware)
 *  - Laptop Webcam MediaPipe Pose arm tracker (LEFT / CENTER / RIGHT + FOREHAND / BACKHAND)
 *  - Keyboard + Mouse fallback (A/D arm side, 1/2/3 shot type, Space swing, R recenter)
 *
 * Performance note: IMU packets mutate `this.state` silently at 100 Hz with ZERO React re-renders.
 * Read `getState()` inside `requestAnimationFrame` / 60Hz game loop, and subscribe to `onSwing()`
 * for immediate swing events.
 */
interface BluetoothLike {
  requestDevice: (opts: {
    filters: Array<{ services?: string[]; namePrefix?: string }>;
    optionalServices?: string[];
  }) => Promise<BleDeviceLike>;
  getDevices?: () => Promise<BleDeviceLike[]>;
}

interface SerialLike extends EventTarget {
  requestPort: () => Promise<SerialPortLike>;
  getPorts?: () => Promise<SerialPortLike[]>;
}

/** Which link carries the racket: the USB cable is the default, Bluetooth is the fallback. */
export type RacketLinkKind = 'cable' | 'bluetooth' | 'none';

/** Link state shown in the match header. */
export type BleLinkStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export class HardwareInputManager {
  readonly webcam = new WebcamArmTracker();
  readonly classifier = new ImuSwingClassifier();

  private state: PlayerControlState = {
    arm: {
      active: false,
      armZone: 'center',
      armX: 0,
      armY: 0.5,
      wing: 'forehand',
      handedness: 'right',
      confidence: 0,
      lastUpdateMs: 0,
    },
    shotType: 'topspin',
    gyro: {
      power: 0,
      rotation: 0,
      angle: 0,
      linearAccelG: 0,
      gyroRateDps: 0,
      rawPitchDeg: 0,
      rawRollDeg: 0,
      rawYawDeg: 0,
    },
    rawImu: null,
    source: 'keyboard',
    imuConnected: false,
    calibration: 'needs_zero',
    calibrationProgress: 0,
    deviceInfo: null,
    imuHz: 0,
  };

  private swingListeners = new Set<SwingListener>();
  private swingStartListeners = new Set<SwingStartListener>();
  private stateListeners = new Set<StateListener>();
  private keys = new Set<string>();

  private ws: WebSocket | null = null;
  private wsReconnectTimer: number | null = null;

  private serialWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private serialActive = false;
  private serialPort: SerialPortLike | null = null;
  private serialReader: ReadableStreamDefaultReader<BufferSource> | null = null;
  private serialOpening = false;
  /** True once the cable has been open in this page: a dropped port is reopened by itself. */
  private serialWanted = false;
  private serialLastError: string | null = null;
  private serialReopenTimer: number | null = null;
  /** Set when the cable picker used up the click, so the next click goes straight to Bluetooth. */
  private bleNextClick = false;

  private bleDevice: BleDeviceLike | null = null;
  private bleCmdChar: BleCharacteristicLike | null = null;
  private bleActive = false;
  /** True from the moment a racket is chosen until `disconnectBle()`: the link is kept up by itself. */
  private bleWanted = false;
  private bleLink: BleLinkStatus = 'idle';
  private bleLastError: string | null = null;
  private bleOpening = false;
  private bleOpenToken = 0;
  private bleReconnectTimer: number | null = null;
  private bleReconnectAttempt = 0;
  private bleWatchdogTimer: number | null = null;
  private bleLastPacketMs = 0;
  private bleWatchedDevices = new WeakSet<object>();
  private bleWatchedChars = new WeakSet<object>();

  private swingCounter = 0;
  private lastSwingMs = 0;
  private lastImuPacketMs = 0;
  private imuPacketTimestamps: number[] = [];
  private started = false;
  private pendingSwingTimer: number | null = null;
  private pendingImuSwing: {
    swing: RawClassifiedSwing;
    source: 'm5_ble' | 'm5_serial' | 'm5_ws';
    receivedMs: number;
  } | null = null;
  private unsubWebcamSwing: (() => void) | null = null;
  /** When false (between points / ball on opponent side), sensors stay hot & calibrated but never emit swings. */
  private strikeWindowOpen = true;
  /** Optional incoming ball lateral offset from player in metres (+ = right of player, - = left). */
  private strikeBallOffsetRightM: number | undefined = undefined;

  start(wsUrl?: string) {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('mousemove', this.handleMouseMove);

    this.unsubWebcamSwing = this.webcam.onWebcamSwing((camSwing) => {
      this.handleWebcamSwing(camSwing);
    });

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const targetUrl = wsUrl ?? `${protocol}//${window.location.host}/ws-hardware`;
    this.connectWebSocket(targetUrl);
    this.getSerial()?.addEventListener('connect', this.handleSerialPlugged);
    window.addEventListener('pagehide', this.handlePageHide);
    void this.bootRacketLink();
  }

  stop() {
    if (!this.started || typeof window === 'undefined') return;
    this.started = false;
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('mousemove', this.handleMouseMove);
    this.unsubWebcamSwing?.();
    this.unsubWebcamSwing = null;
    if (this.wsReconnectTimer !== null) {
      window.clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.pendingSwingTimer !== null) {
      window.clearTimeout(this.pendingSwingTimer);
      this.pendingSwingTimer = null;
    }
    this.pendingImuSwing = null;
    this.ws?.close();
    this.ws = null;
    this.getSerial()?.removeEventListener('connect', this.handleSerialPlugged);
    window.removeEventListener('pagehide', this.handlePageHide);
    void this.disconnectSerial();
    this.disconnectBle();
  }

  getState(): PlayerControlState {
    const now = performance.now();
    const imuLive = now - this.lastImuPacketMs < 1200;
    this.state.imuConnected = imuLive;
    this.state.calibration = this.classifier.getCalibrationPhase();
    this.state.calibrationProgress = this.classifier.getCalibrationProgress();

    if (!imuLive) {
      this.state.imuHz = 0;
      if (!this.bleActive && !this.serialActive && this.state.source !== 'keyboard') {
        this.state.source = 'keyboard';
      }
    }

    // Pull latest webcam arm state directly (zero React overhead)
    const camArm = this.webcam.getSnapshot().arm;
    if (camArm.active) {
      this.state.arm = camArm;
    } else {
      const left = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
      const right = this.keys.has('KeyD') || this.keys.has('ArrowRight');
      let armX = 0;
      let armZone: ArmZone = 'center';
      if (left && !right) {
        armX = -0.8;
        armZone = 'left';
      } else if (right && !left) {
        armX = 0.8;
        armZone = 'right';
      }
      const handedness = this.state.arm.handedness;
      const wing: StrokeWing =
        handedness === 'right'
          ? armX >= -0.05
            ? 'forehand'
            : 'backhand'
          : armX <= 0.05
            ? 'forehand'
            : 'backhand';

      this.state.arm = {
        ...this.state.arm,
        active: false,
        armZone,
        armX,
        wing,
      };
    }

    return this.state;
  }

  onSwing(listener: SwingListener): () => void {
    this.swingListeners.add(listener);
    return () => this.swingListeners.delete(listener);
  }

  /** Fires ~100-160ms BEFORE `onSwing` at swing onset so OpponentBrain can `anticipate`. */
  onSwingStart(listener: SwingStartListener): () => void {
    this.swingStartListeners.add(listener);
    return () => this.swingStartListeners.delete(listener);
  }

  /** Fires on connection/mode changes (NOT on every 100 Hz packet). */
  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  zeroRacket() {
    if (this.pendingSwingTimer !== null) {
      window.clearTimeout(this.pendingSwingTimer);
      this.pendingSwingTimer = null;
    }
    this.pendingImuSwing = null;
    this.classifier.rezero();
    this.webcam.resetSwingDetector();
    this.lastSwingMs = 0;
    this.state.shotType = 'topspin';
    this.state.calibration = this.classifier.getCalibrationPhase();
    this.state.calibrationProgress = this.classifier.getCalibrationProgress();
    this.state.gyro = this.classifier.getLatestReading();
    void this.sendBleCommand('RECENTER');
    void this.sendSerialCommand('RECENTER');
    // Also broadcast RECENTER over WS relay so ble_bridge can flash M5 LCD
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'cmd', cmd: 'RECENTER' }));
    }
    this.notifyState();
  }

  rezero() {
    this.zeroRacket();
  }

  recenter() {
    this.zeroRacket();
  }

  /**
   * Gate swing tracking to ONLY when an incoming ball is approaching the player's hitting zone!
   * Defaults to `active = true` so standalone test pages work anytime.
   * On `/match`, call `hardwareInput.setStrikeWindow(ballIncoming, ball.x - player.x)` each frame:
   *  - Between points / opponent shots (`active = false`): sensors keep tracking pose & auto-healing
   *    bias silently, but NEVER emit swings or burn cooldown.
   *  - During incoming ball (`active = true`): immediately arms cleanly and passes `ballOffsetRightMeters`
   *    into `TennisSwingDetector` for rock-solid Forehand vs. Backhand accuracy!
   */
  setStrikeWindow(active: boolean, ballOffsetRightMeters?: number) {
    const wasOpen = this.strikeWindowOpen;
    this.strikeWindowOpen = active;
    this.strikeBallOffsetRightM =
      active && typeof ballOffsetRightMeters === 'number' && Number.isFinite(ballOffsetRightMeters)
        ? ballOffsetRightMeters
        : undefined;
    this.webcam.swingDetector.setBallLateral(this.strikeBallOffsetRightM);

    if (active && !wasOpen) {
      // Fresh strike window just opened -> clear any leftover cooldown so the real hit triggers immediately!
      // NOTE: When `active` turns false, DO NOT cancel an already-captured `pendingSwingTimer` —
      // if the M5 peak already fired while the ball was incoming, let its camera-fusion settle timer emit!
      this.classifier.cancelCooldown();
    }
  }

  setHandedness(handedness: 'right' | 'left') {
    this.state.arm.handedness = handedness;
    this.webcam.setHandedness(handedness);
    this.notifyState();
  }

  setShotType(shotType: HumanShotType) {
    this.state.shotType = shotType;
    if (shotType === 'topspin') this.state.gyro.rotation = 0.65;
    else if (shotType === 'slice') this.state.gyro.rotation = -0.65;
    else this.state.gyro.rotation = -0.25;
    this.notifyState();
  }

  updateClassifierConfig(partial: Partial<ImuClassifierConfig>) {
    this.classifier.updateConfig(partial);
  }

  triggerManualSwing(overrides?: Partial<Omit<PlayerSwingEvent, 'id' | 'timestampMs'>>) {
    const now = performance.now();
    if (now - this.lastSwingMs < 240) return;
    this.lastSwingMs = now;

    const current = this.getState();
    const evt: PlayerSwingEvent = {
      id: ++this.swingCounter,
      timestampMs: Date.now(),
      shotType: overrides?.shotType ?? current.shotType,
      wing: overrides?.wing ?? current.arm.wing,
      armZone: overrides?.armZone ?? current.arm.armZone,
      armX: overrides?.armX ?? current.arm.armX,
      power: clamp(overrides?.power ?? Math.max(0.55, current.gyro.power), 0.18, 1),
      rotation: clamp(overrides?.rotation ?? current.gyro.rotation, -1, 1),
      angle: clamp(overrides?.angle ?? current.gyro.angle, -1, 1),
      confidence: overrides?.confidence ?? 0.95,
      peakAccelG: overrides?.peakAccelG ?? current.gyro.linearAccelG,
      peakGyroDps: overrides?.peakGyroDps ?? current.gyro.gyroRateDps,
      source: overrides?.source ?? current.source,
    };
    this.emitSwing(evt);
  }

  /**
   * 1-Click Wireless Connection to M5-TENNIS-IMU via Chrome Web Bluetooth!
   * Streams 13-byte packed binary IMU packets at ~70–100 Hz with <10 ms latency.
   * Once a racket is chosen the link is kept up: a drop or a stalled stream reconnects by itself.
   */
  async connectBle(): Promise<{ ok: boolean; error?: string }> {
    if (this.serialActive) {
      return { ok: false, error: 'The cable is connected, so Bluetooth is not used.' };
    }
    const bt = this.getBluetooth();
    if (!bt) {
      this.bleLink = 'failed';
      this.bleLastError = 'Web Bluetooth unavailable - open the game in Chrome or Edge.';
      this.notifyState();
      return { ok: false, error: this.bleLastError };
    }

    if (!this.bleDevice) {
      this.bleLink = 'connecting';
      this.bleLastError = null;
      this.notifyState();
    }

    let device: BleDeviceLike;
    try {
      // The current link stays up while the chooser is open, so a stray click or a cancelled chooser drops nothing.
      device = await bt.requestDevice({
        filters: [{ services: [M5_BLE_SERVICE_UUID] }, { namePrefix: 'M5-TENNIS' }],
        optionalServices: [M5_BLE_SERVICE_UUID],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!this.bleDevice) {
        const cancelled = /cancel/i.test(msg);
        this.bleLink = cancelled ? 'idle' : 'failed';
        this.bleLastError = cancelled ? null : msg;
      }
      this.notifyState();
      return { ok: false, error: msg };
    }

    if (this.bleDevice && this.bleDevice !== device) this.disconnectBle();
    this.bleDevice = device;
    this.bleWanted = true;
    this.clearBleReconnectTimer();
    this.bleReconnectAttempt = 0;
    this.watchBleDevice(device);
    this.startBleWatchdog();

    if (this.bleActive && device.gatt?.connected) {
      this.bleLink = 'connected';
      this.notifyState();
      return { ok: true };
    }

    this.bleLink = 'connecting';
    this.notifyState();
    try {
      await this.openBleGatt(device);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.bleDevice === device) {
        this.bleLastError = msg;
        this.bleLink = 'reconnecting';
        this.scheduleBleReconnect();
      }
      this.notifyState();
      return { ok: false, error: msg };
    }
  }

  /** Wireless link state for the header pill. */
  getBleLink(): { status: BleLinkStatus; error: string | null } {
    return { status: this.bleLink, error: this.bleLastError };
  }

  disconnectBle() {
    this.bleWanted = false;
    this.clearBleReconnectTimer();
    if (this.bleWatchdogTimer !== null) {
      window.clearInterval(this.bleWatchdogTimer);
      this.bleWatchdogTimer = null;
    }
    this.bleOpenToken += 1;
    this.bleOpening = false;
    const device = this.bleDevice;
    this.bleDevice = null;
    this.bleCmdChar = null;
    this.bleActive = false;
    this.bleLink = 'idle';
    try {
      device?.gatt?.disconnect();
    } catch {
      // ignore: the link is already gone
    }
  }

  private getBluetooth(): BluetoothLike | null {
    if (typeof navigator === 'undefined') return null;
    return (navigator as Navigator & { bluetooth?: BluetoothLike }).bluetooth ?? null;
  }

  /** Opens GATT, finds the IMU stream and starts notifications. Throws if any step fails or times out. */
  private async openBleGatt(device: BleDeviceLike): Promise<void> {
    const gatt = device.gatt;
    if (!gatt) throw new Error('Selected BLE device has no GATT server.');
    const token = ++this.bleOpenToken;
    this.bleOpening = true;
    try {
      const server = await withTimeout(gatt.connect(), 12000, 'Bluetooth connect timed out');
      const service = await withTimeout(
        server.getPrimaryService(M5_BLE_SERVICE_UUID),
        8000,
        'Racket service not found',
      );
      const imuChar = await withTimeout(
        service.getCharacteristic(M5_BLE_IMU_CHAR_UUID),
        8000,
        'Racket IMU stream not found',
      );
      let cmdChar: BleCharacteristicLike | null = null;
      try {
        cmdChar = await withTimeout(service.getCharacteristic(M5_BLE_CMD_CHAR_UUID), 4000, 'no command channel');
      } catch {
        cmdChar = null;
      }

      if (!this.bleWatchedChars.has(imuChar)) {
        this.bleWatchedChars.add(imuChar);
        imuChar.addEventListener('characteristicvaluechanged', (ev: Event) => {
          if (this.bleDevice !== device) return;
          const target = ev.target as BleCharacteristicLike;
          const dv = target.value;
          if (!dv || dv.byteLength < 13) return;
          this.bleLastPacketMs = performance.now();
          const sample: RawImuSample = {
            ax: dv.getInt16(0, true) / 1000,
            ay: dv.getInt16(2, true) / 1000,
            az: dv.getInt16(4, true) / 1000,
            gx: dv.getInt16(6, true) / 10,
            gy: dv.getInt16(8, true) / 10,
            gz: dv.getInt16(10, true) / 10,
            recenter: (dv.getUint8(12) & 1) === 1,
          };
          this.ingestSample(sample, 'm5_ble');
        });
      }

      await withTimeout(imuChar.startNotifications(), 8000, 'Racket stream did not start');
      if (token !== this.bleOpenToken || this.bleDevice !== device) return;

      this.bleCmdChar = cmdChar;
      this.bleActive = true;
      this.bleLink = 'connected';
      this.bleLastError = null;
      this.bleReconnectAttempt = 0;
      this.bleLastPacketMs = performance.now();
      this.state.source = 'm5_ble';
      this.state.imuConnected = true;
      this.state.deviceInfo = `${device.name ?? 'M5-TENNIS-IMU'} • Wireless BLE`;
      this.notifyState();
    } catch (err) {
      // A half-open link is closed so the next attempt starts clean.
      if (token === this.bleOpenToken && this.bleDevice === device) {
        try {
          gatt.disconnect();
        } catch {
          // ignore
        }
      }
      throw err;
    } finally {
      if (token === this.bleOpenToken) this.bleOpening = false;
    }
  }

  private watchBleDevice(device: BleDeviceLike) {
    if (this.bleWatchedDevices.has(device)) return;
    this.bleWatchedDevices.add(device);
    device.addEventListener('gattserverdisconnected', () => {
      if (this.bleDevice !== device) return;
      this.bleActive = false;
      this.bleCmdChar = null;
      this.state.imuConnected = false;
      if (this.bleWanted) {
        this.bleLink = 'reconnecting';
        this.scheduleBleReconnect(300);
      } else {
        this.bleLink = 'idle';
      }
      this.notifyState();
    });
  }

  private clearBleReconnectTimer() {
    if (this.bleReconnectTimer !== null) {
      window.clearTimeout(this.bleReconnectTimer);
      this.bleReconnectTimer = null;
    }
  }

  /** Short backoff: 0.4 s, 0.8 s, 1.6 s, then every 3 s until the racket is back. */
  private scheduleBleReconnect(delayMs?: number) {
    if (!this.bleWanted || !this.bleDevice || this.bleReconnectTimer !== null) return;
    const delay = delayMs ?? Math.min(3000, 400 * 2 ** Math.min(this.bleReconnectAttempt, 3));
    this.bleReconnectTimer = window.setTimeout(() => {
      this.bleReconnectTimer = null;
      void this.tryBleReconnect();
    }, delay);
  }

  private async tryBleReconnect() {
    const device = this.bleDevice;
    if (!device || !this.bleWanted || this.bleActive || this.bleOpening || this.serialActive) return;
    this.bleReconnectAttempt += 1;
    this.bleLink = 'reconnecting';
    this.notifyState();
    try {
      await this.openBleGatt(device);
    } catch (err) {
      if (this.bleDevice !== device) return;
      this.bleLastError = err instanceof Error ? err.message : String(err);
      this.scheduleBleReconnect();
    }
  }

  /** Once a second: a link that claims to be up but sends nothing for 4 s is dropped and reopened. */
  private startBleWatchdog() {
    if (this.bleWatchdogTimer !== null) return;
    this.bleWatchdogTimer = window.setInterval(() => {
      const device = this.bleDevice;
      if (!device || !this.bleWanted) return;
      if (this.bleActive && performance.now() - this.bleLastPacketMs > 4000) {
        this.bleActive = false;
        this.bleCmdChar = null;
        this.bleLink = 'reconnecting';
        this.bleLastError = 'No data from the racket for 4 s';
        try {
          device.gatt?.disconnect();
        } catch {
          // ignore
        }
        this.notifyState();
        this.scheduleBleReconnect(300);
      } else if (!this.bleActive && !this.bleOpening && this.bleReconnectTimer === null) {
        this.scheduleBleReconnect(0);
      }
    }, 1000);
  }

  /**
   * After a page reload, picks the racket back up with no chooser when the browser still remembers it
   * (`navigator.bluetooth.getDevices()`, where the browser offers it).
   */
  private async restoreBleDevice() {
    const bt = this.getBluetooth();
    if (!bt?.getDevices) return;
    try {
      const devices = await bt.getDevices();
      const device =
        devices.find((d) => (d.name ?? '').startsWith('M5-TENNIS')) ??
        (devices.length === 1 ? devices[0] : undefined);
      if (!device || this.bleDevice || !this.started || this.serialActive) return;
      this.bleDevice = device;
      this.bleWanted = true;
      this.watchBleDevice(device);
      this.startBleWatchdog();
      try {
        void device.watchAdvertisements?.().catch(() => undefined);
      } catch {
        // ignore: not offered by this browser
      }
      this.bleLink = 'reconnecting';
      this.notifyState();
      void this.tryBleReconnect();
    } catch {
      // ignore: no remembered racket
    }
  }

  private async sendBleCommand(cmd: string) {
    if (!this.bleCmdChar) return;
    try {
      const bytes = new TextEncoder().encode(cmd);
      if (this.bleCmdChar.writeValueWithoutResponse) {
        await this.bleCmdChar.writeValueWithoutResponse(bytes);
      } else if (this.bleCmdChar.writeValue) {
        await this.bleCmdChar.writeValue(bytes);
      }
    } catch {
      // ignore transient BLE write error
    }
  }

  /**
   * Pair button: the cable first, Bluetooth only when no cable port is picked.
   * A port that was allowed before opens with no picker.
   */
  async connectRacket(opts?: {
    bluetooth?: boolean;
  }): Promise<{ ok: boolean; link: RacketLinkKind; error?: string }> {
    if (this.serialActive) return { ok: true, link: 'cable' };
    const serial = this.getSerial();
    const straightToBluetooth = !!opts?.bluetooth || this.bleNextClick || !serial;
    this.bleNextClick = false;

    if (!straightToBluetooth && serial) {
      if (await this.autoConnectSerial()) return { ok: true, link: 'cable' };
      let port: SerialPortLike | null = null;
      try {
        port = await serial.requestPort();
      } catch {
        port = null; // picker cancelled or no port there: Bluetooth is next
      }
      if (port) {
        if (await this.openSerialPort(port)) return { ok: true, link: 'cable' };
        this.notifyState();
        return { ok: false, link: 'none', error: this.serialLastError ?? 'The cable port did not open.' };
      }
      this.serialLastError = null;
    }

    const res = await this.connectBle();
    if (!res.ok && /gesture|activation|permission request/i.test(res.error ?? '')) {
      // The cable picker used up the click. The next click goes straight to Bluetooth.
      this.bleNextClick = true;
      this.bleLink = 'failed';
      this.bleLastError = 'Click once more to pair over Bluetooth.';
      this.notifyState();
    }
    return { ok: res.ok, link: res.ok ? 'bluetooth' : 'none', error: res.error };
  }

  /** Which link carries the racket right now, for the header. */
  getRacketLink(): { link: RacketLinkKind; status: BleLinkStatus; error: string | null } {
    if (this.serialActive) return { link: 'cable', status: 'connected', error: null };
    if (this.serialOpening) return { link: 'cable', status: 'connecting', error: null };
    if (this.bleDevice || this.bleLink === 'connecting') {
      return { link: 'bluetooth', status: this.bleLink, error: this.bleLastError };
    }
    if (this.serialWanted) return { link: 'cable', status: 'reconnecting', error: this.serialLastError };
    if (this.bleLink === 'failed') return { link: 'bluetooth', status: 'failed', error: this.bleLastError };
    if (this.serialLastError) return { link: 'cable', status: 'failed', error: this.serialLastError };
    return { link: 'none', status: 'idle', error: null };
  }

  /**
   * Chrome Web Serial connection to the M5 over USB-C (115200 baud, compact CSV at 100 Hz).
   * Opens a port that was allowed before with no picker, and asks for one otherwise.
   */
  async connectSerial(baudRate = 115200): Promise<boolean> {
    if (this.serialActive) return true;
    const serial = this.getSerial();
    if (!serial) {
      console.warn('[Hardware] Web Serial API unavailable — use Chrome/Edge.');
      return false;
    }
    if (await this.autoConnectSerial(baudRate)) return true;
    try {
      const port = await serial.requestPort();
      const ok = await this.openSerialPort(port, baudRate);
      if (!ok) this.notifyState();
      return ok;
    } catch (err) {
      console.warn('[Hardware] Serial connect cancelled/failed:', err);
      return false;
    }
  }

  /** Lets the cable go and stops reopening it. */
  async disconnectSerial() {
    this.serialWanted = false;
    this.clearSerialReopenTimer();
    this.serialActive = false;
    try {
      await this.serialReader?.cancel();
    } catch {
      // ignore: the stream is already closed
    }
  }

  private getSerial(): SerialLike | null {
    if (typeof navigator === 'undefined') return null;
    return (navigator as Navigator & { serial?: SerialLike }).serial ?? null;
  }

  private handleSerialPlugged = () => {
    void this.autoConnectSerial();
  };

  private handlePageHide = () => {
    void this.disconnectSerial();
    this.disconnectBle();
  };

  /**
   * On load: the cable first. A reload can find the port still closing, so the first seconds retry.
   * With no cable there, a racket the browser remembers is picked back up over Bluetooth.
   */
  private async bootRacketLink() {
    for (let attempt = 0; attempt < 4 && this.started && !this.serialActive; attempt++) {
      if (await this.autoConnectSerial()) return;
      if (attempt === 0) void this.restoreBleDevice();
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
    }
  }

  /** Opens the first cable port this page is already allowed to use. No picker, no click needed. */
  private async autoConnectSerial(baudRate = 115200): Promise<boolean> {
    if (this.serialActive) return true;
    const serial = this.getSerial();
    if (!serial?.getPorts) return false;
    try {
      const ports = await serial.getPorts();
      for (const port of ports) {
        if (await this.openSerialPort(port, baudRate)) return true;
      }
    } catch {
      // ignore: no port allowed yet
    }
    return false;
  }

  private async openSerialPort(port: SerialPortLike, baudRate = 115200): Promise<boolean> {
    if (this.serialActive) return this.serialPort === port;
    if (this.serialOpening) return false;
    this.serialOpening = true;
    try {
      try {
        await port.open({ baudRate, bufferSize: 16384 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already open/i.test(msg)) throw err;
        // Left open by an earlier load of this page: close it and open it once more.
        await port.close?.();
        await port.open({ baudRate, bufferSize: 16384 });
      }
      this.serialPort = port;
      this.serialActive = true;
      this.serialWanted = true;
      this.serialLastError = null;
      this.clearSerialReopenTimer();
      // One source of swings at a time: the cable wins and Bluetooth is let go.
      this.disconnectBle();
      this.bleLastError = null;
      this.state.source = 'm5_serial';
      this.state.imuConnected = true;

      if (port.writable) {
        this.serialWriter = port.writable.getWriter();
        void this.sendSerialCommand('INFO');
      }

      this.notifyState();
      void this.pumpSerial(port);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.serialLastError = `The cable port did not open (${msg}). Close other tabs or apps that use it.`;
      return false;
    } finally {
      this.serialOpening = false;
    }
  }

  private async pumpSerial(port: SerialPortLike) {
    const decoder = new TextDecoder();
    let buffer = '';
    let streamErrors = 0;
    try {
      while (this.serialActive && this.serialPort === port && port.readable) {
        const reader = port.readable.getReader();
        this.serialReader = reader;
        let ended = false;
        try {
          while (this.serialActive && this.serialPort === port) {
            const { value, done } = await reader.read();
            if (done) {
              ended = true;
              break;
            }
            if (!value) continue;
            streamErrors = 0;
            buffer += decoder.decode(value, { stream: true });
            let idx = buffer.indexOf('\n');
            while (idx !== -1) {
              const line = buffer.slice(0, idx).trim();
              buffer = buffer.slice(idx + 1);
              if (line) this.parseIncomingLine(line, 'm5_serial');
              idx = buffer.indexOf('\n');
            }
            if (buffer.length > 4096) buffer = '';
          }
        } catch (err) {
          // A framing or overrun error ends this stream only. The port hands out a fresh one, so the loop carries on.
          streamErrors += 1;
          console.warn('[Hardware] Serial stream error:', err);
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // ignore
          }
          if (this.serialReader === reader) this.serialReader = null;
        }
        if (ended || streamErrors > 20) break;
        if (streamErrors > 0) await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
    } finally {
      await this.releaseSerialPort(port);
    }
  }

  private async releaseSerialPort(port: SerialPortLike) {
    const writer = this.serialWriter;
    this.serialWriter = null;
    try {
      writer?.releaseLock();
    } catch {
      // ignore
    }
    try {
      await port.close?.();
    } catch {
      // ignore: an unplugged port is already closed
    }
    if (this.serialPort === port) this.serialPort = null;
    this.serialActive = false;
    this.state.imuConnected = false;
    if (this.serialWanted) {
      this.serialLastError = 'The cable dropped. It reopens by itself when it is back.';
      this.scheduleSerialReopen();
    }
    this.notifyState();
  }

  private clearSerialReopenTimer() {
    if (this.serialReopenTimer !== null) {
      window.clearTimeout(this.serialReopenTimer);
      this.serialReopenTimer = null;
    }
  }

  private scheduleSerialReopen() {
    if (!this.serialWanted || this.serialActive || this.serialReopenTimer !== null) return;
    this.serialReopenTimer = window.setTimeout(() => {
      this.serialReopenTimer = null;
      if (!this.serialWanted || this.serialActive) return;
      void this.autoConnectSerial().then((ok) => {
        if (!ok) {
          this.serialLastError = 'The cable dropped. It reopens by itself when it is back.';
          this.scheduleSerialReopen();
        }
      });
    }, 1500);
  }

  async sendSerialCommand(command: string): Promise<boolean> {
    if (!this.serialWriter) return false;
    try {
      const encoded = new TextEncoder().encode(`${command}\n`);
      await this.serialWriter.write(encoded);
      return true;
    } catch {
      return false;
    }
  }

  private connectWebSocket(url: string) {
    try {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          this.parseIncomingLine(event.data, 'm5_ws');
        }
      };

      ws.onclose = () => {
        if (this.started) {
          this.wsReconnectTimer = window.setTimeout(() => this.connectWebSocket(url), 2000);
        }
      };

      ws.onerror = () => ws.close();
    } catch {
      // ignore WS init failures
    }
  }

  private parseIncomingLine(raw: string, source: 'm5_serial' | 'm5_ws') {
    // Fast path: compact CSV "I,ax,ay,az,gx,gy,gz,flags"
    if (raw.startsWith('I,')) {
      const parts = raw.split(',');
      if (parts.length >= 8) {
        const ax = Number(parts[1]);
        const ay = Number(parts[2]);
        const az = Number(parts[3]);
        const gx = Number(parts[4]);
        const gy = Number(parts[5]);
        const gz = Number(parts[6]);
        if (
          Number.isFinite(ax) &&
          Number.isFinite(ay) &&
          Number.isFinite(az) &&
          Number.isFinite(gx) &&
          Number.isFinite(gy) &&
          Number.isFinite(gz)
        ) {
          this.ingestSample(
            { ax, ay, az, gx, gy, gz, recenter: parts[7] === '1' },
            source,
          );
        }
      }
      return;
    }

    if (!raw.startsWith('{')) return;
    let pkt: IncomingPacket;
    try {
      pkt = JSON.parse(raw) as IncomingPacket;
    } catch {
      return;
    }

    if (pkt.type === 'info') {
      const parts = [pkt.board, pkt.imu, pkt.ble ? `BLE ${pkt.ble}` : null].filter(Boolean);
      this.state.deviceInfo = parts.join(' • ') || 'M5Stack IMU';
      this.notifyState();
      return;
    }

    if (pkt.type === 'cmd' && pkt.cmd === 'RECENTER') {
      this.classifier.rezero();
      this.webcam.resetSwingDetector();
      this.state.calibration = this.classifier.getCalibrationPhase();
      this.state.calibrationProgress = this.classifier.getCalibrationProgress();
      this.notifyState();
      return;
    }

    if (
      typeof pkt.ax === 'number' &&
      typeof pkt.ay === 'number' &&
      typeof pkt.az === 'number' &&
      typeof pkt.gx === 'number' &&
      typeof pkt.gy === 'number' &&
      typeof pkt.gz === 'number'
    ) {
      this.ingestSample(
        {
          ax: pkt.ax,
          ay: pkt.ay,
          az: pkt.az,
          gx: pkt.gx,
          gy: pkt.gy,
          gz: pkt.gz,
          t: pkt.t,
          recenter: pkt.recenter === true || pkt.recenter === 1,
        },
        source,
      );
    }
  }

  private ingestSample(sample: RawImuSample, source: 'm5_ble' | 'm5_serial' | 'm5_ws') {
    // One source of swings at a time: the cable wins, then Bluetooth, then the relay.
    if (this.serialActive && source !== 'm5_serial') return;
    if (this.bleActive && source !== 'm5_ble') return;

    const now = performance.now();
    const wasConnected = this.state.imuConnected;
    this.lastImuPacketMs = now;
    this.state.source = source;
    this.state.imuConnected = true;

    this.imuPacketTimestamps.push(now);
    while (this.imuPacketTimestamps.length > 0 && now - this.imuPacketTimestamps[0] > 1000) {
      this.imuPacketTimestamps.shift();
    }
    this.state.imuHz = this.imuPacketTimestamps.length;
    this.state.rawImu = sample;

    const camActive = this.webcam.getSnapshot().arm.active;
    // Keep soft IMU dropshot path enabled (`true`) even when webcam is active, because M5 BLE
    // is the sole swing trigger when connected (preventing mutual exclusion on soft 85-220 deg/s dropshots!).
    // Time-aligned webcam backswing-prep veto below still eliminates backswing false triggers.
    const swing = this.classifier.ingest(sample, now, false, true);
    const early = this.classifier.consumeEarlySwingGuess();
    this.state.gyro = this.classifier.getLatestReading();
    this.state.calibration = this.classifier.getCalibrationPhase();
    this.state.calibrationProgress = this.classifier.getCalibrationProgress();

    if (!wasConnected) {
      this.notifyState();
    }

    // Strike-window gate: when closed (between points / ball not approaching), keep AHRS &
    // stillness bias auto-heal running smoothly, but NEVER emit swings or burn cooldown!
    if (!this.strikeWindowOpen) {
      this.state.shotType = this.classifier.getLastShotType();
      return;
    }

    if (early) {
      const pre = this.webcam.getPreSwingTakeback(early.swingStartMs);
      const handedness = this.state.arm.handedness;
      const handSign = handedness === 'right' ? 1 : -1;
      const yawSign = this.classifier.getConfig().invertWingYaw ? -1 : 1;
      const earlyImuScore =
        (early.earlyYawDeg * 0.65 - early.preSwingRelYawDeg * 0.35) * handSign * yawSign;
      const earlyImuWing: StrokeWing = earlyImuScore >= 0 ? 'forehand' : 'backhand';
      const earlyImuConf =
        Math.abs(earlyImuScore) < 6 ? 0.15 : clamp(0.4 + Math.abs(earlyImuScore) / 45, 0.4, 0.85);

      let earlyWing: StrokeWing = pre.wing;
      if (!pre.hasWebcamData) {
        earlyWing = earlyImuConf >= 0.35 ? earlyImuWing : this.getState().arm.wing;
      } else {
        const camDir = pre.wing === 'forehand' ? 1 : -1;
        const imuDir = earlyImuWing === 'forehand' ? 1 : -1;
        const camConf = pre.wingConfidence ?? 0.6;
        earlyWing = camDir * camConf + imuDir * (earlyImuConf * 0.75) >= 0 ? 'forehand' : 'backhand';
      }

      const backswing = pre.hasWebcamData
        ? clamp(pre.backswing * 0.7 + early.imuBackswing * 0.3, 0.1, 1)
        : early.imuBackswing;
      const earlyResolved = this.classifier.resolveEarlyGuess(
        early,
        earlyWing,
        backswing,
        pre.deltaArmY,
        pre.hasWebcamData,
      );
      this.emitSwingStart({
        id: this.swingCounter + 1,
        timestampMs: Date.now(),
        earlyGuess: earlyResolved.shotType,
        confidence: clamp(earlyResolved.confidence, 0.35, 0.95),
        backswing,
        initialSpeed: early.initialSpeed,
        wing: earlyWing,
        armZone: pre.armZone,
        armX: pre.armX,
        source,
      });
    }

    if (swing) {
      if (camActive && typeof window !== 'undefined') {
        // M5 BLE Peak is the SOLE swing trigger when M5 is connected (eliminates 100% of
        // standalone webcam backswing/drift false triggers!). Wait 60 ms so the exact
        // time-aligned MediaPipe frames for [swingStartMs..swingEndMs] have arrived, then
        // run TennisSwingDetector.classifyWindow() directly on THAT exact physical swing!
        if (this.pendingSwingTimer !== null) {
          window.clearTimeout(this.pendingSwingTimer);
        }
        this.pendingImuSwing = { swing, source, receivedMs: now };
        this.pendingSwingTimer = window.setTimeout(() => {
          this.pendingSwingTimer = null;
          const pending = this.pendingImuSwing;
          this.pendingImuSwing = null;
          if (!pending) return;
          const nowTs = performance.now();

          // Run backswing-prep veto on the time-aligned forward-stroke frames first!
          const armSummary = this.webcam.getSwingArmSummary(
            pending.swing.swingStartMs,
            pending.swing.swingEndMs,
            60,
          );
          const handedness = this.state.arm.handedness;
          const handSign = handedness === 'right' ? 1 : -1;
          const yawSign = this.classifier.getConfig().invertWingYaw ? -1 : 1;
          const rawYawDeg =
            Math.abs(pending.swing.worldYawToPeakDeg) >= 5
              ? pending.swing.worldYawToPeakDeg
              : pending.swing.worldYawAccumDeg;
          const signedSwingYawDeg = rawYawDeg * handSign * yawSign;

          const isForehandBackswingPrep =
            armSummary.hasWebcamData &&
            armSummary.minSignedX >= -0.06 &&
            (signedSwingYawDeg < -7 || (armSummary.signedDeltaX > 0.14 && signedSwingYawDeg < 5));

          const isBackhandBackswingPrep =
            armSummary.hasWebcamData &&
            pending.swing.peakAccelG < 1.35 &&
            pending.swing.swingSpeedMps < 1.95 &&
            armSummary.endSignedX < -0.08 &&
            armSummary.signedDeltaX < -0.14;

          if (isForehandBackswingPrep || isBackhandBackswingPrep) {
            this.classifier.cancelCooldown();
            return;
          }

          // Exact-window battle-tested Tennis-Game-Spec camera contact classification!
          const camRead = this.webcam.swingDetector.classifyWindow(
            pending.swing.swingStartMs + 60,
            pending.swing.swingEndMs + 60,
            this.strikeBallOffsetRightM,
          );
          if (camRead) {
            this.emitMergedWebcamImuSwing(camRead, pending.swing, pending.source, nowTs);
          } else {
            this.finalizeSwing(pending.swing, pending.source, nowTs, 60);
          }
        }, 60);
      } else {
        this.finalizeSwing(swing, source, now, 0);
      }
    } else {
      this.state.shotType = this.classifier.getLastShotType();
    }
  }

  /**
   * Standalone Webcam TennisSwingDetector handler:
   * - When M5 IMU IS connected: DO NOT standalone-fire on webcam arm movements (prevents
   *   backswing prep or arm positioning from firing fake shots and swallowing the real swing!).
   *   M5 BLE gyro peak triggers the exact time-aligned `classifyWindow()` read instead!
   * - When M5 IMU is NOT connected (webcam-only mode): emits swings directly so the game
   *   still works seamlessly with just a laptop webcam!
   */
  private handleWebcamSwing(camSwing: DetectedWebcamSwing) {
    if (!this.strikeWindowOpen) return;
    const now = performance.now();
    const imuLive = now - this.lastImuPacketMs < 1200;
    if (imuLive) {
      // M5 BLE is the sole swing trigger when connected — ignore standalone webcam triggers!
      return;
    }

    if (now - this.lastSwingMs < 360) return;

    this.lastSwingMs = now;
    this.state.shotType = camSwing.shotType;

    this.emitSwing({
      id: ++this.swingCounter,
      timestampMs: Date.now(),
      shotType: camSwing.shotType,
      wing: camSwing.wing,
      armZone: camSwing.armZone,
      armX: camSwing.armX,
      power: clamp(camSwing.power, 0.18, 1),
      rotation: clamp(camSwing.rotation, -1, 1),
      angle: clamp(camSwing.angle, -1, 1),
      confidence: clamp(camSwing.confidence, 0.55, 0.97),
      peakAccelG: 0,
      peakGyroDps: 0,
      source: 'keyboard',
    });
  }

  /**
   * Merges battle-tested Webcam exact-window classification (`wing`, `shotType`, `rotation`, `angle`)
   * with M5 BLE 220°/s gyro-peak power & IMU tie-breaking for neutral-center strokes.
   */
  private emitMergedWebcamImuSwing(
    camSwing: DetectedWebcamSwing,
    imuSwing: RawClassifiedSwing,
    source: 'm5_ble' | 'm5_serial' | 'm5_ws',
    now: number,
  ) {
    this.lastSwingMs = now;
    const imuGyroPower = clamp(((imuSwing.peakGyroDps - 200) / 1100) * 0.8 + 0.2, 0.2, 1.0);
    const mergedPower = clamp(0.60 * imuGyroPower + 0.40 * camSwing.power, 0.18, 1);

    // If webcam wingScore was nearly dead-center (|wingScore| < 0.20), let IMU vertical yaw break the tie!
    const imuVote = this.classifier.inferImuWing(imuSwing, this.state.arm.handedness);
    const wing: StrokeWing =
      Math.abs(camSwing.wingScore) < 0.20 && imuVote.confidence >= 0.50
        ? imuVote.wing
        : camSwing.wing;

    // Fuse 6-DOF IMU spin (`vContact.z` + `racketUpAtPeak`) whenever webcam spin cues were ambiguous,
    // and enforce realistic gyro-peak bounds for soft dropshots vs full swings!
    const imuResolved = this.classifier.resolveShot(imuSwing, wing, 0, false, 0, false, 0);
    let shotType = camSwing.shotType;
    let rotation = camSwing.rotation;

    if (camSwing.spinAmbiguous && shotType !== 'dropshot') {
      shotType = imuResolved.shotType;
      rotation = imuResolved.rotation;
    }

    if (
      shotType !== 'dropshot' &&
      imuSwing.peakGyroDps < 300 &&
      imuSwing.swingSpeedMps < 1.55 &&
      camSwing.swingSpeed < 1.1
    ) {
      shotType = 'dropshot';
      rotation = -0.32;
    } else if (shotType === 'dropshot' && imuSwing.peakGyroDps > 360) {
      shotType =
        camSwing.pathAngleDeg < -6
          ? 'slice'
          : imuResolved.shotType !== 'dropshot'
            ? imuResolved.shotType
            : 'topspin';
      rotation = shotType === 'slice' ? -0.48 : 0.48;
    }

    this.state.shotType = shotType;

    this.emitSwing({
      id: ++this.swingCounter,
      timestampMs: Date.now(),
      shotType,
      wing,
      armZone: camSwing.armZone,
      armX: camSwing.armX,
      power: mergedPower,
      rotation: clamp(rotation, -1, 1),
      angle: clamp(camSwing.angle, -1, 1),
      confidence: clamp(Math.max(camSwing.confidence, 0.84), 0.6, 0.98),
      peakAccelG: imuSwing.peakAccelG,
      peakGyroDps: imuSwing.peakGyroDps,
      source,
    });
  }

  private finalizeSwing(
    swing: NonNullable<ReturnType<ImuSwingClassifier['ingest']>>,
    source: 'm5_ble' | 'm5_serial' | 'm5_ws',
    now: number,
    camLagMs: number,
  ) {
    const armSummary = this.webcam.getSwingArmSummary(
      swing.swingStartMs,
      swing.swingEndMs,
      camLagMs,
    );
    const armFallback = this.getState().arm;
    const handedness = this.state.arm.handedness;
    const handSign = handedness === 'right' ? 1 : -1;
    const yawSign = this.classifier.getConfig().invertWingYaw ? -1 : 1;
    const imuVote = this.classifier.inferImuWing(swing, handedness);
    const rawYawDeg =
      Math.abs(swing.worldYawToPeakDeg) >= 5
        ? swing.worldYawToPeakDeg
        : swing.worldYawAccumDeg;
    const signedSwingYawDeg = rawYawDeg * handSign * yawSign;

    // BACKSWING-PREP VETO (on time-aligned camera frames + IMU!):
    // Reject moving backwards to coil/prepare a swing, and immediately cancel cooldown
    // so the player's ACTUAL forward swing 150ms later triggers cleanly!
    const isForehandBackswingPrep =
      armSummary.hasWebcamData &&
      armSummary.minSignedX >= -0.06 &&
      (signedSwingYawDeg < -7 || (armSummary.signedDeltaX > 0.14 && signedSwingYawDeg < 5));

    const isBackhandBackswingPrep =
      armSummary.hasWebcamData &&
      swing.peakAccelG < 1.35 &&
      swing.swingSpeedMps < 1.95 &&
      armSummary.endSignedX < -0.08 &&
      armSummary.signedDeltaX < -0.14;

    const isImuOnlyBackswingPrep =
      !armSummary.hasWebcamData &&
      Math.abs(swing.preSwingRelYawDeg) < 10 &&
      Math.abs(rawYawDeg) > 26 &&
      swing.peakAccelG < 1.10;

    if (isForehandBackswingPrep || isBackhandBackswingPrep || isImuOnlyBackswingPrep) {
      this.classifier.cancelCooldown();
      return;
    }

    this.lastSwingMs = now;

    let wing: StrokeWing;
    let armZone: ArmZone;
    let armX: number;

    if (armSummary.hasWebcamData) {
      // CAMERA-PRIMARY + IMU TIE-BREAKER FUSION:
      // When time-aligned webcam clearly sees FH or BH (wingConfidence >= 0.65),
      // camera leads strongly (1.2x weight), while IMU yaw (0.45x weight) reinforces
      // agreement and cleanly breaks ties when starting from neutral center!
      const camDir = armSummary.wing === 'forehand' ? 1 : -1;
      const imuDir = imuVote.wing === 'forehand' ? 1 : -1;
      const camWeight =
        armSummary.wingConfidence >= 0.65
          ? armSummary.wingConfidence * 1.2
          : armSummary.wingConfidence * 0.75;
      const imuWeight =
        armSummary.wingConfidence >= 0.65
          ? imuVote.confidence * 0.45
          : imuVote.confidence * 0.85;
      const fusedScore = camDir * camWeight + imuDir * imuWeight;
      wing = fusedScore >= 0 ? 'forehand' : 'backhand';
      armZone = armSummary.armZone;
      armX = armSummary.armX;
    } else if (imuVote.confidence >= 0.35) {
      // IMU-only mode (webcam off): pure 6-DOF world-vertical yaw cleanly classifies FH vs BH!
      wing = imuVote.wing;
      const sideSign = wing === 'forehand' ? handSign : -handSign;
      armZone = sideSign > 0 ? 'right' : 'left';
      armX = sideSign * 0.65;
    } else {
      wing = armFallback.wing;
      armZone = armFallback.armZone;
      armX = armFallback.armX;
    }

    // Camera-Primary (70%) + IMU (30%) 6-Combo Shot Resolution!
    const resolved = this.classifier.resolveShot(
      swing,
      wing,
      armSummary.deltaArmY,
      armSummary.hasWebcamData,
      armSummary.peakWristSpeed,
      true,
      armSummary.strokePathSw,
    );

    this.state.shotType = resolved.shotType;

    this.emitSwing({
      id: ++this.swingCounter,
      timestampMs: Date.now(),
      shotType: resolved.shotType,
      wing,
      armZone,
      armX,
      power: resolved.power,
      rotation: resolved.rotation,
      angle: resolved.angle,
      confidence: resolved.confidence,
      peakAccelG: swing.peakAccelG,
      peakGyroDps: swing.peakGyroDps,
      source,
    });
  }

  private emitSwing(evt: PlayerSwingEvent) {
    for (const cb of this.swingListeners) cb(evt);
  }

  private emitSwingStart(evt: PlayerSwingStartEvent) {
    for (const cb of this.swingStartListeners) cb(evt);
  }

  private notifyState() {
    for (const cb of this.stateListeners) cb(this.state);
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    this.keys.add(e.code);
    if (e.code === 'Digit1') this.setShotType('topspin');
    else if (e.code === 'Digit2') this.setShotType('slice');
    else if (e.code === 'Digit3') this.setShotType('dropshot');
    else if (e.code === 'KeyR' && !e.repeat && !e.shiftKey && !e.metaKey && !e.ctrlKey) this.recenter();
    else if (e.code === 'Space') {
      e.preventDefault();
      this.triggerManualSwing();
    }
  };

  private handleKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private handleMouseMove = (e: MouseEvent) => {
    if (performance.now() - this.lastImuPacketMs < 1200) return;
    const normX = (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1;
    const normY = 1 - e.clientY / Math.max(1, window.innerHeight);
    this.state.gyro.angle = clamp(normX * 1.15, -1, 1);
    this.state.gyro.power = clamp(0.35 + normY * 0.65, 0.25, 1);
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// One manager per page, kept across hot reloads of this file so a code update never drops the racket link.
const hardwareHolder = globalThis as { __tennisHardwareInput?: HardwareInputManager };
export const hardwareInput: HardwareInputManager =
  hardwareHolder.__tennisHardwareInput ?? (hardwareHolder.__tennisHardwareInput = new HardwareInputManager());
