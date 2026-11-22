# VALOR

A 3v3 round-based tactical shooter that runs in the browser. Keyboard and mouse, no install.

You play with two bot teammates (blue) against three enemy bots (red). There are no respawns inside a round: a team wins the round when the other team is wiped out, and the first team to win 4 rounds wins the match.

The enemy team isn't fixed. Between rounds, a set of agents looks at how you've been winning and changes what the enemies do next round. The HUD shows what they noticed and what they changed, and whether the change came from live Gemini, an offline stand-in, or the baseline. How that works, and the evidence that it actually changes behaviour, is in [docs/PROOF.md](docs/PROOF.md).

## Run it

```bash
npm install
npm run dev        # then open the URL Vite prints
npm test           # unit tests (combat, etc.)
```

Open `/` and click to play. The mouse is captured; press Esc to pause.

## Controls

| Key | Action |
|---|---|
| W A S D | Move |
| Shift (hold) | Walk: quieter and more accurate |
| Ctrl / C | Crouch |
| Space | Jump |
| Mouse | Aim |
| Left click (hold) | Fire (automatic) |
| Right click (hold) | Aim down sights |
| R | Reload |
| Tab (hold) | Scoreboard |
| [ / ] | Mouse sensitivity down / up |
| Esc | Pause |

A few things that help: stop moving before you shoot, aim for the head (headshots do 2.5x damage), and fire in short bursts instead of holding the trigger.

## What's on screen

- Top center: score, round number, round clock, and a pip for each player on both teams (lit = alive).
- Top right: killfeed, with your team in teal and the enemy in red.
- Bottom: health on the left, ammo on the right.
- Between rounds: the result, and a card showing what the enemy AI noticed and what it will do differently. If the game's self-check refused a change the agents proposed, the card says so.
- End of match: victory or defeat, the score, a round-by-round history, and Play again.

## Project layout

- `src/game/` is the game: scene, player, weapon, bots, combat, match state (`match.ts`), HUD and menus (`HUD.tsx`, `StartOverlay.tsx`, `ui/`).
- `src/agent/` connects the enemy team to the adaptive agents (`status.ts` is what the HUD reads).
- `docs/` has design notes and the agent protocol.

## Earlier version

VALOR started at the SpacetimeDB Launchpad Hackathon (NY Tech Week, June 2026) as a webcam-controlled multiplayer shooter: MediaPipe tracked your hands for movement and shooting, a wink zoomed the scope, and matches ran server-authoritatively in a SpacetimeDB module (Rust compiled to WebAssembly) with a broadcast view, an AI commentator and phone voting. That code is still in the repo and reachable by URL hash (`#lobby`, `#multiplayer`, `#broadcast`, `#spectator`, `#join`, `#studio`), but the PC game at `/` doesn't use any of it.

### How the multiplayer version worked

The whole game ran on the server (SpacetimeDB); every client and viewer just subscribed to its tables.

```
   YOUR WEBCAM                         SPACETIMEDB (Rust → WebAssembly)
   ┌──────────────┐                    ┌───────────────────────────────────┐
   │ MediaPipe    │   your inputs      │  8 tables · 16 reducers           │
   │ hands + wink │ ─────────────────► │                                   │
   │ One-Euro     │   (send_input,     │  A SCHEDULED REDUCER runs the     │
   │ smoothing    │    fire, join…)    │  game loop 30 times/second:       │
   └──────────────┘                    │   • move players                  │
          ▲                            │   • raycast hit-registration      │
          │ live table updates         │   • round/score state machine     │
          │ (subscriptions)            │   • kill feed + AI commentary     │
   ┌──────┴───────┐                    └──────────────┬────────────────────┘
   │ GAME CLIENT  │                                   │  one source of truth
   │ R3F + three  │ ◄─────────────────────────────────┤  (the live tables)
   │ predicts +   │                                   │
   │ reconciles   │           everyone below is just a SUBSCRIBER:
   └──────────────┘            ┌──────────────┬──────────────┬─────────────┐
                               │ #broadcast   │ #spectator   │ #join       │
                               │ 2×2 cams +   │ mobile       │ QR wall →   │
                               │ AI caster    │ ghost-cam    │ scan + vote │
                               └──────────────┴──────────────┴─────────────┘
```

Stack: SpacetimeDB (8 tables, 16 reducers, a 30 Hz `tick` scheduled reducer), React Three Fiber + three.js, MediaPipe hands/face with One-Euro smoothing, Vitest + Playwright.

### Its routes (still in the code)

| Link | What it is |
|---|---|
| `…/#multiplayer` | Play. Type a name, pick a side, ready up. Bring a friend for 1v1 or 2v2. |
| `…/#broadcast` | The "esports" view: 2×2 live cams, score bar, AI commentary, start a crowd vote. Great on a big screen. |
| `…/#join` | A big QR code — phones scan it to watch the match. |
| `…/#spectator` | Watch the match (mobile ghost-cam on phones, fixed caster angle on desktop). |

The old build is deployed at https://valor-akhil-1v1.surge.sh.

The SpacetimeDB module lives in `server/` and is built to WebAssembly by GitHub Actions (`.github/workflows/build-server.yml`).

## Team
- **Akhil Mattaparthi**
- **Aidan Yap**

*(plus contributors on the game, characters, and animations)*
