# Team & Multi-Chat Sync Contract (Canonical)

> **Source of truth** for Ethan's parallel Antigravity sessions, Akhil (3D Scene / Blender), and Felix & Gavin (Agentic System WebSocket Backend).
> Aligned against Notion **API Design (Draft 2)**, **API Design examples: tennis and CS:GO**, and **What the agent side needs from the game** (Nov 21, 11:55 AM ET).

---

## 1. Active Folder Ownership (Zero Merge Conflicts)

| Owner / Session | Owned Files & Folders | Status |
|---|---|---|
| **Ethan (Hardware Chat `d37b0bad`)** | `hardware/m5_tennis_imu/`, `client/src/hardware/*`, `client/src/App.tsx` (test view) | Building M5 ESP32 IMU + MediaPipe `WebcamArmTracker` + `HardwareInputManager` |
| **Ethan (Integration / Engine / AI / Dashboard)** | `shared/agentProtocol.ts`, `client/src/ai/*`, `client/src/engine/*`, `client/src/dashboard/*` | `shared/agentProtocol.ts`, `client/src/ai/OpponentBrain.ts`, `client/src/ai/AgentClient.ts` wired to Felix & Gavin Draft 2 |
| **Akhil (3D Scene & Blender)** | `blender/`, `client/public/models/`, `client/src/scene/*` | Built in Notion zip; ready to push to `main` |
| **Felix & Gavin (Agentic Backend)** | `agents/` (`agents/server/`, `agents/sim/`, `agents/eval/`, `agents/demo/tennis-screen/`, `agents/sdk/`, `agents/docs/api.md`) | WebSocket server on `ws://localhost:8000/ws` (Draft 2 + 12:00 PM additions) |

---

## 2. Locked Interface with Felix & Gavin (`shared/agentProtocol.ts`)

**Do NOT use the old REST `CONTRACTS.md` (`/session/init`, `/telemetry/tick`, `/round/adapt`).**
Everything uses **Felix & Gavin's Notion API Design Draft 2** (`ws://localhost:8000/ws`):

- **7 WebSocket messages:** `setup`, `ready`, `event`, `frames`, `round_end`, `player_read`, `strategy_update` (`quick` & `full`).
- **Real Tennis `setup` names (replacing Notion placeholders):**
  - `lists.zone`: `["left_short", "middle_short", "right_short", "left_deep", "middle_deep", "right_deep"]`
  - `lists.human_shot_type`: `["topspin", "slice", "dropshot"]` *(matches `ImuSwingClassifier` + `HardwareInputManager`)*
  - `lists.ai_shot_type`: `["topspin", "flat", "slice", "dropshot", "lob"]`
  - `lists.arm_zone`: `["left", "center", "right"]` *(matches `WebcamArmTracker`)*
  - `npcs.opponent.decisions`: `shot_type`, `aim` (`left_deep|middle_deep|right_deep|left_short|right_short`), `position` (`middle_deep|left_deep|right_deep|middle_short`)
  - `settings.opponent_speed`: `min: 0.65`, `max: 1.25`, `now: 0.85` *(controls opponent court movement speed ONLY, never ball speed)*
- **Single decision point (`pick()`):** All opponent shot/aim/position choices go through `OpponentBrain.decideShot()` -> `pick()` in `client/src/ai/OpponentBrain.ts`. Once Felix & Gavin push `agents/sdk/js/pick.js` + `agents/sdk/test-vectors.json`, we will import `agents/sdk/js/pick.js` directly (or verify against all 36 test vectors) so there is strictly one `pick()`.
- **Clean scaffold:** Empty `agentic-api/` folder removed; Felix & Gavin own `agents/`.
- **Between-round swaps only:** `OpponentBrain.queueStrategyUpdate()` buffers updates; `applyPendingBetweenRounds()` applies them between points (never mid-rally).
- **Webcam `player_cam` frames:** `hardwareInput.webcam.capturePlayerCamJpeg(384)` already outputs unmirrored 384px base64 JPEGs ready for `AgentClient.sendFrames()`.

---

## 3. Two Remaining Action Items for Full End-to-End Fit

1. **For Ethan's `client/src/engine/` (next step):**
   - Keep `client/src/engine/` **100% pure TypeScript (no React / Three.js / DOM)** so the exact same ball physics + rally + `OpponentBrain` runs:
     - at 60 FPS in the browser driving Akhil's `matchStateRef.current` (`MatchRenderState`), AND
     - headlessly in Node (`mode: "practice"`, no screen, >100× real-time) with a configurable scripted player (e.g., `"70% forehand, weak backhand"`) for Felix & Gavin's onboarding + proof benchmark (25% of judging).
   - Ensure opponent shot choices (`shot_type` + `aim`) have a **≥25% return-difficulty gap** against player weaknesses (e.g., wide `left_deep` slices / short `dropshot`s noticeably harder for a weak-backhand / deep-baseline player).
2. **For Akhil (`client/src/scene/CourtScene.tsx`):**
   - Push `client/src/scene/`, `client/public/models/`, and `blender/` to `main`.
   - Add `preserveDrawingBuffer: true` to `<Canvas gl={{ ... }} />` in `CourtScene.tsx` (or expose a `captureCourtJpeg(384)` helper) so `frames.views.court` doesn't capture blank black frames.
   - Note that `PlayerControlState` in `shared/contracts.ts` was updated for the stationary M5 IMU + Webcam Arm Tracker (`arm.armZone`, `arm.wing`, `imuConnected`); Akhil's `CourtScene.tsx` only reads `MatchRenderState` (which is **100% unchanged**), so his 3D scene stays completely drop-in compatible!
