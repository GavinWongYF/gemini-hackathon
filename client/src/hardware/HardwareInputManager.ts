import type {
  ArmZone,
  HumanShotType,
  PlayerControlState,
  PlayerSwingEvent,
  RawImuSample,
  StrokeWing,
} from '@shared/contracts';
import {
  ImuSwingClassifier,
  type ImuClassifierConfig,
} from './ImuSwingClassifier';
import { WebcamArmTracker } from './WebcamArmTracker';

type SwingListener = (evt: PlayerSwingEvent) => void;
type StateListener = (state: PlayerControlState) => void;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// BLE GATT UUIDs matching m5_tennis_imu.ino
const M5_BLE_SERVICE_UUID = '19b10000-e8f2-537e-4f6c-d104768a1214';
const M5_BLE_IMU_CHAR_UUID = '19b10001-e8f2-537e-4f6c-d104768a1214';
const M5_BLE_CMD_CHAR_UUID = '19b10002-e8f2-537e-4f6c-d104768a1214';

interface IncomingPacket {
  type?: 'imu' | 'info' | 'control' | 'swing' | 'ping';
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
  open: (opts: { baudRate: number }) => Promise<void>;
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
  private stateListeners = new Set<StateListener>();
  private keys = new Set<string>();

  private ws: WebSocket | null = null;
  private wsReconnectTimer: number | null = null;

  private serialWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private serialActive = false;

  private bleDevice: BleDeviceLike | null = null;
  private bleCmdChar: BleCharacteristicLike | null = null;
  private bleActive = false;

  private swingCounter = 0;
  private lastSwingMs = 0;
  private lastImuPacketMs = 0;
  private imuPacketTimestamps: number[] = [];
  private started = false;
  private trainingTarget: HumanShotType | null = null;

  start(wsUrl?: string) {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('mousemove', this.handleMouseMove);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const targetUrl = wsUrl ?? `${protocol}//${window.location.host}/ws-hardware`;
    this.connectWebSocket(targetUrl);
  }

