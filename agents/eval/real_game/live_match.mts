// One headless live match on the real tennis engine, against an agent server.
//
// A scripted player stands in for the person with the racket. Everything else
// is the game's own code, wired the way the game's live match view wires it:
// its engine, its opponent brain and its socket client in live mode. The real
// `setup` goes out, every `event` and `round_end` goes out, `player_read`
// values go straight into the brain, and each `strategy_update` is queued so
// the engine swaps it in before the next serve.
//
// Run it with the game's own tsconfig so its "@shared/*" imports resolve:
//
//   npx --yes tsx --tsconfig <game-root>/client/tsconfig.json eval/real_game/live_match.mts \
//       --game-root <game-root> --url ws://localhost:8000/ws --player forehand_lover --rounds 24
//
// Flags:
//   --game-root DIR     folder that holds client/ and shared/ (default: the repo root)
//   --url URL           the agent server socket (default ws://localhost:8000/ws)
//   --player NAME       forehand_lover, baseline_grinder or even (default forehand_lover).
//                       "a-to-b" plays as a, then changes style to b (see --switch-at)
//                       also: random, never_swings, contrarian (plays against each behaviour it
//                       sees), and persona-NAME (a persona from --personas)
//                       and person-beginner, person-club, person-strong, person-reactive:
//                       forehand first with a miss rate, closer to a person (see driver.mts)
//   --personas FILE     a list of persona objects, or a stored design that holds one
//   --player-settings FILE  numbers for the person players, laid over the defaults
//   --seconds S         an open-ended match. Play stops at the first point that ends after
//                       S seconds of play. The game's own plan goes out in `setup`, and the
//                       engine is set up the way the game's live view sets it up. A game
//                       whose plan still has a point cap is played past it, with no breaks.
//                       (--rounds then caps the points, and --break-every turns breaks on.)
//   --switch-at N       the point at which an "a-to-b" player changes style (default: half way)
//   --drop-socket-at N  cut the socket after point N, to test the game's reconnect
//   --bad-events-at N   send three malformed messages after point N, to test the server's errors
//   --rounds N          points in the match (default 6, as the game ships)
//   --break-every N     points between breaks (default 2, as the game ships)
//   --break-seconds S   how long a break lasts (default 5)
//   --plan-break-every N  break_every to state in setup.plan (default: same as --break-every)
//   --as-shipped        send the setup exactly as the game's client builds it by default
//   --match-id ID       default real_<player>_<time>
//   --pace real|N|max   real time (default), N times real time, or as fast as it can
//   --start early|ready ready waits for `ready` before the first point, as the game does (default);
//                       early starts play at once, as older builds of the game did
//   --seed N            seed for the scripted player and the opponent's picks (default 1)
//   --log FILE          write every message sent and received as JSON lines
//   --linger S          seconds to keep the socket open after the last point (default 2)
//   --quiet             no line per point

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  againstBehaviour,
  defaultGameRoot,
  loadGame,
  loadPersonas,
  loadPersonSettings,
  makeScriptedPlayer,
  parseArgs,
  playToEnd,
  reactStyle,
  resolveProfile,
  sleep,
  splitPlayer,
  type Any,
} from './driver.mts';

