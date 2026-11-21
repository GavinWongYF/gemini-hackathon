// A small client for the agent server, for games written in JavaScript.
// It runs in a browser and in Node 22 or later, which both have WebSocket built in.
//
// It opens the socket, sends `setup`, waits for `ready`, and keeps the latest
// player values and the latest behaviour. A new behaviour is only swapped in
// between rounds. `client.pick(...)` never waits on the network.
//
//   const client = new Client(setup, { onPracticeRun: playPractice });
//   await client.connect();
//   client.startRound();                       // swaps in the newest behaviour
//   const [option, byRule] = client.pick("opponent", "shot_type", ["topspin", "flat", "slice", "dropshot", "lob"], facts);
//   client.event("shot", { round: 1, by: "player", data: { side: "forehand" } });
//   client.roundEnd({ round: 1, winner: "player", how: "winner", score: { player: 1, opponent: 0 } });

import { pick } from "./pick.js";

export class Client {
  constructor(setup, { url = "ws://localhost:8000/ws", onPracticeRun = null, onMessage = null, WebSocket: WS = globalThis.WebSocket } = {}) {
    this.setup = setup;
    this.matchId = setup.match_id;
    this.url = url;
    this.onPracticeRun = onPracticeRun;
    this.onMessage = onMessage;
    this.WS = WS;
    this.behaviour = setup.default_behaviour || { version: 0, npcs: {} }; // what the NPCs use now
    this.pending = null; // the newest strategy_update, not swapped in yet
    this.update = null; // the last one swapped in, for the break screen
    this.values = {};
    this.labels = {};
    this.lastRead = null;
    this.errors = [];
    this.gap = true; // true between rounds
    this.ws = null;
    this.t0 = Date.now();
  }

  /** Open the socket, send `setup` and wait for `ready`. Resolves false if it never came. */
  connect(readyTimeoutMs = 90000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), readyTimeoutMs); // play on with the default
      this.resolveReady = (ok) => { clearTimeout(timer); resolve(ok); };
      this.ws = new this.WS(this.url);
      this.ws.onopen = () => { this.t0 = Date.now(); this.send(this.setup); };
      this.ws.onmessage = (e) => this.read(JSON.parse(typeof e.data === "string" ? e.data : String(e.data)));
    });
  }

  close() {
    if (this.ws) this.ws.close();
  }

  /** Seconds since the match started. */
  t() {
    return Math.round((Date.now() - this.t0) / 10) / 100;
  }

  // What the game sends.

  event(name, { round, by, data = {}, picked, byRule, t } = {}) {
    const msg = { type: "event", name, round, t: t ?? this.t(), by, data };
    if (picked) { msg.picked = picked; msg.by_rule = byRule || []; }
    this.send(msg);
  }

  frames({ round, views, t } = {}) {
    this.send({ type: "frames", round, t: t ?? this.t(), views });
  }

  roundEnd({ round, winner, how, score, brk = true, stats, t } = {}) {
    const msg = { type: "round_end", round, t: t ?? this.t(), winner, how, score, break: brk };
    if (stats) msg.stats = stats;
    this.gap = true;
    this.send(msg);
  }

  // Between rounds, and during play.

  /** Swap in the newest behaviour. Returns the settings to apply this round. */
  startRound() {
    this.gap = false;
    if (!this.pending) return {};
    this.update = this.pending;
    this.pending = null;
    this.behaviour = this.update.behaviour;
    return this.update.settings || {};
  }

  /** [option, byRule]: the option to play, and whether a rule decided it. Never waits. */
  pick(npc, decision, legal, facts = {}) {
    if (this.gap) this.startRound();
    return pick(npc, decision, legal, this.behaviour, this.values, facts);
  }

  // What comes back.

  read(msg) {
    if (msg.type === "ready") {
      this.behaviour = msg.behaviour;
      this.addLabels(msg.values);
      if (this.resolveReady) this.resolveReady(true);
    } else if (msg.type === "player_read") {
      this.values = msg.values || {};
      this.lastRead = msg;
    } else if (msg.type === "strategy_update") {
      this.addLabels(msg.new_values);
      const newest = this.pending ? this.pending.version : this.behaviour.version || 0;
      if ((msg.version || 0) >= newest) this.pending = msg;
    } else if (msg.type === "practice_run") {
      this.practice(msg);
    } else if (msg.type === "error") {
      this.errors.push(msg);
    }
    if (this.onMessage) this.onMessage(msg);
  }

  async practice(run) {
    if (!this.onPracticeRun) return;
    const result = await this.onPracticeRun(run);
    const player = typeof run.player === "object" ? run.player.name : run.player;
    this.send({ type: "practice_result", run_id: run.run_id, player, rounds: run.rounds, ...result });
  }

  addLabels(values = {}) {
    for (const [name, spec] of Object.entries(values || {})) this.labels[name] = spec.label || name;
  }

  send(msg) {
    if (!msg.match_id) msg.match_id = this.matchId;
    try {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
    } catch {
      // the game never stops for the network
    }
  }
}
