// scripts/proof/run.ts — VALOR headless proof harness.
//
//   npx tsx scripts/proof/run.ts            # N=200 matches per habit per arm (seeded, reproducible)
//   npx tsx scripts/proof/run.ts --n 50     # quicker
//   npx tsx scripts/proof/run.ts --live     # also run practice matches against ws://localhost:8000/ws
//                                           # (Felix/Gavin's Gemini backend) and record real latencies
//
// Arms: (A) baseline brain (src/agent/brain.ts baselineBrain = default_behaviour)
//       (B) adaptive: offline stand-in → self-check → adaptive brain (labelled offline_standin)
//       (C) live Gemini — only with --live and a reachable server; skipped cleanly otherwise.
// Same seed per match index in A and B (common random numbers): round 1 is identical by construction.
// Outputs: docs/proof/results.json, results.csv, winrate_by_round.svg, open_deaths_by_round.svg,
//          selfcheck_log.json, latency.json

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPracticeMatch, type PracticeMatch } from "../../src/agent/practice";
import { PLAYERS } from "../../src/agent/sim";
import { BASELINE_AGENT_SETTINGS, valorSetup, VALOR_PLAN } from "../../src/agent/setup";
import { validateStructure } from "../../src/agent/selfcheck";
import { STANDIN_VALUES } from "../../src/agent/standin";
import { runLive, probeServer } from "./live";
import { svgPanels } from "./svg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = resolve(ROOT, "docs/proof");
const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const N = Number(arg("--n", "200"));
const CHECK_N = Number(arg("--check-n", "60"));
const LIVE = process.argv.includes("--live");
const ROUNDS = VALOR_PLAN.rounds;

// ── stats ──────────────────────────────────────────────────────────────────
const wilson = (k: number, n: number) => {
  if (!n) return { p: 0, lo: 0, hi: 0, n };
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { p: +p.toFixed(4), lo: +Math.max(0, c - h).toFixed(4), hi: +Math.min(1, c + h).toFixed(4), n };
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const meanCI = (xs: number[]) => {
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
  const h = (1.96 * sd) / Math.sqrt(Math.max(1, xs.length));
  return { mean: +m.toFixed(3), lo: +(m - h).toFixed(3), hi: +(m + h).toFixed(3), n: xs.length };
};
const pctl = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(3);
};

/** Did the counter to this habit appear? (rules or cover active in that round) */
const counterActive = (habit: string, r: PracticeMatch["rounds"][number]) =>
  habit === "flank_left_always"
    ? r.rulesActive.some((w) => /left flank/.test(w))
    : habit === "rush_open_mid"
      ? r.cover.some((c) => c.startsWith("mid_"))
      : r.rulesActive.length > 0 || r.cover.length > 0;

function summarise(habit: string, matches: PracticeMatch[]) {
  const byRound = Array.from({ length: ROUNDS }, (_, i) => wilson(matches.filter((m) => m.rounds[i].winner === "blue").length, matches.length));
  const openByRound = Array.from({ length: ROUNDS }, (_, i) => wilson(matches.filter((m) => m.rounds[i].playerDiedInOpen).length, matches.length));
  const all = matches.flatMap((m) => m.rounds);
  const late = matches.flatMap((m) => m.rounds.slice(3)); // rounds 4–7
  const matchWins = matches.filter((m) => {
    let p = 0, r = 0;
    for (const x of m.rounds) {
      if (x.winner === "blue") p++;
      else r++;
      if (p === 4 || r === 4) break;
    }
    return p === 4;
  }).length;
  const firstCounter = matches.map((m) => m.rounds.findIndex((r) => counterActive(habit, r))).map((i) => (i < 0 ? null : i + 1));
  const withC = all.filter((r) => counterActive(habit, r));
  const withoutC = all.filter((r) => !counterActive(habit, r));
  return {
    roundWinRate: wilson(all.filter((r) => r.winner === "blue").length, all.length),
    roundWinRate_rounds4to7: wilson(late.filter((r) => r.winner === "blue").length, late.length),
    matchWinRate: wilson(matchWins, matches.length),
    winRateByRound: byRound,
    diedInOpenByRound: openByRound,
    diedInOpen: wilson(all.filter((r) => r.playerDiedInOpen).length, all.length),
    diedInOpen_counterActive: wilson(withC.filter((r) => r.playerDiedInOpen).length, withC.length),
    diedInOpen_counterInactive: wilson(withoutC.filter((r) => r.playerDiedInOpen).length, withoutC.length),
    counterAppearedInMatches: wilson(firstCounter.filter((x) => x !== null).length, matches.length),
    roundOfFirstCounter: firstCounter.some((x) => x !== null) ? meanCI(firstCounter.filter((x): x is number => x !== null)) : null,
    enemyTtkSec: meanCI(all.map((r) => r.enemyTtk).filter((x): x is number => x !== null)),
    playerTimeToDeathSec: meanCI(all.map((r) => r.timeToPlayerDeath).filter((x): x is number => x !== null)),
    roundSeconds: meanCI(all.map((r) => r.seconds)),
  };
}