const args = parseArgs(process.argv.slice(2));
const gameRoot = args['game-root'] ?? defaultGameRoot();
const url = args.url ?? 'ws://localhost:8000/ws';
const playerName = args.player ?? 'forehand_lover';
const openSeconds = args.seconds ? Number(args.seconds) : null;
let rounds = Number(args.rounds ?? 6);
let breakEvery = Number(args['break-every'] ?? 2);
let breaksOn = true;
let breakSeconds = Number(args['break-seconds'] ?? 5);
const asShipped = args['as-shipped'] === 'true';
let planBreakEvery = Number(args['plan-break-every'] ?? breakEvery);
const seed = Number(args.seed ?? 1);
const paceArg = args.pace ?? 'real';
const pace = paceArg === 'real' ? 1 : paceArg === 'max' ? Infinity : Number(paceArg);
const startMode = args.start ?? 'ready';
const matchId = args['match-id'] ?? `real_${playerName}_${Date.now().toString(36)}`;
const linger = Number(args.linger ?? 2);
const quiet = args.quiet === 'true';
const logPath = args.log ? path.resolve(args.log) : null;
const players = splitPlayer(playerName);
const switchAt = Number(args['switch-at'] ?? Math.floor(rounds / 2) + 1);
const dropSocketAt = args['drop-socket-at'] ? Number(args['drop-socket-at']) : null;
const badEventsAt = args['bad-events-at'] ? Number(args['bad-events-at']) : null;
let gameCommit: string | null = null;
try {
  gameCommit = execFileSync('git', ['-C', gameRoot, 'rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {
  // Not a git checkout: an unpacked copy can say which commit it is in a COMMIT file.
  const stamp = path.join(gameRoot, 'COMMIT');
  gameCommit = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : null;
  if (gameCommit && /^[0-9a-f]{40}$/.test(gameCommit)) gameCommit = gameCommit.slice(0, 7);
}

const game = await loadGame(gameRoot);
const P = game.protocol;
if (openSeconds !== null) {
  // As the game's live view does it: the point cap, the breaks and their length come from the game's plan.
  const plan = P.TENNIS_MATCH_PLAN ?? {};
  const gameIsOpenEnded = typeof plan.rounds !== 'number';
  if (!args.rounds) rounds = gameIsOpenEnded ? 0 : 100000; // 0 is the newer engine's "no cap"
  if (!args['break-every']) breakEvery = gameIsOpenEnded ? (plan.break_every ?? 0) : 0;
  if (!args['break-seconds']) breakSeconds = plan.break_seconds ?? 0;
  if (!args['plan-break-every']) planBreakEvery = breakEvery;
  breaksOn = breakEvery > 0;
}

// ---- the wire log ----------------------------------------------------------

const wallStart = performance.now();
const wall = () => Math.round(performance.now() - wallStart) / 1000;
if (logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, '');
}
const writeLog = (row: Any) => {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(row) + '\n');
};

const sentCounts: Record<string, number> = {};
const receivedCounts: Record<string, number> = {};
const errors: Array<{ count: number; first_wall: number; message: Any }> = [];
const notes = new Map<string, number>();
const note = (line: string) => notes.set(line, (notes.get(line) ?? 0) + 1);

let readyAt: number | null = null;
let readyCount = 0;
let setupSentAt: number | null = null;
let droppedWhileOffline = 0;
let picksTotal = 0;
let picksByRule = 0;
const midRoundSwaps: Any[] = [];
const statusLog: Any[] = [];
let liveSocket: Any = null;
let sentBeforeReady = 0;
const knownValues = new Set<string>();
let lastRead: Any = null;
let reads = 0;
const updates: Any[] = [];

const RealWebSocket = (globalThis as Any).WebSocket;
if (!RealWebSocket) throw new Error('This Node has no global WebSocket. Use Node 22 or newer.');

/** A pass-through socket that records every message exactly as it crosses the wire. */
class RecordingSocket {
  private ws: Any;
  onopen: Any = null;
  onmessage: Any = null;
  onclose: Any = null;
  onerror: Any = null;
  constructor(target: string) {
    this.ws = new RealWebSocket(target);
    liveSocket = this.ws;
    this.ws.onopen = (ev: Any) => this.onopen?.(ev);
    this.ws.onclose = (ev: Any) => this.onclose?.(ev);
    this.ws.onerror = (ev: Any) => this.onerror?.(ev);
    this.ws.onmessage = (ev: Any) => {
      onWire('in', ev.data);
      this.onmessage?.(ev);
    };
  }
  get readyState() {
    return this.ws.readyState;
  }
  send(data: string) {
    onWire('out', data);
    this.ws.send(data);
  }
  close() {
    this.ws.close();
  }
}

