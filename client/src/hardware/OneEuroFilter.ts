/**
 * Adaptive One Euro Filter — smooths noisy sensor signals while keeping
 * near-zero lag during fast tennis swings.
 */
export class OneEuroFilter {
  private prevValue: number | null = null;
  private prevDeriv = 0;
  private prevTimeMs: number | null = null;

  constructor(
    private minCutoff = 1.6,
    private beta = 0.08,
    private dCutoff = 1.0,
  ) {}

  reset(value?: number) {
    this.prevValue = value ?? null;
    this.prevDeriv = 0;
    this.prevTimeMs = null;
  }

  filter(value: number, timestampMs: number): number {
    if (this.prevValue === null || this.prevTimeMs === null) {
      this.prevValue = value;
      this.prevTimeMs = timestampMs;
      return value;
    }

    const dtSec = Math.max(0.001, (timestampMs - this.prevTimeMs) / 1000);
    this.prevTimeMs = timestampMs;

    const rawDeriv = (value - this.prevValue) / dtSec;
    const alphaD = this.alpha(this.dCutoff, dtSec);
    const smoothedDeriv = alphaD * rawDeriv + (1 - alphaD) * this.prevDeriv;
    this.prevDeriv = smoothedDeriv;

    const cutoff = this.minCutoff + this.beta * Math.abs(smoothedDeriv);
    const alphaX = this.alpha(cutoff, dtSec);
    const filtered = alphaX * value + (1 - alphaX) * this.prevValue;
    this.prevValue = filtered;
    return filtered;
  }

  private alpha(cutoffHz: number, dtSec: number): number {
    const tau = 1 / (2 * Math.PI * cutoffHz);
    return 1 / (1 + tau / dtSec);
  }
}
