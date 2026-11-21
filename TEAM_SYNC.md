# Team & Multi-Chat Sync Contract (Canonical)

> **Source of truth:** Notion (**[Gemini NYC Hackathon](https://app.notion.com/p/41e544411a7d80bfb622db9e3c244fc9)** / `Docs` DB) + GitHub (`origin/main`: `https://github.com/GavinWongYF/gemini-hackathon`).
> Auto-injected into all of Ethan's Antigravity chats via `.agents/rules/team-boundaries.md`. Update this file whenever you add or change a cross-module interface.

---

## 1. Folder & Multi-Chat Ownership (Zero Collisions)

| Owner / Parallel Chat | Strictly Owned Files & Folders | Current State |
| --- | --- | --- |
| **Ethan — Hardware Chat (`d37b0bad`)** | `client/src/hardware/*` (`firmware/`, `ble_bridge.py`, `MadgwickAhrs.ts`, `ImuSwingClassifier.ts`, `WebcamArmTracker.ts`, `HardwareInputManager.ts`, `HardwareTestView.tsx`) | Live 100 Hz BLE/Serial M5 IMU + Madgwick AHRS + universal shot classifier + cross-body webcam arm tracker |
| **Ethan — Engine & AI Chat (`0f243a7a`)** | `shared/agentProtocol.ts`, `client/src/ai/*`, `client/src/engine/*`, `TEAM_SYNC.md` | Draft 2 + Section 10 verified: 36/36 `pick()`, `TENNIS_MATCH_PLAN` (`break_every: 2`), `ready`-gated match start, fresh `match_id` on restart, `cd client && npm run practice` (`300s` timeout, stays open until server closes) |
| **Ethan — Dashboard / App Shell** | `client/src/dashboard/*`, `client/src/App.tsx`, `client/src/matchMain.tsx`, `client/index.html`, `client/match.html`, `client/vite.config.ts` | Two separate pages: `/` (`index.html`) = Ethan's Hardware & Classifier UI; `/match` (`match.html`) = Akhil's 3D `CourtScene` + Felix & Gavin's 3-column `<npc-panel side="left\|right">` Google-clean live match |
| **Akhil (Teammate — DO NOT EDIT)** | `blender/`, `client/public/models/`, `client/src/scene/*` | Merged (`f3d0e9f`): Gemini Arena 3D stadium, Gemini vs GPT rigged athletes + Mixamo strokes/volleys/split-step, R3F `CourtScene` |
| **Felix & Gavin (Teammates — DO NOT EDIT)** | `agents/` (`server/`, `sim/`, `eval/`, `demo/tennis-screen/`, `sdk/`, `docs/`) | End-to-end Gemini 4 Carbon/Neon + Decision 1 WS backend (`ws://localhost:8000/ws`, viewer `/screen/`) |

---

## 2. Locked Internal Interfaces Across Ethan's Chats (DO NOT BREAK)

`LiveMatchView.tsx` and `TennisMatchEngine.ts` rely on these exact methods on `hardwareInput` (`client/src/hardware/HardwareInputManager.ts`):
- `hardwareInput.start(wsUrl?: string): void`
- `hardwareInput.getState(): PlayerControlState`
- `hardwareInput.onSwingStart(cb: (evt: PlayerSwingStartEvent) => void): () => void`
- `hardwareInput.onSwing(cb: (evt: PlayerSwingEvent) => void): () => void`
- `hardwareInput.triggerManualSwing(overrides?): void`
- `hardwareInput.webcam.capturePlayerCamJpeg(targetWidth?: number, quality?: number): string | null`

And Akhil's `client/src/scene/CourtScene.tsx` relies on `CourtSceneProps` & `MatchRenderState` in `shared/contracts.ts`:
- `CourtScene({ matchStateRef, replayMode, replayArcs, onCanvasClick })`

---

## 3. Locked Protocol Rules With Felix & Gavin (`shared/agentProtocol.ts`)

1. **Identical `setup` across `practice` and `live`:** `createTennisSetup()` sends the **exact same** `views`, `practice`, `events`, `facts`, `npcs`, and `settings` in both `mode: "practice"` and `mode: "live"` so `agents/server/` reuses the cached Carbon design immediately.
2. **Events declared & emitted:**
   - `swing_start` (`by: "player"`, ~85–160 ms before contact): `early_guess`, `confidence`, `backswing`, `initial_speed`, `side`, `arm_zone`.
   - `anticipate` (`by: "opponent"`): `picked: { anticipate }`, `by_rule`, `data: { move }` (`stay | lean_left | lean_right | move_in | move_back`).
   - `shot` (`by: "player" | "opponent"`, once at ball contact): `rally`, `side`, `arm_zone`, `shot_type`, `power` (`0..1`), `rotation` (`-1..1`), `angle` (`-1..1`), `confidence` (`0..1`), `timing` (`early | on_time | late`), `quality` (`0..1`), `from`, `other_position`, `lands`, `result` (`in | out | net`). *(Opponent shots omit player-only IMU fields.)*
   - `missed_swing` (`by: "player"`): `side`, `arm_zone`, `shot_type`, `power`, `reason` (`unreachable | too_early | too_late`).
3. **One `pick()`:** Mirrored in `shared/agentProtocol.ts`; once Felix pushes `agents/`, import `agents/sdk/js/pick.js` (and run `agents/sdk/test-vectors.json`).
4. **`opponent_speed` (`0.65..1.25`, default `0.85`):** Controls opponent court movement speed **only** (never ball speed).
5. **Enriched `practice_result.stats`:** Reports `average_exchanges`, `average_point_seconds`, `average_quality` (`0..1`), `missed_swings`, and `forced_errors`.