// ── run ────────────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const results: Record<string, unknown> = {};
const csv: string[] = ["habit,arm,round,n,player_win_rate,ci_lo,ci_hi,died_in_open_rate"];
const checkLog: unknown[] = [];
const examples: Record<string, unknown> = {};
const pipelineMs: number[] = [];
const readMs: number[] = [];
const charts: Parameters<typeof svgPanels>[0] = [];
const openCharts: Parameters<typeof svgPanels>[0] = [];

for (const player of Object.values(PLAYERS)) {
  const arms: Record<string, PracticeMatch[]> = { baseline: [], adaptive_standin: [] };
  for (let s = 1; s <= N; s++) {
    arms.baseline.push(runPracticeMatch({ player, seed: s, mode: "baseline" }));
    const m = runPracticeMatch({ player, seed: s, mode: "standin", checkN: CHECK_N });
    arms.adaptive_standin.push(m);
    pipelineMs.push(...m.pipelineMs);
    readMs.push(...m.readMs);
    for (const c of m.checks) checkLog.push({ habit: player.id, seed: s, ...c, ms: +c.ms.toFixed(2) });
  }
  const sum = Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, summarise(player.id, v)]));
  results[player.id] = { about: player.about, ...sum };
  for (const [arm, s] of Object.entries(sum))
    s.winRateByRound.forEach((w, i) => csv.push([player.id, arm, i + 1, w.n, w.p, w.lo, w.hi, s.diedInOpenByRound[i].p].join(",")));
  // real example: the accepted updates + rejections of match seed 1
  const m1 = arms.adaptive_standin[0];
  examples[player.id] = {
    seed: 1,
    rounds: m1.rounds.map((r) => ({ round: r.round, winner: r.winner, player_lane: r.playerLane, died_in_open: r.playerDiedInOpen, red_positions: r.redPositions, behaviour_version: r.version, cover: r.cover })),
    accepted_updates: m1.updates,
    self_check: m1.checks,
  };
  charts.push({ title: player.id, series: [
    { name: "baseline", color: "#8a8f98", points: sum.baseline.winRateByRound },
    { name: "adaptive (offline stand-in)", color: "#2f6fde", points: sum.adaptive_standin.winRateByRound },
  ] });
  openCharts.push({ title: player.id, series: [
    { name: "baseline", color: "#8a8f98", points: sum.baseline.diedInOpenByRound },
    { name: "adaptive (offline stand-in)", color: "#d9822b", points: sum.adaptive_standin.diedInOpenByRound },
  ] });
  console.log(`${player.id}: baseline ${(sum.baseline.roundWinRate.p * 100).toFixed(1)}%  adaptive ${(sum.adaptive_standin.roundWinRate.p * 100).toFixed(1)}%  (rounds 4-7: ${(sum.baseline.roundWinRate_rounds4to7.p * 100).toFixed(1)}% → ${(sum.adaptive_standin.roundWinRate_rounds4to7.p * 100).toFixed(1)}%)`);
}

// ── injected faults: what a model might hallucinate, run through the same validator ──
const setup = valorSetup({ matchId: "fault_injection", mode: "practice" });
const base = setup.default_behaviour!;
const clone = () => JSON.parse(JSON.stringify(base));
const faults = [
  { name: "invented option", mk: () => { const b = clone(); b.npcs.red.decisions.position.snipe_from_roof = { base: 1 }; return { behaviour: b }; } },
  { name: "invented fact in a rule", mk: () => { const b = clone(); b.npcs.red.rules = [{ if: [{ fact: "player_health", below: 30 }], do: { style: "stand_and_shoot" } }]; return { behaviour: b }; } },
  { name: "superhuman accuracy", mk: () => ({ behaviour: clone(), settings: { enemy_accuracy: 0.95 } }) },
  { name: "cover on the blue spawn", mk: () => ({ behaviour: clone(), settings: { cover: ["blue_spawn_crate"] } }) },
  { name: "walls blocking the middle", mk: () => ({ behaviour: clone(), settings: { cover: ["mid_wall_front"] } }) },
  { name: "too much cover", mk: () => ({ behaviour: clone(), settings: { cover: ["left_tree_near", "left_crate_far", "mid_crate_near", "mid_tree_center", "right_tree_mid"] } }) },
  { name: "five rules", mk: () => { const b = clone(); b.npcs.red.rules = Array.from({ length: 5 }, () => ({ if: [], do: { position: "hold_mid" } })); return { behaviour: b }; } },
];
const injected = faults.map((f) => ({ fault: f.name, injected: true, reasons: validateStructure(f.mk() as never, setup, Object.keys(STANDIN_VALUES), BASELINE_AGENT_SETTINGS).reasons }));

