// ─────────────────────────────────────────────────────────────────────────
// bridge.ts — AgentBridge: the browser side of the game↔agent contract.
//
//  • one WebSocket to ws://localhost:8000/ws, reconnect with backoff, never blocks
//    the game (all sends are fire-and-forget; nothing awaits the agents in a frame);
//  • setup → wait for ready (90 s → baseline/stand-in); same setup on reconnect;
//  • forwards events, ~1 Hz 384 px JPEG frames of the WebGL canvas (only while a
//    round is live), round_end; receives player_read / strategy_update;
//  • behaviour swaps ONLY between rounds: an update that lands mid-round is queued
//    and applied at the next round end, before the next round is planned;
//  • every update goes through the self-check first (selfcheck.ts);
//  • no server → the OFFLINE STAND-IN (standin.ts) produces the updates, labelled
//    "offline_standin" everywhere (never presented as Gemini);
//  • latency per message type is recorded (getLatencyReport()).
// ─────────────────────────────────────────────────────────────────────────

import { setBrain } from "./brain";
import { useAgentStatus } from "./status";
import { makeAdaptiveBrain } from "./adaptiveBrain";
import { deepClone, type AgentPlayerReadMessage, type AgentReadyMessage, type AgentStrategyUpdateMessage, type BehaviourJson, type EventData, type GameEventMessage, type GameSetupMessage } from "./protocol";
import { BASELINE_AGENT_SETTINGS, valorSetup, type AgentSettings } from "./setup";
import { chooseCandidate, type CheckLogEntry } from "./selfcheck";
import { OfflineStandin, STANDIN_VALUES, type Candidate } from "./standin";
import { captureCanvasJpeg } from "./frames";

export interface BridgeOptions {
  url?: string;
  canvas?: HTMLCanvasElement | null;
  matchId?: string;
  readyTimeoutMs?: number;
  /** Sims per brain in the fairness check (browser default is lighter than the harness). */
  checkN?: number;
}

type Phase = "warmup" | "live" | "round_end" | "match_end";
const now = () => performance.now();
const pctl = (xs: number[], q: number) => (xs.length ? +xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))].toFixed(1) : null);

export class AgentBridge {
  private ws: WebSocket | null = null;
  private url = "ws://localhost:8000/ws";
  private canvas: HTMLCanvasElement | null = null;
  private matchId = `valor_${Date.now().toString(36)}`;
  private setup!: GameSetupMessage;
  private ready = false;
  private backoff = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private phase: Phase = "warmup";
  private round = 1;
  private t0 = now();
  private checkN = 40;
  private readyTimeoutMs = 90_000;

  private behaviour: BehaviourJson = valorSetup({ matchId: "x" }).default_behaviour!;
  private settings: AgentSettings = { ...BASELINE_AGENT_SETTINGS };
  private values: Record<string, number> = {};
  private knownValues: string[] = Object.keys(STANDIN_VALUES);
  private pending: { update: AgentStrategyUpdateMessage; label: string; candidates?: Candidate[] } | null = null;
  private standin: OfflineStandin;
  readonly checkLog: CheckLogEntry[] = [];
  private lat = { read: [] as number[], quick: [] as number[], full: [] as number[], call: [] as number[], capture: [] as number[], frameBytes: [] as number[], selfcheck: [] as number[], framesSent: 0 };
  private lastPlayerEventAt = 0;
  private roundEndAt = 0;
  private gotQuick = false;
  private gotFull = false;

  constructor() {
    this.standin = new OfflineStandin(this.matchId, BASELINE_AGENT_SETTINGS);
  }

  /** Start once (idempotent). Safe to call before the canvas exists. */
  start(o: BridgeOptions = {}) {
    if (o.canvas) this.canvas = o.canvas;
    if (this.started) return;
    this.started = true;
    if (o.url) this.url = o.url;
    if (o.matchId) this.matchId = o.matchId;
    if (o.checkN) this.checkN = o.checkN;
    if (o.readyTimeoutMs) this.readyTimeoutMs = o.readyTimeoutMs;
    this.setup = valorSetup({ matchId: this.matchId, mode: "live" });
    this.standin = new OfflineStandin(this.matchId, this.settings);
    this.enterStandin("starting — waiting for the agent server");
    this.connect();
    this.frameTimer = setInterval(() => this.sendFrame(), 1000);
  }

