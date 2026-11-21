// Node CLI entrypoint for headless practice mode & local proof verification.
// Usage:
//   Connect to Felix & Gavin's live WebSocket server in `mode: "practice"`:
//     cd client && npm run practice
//     cd client && npm run practice -- --ws ws://localhost:8000/ws
//   Benchmark locally (proves >=25% shot-choice margin):
//     cd client && npm run practice:benchmark

import type { BehaviourJson, PracticePersona } from '@shared/contracts';
import { DEFAULT_TENNIS_BEHAVIOUR } from '@shared/agentProtocol';
import { AgentClient, type WebSocketLike } from '../ai/AgentClient';
import {
  UnknownPracticePlayerError,
  compareBehavioursHeadless,
  runPracticeBatch,
} from './PracticeRunner';

function makeCounterBehaviour(
  shotType: 'slice' | 'dropshot' | 'lob',
  aim: 'left_deep' | 'left_short' | 'right_short' | 'right_deep',
  position: 'left_deep' | 'middle_deep' | 'right_deep' | 'middle_short' = 'middle_deep',
): BehaviourJson {
  const b: BehaviourJson = structuredClone(DEFAULT_TENNIS_BEHAVIOUR);
  b.version = 2;
  b.npcs.opponent.decisions.shot_type = {
    topspin: { base: 0.04 },
    flat: { base: 0.04 },
    slice: { base: shotType === 'slice' ? 0.88 : 0.04 },
    dropshot: { base: shotType === 'dropshot' ? 0.88 : 0.04 },
    lob: { base: shotType === 'lob' ? 0.88 : 0.04 },
  };
  b.npcs.opponent.decisions.aim = {
    left_deep: { base: aim === 'left_deep' ? 0.88 : 0.03 },
    middle_deep: { base: 0.03 },
    right_deep: { base: aim === 'right_deep' ? 0.88 : 0.03 },
    left_short: { base: aim === 'left_short' ? 0.88 : 0.03 },
    right_short: { base: aim === 'right_short' ? 0.88 : 0.03 },
  };
  b.npcs.opponent.decisions.position = {
    middle_deep: { base: position === 'middle_deep' ? 0.8 : 0.08 },
    left_deep: { base: position === 'left_deep' ? 0.8 : 0.06 },
    right_deep: { base: position === 'right_deep' ? 0.8 : 0.06 },
    middle_short: { base: position === 'middle_short' ? 0.8 : 0.06 },
  };
  return b;
}

export async function runLocalBenchmark() {
  const fhCounter = makeCounterBehaviour('slice', 'left_deep', 'left_deep');
  const grinderCounter = makeCounterBehaviour('dropshot', 'left_short', 'middle_short');
  const agentPersona: PracticePersona = {
    name: 'carbon_forehand_crosscourt',
    about: 'Leans on the forehand and goes cross-court from deep behind the baseline.',
    plays: {
      shot: {
        side: { forehand: 0.8, backhand: 0.2 },
        from: { right_deep: 0.6, middle_deep: 0.3, left_deep: 0.1 },
        lands: { left_deep: 0.6, middle_deep: 0.25, right_deep: 0.15 },
      },
    },
  };

  const results = [
    compareBehavioursHeadless('forehand_lover', DEFAULT_TENNIS_BEHAVIOUR, fhCounter, 80),
    compareBehavioursHeadless('baseline_grinder', DEFAULT_TENNIS_BEHAVIOUR, grinderCounter, 80),
    compareBehavioursHeadless(agentPersona, DEFAULT_TENNIS_BEHAVIOUR, fhCounter, 80),
  ];

  console.log(JSON.stringify({ benchmark: results }, null, 2));
}

export async function connectPracticeWorker(wsUrl: string) {
  let runCounter = 0;
  let WsCtor: (new (url: string) => WebSocketLike) | undefined =
    typeof globalThis.WebSocket !== 'undefined'
      ? (globalThis.WebSocket as unknown as new (url: string) => WebSocketLike)
      : undefined;
  if (!WsCtor) {
    const wsMod = await import('ws');
    WsCtor = wsMod.default as unknown as new (url: string) => WebSocketLike;
  }

  await new Promise<void>((resolve) => {
    const client = new AgentClient({
      wsUrl,
      mode: 'practice',
      matchId: `tennis_practice_${Date.now().toString(36)}`,
      autoReconnect: false,
      readyTimeoutMs: 300_000,
      WebSocketCtor: WsCtor,
      callbacks: {
        onStatus: (s) => console.log(`[PracticeCLI] status=${s}`),
        onPracticeRun: (req) => {
          runCounter += 1;
          try {
            const { reply, durationMs } = runPracticeBatch(req, 1000 + runCounter * 37);
            console.log(
              `[PracticeCLI] run_id=${req.run_id} player=${reply.player} rounds=${reply.rounds} wins=${JSON.stringify(reply.wins)} (${durationMs}ms)`,
            );
            client.sendPracticeResult(reply);
          } catch (err) {
            if (err instanceof UnknownPracticePlayerError) {
              console.error(`[PracticeCLI] ${err.message}`);
              client.sendError({
                where: 'practice_run.player',
                about: err.message,
                got: req.player,
              });
            } else {
              throw err;
            }
          }
        },
        onReady: (ready) => {
          console.log(
            `[PracticeCLI] ready! learned values=${Object.keys(ready.values).join(', ')} behaviour v${ready.behaviour.version} (staying connected until server closes socket)`,
          );
        },
        onError: (err) => {
          console.error(`[PracticeCLI] server error at ${err.where}: ${err.about}`);
        },
        onServerClose: () => {
          console.log('[PracticeCLI] server closed socket; exiting cleanly.');
          resolve();
        },
      },
    });

    void client.connectAndSetup().then(() => {
      if (client.getStatus() === 'mock') {
        console.error(`[PracticeCLI] Could not connect to ${wsUrl} (or timed out waiting for ready).`);
        resolve();
      }
    });
  });
}

// Execute directly only when invoked as CLI script (never when imported as a module)
const isDirectCli =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  Boolean(process.argv[1] && process.argv[1].includes('runPracticeCli'));

if (isDirectCli) {
  const args = process.argv.slice(2);
  if (args.includes('--benchmark')) {
    void runLocalBenchmark();
  } else if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: npm run practice [-- --ws ws://localhost:8000/ws] | npm run practice:benchmark');
  } else {
    const wsIdx = args.lastIndexOf('--ws');
    const wsUrl =
      wsIdx >= 0 && args[wsIdx + 1]
        ? args[wsIdx + 1]
        : process.env.AGENT_WS_URL || 'ws://localhost:8000/ws';
    void connectPracticeWorker(wsUrl);
  }
}