function onWire(dir: 'in' | 'out', raw: unknown) {
  let message: Any;
  try {
    message = JSON.parse(String(raw));
  } catch {
    note(`${dir === 'in' ? 'received' : 'sent'} something that is not JSON`);
    return;
  }
  writeLog({ dir, wall: wall(), message });
  if (dir === 'out') {
    const key = message.type === 'event' ? `event:${message.name}:${message.by}` : message.type;
    sentCounts[key] = (sentCounts[key] ?? 0) + 1;
    if (message.type === 'setup' && setupSentAt === null) setupSentAt = wall();
    if (readyAt === null && message.type !== 'setup') sentBeforeReady += 1;
    return;
  }
  receivedCounts[message.type] = (receivedCounts[message.type] ?? 0) + 1;
  if (message.type === 'ready') readyCount += 1;
  if (message.match_id !== undefined && message.match_id !== matchId) {
    note(`received a ${message.type} for another match_id (${message.match_id}); the game drops it`);
  }
  if (message.type === 'error') {
    const key = `${message.where}|${message.about}`;
    const seen = errors.find((e) => `${e.message.where}|${e.message.about}` === key);
    if (seen) seen.count += 1;
    else errors.push({ count: 1, first_wall: wall(), message });
  } else if (!['ready', 'player_read', 'strategy_update', 'practice_run'].includes(message.type)) {
    note(`received a message type the game does not handle: ${message.type}`);
  }
}

// ---- what the game would not apply ------------------------------------------

const LEGAL: Record<string, readonly string[]> = {
  shot_type: P.TENNIS_AI_SHOT_TYPES,
  aim: P.TENNIS_AI_AIM_OPTIONS,
  position: P.TENNIS_AI_POSITION_OPTIONS,
  anticipate: P.TENNIS_AI_ANTICIPATE_OPTIONS,
};

function auditBehaviour(label: string, behaviour: Any, setup: Any) {
  if (!behaviour || typeof behaviour !== 'object' || !behaviour.npcs) {
    note(`${label}: no behaviour.npcs; the game would pick every option with equal chance`);
    return;
  }
  const facts = new Set(Object.keys(setup.facts ?? {}));
  for (const [npc, entry] of Object.entries<Any>(behaviour.npcs)) {
    if (npc !== 'opponent') {
      note(`${label}: behaviour has an NPC "${npc}" the game never asks about`);
      continue;
    }
    for (const decision of Object.keys(LEGAL)) {
      if (!entry.decisions?.[decision]) note(`${label}: no "${decision}" decision; the game picks it with equal chance`);
    }
    for (const [decision, options] of Object.entries<Any>(entry.decisions ?? {})) {
      if (!LEGAL[decision]) {
        note(`${label}: decision "${decision}" is not one the game picks`);
        continue;
      }
      for (const [option, spec] of Object.entries<Any>(options ?? {})) {
        if (!LEGAL[decision].includes(option)) note(`${label}: option ${decision}.${option} is never legal in the game`);
        for (const value of Object.keys(spec?.when ?? {})) {
          if (!knownValues.has(value)) note(`${label}: ${decision}.${option} weighs value "${value}" that was never named in ready or new_values`);
        }
      }
    }
    if (entry.rules !== undefined && !Array.isArray(entry.rules)) note(`${label}: rules is not an array; the game skips it`);
    for (const rule of Array.isArray(entry.rules) ? entry.rules : []) {
      for (const [decision, option] of Object.entries<Any>(rule?.do ?? {})) {
        if (!LEGAL[decision]) note(`${label}: a rule forces "${decision}", which the game never picks`);
        else if (!LEGAL[decision].includes(option)) note(`${label}: a rule forces ${decision}=${option}, which is never legal`);
      }
      for (const cond of Array.isArray(rule?.if) ? rule.if : []) {
        if (cond.fact !== undefined && !facts.has(cond.fact)) note(`${label}: a rule checks fact "${cond.fact}" that setup does not declare`);
        if (cond.value !== undefined && !knownValues.has(cond.value)) note(`${label}: a rule checks value "${cond.value}" that was never named`);
        if (cond.fact !== undefined && String(cond.fact).startsWith('swing_') && Object.keys(rule?.do ?? {}).some((d) => d !== 'anticipate')) {
          note(`${label}: a rule on fact "${cond.fact}" forces something other than anticipate; the game only passes swing_ facts to the anticipate pick, so it never fires`);
        }
      }
    }
  }
}

