/**
 * 6-DOF Madgwick Quaternion AHRS tailored for the M5Stack MPU6886 100 Hz tennis IMU.
 *
 * Pure TypeScript (zero React / DOM / Three.js imports) so it runs identically in the
 * browser and headlessly in Node.
 *
 * Frame convention:
 * - Body frame B: raw MPU6886 sensor axes (accel in g, gyro in deg/s).
 *   At rest, the accelerometer measures proper acceleration pointing world UP (+Z_W).
 * - World frame W: Z_W points straight UP (opposite gravity).
 * - Quaternion q = { w, x, y, z } transforms body-frame vectors into world-frame vectors:
 *     v_world = rotateVecByQuat(q, v_body) = q * (0, v_body) * q*
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quaternion {
  w: number;
  x: number;
  y: number;
  z: number;
}

export interface AhrsOutput {
  /** Normalized body-to-world orientation quaternion */
  q: Quaternion;
  /** Gravity-free 3D linear acceleration in world frame (g) */
  worldLinearAccel: Vec3;
  /** Magnitude of 3D world linear acceleration (g) */
  worldLinearAccelMag: number;
  /** Angular velocity rotated into world frame (deg/s); z = world-vertical yaw rate */
  worldGyro: Vec3;
  /** M5 screen normal [0, 0, 1]_body rotated into world frame (z > 0 open/skyward, z < 0 closed/floorward) */
  worldFaceNormal: Vec3;
  /** Relative screen face tilt in degrees vs. ZERO pose (+ open/skyward, - closed/floorward) */
  faceTiltDeg: number;
}

export interface MadgwickAhrsConfig {
  /** Madgwick gain when static (magErr < gateLowG) */
  betaStatic: number;
  /** Madgwick gain at upper edge of ramp (magErr approaching gateHighG) */
  betaRamped: number;
  /** Lower dynamic accel magnitude error threshold (g) where beta begins ramping down */
  gateLowG: number;
  /** Upper dynamic accel magnitude error threshold (g) above which beta = 0 (pure gyro) */
  gateHighG: number;
}

export const DEFAULT_MADGWICK_CONFIG: MadgwickAhrsConfig = {
  betaStatic: 0.08,
  betaRamped: 0.015,
  gateLowG: 0.18,
  gateHighG: 0.35,
};

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const MAX_DT_SEC = 0.2;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function rotateVecByQuat(q: Quaternion, vx: number, vy: number, vz: number): Vec3 {
  // Fast quaternion-vector rotation: v' = v + w * t + cross(q.xyz, t), t = 2 * cross(q.xyz, v)
  const tx = 2 * (q.y * vz - q.z * vy);
  const ty = 2 * (q.z * vx - q.x * vz);
  const tz = 2 * (q.x * vy - q.y * vx);

  return {
    x: vx + q.w * tx + (q.y * tz - q.z * ty),
    y: vy + q.w * ty + (q.z * tx - q.x * tz),
    z: vz + q.w * tz + (q.x * ty - q.y * tx),
  };
}

export class MadgwickAhrs {
  private readonly config: MadgwickAhrsConfig;

  private qw = 1;
  private qx = 0;
  private qy = 0;
  private qz = 0;

  private restAccelMag = 1.0;
  private restFaceNormal: Vec3 = { x: 0, y: -1, z: 0 };
  private restFaceTiltDeg = 0;

  constructor(config?: Partial<MadgwickAhrsConfig>) {
    this.config = { ...DEFAULT_MADGWICK_CONFIG, ...config };
  }

  /**
   * Reset orientation and ZERO reference state back to defaults.
   */
  reset(): void {
    this.qw = 1;
    this.qx = 0;
    this.qy = 0;
    this.qz = 0;
    this.restAccelMag = 1.0;
    this.restFaceNormal = { x: 0, y: -1, z: 0 };
    this.restFaceTiltDeg = 0;
  }

  /**
   * Returns the calibrated resting accelerometer magnitude recorded during `alignToZero` (g).
   */
  getRestAccelMag(): number {
    return this.restAccelMag;
  }

