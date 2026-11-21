// ─────────────────────────────────────────────────────────────────────────
// standin.ts — the OFFLINE STAND-IN analyser (mode "offline_standin").
//
// NOT Gemini, never presented as Gemini. It is a deterministic, rule-based
// reference implementation of the agent side, used when ws://localhost:8000/ws
// is unreachable (so the demo still adapts) and as a worked example for the
// backend team. It consumes the SAME contract messages the Gemini backend gets
// (event / round_end) and produces the SAME shapes (ready / player_read /
// strategy_update). It only knows what VALOR said about itself in `setup`
// plus counting — it cannot see the `game` frames, so the pixel-only values
// (hugs_cover, peeks_bus_side) stay 0 here.
//
// It proposes a LADDER of candidate updates per break, strongest first; the
// self-check (selfcheck.ts) applies the first that passes and logs the rest.
// ─────────────────────────────────────────────────────────────────────────

import type { AgentPlayerReadMessage, AgentReadyMessage, AgentStrategyUpdateMessage, BehaviourJson, BehaviourRule, GameEventMessage, GameRoundEndMessage, StrategyChangeMsg } from "./protocol";
import { deepClone } from "./protocol";
import { COVER_SPOTS, RED, baselineBehaviour, type AgentSettings } from "./setup";
import type { Lane } from "./plaza";

/** Values the agent side tracks for VALOR (what a `ready` would name). */
export const STANDIN_VALUES: Record<string, { label: string; pixelsOnly?: boolean }> = {
  flanks_left: { label: "Goes up the left lane" },
  flanks_right: { label: "Goes up the right lane" },
  rushes_mid: { label: "Pushes up the open middle" },
  wins_via_left: { label: "Wins rounds from the left flank" },
  wins_via_right: { label: "Wins rounds from the right flank" },
  dies_in_open: { label: "Dies in open ground, away from cover" },
  hugs_cover: { label: "Stays pressed against cover (only visible in the frames)", pixelsOnly: true },
  peeks_bus_side: { label: "Peeks out from the bus side (only visible in the frames)", pixelsOnly: true },
};

export interface RoundRecord {
  round: number;
  won: boolean;
  lane: Lane;
  diedInOpen: boolean;
  diedLane: Lane | null;
  kills: number;
}

/** Counts the player's habits from contract events. Shared by the stand-in and the self-check. */
export class HabitTracker {
  rounds: RoundRecord[] = [];
  private cur = { lane: "mid" as Lane, diedInOpen: false, diedLane: null as Lane | null, kills: 0, laneTime: { left: 0, mid: 0, right: 0 } as Record<Lane, number>, lastT: 0 };
  events = 0;

