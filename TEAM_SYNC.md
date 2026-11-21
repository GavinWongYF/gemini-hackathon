# Team & Multi-Chat Sync Contract (Canonical)

> **Source of truth:** Notion (**[Gemini NYC Hackathon](https://app.notion.com/p/41e544411a7d80bfb622db9e3c244fc9)** / `Docs` DB) + GitHub (`origin/main`: `https://github.com/GavinWongYF/gemini-hackathon`).
> Every parallel Antigravity chat in this workspace MUST read this file + `git status -s` before editing shared contracts or pushing.

---

## 1. Folder & Multi-Chat Ownership (Zero Collisions)

| Owner / Parallel Chat | Strictly Owned Files & Folders | Current State |
| --- | --- | --- |
| **Ethan — Hardware Chat (`d37b0bad`)** | `client/src/hardware/*` (`firmware/`, `ble_bridge.py`, `ImuSwingClassifier.ts`, `WebcamArmTracker.ts`, `HardwareInputManager.ts`, `HardwareTestView.tsx`) | Live 100 Hz BLE/Serial M5 IMU + universal zero-training shot classifier + cross-body webcam arm tracker + `onSwingStart` / `onSwing` |
| **Ethan — Engine & AI Chat (`0f243a7a`)** | `shared/agentProtocol.ts`, `client/src/ai/*` (`AgentClient.ts`, `OpponentBrain.ts`), `client/src/engine/*` (`BallFlightEngine.ts`, `TennisMatchEngine.ts`, `PracticeRunner.ts`, `runPracticeCli.ts`), `TEAM_SYNC.md` | Complete Draft 2 + 12:45 PM WS protocol, single `pick()` (`shot_type`, `aim`, `position`, `anticipate`), fixed-1/60s physics, >2000x real-time headless `practice_run` runner |
| **Ethan — Dashboard / App Shell** | `client/src/dashboard/*`, `client/src/App.tsx` | Pause replay / heatmap / observations overlay (coordinate before editing `App.tsx` or `shared/contracts.ts`) |
| **Akhil (Teammate — DO NOT EDIT)** | `blender/`, `client/public/models/`, `client/src/scene/*` | 3D stadium, rigged athletes, R3F `CourtScene` reading `matchStateRef.current` (`MatchRenderState`) |
| **Felix & Gavin (Teammates — DO NOT EDIT)** | `agents/` (`server/`, `sim/`, `eval/`, `demo/tennis-screen/`, `sdk/`, `docs/`) | End-to-end Gemini 4 Carbon/Neon + Decision 1 WS backend (`ws://localhost:8000/ws`, viewer `/screen/`) |

---

## 2. Locked Protocol Rules With Felix & Gavin (`shared/agentProtocol.ts`)

1. **Identical `setup` across `practice` and `live`:** `createTennisSetup()` sends the **exact same** `views`, `practice`, `events`, `facts`, `npcs`, and `settings` in both `mode: "practice"` and `mode: "live"` so `agents/server/` reuses the cached Carbon design immediately.
2. **Events declared & emitted:**
   - `swing_start` (`by: "player"`, ~85–160 ms before contact): `early_guess`, `confidence`, `backswing`, `initial_speed`, `side`, `arm_zone`.
   - `anticipate` (`by: "opponent"`): `picked: { anticipate }`, `by_rule`, `data: { move }` (`stay | lean_left | lean_right | move_in | move_back`).
   - `shot` (`by: "player" | "opponent"`, once at ball contact): `rally`, `side`, `arm_zone`, `shot_type`, `power` (`0..1`), `rotation` (`-1..1`), `angle` (`-1..1`), `confidence` (`0..1`), `timing` (`early | on_time | late`), `quality` (`0..1`), `from`, `other_position`, `lands`, `result` (`in | out | net`).
   - `missed_swing` (`by: "player"`): `side`, `arm_zone`, `shot_type`, `power`, `reason` (`unreachable | too_early | too_late`).
3. **One `pick()`:** Currently mirrored in `shared/agentProtocol.ts`; as soon as Felix pushes `agents/`, import `agents/sdk/js/pick.js` (and run `agents/sdk/test-vectors.json`) so both sides run one `pick()`.
4. **`opponent_speed` (`0.65..1.25`, default `0.85`):** Controls opponent court movement speed **only** (never ball speed).