  stop() {
    this.started = false;
    if (this.frameTimer) clearInterval(this.frameTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.ws?.close();
    this.ws = null;
  }

  setCanvas(c: HTMLCanvasElement | null) {
    this.canvas = c;
  }

  // ── game → agents ───────────────────────────────────────────────────────
  /** A declared event happened (`name` from setup.events). by = "player" or "red". */
  onEvent(name: string, data: EventData, by = "player", picked?: Record<string, string>, byRule?: string[]) {
    const c0 = now();
    const ev: GameEventMessage = { type: "event", match_id: this.matchId, name, round: this.round, t: this.t(), by, data, picked, by_rule: byRule };
    if (this.isLive()) {
      this.send(ev);
      if (by === "player") this.lastPlayerEventAt = now();
    }
    // the stand-in always counts (cheap) so it can take over instantly if the server drops
    const read = this.standin.onEvent(ev, this.round);
    if (read && !this.isLive()) this.applyPlayerRead(read);
    this.lat.call.push(now() - c0);
    if (this.lat.call.length > 2000) this.lat.call.splice(0, 1000);
  }

  /** A round went live (call after the round's red plans are made). */
  onRoundStart(round: number, redPicks: Array<{ position: string; target: string; style: string; byRule: boolean }> = []) {
    this.round = round;
    this.phase = "live";
    redPicks.forEach((p, i) => this.onEvent("round_start", { enemy_index: i }, "red", { position: p.position, target: p.target, style: p.style }, p.byRule ? ["position"] : []));
  }

  /** The round ended. winner: "player" (blue won) or "red". Applies queued updates (between rounds). */
  onRoundEnd(r: { round: number; winner: "player" | "red" | "none"; how: string; stats?: Record<string, number>; score: { player: number; red: number }; isBreak?: boolean }) {
    this.phase = "round_end";
    const msg = { type: "round_end" as const, match_id: this.matchId, round: r.round, t: this.t(), winner: r.winner, how: r.how, stats: r.stats, score: r.score, break: r.isBreak ?? true };
    this.roundEndAt = now();
    this.gotQuick = this.gotFull = false;
    if (this.isLive()) this.send(msg);
    // stand-in runs on every round so its habit counts stay current; its output is used only offline
    const cands = this.standin.onRoundEnd(msg);
    if (this.pending) this.applyPending(); // a Gemini update that landed during the round
    if (!this.isLive() && cands.length) {
      // off the frame: the round is over, the banner is up (ROUND_END_MS)
      setTimeout(() => this.checkAndApply(cands, "offline_standin"), 0);
    }
  }

  onMatchEnd() {
    this.phase = "match_end";
  }

  // ── status / latency ────────────────────────────────────────────────────
  getLatencyReport() {
    const L = this.lat;
    return {
      event_to_player_read_ms: { p50: pctl(L.read, 0.5), p95: pctl(L.read, 0.95), n: L.read.length },
      round_end_to_quick_update_ms: { p50: pctl(L.quick, 0.5), p95: pctl(L.quick, 0.95), n: L.quick.length },
      round_end_to_full_update_ms: { p50: pctl(L.full, 0.5), p95: pctl(L.full, 0.95), n: L.full.length },
      frames: { sent: L.framesSent, bytes_p50: pctl(L.frameBytes, 0.5), capture_ms_p50: pctl(L.capture, 0.5), capture_ms_p95: pctl(L.capture, 0.95) },
      game_side_call_ms: { p50: pctl(L.call, 0.5), p95: pctl(L.call, 0.95), n: L.call.length },
      selfcheck_ms: { p50: pctl(L.selfcheck, 0.5), p95: pctl(L.selfcheck, 0.95), n: L.selfcheck.length },
    };
  }

  // ── internals ───────────────────────────────────────────────────────────
  private t() {
    return Math.round((now() - this.t0) / 100) / 10;
  }
  private isLive() {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }
  private send(m: object) {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
    } catch {
      /* never let the agents break the game */
    }
  }