  onEvent(e: Pick<GameEventMessage, "name" | "by" | "data" | "t">) {
    if (e.by !== "player") {
      if (e.name === "round_start") this.resetRound(e.t);
      return;
    }
    this.events++;
    const lane = e.data.lane as Lane | undefined;
    if (e.name === "player_lane_change" && lane) {
      this.cur.laneTime[this.cur.lane] += Math.max(0, e.t - this.cur.lastT);
      this.cur.lastT = e.t;
      this.cur.lane = lane;
    } else if (e.name === "kill") this.cur.kills++;
    else if (e.name === "death") this.cur.diedLane = lane ?? this.cur.lane;
    else if (e.name === "died_in_open") {
      this.cur.diedInOpen = true;
      this.cur.diedLane = lane ?? this.cur.lane;
    }
  }
  private resetRound(t: number) {
    // everyone respawns at the blue spawn (mid) when a round starts
    this.cur = { lane: "mid", diedInOpen: false, diedLane: null, kills: this.cur.kills, laneTime: { left: 0, mid: 0, right: 0 }, lastT: t };
  }
  onRoundEnd(m: Pick<GameRoundEndMessage, "round" | "winner" | "t">): RoundRecord {
    this.cur.laneTime[this.cur.lane] += Math.max(0.1, m.t - this.cur.lastT);
    // The lane the player committed to = where they spent most of the round (spawn walk excluded by weight).
    const lt = this.cur.laneTime;
    const lane = (Object.keys(lt) as Lane[]).sort((a, b) => lt[b] - lt[a])[0];
    const rec: RoundRecord = { round: m.round, won: m.winner === "player", lane, diedInOpen: this.cur.diedInOpen, diedLane: this.cur.diedLane, kills: this.cur.kills };
    this.rounds.push(rec);
    this.cur = { lane: "mid", diedInOpen: false, diedLane: null, kills: 0, laneTime: { left: 0, mid: 0, right: 0 }, lastT: m.t };
    return rec;
  }
  window(k = 3) {
    return this.rounds.slice(-k);
  }
  /** Values in [0,1] from the last k rounds (+ the round in progress, lightly). */
  values(k = 3): Record<string, number> {
    const w = this.window(k);
    const n = Math.max(1, w.length);
    const f = (p: (r: RoundRecord) => boolean) => Math.round((w.filter(p).length / n) * 100) / 100;
    return {
      flanks_left: f((r) => r.lane === "left"),
      flanks_right: f((r) => r.lane === "right"),
      rushes_mid: f((r) => r.lane === "mid"),
      wins_via_left: f((r) => r.won && r.lane === "left"),
      wins_via_right: f((r) => r.won && r.lane === "right"),
      dies_in_open: f((r) => r.diedInOpen),
      hugs_cover: 0,
      peeks_bus_side: 0,
    };
  }
  /** Frequencies for the self-check's player model (all rounds so far). */
  habit(): { left: number; mid: number; right: number; cover: number; rush: number } {
    const r = this.rounds;
    const c = (l: Lane) => r.filter((x) => x.lane === l).length;
    const open = r.filter((x) => x.diedInOpen).length;
    const mids = r.filter((x) => x.lane === "mid");
    return {
      left: c("left"),
      mid: c("mid"),
      right: c("right"),
      cover: r.length ? 1 - open / r.length : 0.5,
      rush: mids.length ? mids.filter((x) => x.diedInOpen).length / mids.length : 0.3,
    };
  }
}

export interface Candidate {
  label: string; // "strong" | "medium" | "mild" ...
  update: AgentStrategyUpdateMessage;
  settings: AgentSettings;
}

const laneWord: Record<Lane, string> = { left: "left", mid: "middle", right: "right" };

export class OfflineStandin {
  readonly tracker = new HabitTracker();
  private version = 1;
  private behaviour: BehaviourJson;
  private settings: AgentSettings;
  constructor(
    private matchId: string,
    initialSettings: AgentSettings,
    /** Rounds in the evidence window and how many must agree before acting. */
    private opts = { window: 3, minEvidence: 2 },
  ) {
    this.behaviour = { ...baselineBehaviour(), version: 1 };
    this.settings = deepClone(initialSettings);
  }

  ready(): AgentReadyMessage {
    return {
      type: "ready",
      match_id: this.matchId,
      values: Object.fromEntries(Object.entries(STANDIN_VALUES).map(([k, v]) => [k, { label: v.label }])),
      behaviour: deepClone(this.behaviour),
    };
  }

  /** The self-check accepted a candidate → it becomes the base for the next one. */
  accept(c: Candidate) {
    this.behaviour = deepClone(c.update.behaviour);
    this.settings = deepClone(c.settings);
    this.version = c.update.version;
  }

  onEvent(e: GameEventMessage, round: number): AgentPlayerReadMessage | null {
    this.tracker.onEvent(e);
    if (e.by !== "player" || e.name === "shot") return null;
    const values = this.tracker.values(this.opts.window);
    return {
      type: "player_read",
      match_id: this.matchId,
      round,
      t: e.t,
      values,
      based_on_events: this.tracker.events,
      why: `${e.name.replace(/_/g, " ")} in the ${String(e.data.lane ?? "?")} lane (counted, not seen).`,
    };
  }