function auditUpdate(msg: Any, setup: Any) {
  const label = `strategy_update v${msg.version}`;
  if (msg.behaviour?.version !== msg.version) note(`${label}: version ${msg.version} but behaviour.version ${msg.behaviour?.version}`);
  for (const [name, value] of Object.entries<Any>(msg.settings ?? {})) {
    const bounds = P.TENNIS_SETTINGS_BOUNDS[name];
    if (!bounds) note(`${label}: setting "${name}" is not one the game applies`);
    else if (typeof value !== 'number') note(`${label}: setting "${name}" is not a number (${JSON.stringify(value)}); the game ignores it`);
    else if (value < bounds.min || value > bounds.max) note(`${label}: setting "${name}"=${value} is outside ${bounds.min}..${bounds.max}; the game clamps it`);
  }
  for (const change of msg.changes ?? []) {
    if (typeof change.where === 'string' && change.where.startsWith('settings.')) {
      const name = change.where.slice('settings.'.length);
      if (!(msg.settings && name in msg.settings)) note(`${label}: changes names ${change.where} but settings does not carry it`);
    }
  }
  for (const name of Object.keys(msg.new_values ?? {})) knownValues.add(name);
  auditBehaviour(label, msg.behaviour, setup);
}

// ---- the match, wired as the game's live view wires it -----------------------

const personas = loadPersonas(args.personas);
const personSettings = loadPersonSettings(args['player-settings']);
let profile: Any = resolveProfile(game, players.first, personas, personSettings);
const contrarianBase: Any = players.first === 'contrarian' ? structuredClone(profile) : null;
// The reactive person: it notices that the opponent changed, and changes style once the points go against it.
const reactive: Any = players.first === 'person-reactive'
  ? { base: structuredClone(profile), reactions: 0, lostSinceChange: 0, opponentChanged: false, lastVersion: null, log: [] }
  : null;
const rng = game.createSeededRng(seed);
const brain = new game.OpponentBrain(P.DEFAULT_TENNIS_BEHAVIOUR, rng);
let status = 'disconnected';
let mockFallback = false;

const agent = new game.AgentClient({
  wsUrl: url,
  mode: 'live',
  matchId,
  WebSocketCtor: RecordingSocket,
  callbacks: {
    onStatus: (next: string) => {
      statusLog.push({ wall: wall(), status: next });
      status = next;
      if (next === 'mock') mockFallback = true;
    },
    onReady: (msg: Any) => {
      if (readyAt === null) readyAt = wall();
      for (const name of Object.keys(msg.values ?? {})) knownValues.add(name);
      auditBehaviour('ready', msg.behaviour, agent.getSetupMessage());
      brain.applyReadyBehaviour(msg.behaviour);
      if (contrarianBase) profile = againstBehaviour(contrarianBase, msg.behaviour, brain.getLatestValues());
    },
    onPlayerRead: (msg: Any) => {
      reads += 1;
      lastRead = msg;
      for (const [name, value] of Object.entries<Any>(msg.values ?? {})) {
        if (!knownValues.has(name)) note(`player_read carries value "${name}" that was never named in ready or new_values`);
        if (typeof value !== 'number' || value < 0 || value > 1) note(`player_read value "${name}" is not a number from 0 to 1 (${JSON.stringify(value)})`);
      }
      brain.updatePlayerValues(msg.values);
    },
    onStrategyUpdate: (msg: Any) => {
      auditUpdate(msg, agent.getSetupMessage());
      updates.push({
        version: msg.version,
        source: msg.source,
        received_wall: wall(),
        received_in_round: engine.getRenderState().score.pointIndex,
        settings: msg.settings ?? null,
        new_values: Object.keys(msg.new_values ?? {}),
        changes: (msg.changes ?? []).length,
        checks: (msg.checks ?? []).length,
        first_round_played: null,
        swapped_wall: null,
      });
      brain.queueStrategyUpdate(msg);
      if (contrarianBase) profile = againstBehaviour(contrarianBase, msg.behaviour, brain.getLatestValues());
    },
  },
});

