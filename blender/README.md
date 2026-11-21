# 3D: stadium, players, animations (Akhil)

Everything here plugs into Ethan's app with no edits outside these folders:
`blender/`, `client/public/models/`, `client/src/scene/`.
`client/src/dashboard/SceneSlot.tsx` mounts `client/src/scene/CourtScene.tsx` automatically.

## What's in the game

| File | What it is |
| --- | --- |
| `client/public/models/court_stadium.glb` | Gemini Arena: gradient court, oval enclosure, LED boards, lower bowl (Draco, ~0.7 MB) |
| `client/public/models/player_athlete.glb` | Gemini bot, the human player, near side (Draco, ~0.4 MB) |
| `client/public/models/ai_athlete.glb` | GPT bot, the opponent, far side (Draco, ~0.4 MB) |
| `client/public/models/racket.glb` | Racket, attached to `mixamorig:RightHand` |
| `client/public/models/animations/*.glb` | 12 clips: forehand, backhand, slice, dropshot, serve, idle, run_left/right/forward, split_step, volley_forehand/backhand |
| `client/public/models/draco/` | Local Draco decoder, so no CDN is needed at the venue |

Both players use the Mixamo skeleton (`mixamorig:*`, 41 bones), 1.8 m tall, ~20k faces, 512 px textures.
Clips are retargeted rotation-only (no hip translation), so the engine moves the players and the clips only animate them.

## Scene (`client/src/scene/`)

- `CourtScene.tsx`: entry point, matches `CourtSceneProps` from `SceneSlot.tsx`, reads only `MatchRenderState` from `shared/contracts.ts`.
- `TennisAvatar.tsx`: loads a player, attaches the racket, picks stroke/locomotion clips from `animState`, `swingTriggerId`, `swingSide`, `swingShotType` and velocity.
- `externalAnimations.ts`: loads `/models/animations/*.glb` and retargets them onto the rigs.
- `clipContactTimings.ts`: contact frame for each stroke clip, so the swing lines up with the ball.
- `BroadcastCamera.tsx`: TV camera behind the near baseline, switches framing for portrait phones.
- `TennisBallAndTrajectories.tsx`: ball, contact shadow, trail, bounce marks, replay arcs.
- `CourtStadium.tsx`: loads the stadium at the origin (court lines at x = ±5.5, z = ±11.5, net at z = 0).

## Rebuilding the players from Tripo

```
blender -b -P blender/convert_tripo_players.py -- --gemini <gemini.fbx> --gpt <gpt.fbx>
```

This scales to 1.8 m, decimates to ~20k faces, shrinks textures to 512 px, exports Draco GLBs, and writes previews to `blender/previews/`.
`build_racket.py` rebuilds `racket.glb`. The stadium was modelled live in Blender; the `.blend` is kept locally, not in git (too large).

## Notes for Ethan

- The engine never sets `animState = 'celebrate'` at `point_over`, so there's no win animation. The scene ignores it if it's missing.
- Anything new the engine adds to `AthleteRenderState`, such as a predicted contact time, can make swing timing tighter. The scene degrades gracefully without it.