  /**
   * Returns a copy of the current normalized orientation quaternion.
   */
  getQuaternion(): Quaternion {
    return { w: this.qw, x: this.qx, y: this.qy, z: this.qz };
  }

  /**
   * Returns the M5 screen normal [0, 0, 1]_body rotated into world frame.
   */
  worldFaceNormal(): Vec3 {
    return rotateVecByQuat(
      { w: this.qw, x: this.qx, y: this.qy, z: this.qz },
      0,
      0,
      1,
    );
  }

  /**
   * Returns the resting screen normal captured during `alignToZero`.
   */
  getRestFaceNormal(): Vec3 {
    return { ...this.restFaceNormal };
  }

  /**
   * Align the AHRS to the player's resting ZERO pose.
   *
   * Records the sensor's resting gravity magnitude (`restAccelMag`) to tolerate
   * MPU6886 axis scale bias (~0.83–1.10g), computes the shortest-arc quaternion
   * mapping `[meanAx, meanAy, meanAz]` directly onto world UP `[0, 0, +restAccelMag]`,
   * and captures the resting screen normal & tilt for relative `faceTiltDeg`.
   */
  alignToZero(meanAx: number, meanAy: number, meanAz: number): void {
    const rawMag = Math.hypot(meanAx, meanAy, meanAz);
    this.restAccelMag = Math.max(0.2, rawMag);

    if (rawMag < 1e-6) {
      this.qw = 1;
      this.qx = 0;
      this.qy = 0;
      this.qz = 0;
    } else {
      const ux = meanAx / rawMag;
      const uy = meanAy / rawMag;
      const uz = meanAz / rawMag;

      // Shortest-arc quaternion from u = (ux, uy, uz) to world UP v = (0, 0, 1):
      // dot(u, v) = uz, cross(u, v) = (uy, -ux, 0)
      if (uz > -0.999999) {
        const w = 1 + uz;
        const x = uy;
        const y = -ux;
        const z = 0;
        const norm = Math.hypot(w, x, y, z);
        this.qw = w / norm;
        this.qx = x / norm;
        this.qy = y / norm;
        this.qz = z / norm;
      } else {
        // Antipodal case: u ≈ (0, 0, -1), rotate 180° around X axis
        this.qw = 0;
        this.qx = 1;
        this.qy = 0;
        this.qz = 0;
      }
    }

    const normal = this.worldFaceNormal();
    this.restFaceNormal = normal;
    this.restFaceTiltDeg = Math.asin(clamp(normal.z, -1, 1)) * RAD_TO_DEG;
  }