if (!asShipped) {
  // An open-ended match sends the game's own plan, with only what a flag names laid over it.
  const plan: Any = openSeconds === null ? { rounds, breakEvery: planBreakEvery, breakSeconds } : {};
  if (openSeconds !== null && (args['plan-break-every'] || args['break-every'])) plan.breakEvery = planBreakEvery;
  if (openSeconds !== null && args['break-seconds']) plan.breakSeconds = breakSeconds;
  agent.setSetup(P.createTennisSetup({ matchId, mode: 'live', ...plan }));
}

const roundRows: Any[] = [];
let current: Any = null;

const engine: Any = new game.TennisMatchEngine(brain, {
  totalDemoPoints: rounds,
  breakEvery,
  enableDemoPauses: breaksOn,
  rng,
  sink: {
    onAgentEvent: (evt: Any) => {
      if (status !== 'connected') droppedWhileOffline += 1;
      agent.sendEvent(evt);
      if (evt.by === 'opponent') {
        picksTotal += Object.keys(evt.picked ?? {}).length;
        picksByRule += (evt.by_rule ?? []).length;
        if (current && evt.by_rule?.length) current.rule_picks += 1;
        const now = brain.getActiveBehaviour().version;
        if (current && now !== current.version) {
          midRoundSwaps.push({ round: evt.round, from: current.version, to: now });
          current.version = now;
        }
      }
    },
    onAgentRoundEnd: (roundEnd: Any) => {
      agent.sendRoundEnd(roundEnd);
      const row = {
        round: roundEnd.round,
        winner: roundEnd.winner,
        how: roundEnd.how,
        rally: roundEnd.stats?.rally_length ?? 0,
        version: current?.version ?? null,
        speed: current?.speed ?? null,
        rule_picks: current?.rule_picks ?? 0,
        score: `${roundEnd.score.player}-${roundEnd.score.opponent}`,
        break: roundEnd.break,
        t: roundEnd.t,
      };
      roundRows.push(row);
      if (reactive) {
        if (reactive.lastVersion !== null && row.version !== reactive.lastVersion) {
          reactive.opponentChanged = true;
          reactive.lostSinceChange = 0;
        }
        reactive.lastVersion = row.version;
        if (reactive.opponentChanged && row.winner !== 'player') reactive.lostSinceChange += 1;
        if (reactive.opponentChanged && reactive.lostSinceChange >= personSettings.reactive.react_after_losses) {
          reactive.reactions += 1;
          reactive.opponentChanged = false;
          reactive.lostSinceChange = 0;
          profile = reactStyle(reactive.base, reactive.reactions);
          reactive.log.push({ after_round: row.round, style: reactive.reactions % 4 });
        }
      }
      if (dropSocketAt === row.round) liveSocket?.close();
      if (badEventsAt === row.round && liveSocket?.readyState === 1) {
        for (const bad of [
          { type: 'event', match_id: matchId, name: 'shot', round: row.round, t: row.t, by: 'player', data: { side: 'forehand', spin: 'heavy' } },
          { type: 'event', match_id: matchId, name: 'teleport', round: row.round, t: row.t, by: 'player', data: {} },
          { type: 'event', match_id: matchId, name: 'shot', by: 'player', data: { side: 'sideways', power: 7 } },
        ]) {
          onWire('out', JSON.stringify(bad));
          liveSocket.send(JSON.stringify(bad));
        }
      }
      // What the scripted player itself did in this point: the game's events do not tell
      // a miss the script chose from a ball the opponent put out of reach.
      const counts = afterTick.counts ?? { swings: 0, own_misses: 0, weakness_misses: 0 };
      const script = {
        swings: counts.swings - scriptSeen.swings,
        own_misses: counts.own_misses - scriptSeen.own_misses,
        weakness_misses: counts.weakness_misses - scriptSeen.weakness_misses,
      };
      scriptSeen = { ...counts };
      writeLog({ dir: 'meta', wall: wall(), wall_start: current?.wallStart ?? null, round: row.round, version: row.version, settings: { opponent_speed: row.speed }, script });
      if (!quiet) {
        console.log(
          `pt ${String(row.round).padStart(2)} ${row.winner.padEnd(8)} ${String(row.how).padEnd(11)} rally ${String(row.rally).padStart(2)}  v${row.version} speed ${row.speed}  rules ${row.rule_picks}  score ${row.score}  t ${row.t}s  reads ${reads} updates ${updates.length}${row.break ? '  break' : ''}`,
        );
      }
    },
    onPhaseChange: (phase: string) => {
      if (phase !== 'serving') return;
      const version = brain.getActiveBehaviour().version;
      const round = engine.getRenderState().score.pointIndex;
      current = { version, speed: brain.getSettings().opponent_speed, rule_picks: 0, wallStart: wall() };
      for (const update of updates) {
        if (update.version === version && update.first_round_played === null) {
          update.first_round_played = round;
          update.swapped_wall = wall(); // the serve that first plays it: the game swaps a behaviour in between points
        }
      }
    },
  },
});