  private connect() {
    if (!this.started) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      return this.scheduleReconnect();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      useAgentStatus.getState().set({ connected: true });
      this.send(this.setup); // same match_id on reconnect → the agents pick up where they were
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = setTimeout(() => {
        if (!this.ready) this.enterStandin("no ready within 90 s");
      }, this.readyTimeoutMs);
    };
    ws.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(String(e.data)));
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      const wasReady = this.ready;
      this.ready = false;
      useAgentStatus.getState().set({ connected: false });
      if (wasReady) this.enterStandin("connection lost");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }
  private scheduleReconnect() {
    if (!this.started || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30_000);
  }

  private onMessage(m: { type: string } & Record<string, unknown>) {
    if (m.type === "ready") {
      const r = m as unknown as AgentReadyMessage;
      this.ready = true;
      this.knownValues = Object.keys(r.values ?? {});
      useAgentStatus.getState().set({ mode: "live_gemini", connected: true, source: null });
      // the first behaviour is applied like any other: checked, and only between rounds
      this.queue({ type: "strategy_update", match_id: this.matchId, version: r.behaviour?.version ?? 1, source: "full", observations: [], plan: ["First behaviour from the agents."], changes: [], behaviour: r.behaviour }, "ready");
    } else if (m.type === "player_read") {
      if (this.lastPlayerEventAt) this.lat.read.push(now() - this.lastPlayerEventAt);
      this.applyPlayerRead(m as unknown as AgentPlayerReadMessage);
    } else if (m.type === "strategy_update") {
      const u = m as unknown as AgentStrategyUpdateMessage;
      if (this.roundEndAt) {
        if (u.source === "full" && !this.gotFull) (this.gotFull = true), this.lat.full.push(now() - this.roundEndAt);
        if (u.source !== "full" && !this.gotQuick) (this.gotQuick = true), this.lat.quick.push(now() - this.roundEndAt);
      }
      for (const k of Object.keys(u.new_values ?? {})) if (!this.knownValues.includes(k)) this.knownValues.push(k);
      this.queue(u, `gemini ${u.source} v${u.version}`);
    }
  }

  private applyPlayerRead(r: AgentPlayerReadMessage) {
    this.values = { ...r.values }; // `when` values may change mid-round (contract); behaviour may not
  }

  private queue(update: AgentStrategyUpdateMessage, label: string) {
    this.pending = { update, label }; // the later one replaces the earlier one
    if (this.phase !== "live") this.applyPending();
  }
  private applyPending() {
    const p = this.pending;
    this.pending = null;
    if (p) setTimeout(() => this.checkAndApply([{ label: p.label, update: p.update, settings: this.settings }], "live_gemini"), 0);
  }

  private checkAndApply(cands: Candidate[], mode: "offline_standin" | "live_gemini") {
    if (this.phase === "live") {
      // too late for this break; keep it for the next one
      this.pending = { update: cands[0].update, label: cands[0].label };
      return;
    }
    const t0 = now();
    const { chosen, log } = chooseCandidate(cands, {
      setup: this.setup,
      knownValues: this.knownValues,
      current: { behaviour: this.behaviour, settings: this.settings },
      habit: this.standin.tracker.habit(),
      round: this.round,
      n: this.checkN,
      seed: this.round * 7919,
      values: this.values,
    });
    this.lat.selfcheck.push(now() - t0);
    this.checkLog.push(...log);
    const st = useAgentStatus.getState();
    const rejected = log.filter((l) => !l.accepted).map((l) => `R${l.round} ${l.label}: ${l.reasons.join("; ")}`);
    st.set({ rejected: [...st.rejected, ...rejected].slice(-12) });
    if (!chosen) return;
    if (mode === "offline_standin") this.standin.accept(chosen);
    this.behaviour = deepClone(chosen.update.behaviour);
    this.settings = chosen.settings;
    this.installBrain(chosen.update);
    st.set({
      mode,
      version: chosen.update.version,
      source: chosen.update.source,
      observations: chosen.update.observations,
      plan: chosen.update.plan,
      changes: chosen.update.changes,
    });
  }

  private installBrain(u: AgentStrategyUpdateMessage) {
    const callout = u.plan?.[0] ? `${u.plan[0]}${u.changes?.[0]?.why ? ` (${u.changes[0].why})` : ""}` : null;
    setBrain(makeAdaptiveBrain({ behaviour: this.behaviour, settings: this.settings, callout, getValues: () => this.values }));
  }

  private enterStandin(why: string) {
    const st = useAgentStatus.getState();
    if (st.mode !== "offline_standin") st.set({ mode: "offline_standin", source: null, observations: [`Offline stand-in (not Gemini): ${why}.`], plan: [] });
  }

  private sendFrame() {
    if (!this.isLive() || this.phase !== "live" || !this.canvas) return;
    const t0 = now();
    captureCanvasJpeg(this.canvas, 384, 0.6).then((b64) => {
      if (!b64) return;
      this.lat.capture.push(now() - t0);
      this.lat.frameBytes.push(Math.round((b64.length * 3) / 4));
      this.lat.framesSent++;
      this.send({ type: "frames", match_id: this.matchId, round: this.round, t: this.t(), views: { game: { mime_type: "image/jpeg", data: b64 } } });
    });
  }
}

export const agentBridge = new AgentBridge();