  /**
   * Advance the 6-DOF Madgwick filter by one sample.
   *
   * @param ax Body X acceleration (g)
   * @param ay Body Y acceleration (g)
   * @param az Body Z acceleration (g)
   * @param gxDps Bias-corrected body X angular rate (deg/s)
   * @param gyDps Bias-corrected body Y angular rate (deg/s)
   * @param gzDps Bias-corrected body Z angular rate (deg/s)
   * @param dtSec Time step since previous sample (seconds)
   */
  update(
    ax: number,
    ay: number,
    az: number,
    gxDps: number,
    gyDps: number,
    gzDps: number,
    dtSec: number,
  ): AhrsOutput {
    const dt = Number.isFinite(dtSec) && dtSec > 0 ? Math.min(dtSec, MAX_DT_SEC) : 0;

    const accMag = Math.hypot(ax, ay, az);
    const magErr = Math.abs(accMag - this.restAccelMag);

    // Dynamic acceleration gating for Madgwick gain beta
    let beta = 0;
    if (accMag > 1e-6) {
      if (magErr < this.config.gateLowG) {
        beta = this.config.betaStatic;
      } else if (magErr < this.config.gateHighG) {
        const span = Math.max(1e-6, this.config.gateHighG - this.config.gateLowG);
        const t = (magErr - this.config.gateLowG) / span;
        beta = this.config.betaStatic + t * (this.config.betaRamped - this.config.betaStatic);
      } else {
        beta = 0;
      }
    }

    if (dt > 0) {
      const gx = gxDps * DEG_TO_RAD;
      const gy = gyDps * DEG_TO_RAD;
      const gz = gzDps * DEG_TO_RAD;

      // Step 1: Exact axis-angle gyro propagation from t_{k-1} to t_k
      // (zero discretization drift even during fast high-G tennis swings).
      let qw = this.qw;
      let qx = this.qx;
      let qy = this.qy;
      let qz = this.qz;

      const omegaMag = Math.hypot(gx, gy, gz);
      if (omegaMag > 1e-9) {
        const halfAngle = 0.5 * omegaMag * dt;
        const s = Math.sin(halfAngle) / omegaMag;
        const dw = Math.cos(halfAngle);
        const dx = gx * s;
        const dy = gy * s;
        const dz = gz * s;

        const pw = qw * dw - qx * dx - qy * dy - qz * dz;
        const px = qw * dx + qx * dw + qy * dz - qz * dy;
        const py = qw * dy - qx * dz + qy * dw + qz * dx;
        const pz = qw * dz + qx * dy - qy * dx + qz * dw;

        const invPredNorm = 1 / Math.hypot(pw, px, py, pz);
        qw = pw * invPredNorm;
        qx = px * invPredNorm;
        qy = py * invPredNorm;
        qz = pz * invPredNorm;
      }

      // Step 2: Madgwick gradient-descent gravity correction at t_k (when not gated off)
      if (beta > 0) {
        const invAcc = 1 / accMag;
        const nax = ax * invAcc;
        const nay = ay * invAcc;
        const naz = az * invAcc;

        // Objective function f = g_body(q) - a_hat, where g_body(q) = q* * (0, 0, 0, 1) * q
        const f1 = 2 * (qx * qz - qw * qy) - nax;
        const f2 = 2 * (qw * qx + qy * qz) - nay;
        const f3 = 2 * (0.5 - qx * qx - qy * qy) - naz;

        // Gradient s = J^T * f
        const sw = -2 * qy * f1 + 2 * qx * f2;
        const sx = 2 * qz * f1 + 2 * qw * f2 - 4 * qx * f3;
        const sy = -2 * qw * f1 + 2 * qz * f2 - 4 * qy * f3;
        const sz = 2 * qx * f1 + 2 * qy * f2;

        const sNorm = Math.hypot(sw, sx, sy, sz);
        if (sNorm > 1e-9) {
          const step = (beta * dt) / sNorm;
          qw -= sw * step;
          qx -= sx * step;
          qy -= sy * step;
          qz -= sz * step;

          const invNorm = 1 / Math.hypot(qw, qx, qy, qz);
          qw *= invNorm;
          qx *= invNorm;
          qy *= invNorm;
          qz *= invNorm;
        }
      }

      this.qw = qw;
      this.qx = qx;
      this.qy = qy;
      this.qz = qz;
    }

    const q: Quaternion = { w: this.qw, x: this.qx, y: this.qy, z: this.qz };

    // Rotate raw accel into world frame and subtract calibrated gravity along +Z_world
    const worldAccel = rotateVecByQuat(q, ax, ay, az);
    const worldLinearAccel: Vec3 = {
      x: worldAccel.x,
      y: worldAccel.y,
      z: worldAccel.z - this.restAccelMag,
    };
    const worldLinearAccelMag = Math.hypot(
      worldLinearAccel.x,
      worldLinearAccel.y,
      worldLinearAccel.z,
    );

    // Rotate gyro into world frame (worldGyro.z = exact world-vertical yaw rate)
    const worldGyro = rotateVecByQuat(q, gxDps, gyDps, gzDps);

    // Screen normal in world frame and relative face tilt vs. ZERO pose
    const worldFaceNormal = rotateVecByQuat(q, 0, 0, 1);
    const faceTiltDeg =
      Math.asin(clamp(worldFaceNormal.z, -1, 1)) * RAD_TO_DEG - this.restFaceTiltDeg;

    return {
      q,
      worldLinearAccel,
      worldLinearAccelMag,
      worldGyro,
      worldFaceNormal,
      faceTiltDeg,
    };
  }
}