const secondProfile = players.second ? resolveProfile(game, players.second, personas, personSettings) : null;
const profileNow = () =>
  secondProfile && engine.getRenderState().score.pointIndex >= switchAt ? secondProfile : profile;

let afterTick: Any = () => {};
let scriptSeen = { swings: 0, own_misses: 0, weakness_misses: 0 };
const begin = () => {
  engine.startMatch();
  afterTick = makeScriptedPlayer(engine, profileNow, rng, game);
};

if (startMode === 'ready') {
  await agent.connectAndSetup();
  begin();
} else {
  // As the game does: play starts at once and `ready` lands when it lands.
  begin();
  void agent.connectAndSetup();
}

const played = await playToEnd(game, engine, () => afterTick(), {
  rounds,
  pace,
  breakSeconds,
  stopAfterSeconds: openSeconds,
  onBreak: (pointsPlayed, seconds) => writeLog({ dir: 'break', wall: wall(), after_round: pointsPlayed, seconds }),
});
await sleep(linger * 1000);
agent.disconnect();

const finalScore = engine.getRenderState().score;
const versionsUsed = [...new Set(roundRows.map((r) => r.version))];
const summary = {
  match_id: matchId,
  game_commit: gameCommit,
  player: playerName,
  switch_at: secondProfile ? switchAt : null,
  open_ended_seconds: openSeconds,
  breaks: breaksOn ? { every: breakEvery, seconds: breakSeconds } : null,
  person_settings: players.first.startsWith('person-') ? personSettings : null,
  style_changes: reactive ? reactive.log : null,
  url,
  rounds_played: roundRows.length,
  score: { player: finalScore.humanPoints, opponent: finalScore.aiPoints },
  player_share: roundRows.length ? Math.round((finalScore.humanPoints / roundRows.length) * 1000) / 1000 : null,
  pace: paceArg,
  start: startMode,
  seed,
  wall_seconds: wall(),
  final_status: mockFallback ? 'mock' : status,
  mock_fallback: mockFallback,
  ready_after_seconds: readyAt,
  setup_to_ready_seconds: readyAt !== null && setupSentAt !== null ? Math.round((readyAt - setupSentAt) * 1000) / 1000 : null,
  ready_messages: readyCount,
  status_changes: statusLog,
  events_dropped_while_not_connected: droppedWhileOffline,
  picks: { total: picksTotal, by_rule: picksByRule },
  mid_round_behaviour_changes: midRoundSwaps,
  max_lag_behind_wall_clock_ms: played.maxLagMs,
  messages_sent_before_ready: sentBeforeReady,
  sent: sentCounts,
  received: receivedCounts,
  player_reads: reads,
  last_values: lastRead?.values ?? null,
  updates,
  versions_by_round: roundRows.map((r) => r.version),
  versions_used: versionsUsed,
  updates_never_played: updates.filter((u) => u.first_round_played === null).map((u) => u.version),
  final_settings: brain.getSettings(),
  errors,
  game_would_not_apply: [...notes.entries()].map(([line, count]) => ({ count, line })),
};
writeLog({ dir: 'summary', wall: wall(), summary });
console.log(JSON.stringify(summary));
process.exit(mockFallback ? 2 : 0);