  /** Round over → candidate updates, strongest first (may be empty = keep current). */
  onRoundEnd(m: GameRoundEndMessage): Candidate[] {
    this.tracker.onRoundEnd(m);
    const w = this.tracker.window(this.opts.window);
    const values = this.tracker.values(this.opts.window);
    const need = this.opts.minEvidence;
    const obs: string[] = [];
    const plans: string[] = [];
    type Piece = { label: string; rules: BehaviourRule[]; when: Record<string, Record<string, number>>; settings: Partial<AgentSettings>; plan: string; why: string };
    const tiers: Piece[][] = [[], [], []]; // strong, medium, mild

    // ── A. a flank that keeps winning → watch it ────────────────────────
    for (const side of ["left", "right"] as const) {
      const wins = w.filter((r) => r.won && r.lane === side).length;
      if (wins >= need) {
        const opt = side === "left" ? "watch_left_flank" : "watch_right_flank";
        const v = side === "left" ? "flanks_left" : "flanks_right";
        obs.push(`Won ${wins} of the last ${w.length} rounds by going up the ${side}.`);
        const why = `Won ${wins} of the last ${w.length} rounds via the ${side} flank.`;
        const mkRule = (idx: number[]): BehaviourRule => ({ if: [{ fact: "enemy_index", in: idx }], do: { position: opt }, why });
        tiers[0].push({ label: `all three watch ${side}`, rules: [mkRule([0, 1, 2])], when: { [opt]: { [v]: 1 } }, settings: {}, plan: `All three enemies watch the ${side} flank.`, why });
        tiers[1].push({ label: `two watch ${side}`, rules: [mkRule(side === "left" ? [0, 1] : [1, 2])], when: { [opt]: { [v]: 1 } }, settings: {}, plan: `Two enemies watch the ${side} flank.`, why });
        tiers[2].push({ label: `one watches ${side}`, rules: [mkRule([side === "left" ? 0 : 2])], when: { [opt]: { [v]: 0.6 } }, settings: {}, plan: `Put one enemy on ${side}-flank watch.`, why });
      }
    }
    // ── B. keeps dying in the open → add cover where they die ───────────
    const openDeaths = w.filter((r) => r.diedInOpen);
    if (openDeaths.length >= need) {
      const byLane: Record<string, number> = {};
      for (const r of openDeaths) byLane[r.diedLane ?? r.lane] = (byLane[r.diedLane ?? r.lane] ?? 0) + 1;
      const lane = Object.keys(byLane).sort((a, b) => byLane[b] - byLane[a])[0] as Lane;
      // spots in that lane, closest to the enemy line first (that's where open deaths happen)
      const spots = COVER_SPOTS.filter((s) => s.lane === lane && !this.settings.cover.includes(s.name)).sort((a, b) => a.z - b.z);
      if (spots.length) {
        obs.push(`Died in open ground ${openDeaths.length} of the last ${w.length} rounds, mostly in the ${laneWord[lane]}.`);
        const why = `${openDeaths.length} of the last ${w.length} deaths were in the open in the ${laneWord[lane]}.`;
        const wide = spots.slice(0, 3).map((s) => s.name);
        const one = spots.filter((s) => s.kind !== "wall").slice(0, 1).map((s) => s.name);
        const two = spots.filter((s) => s.kind !== "wall").slice(0, 2).map((s) => s.name);
        tiers[0].push({ label: `cover ${wide.join("+")}`, rules: [], when: {}, settings: { cover: wide }, plan: `Add ${wide.length} cover pieces in the ${laneWord[lane]}.`, why });
        tiers[1].push({ label: `cover ${two.join("+")}`, rules: [], when: {}, settings: { cover: two }, plan: `Add ${two.length} crates/trees in the ${laneWord[lane]}.`, why });
        tiers[2].push({ label: `cover ${one.join("+")} + accuracy +0.05`, rules: [], when: {}, settings: { cover: one, enemy_accuracy: this.settings.enemy_accuracy + 0.05 }, plan: `Add one crate in the ${laneWord[lane]}; enemies aim a little better to keep it close.`, why });
      }
    }
    // ── C. no clear habit but one-sided results → nudge skill ───────────
    if (!tiers[0].length && w.length >= this.opts.window) {
      const won = w.filter((r) => r.won).length;
      if (won === w.length) {
        obs.push(`Won all of the last ${w.length} rounds with no single habit.`);
        tiers[2].push({ label: "accuracy +0.05", rules: [], when: {}, settings: { enemy_accuracy: this.settings.enemy_accuracy + 0.05 }, plan: "Enemies aim a little better.", why: `Player won ${won}/${w.length}.` });
      } else if (won === 0) {
        obs.push(`Lost all of the last ${w.length} rounds.`);
        tiers[2].push({ label: "reaction +0.15 s", rules: [], when: {}, settings: { enemy_reaction_sec: this.settings.enemy_reaction_sec + 0.15 }, plan: "Enemies react a little slower.", why: `Player won ${won}/${w.length}.` });
      }
    }
    // ── D. habit gone → drop the old counter (decay) ────────────────────
    const curRules = this.behaviour.npcs[RED]?.rules ?? [];
    const stale = curRules.filter((r) => {
      const opt = r.do.position;
      if (opt === "watch_left_flank") return values.flanks_left < 0.34 && !tiers.flat().some((p) => p.rules.some((x) => x.do.position === opt));
      if (opt === "watch_right_flank") return values.flanks_right < 0.34 && !tiers.flat().some((p) => p.rules.some((x) => x.do.position === opt));
      return false;
    });
    if (!tiers.some((t) => t.length) && !stale.length) return [];

    const out: Candidate[] = [];
    const labels = ["strong", "medium", "mild"];
    const seen = new Set<string>();
    for (let ti = 0; ti < 3; ti++) {
      // a tier falls back to the next milder piece for any change it doesn't have
      const pieces = tiers[ti].length ? tiers[ti] : [];
      if (!pieces.length && !(ti === 2 && stale.length)) continue;
      const beh = deepClone(this.behaviour);
      const npc = beh.npcs[RED];
      const changes: StrategyChangeMsg[] = [];
      const settings: AgentSettings = deepClone(this.settings);
      if (stale.length) {
        npc.rules = npc.rules.filter((r) => !stale.includes(r));
        changes.push({ where: `${RED}.rules`, from: stale.map((r) => r.why ?? ""), to: null, why: "The habit this rule countered has gone (seen in under a third of recent rounds)." });
      }
      for (const p of pieces) {
        for (const r of p.rules) {
          // replace any rule forcing the same option, keep ≤ 4 rules
          const prev = npc.rules.find((x) => x.do.position === r.do.position);
          npc.rules = [r, ...npc.rules.filter((x) => x !== prev)].slice(0, 4);
          changes.push({ where: `${RED}.rules`, from: prev ? describeRule(prev) : null, to: describeRule(r), why: p.why });
        }
        for (const [opt, when] of Object.entries(p.when)) {
          const o = npc.decisions.position[opt];
          const from = deepClone(o);
          o.when = { ...(o.when ?? {}), ...when };
          changes.push({ where: `${RED}.position.${opt}`, from, to: deepClone(o), why: p.why });
        }
        if (p.settings.cover) {
          const from = settings.cover.slice();
          settings.cover = [...settings.cover, ...p.settings.cover].slice(0, 4);
          changes.push({ where: "settings.cover", from, to: settings.cover.slice(), why: p.why });
        }
        for (const k of ["enemy_accuracy", "enemy_reaction_sec", "enemy_damage"] as const) {
          if (p.settings[k] !== undefined) {
            const v = Math.round((p.settings[k] as number) * 100) / 100;
            changes.push({ where: `settings.${k}`, from: settings[k], to: v, why: p.why });
            settings[k] = v;
          }
        }
      }
      const key = JSON.stringify([npc, settings]);
      if (seen.has(key)) continue;
      seen.add(key);
      const version = this.version + 1;
      beh.version = version;
      out.push({
        label: `${labels[ti]}: ${pieces.map((p) => p.label).join(" & ") || "drop stale counter"}`,
        settings,
        update: {
          type: "strategy_update",
          match_id: this.matchId,
          version,
          source: "quick",
          observations: (obs.length ? obs : ["No strong habit in the last rounds."]).slice(0, 4),
          plan: (pieces.length ? pieces.map((p) => p.plan) : ["Go back to the default positions."]).slice(0, 4).concat(plans).slice(0, 4),
          changes,
          settings: { ...settings },
          behaviour: beh,
        },
      });
    }
    return out;
  }
}

export function describeRule(r: BehaviourRule): string {
  const cond = r.if.map((c) => `${c.fact ?? c.value} ${c.is !== undefined ? `is ${c.is}` : c.in ? `in [${c.in.join(",")}]` : c.above !== undefined ? `> ${c.above}` : `< ${c.below}`}`).join(" and ");
  return `If ${cond || "always"}, ${Object.entries(r.do).map(([d, o]) => `${d} = ${o}`).join(", ")}.`;
}