// ── live Gemini arm ────────────────────────────────────────────────────────
let live: unknown = { skipped: true, reason: "run with --live to try ws://localhost:8000/ws" };
if (LIVE) {
  const ok = await probeServer("ws://localhost:8000/ws", 1500);
  live = ok ? await runLive({ url: "ws://localhost:8000/ws", matches: Number(arg("--live-n", "3")), checkN: CHECK_N }) : { skipped: true, reason: "ws://localhost:8000/ws not reachable (Felix/Gavin's backend not running locally)" };
}

const rejected = checkLog.filter((c) => !(c as { accepted: boolean }).accepted) as Array<{ stage: string; reasons: string[] }>;
const reasonCounts: Record<string, number> = {};
for (const r of rejected) for (const x of r.reasons) {
  const k = x.replace(/\d+%/g, "N%").replace(/\(.*?\)/g, "(…)");
  reasonCounts[k] = (reasonCounts[k] ?? 0) + 1;
}
const latency = {
  note: "Measured in this harness on the offline stand-in (CPU, single thread). The Gemini rows are filled by --live against the real backend; null = not measured yet.",
  standin_event_to_player_read_ms: { p50: pctl(readMs, 0.5), p95: pctl(readMs, 0.95), n: readMs.length },
  standin_round_end_to_decision_ms_incl_selfcheck: { p50: pctl(pipelineMs, 0.5), p95: pctl(pipelineMs, 0.95), n: pipelineMs.length },
  selfcheck_ms_per_candidate: { p50: pctl(checkLog.map((c) => (c as { ms: number }).ms), 0.5), p95: pctl(checkLog.map((c) => (c as { ms: number }).ms), 0.95), sims_per_brain: CHECK_N },
  gemini: (live as { latency?: unknown }).latency ?? { event_to_player_read_ms: null, round_end_to_quick_update_ms: null, round_end_to_full_update_ms: null, frames: null },
};

writeFileSync(resolve(OUT, "results.json"), JSON.stringify({
  generated: new Date().toISOString(),
  method: { matches_per_arm: N, rounds_per_match: ROUNDS, selfcheck_sims_per_brain: CHECK_N, seeds: `1..${N} (same seed for both arms)`, ci: "Wilson 95% for rates, normal 95% for means" },
  results,
  live_gemini: live,
  selfcheck: { candidates_checked: checkLog.length, rejected: rejected.length, by_stage: { structure: rejected.filter((r) => r.stage === "structure").length, fairness: rejected.filter((r) => r.stage === "fairness").length }, reason_counts: reasonCounts, injected_faults: injected },
  examples,
  runtime_sec: (Date.now() - t0) / 1000,
}, null, 2));
writeFileSync(resolve(OUT, "results.csv"), csv.join("\n") + "\n");
writeFileSync(resolve(OUT, "selfcheck_log.json"), JSON.stringify({ injected_faults: injected, log: checkLog }, null, 1));
writeFileSync(resolve(OUT, "latency.json"), JSON.stringify(latency, null, 2));
writeFileSync(resolve(OUT, "winrate_by_round.svg"), svgPanels(charts, { yLabel: "player round win-rate", band: [0.35, 0.65], title: "Player win-rate by round: baseline vs adaptive (95% CI)" }));
writeFileSync(resolve(OUT, "open_deaths_by_round.svg"), svgPanels(openCharts, { yLabel: "rounds the player died in the open", title: "Deaths in the open by round: baseline vs adaptive (95% CI)" }));
console.log(`self-check: ${checkLog.length} candidates, ${rejected.length} rejected. latency p50 pipeline ${latency.standin_round_end_to_decision_ms_incl_selfcheck.p50} ms. done in ${((Date.now() - t0) / 1000).toFixed(0)} s → docs/proof/`);