  stop() {
    if (!this.started || typeof window === 'undefined') return;
    this.started = false;
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('mousemove', this.handleMouseMove);
    if (this.wsReconnectTimer !== null) {
      window.clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
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

  /** Fires on connection/mode changes (NOT on every 100 Hz packet). */
  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  zeroRacket() {
    this.classifier.startZeroing();
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

  recenter() {
    this.zeroRacket();
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

  setTrainingTarget(target: HumanShotType | null) {
    this.trainingTarget = target;
    this.notifyState();
  }

  getTrainingTarget(): HumanShotType | null {
    return this.trainingTarget;
  }

  clearShotTraining() {
    this.trainingTarget = null;
    this.classifier.clearTraining();
    this.notifyState();
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
   */
  async connectBle(): Promise<{ ok: boolean; error?: string }> {
    const nav = navigator as Navigator & {
      bluetooth?: {
        requestDevice: (opts: {
          filters: Array<{ services?: string[]; namePrefix?: string }>;
          optionalServices?: string[];
        }) => Promise<BleDeviceLike>;
      };
    };

    if (!nav.bluetooth) {
      return {
        ok: false,
        error: 'Web Bluetooth unavailable — open http://localhost:5173 in Chrome or Edge.',
      };
    }

    try {
      this.disconnectBle();

      const device = await nav.bluetooth.requestDevice({
        filters: [{ services: [M5_BLE_SERVICE_UUID] }, { namePrefix: 'M5-TENNIS' }],
        optionalServices: [M5_BLE_SERVICE_UUID],
      });

      this.bleDevice = device;
      device.addEventListener('gattserverdisconnected', () => {
        this.bleActive = false;
        this.bleCmdChar = null;
        this.state.imuConnected = false;
        this.notifyState();
      });

      if (!device.gatt) return { ok: false, error: 'Selected BLE device has no GATT server.' };
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(M5_BLE_SERVICE_UUID);
      const imuChar = await service.getCharacteristic(M5_BLE_IMU_CHAR_UUID);
      try {
        this.bleCmdChar = await service.getCharacteristic(M5_BLE_CMD_CHAR_UUID);
      } catch {
        this.bleCmdChar = null;
      }

      imuChar.addEventListener('characteristicvaluechanged', (ev: Event) => {
        const target = ev.target as BleCharacteristicLike;
        const dv = target.value;
        if (!dv || dv.byteLength < 13) return;
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

      await imuChar.startNotifications();
      this.bleActive = true;
      this.state.source = 'm5_ble';
      this.state.imuConnected = true;
      this.state.deviceInfo = `${device.name ?? 'M5-TENNIS-IMU'} • Wireless BLE`;
      this.notifyState();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  disconnectBle() {
    if (this.bleDevice?.gatt?.connected) {
      this.bleDevice.gatt.disconnect();
    }
    this.bleDevice = null;
    this.bleCmdChar = null;
    this.bleActive = false;
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
   * Direct Chrome Web Serial connection to M5 over USB-C (115200 baud).
   */
  async connectSerial(baudRate = 115200): Promise<boolean> {
    const nav = navigator as Navigator & {
      serial?: { requestPort: () => Promise<SerialPortLike> };
    };
    if (!nav.serial) {
      console.warn('[Hardware] Web Serial API unavailable — use Chrome/Edge.');
      return false;
    }

    try {
      const port = await nav.serial.requestPort();
      await port.open({ baudRate });
      this.serialActive = true;
      this.state.source = 'm5_serial';
      this.state.imuConnected = true;

      if (port.writable) {
        this.serialWriter = port.writable.getWriter();
        void this.sendSerialCommand('INFO');
      }

      this.notifyState();

      if (port.readable) {
        const decoder = new TextDecoderStream();
        void port.readable.pipeTo(decoder.writable);
        const reader = decoder.readable.getReader();
        let buffer = '';

        const pump = async () => {
          try {
            while (this.serialActive) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += value;
              let idx = buffer.indexOf('\n');
              while (idx !== -1) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (line) this.parseIncomingLine(line, 'm5_serial');
                idx = buffer.indexOf('\n');
              }
            }
          } catch (err) {
            console.warn('[Hardware] Serial stream closed:', err);
          } finally {
            this.serialActive = false;
            this.serialWriter = null;
            this.state.imuConnected = false;
            this.notifyState();
          }
        };
        void pump();
      }
      return true;
    } catch (err) {
      console.warn('[Hardware] Serial connect cancelled/failed:', err);
      return false;
    }
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
    // Prefer wireless BLE if both BLE and Serial happen to be open simultaneously
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

    const swing = this.classifier.ingest(sample, now);
    this.state.gyro = this.classifier.getLatestReading();
    this.state.calibration = this.classifier.getCalibrationPhase();
    this.state.calibrationProgress = this.classifier.getCalibrationProgress();

    if (!wasConnected) {
      this.notifyState();
    }

    if (swing) {
      this.lastSwingMs = now;
      // Resolve true pre-swing Forehand vs Backhand & vertical swing path (never fooled by follow-through!)
      const armSummary = this.webcam.getSwingArmSummary(swing.swingStartMs, swing.swingEndMs);
      const armFallback = this.getState().arm;
      const wing = armSummary.hasWebcamData ? armSummary.wing : armFallback.wing;
      const armZone = armSummary.hasWebcamData ? armSummary.armZone : armFallback.armZone;
      const armX = armSummary.hasWebcamData ? armSummary.armX : armFallback.armX;

      // Refine shot type (topspin / slice / dropshot) using wing-corrected racket face + webcam ΔarmY!
      const resolved = this.classifier.resolveShot(
        swing,
        wing,
        armSummary.deltaArmY,
        armSummary.hasWebcamData,
      );

      let finalShotType = resolved.shotType;
      let finalConfidence = resolved.confidence;
      if (this.trainingTarget) {
        this.classifier.addTrainingExample(this.trainingTarget, resolved.features);
        finalShotType = this.trainingTarget;
        finalConfidence = 1.0;
        this.trainingTarget = null;
        this.notifyState();
      }

      this.state.shotType = finalShotType;

      this.emitSwing({
        id: ++this.swingCounter,
        timestampMs: Date.now(),
        shotType: finalShotType,
        wing,
        armZone,
        armX,
        power: swing.power,
        rotation: resolved.rotation,
        angle: swing.angle,
        confidence: finalConfidence,
        peakAccelG: swing.peakAccelG,
        peakGyroDps: swing.peakGyroDps,
        source,
      });
    } else {
      this.state.shotType = this.classifier.getLastShotType();
    }
  }

  private emitSwing(evt: PlayerSwingEvent) {
    for (const cb of this.swingListeners) cb(evt);
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
    else if (e.code === 'KeyR') this.recenter();
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

export const hardwareInput = new HardwareInputManager();
