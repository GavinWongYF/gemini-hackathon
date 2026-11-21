// The shared `pick` cases in sdk/test-vectors.json, run against the JavaScript SDK.
// Run it with: node sdk/js/test.mjs
import { readFileSync } from "node:fs";
import { pick } from "./pick.js";
import { Client } from "./client.js";

const vectors = JSON.parse(readFileSync(new URL("../test-vectors.json", import.meta.url), "utf8"));

// The answer must not depend on chance, so try draws across the whole range.
const draws = [0, 0.01, 0.25, 0.5, 0.75, 0.99, 0.999999];
const rngs = [...draws.map((d) => () => d), Math.random];

let failed = 0;
for (const c of vectors.cases) {
  for (const rng of rngs) {
    const [option, byRule] = pick(c.npc, c.decision, c.legal, c.behaviour, c.values, c.facts, rng);
    const okOption = "option" in c.expect ? option === c.expect.option : c.expect.one_of.includes(option);
    if (!okOption || byRule !== c.expect.by_rule) {
      failed++;
      console.log(`FAIL ${c.name}: got [${JSON.stringify(option)}, ${byRule}], expected ${JSON.stringify(c.expect)}`);
      break;
    }
  }
}

const total = vectors.cases.length;
console.log(`${total - failed} of ${total} cases passed`);

// The client, against a stand-in socket that answers like the agent server.
const only = (option, version) => ({
  version,
  npcs: { opponent: { decisions: { shot_type: { flat: { base: 0 }, lob: { base: 0 }, [option]: { base: 1 } } }, rules: [] } },
});
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    FakeSocket.last = this;
    setTimeout(() => this.onopen(), 0);
  }
  reply(msg) { setTimeout(() => this.onmessage({ data: JSON.stringify({ match_id: "m_test", ...msg }) }), 0); }
  send(raw) {
    const msg = JSON.parse(raw);
    this.sent.push(msg);
    if (msg.type === "setup") this.reply({ type: "practice_run", run_id: "p_1", player: { name: "lefty", plays: {} }, rounds: 3, behaviour: only("lob", 0) });
    if (msg.type === "practice_result") this.reply({ type: "ready", values: { comes_to_net: { label: "Comes to the net" } }, behaviour: only("flat", 1) });
    if (msg.type === "event") {
      this.reply({ type: "player_read", values: { comes_to_net: 0.4 } });
      this.reply({ type: "strategy_update", version: 2, settings: { speed: "fast" }, behaviour: only("lob", 2) });
    }
  }
  close() { this.readyState = 3; }
}

const checks = [];
const check = (name, ok) => { checks.push(ok); if (!ok) console.log(`FAIL client: ${name}`); };
const client = new Client(
  { type: "setup", match_id: "m_test", game: "tennis" },
  { WebSocket: FakeSocket, onPracticeRun: async () => ({ wins: { player: 1, opponent: 2 } }) },
);
check("ready arrives", await client.connect(2000));
const ws = FakeSocket.last;
const result = ws.sent.find((m) => m.type === "practice_result");
check("practice_result", result && result.player === "lefty" && result.run_id === "p_1" && result.wins.opponent === 2);
check("labels", client.labels.comes_to_net === "Comes to the net");
check("no settings before round 1", Object.keys(client.startRound()).length === 0);
check("ready behaviour", client.pick("opponent", "shot_type", ["flat", "lob"])[0] === "flat");
client.event("shot", { round: 1, by: "player", data: { side: "forehand" } });
await new Promise((r) => setTimeout(r, 20));
check("values kept", client.values.comes_to_net === 0.4);
check("no swap mid-round", client.pending && client.pick("opponent", "shot_type", ["flat", "lob"])[0] === "flat");
client.roundEnd({ round: 1, winner: "player", how: "winner", score: { player: 1, opponent: 0 } });
check("settings at the gap", client.startRound().speed === "fast");
check("new behaviour next round", client.pick("opponent", "shot_type", ["flat", "lob"])[0] === "lob");
check("message order", ws.sent.map((m) => m.type).join() === "setup,practice_result,event,round_end");
check("match_id on every message", ws.sent.every((m) => m.match_id === "m_test"));
client.close();
const clientFailed = checks.filter((ok) => !ok).length;
console.log(`${checks.length - clientFailed} of ${checks.length} client checks passed`);

process.exit(failed || clientFailed ? 1 : 0);
