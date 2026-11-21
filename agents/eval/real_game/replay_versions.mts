// The big-sample check: replay every behaviour version from a live match.
//
// A live match is a few dozen points, too few to say whether one update
// helped. So this takes a match log written by live_match.mts, pulls out the
// game's default behaviour, the `ready` behaviour and the behaviour in every
// `strategy_update`, and plays each one for many points against the same
// scripted player on the real engine. The goal is a player who wins about
// half the points, so each version's player share shows whether that update
// moved toward it.
//
// Two numbers per version:
//   batch      the game's own runPracticeBatch. It starts a fresh opponent, so
//              it has no player values (every `when` weight counts for
//              nothing) and the default settings. It measures the base
//              weights and the rules alone.
//   as_played  the same points with the last player values and the settings
//              that were in force while that version was live in the match.
//
//   npx --yes tsx --tsconfig <game-root>/client/tsconfig.json eval/real_game/replay_versions.mts \
//       --game-root <game-root> --log match.jsonl --rounds 300
//
// Flags: --game-root DIR, --log FILE (comma-separated for several), --rounds N (default 300),
//        --seed N (default 1337), --player NAME (default: the one in the log), --json (JSON only)

import fs from 'node:fs';
import {
  againstBehaviour,
  batchPlayer,
  defaultGameRoot,
  loadGame,
  loadPersonas,
  makeScriptedPlayer,
  parseArgs,
  playToEnd,
  resolveProfile,
  splitPlayer,
  type Any,
  type Game,
} from './driver.mts';

const args = parseArgs(process.argv.slice(2));
const gameRoot = args['game-root'] ?? defaultGameRoot();
const rounds = Number(args.rounds ?? 300);
const seed = Number(args.seed ?? 1337);
const jsonOnly = args.json === 'true';
const logs = (args.log ?? '').split(',').filter(Boolean);
if (logs.length === 0) {
  console.error('Give --log <match log written by live_match.mts>.');
  process.exit(1);
}

const game = await loadGame(gameRoot);
const personas = loadPersonas(args.personas);

/** The same headless points as runPracticeBatch, but with values and settings in place. */
async function playAsPlayed(g: Game, player: string, behaviour: Any, values: Any, settings: Any): Promise<number> {
  const rng = g.createSeededRng(seed);
  const brain = new g.OpponentBrain(behaviour, rng);
  if (values) brain.updatePlayerValues(values);
  if (settings) {
    brain.queueStrategyUpdate({ settings });
    brain.applyPendingBetweenRounds();
  }
  const engine = new g.TennisMatchEngine(brain, {
    totalDemoPoints: rounds,
    breakEvery: rounds + 1,
    pointOverPauseSec: 0,
    serveWindupSec: 0,
    enableDemoPauses: false,
    rng,
  });
  engine.startMatch();
  let profile = resolveProfile(g, player, personas);
  if (player === 'contrarian') profile = againstBehaviour(profile, behaviour, values ?? {});
  const afterTick = makeScriptedPlayer(engine, profile, rng, g);
  await playToEnd(g, engine, afterTick, { rounds, pace: Infinity, breakSeconds: 0 });
  const score = engine.getRenderState().score;
  return score.humanPoints / Math.max(1, score.humanPoints + score.aiPoints);
}

const share = (x: number) => Math.round(x * 1000) / 1000;
const out: Any[] = [];

for (const file of logs) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const setup = rows.find((r) => r.dir === 'out' && r.message.type === 'setup')?.message;
  const summary = rows.find((r) => r.dir === 'summary')?.summary;
  const player = args.player ?? summary?.player ?? 'even';
  if (!setup) {
    console.error(`${file}: no setup in this log, skipped.`);
    continue;
  }

  // Each version, with the values and settings in force when it was last live.
  const versions: Any[] = [];
  if (setup.default_behaviour) {
    versions.push({ version: setup.default_behaviour.version ?? 0, from: 'default', behaviour: setup.default_behaviour });
  }
  let values: Any = null;
  let settings: Any = {};
  for (const row of rows) {
    if (row.dir !== 'in') continue;
    const m = row.message;
    if (m.type === 'player_read') {
      values = m.values;
    } else if (m.type === 'ready' || m.type === 'strategy_update') {
      // The version before this one ends its run here: pin what it last played with.
      const prev = versions[versions.length - 1];
      if (prev) {
        prev.values = values;
        prev.settings = { ...settings };
      }
      if (m.type === 'strategy_update') settings = { ...settings, ...(m.settings ?? {}) };
      versions.push({ version: m.behaviour?.version ?? m.version, from: m.type === 'ready' ? 'ready' : m.source, behaviour: m.behaviour });
    }
  }
  const last = versions[versions.length - 1];
  if (last) {
    last.values = values;
    last.settings = { ...settings };
  }

  // A player who changed style: judge each version against the style it was up against.
  const styles = splitPlayer(player);
  const arrivedIn: Record<string, number> = {};
  for (const u of summary?.updates ?? []) arrivedIn[u.version] = u.received_in_round;
  const styleFor = (version: number) =>
    styles.second && (arrivedIn[version] ?? 0) >= (summary?.switch_at ?? Infinity) ? styles.second : styles.first;

  const playedRounds: Record<string, number> = {};
  for (const v of summary?.versions_by_round ?? []) playedRounds[v] = (playedRounds[v] ?? 0) + 1;

  const result: Any[] = [];
  for (const v of versions) {
    const against = styleFor(v.version);
    const forBatch = batchPlayer(against, personas);
    const batch = forBatch === null
      ? null
      : game.runPracticeBatch({ run_id: `replay_v${v.version}`, player: forBatch, rounds, behaviour: v.behaviour }, seed);
    const asPlayed = await playAsPlayed(game, against, v.behaviour, v.values, v.settings);
    result.push({
      version: v.version,
      against,
      from: v.from,
      live_points_played: playedRounds[v.version] ?? 0,
      batch_player_share: batch === null ? null : share(batch.reply.wins.player / Math.max(1, rounds)),
      as_played_player_share: share(asPlayed),
      rules: v.behaviour?.npcs?.opponent?.rules?.length ?? 0,
      settings: v.settings ?? {},
    });
  }
  out.push({ log: file, match_id: setup.match_id, player, rounds, seed, versions: result });

  if (!jsonOnly) {
    console.log(`\n${setup.match_id} | ${player} | ${rounds} points per version, seed ${seed}`);
    console.log('| Version | From | Live points | Player share, batch | Player share, as played | Rules | Speed |');
    console.log('| --- | --- | --- | --- | --- | --- | --- |');
    for (const r of result) {
      console.log(
        `| v${r.version} | ${r.from} | ${r.live_points_played} | ${r.batch_player_share === null ? '-' : Math.round(r.batch_player_share * 100) + '%'} | ${Math.round(r.as_played_player_share * 100)}% | ${r.rules} | ${r.settings.opponent_speed ?? 'default'} |`,
      );
    }
  }
}

if (jsonOnly) console.log(JSON.stringify(out));
else console.log(`\nJSON: ${JSON.stringify(out)}`);
