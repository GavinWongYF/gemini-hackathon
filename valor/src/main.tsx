import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { Game } from "./game/GameScene";
import { GameView } from "./game/GameView";
import { CasterDemo } from "./caster/CasterDemo";
import { CasterLive } from "./caster/CasterLive";
import { Leaderboard } from "./ui/Leaderboard";
import { SpectatorRoute } from "./spectator/SpectatorRoute";
import { JoinWall } from "./spectator/JoinWall";
import { BroadcastView } from "./broadcast/BroadcastView";
import { MultiplayerGame } from "./multiplayer/MultiplayerGame";
import { Lobby } from "./lobby/Lobby";
import { PadPage } from "./pad/PadPage";
import { useMatch } from "./game/match";
import { useAgentStatus } from "./agent/status";

// Dev-only: lets browser smoke tests drive the match / agent UI states.
if (import.meta.env.DEV) {
  (window as unknown as { __valor?: unknown }).__valor = { useMatch, useAgentStatus };
}

// Screens:
//   /                              → VALOR, the PC game (3v3, keyboard + mouse)
//   /?game                         → same game (old link)
// Earlier experiments, still reachable by hash but not linked from the game:
//   /#lobby                        → webcam-era lobby (character pick, invite)
//   /#studio                       → Model Studio — animation-only playground
//   /?game2  or  /#game            → arena prototype (GameView)
//   /#caster, /#caster/live        → AI caster demos
//   /#leaderboard                  → recent rounds from SpacetimeDB
//   /#multiplayer                  → networked multiplayer (SpacetimeDB)
//   /#spectator[/freefly]          → spectator cameras
//   /#broadcast                    → 2×2 multi-POV broadcast + commentary
//   /#join                         → QR join wall
function Root() {
  // Track the hash so Akhil's #game link still works without a full reload.
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const params = new URLSearchParams(window.location.search);
  if (params.has("game")) return <Game />;
  if (params.has("game2") || hash === "#game") return <GameView />;
  if (hash === "#caster/live") return <CasterLive />;
  if (hash === "#caster") return <CasterDemo />;
  if (hash === "#leaderboard") return <Leaderboard />;
  if (hash === "#multiplayer") return <MultiplayerGame />;
  if (hash === "#spectator" || hash === "#spectator/freefly") return <SpectatorRoute />;
  if (hash === "#broadcast") return <BroadcastView />;
  if (hash === "#join") return <JoinWall />;
  if (hash === "#studio") return <App />;
  if (hash === "#lobby") return <Lobby />;
  // Phone controller (QR on the PC start screen): /#pad?room=CODE
  if (hash.startsWith("#pad")) return <PadPage />;
  // Front door: the single-player PC game (keyboard + mouse, no webcam).
  return <Game />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
