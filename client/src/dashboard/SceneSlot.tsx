// Zero-conflict dynamic slot for Akhil's `client/src/scene/CourtScene.tsx`.
// - Before Akhil pushes `client/src/scene/CourtScene.tsx` & `public/models/*.glb`:
//   Renders a smooth 60 FPS interactive broadcast fallback canvas with the EXACT same
//   `CourtSceneProps` interface so Ethan can play & test live matches right now.
// - The moment Akhil pushes `client/src/scene/CourtScene.tsx` + models:
//   Vite's `import.meta.glob` + model probe automatically mounts Akhil's 3D `CourtScene`
//   with ZERO code edits and ZERO merge conflicts!

import React, { Component, useEffect, useRef, useState } from 'react';
import type { MatchRenderState, RecordedShot } from '@shared/contracts';
import { drawTacticalCourt } from './CourtFrameCapture';

export interface CourtSceneProps {
  matchStateRef: React.MutableRefObject<MatchRenderState>;
  replayMode: boolean;
  replayArcs: RecordedShot[];
  onCanvasClick?: () => void;
}

type CourtSceneComponent = React.ComponentType<CourtSceneProps>;

// Vite resolves this at build/dev time without error even when `../scene/CourtScene.tsx` doesn't exist yet!
const sceneModules = (
  import.meta as unknown as {
    glob: <T>(pattern: string) => Record<string, () => Promise<T>>;
  }
).glob<{ CourtScene: CourtSceneComponent }>('../scene/CourtScene.tsx');

class SceneErrorBoundary extends Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

function FallbackBroadcastCourt({
  matchStateRef,
  replayMode,
  replayArcs,
  onCanvasClick,
}: CourtSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(320, Math.floor(rect.width * dpr));
      const h = Math.max(240, Math.floor(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const arcs = replayMode ? replayArcs : matchStateRef.current.replayArcs;
      drawTacticalCourt(ctx, w, h, matchStateRef.current, arcs);

      // Draw glowing bounce heatmap directly on the court during replayMode (never in a separate modal!)
      if (replayMode && arcs.length > 0) {
        const padX = w * 0.2;
        const padY = h * 0.08;
        const courtW = w - padX * 2;
        const courtH = h - padY * 2;
        const toX = (x: number) => w * 0.5 + (x / 5.5) * (courtW * 0.5);
        const toY = (z: number) => h * 0.5 + (z / 11.5) * (courtH * 0.5);
        for (const shot of arcs) {
          if (!shot.bouncePos) continue;
          const bx = toX(shot.bouncePos.x);
          const by = toY(shot.bouncePos.z);
          const grad = ctx.createRadialGradient(bx, by, 2, bx, by, 24);
          grad.addColorStop(0, shot.actor === 'human' ? 'rgba(56,189,248,0.75)' : 'rgba(251,113,133,0.75)');
          grad.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(bx, by, 24, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [matchStateRef, replayMode, replayArcs]);

  return (
    <div
      className="scene-root"
      onPointerDown={onCanvasClick}
      style={{ position: 'relative', width: '100%', height: '100%', cursor: 'pointer' }}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      <div
        style={{
          position: 'absolute',
          bottom: 12,
          right: 14,
          fontSize: 11,
          color: '#94a3b8',
          background: 'rgba(15,23,42,0.78)',
          padding: '4px 9px',
          borderRadius: 6,
          border: '1px solid rgba(148,163,184,0.2)',
          pointerEvents: 'none',
        }}
      >
        2D Tactical Preview • Auto-upgrades to Akhil&apos;s 3D CourtScene once pushed
      </div>
    </div>
  );
}

export const SceneSlot: React.FC<CourtSceneProps & { containerRef?: React.RefObject<HTMLDivElement> }> = ({
  containerRef,
  ...props
}) => {
  const [AkhilScene, setAkhilScene] = useState<CourtSceneComponent | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loader = sceneModules['../scene/CourtScene.tsx'];
    if (!loader) return;

    // Also verify `/models/court_stadium.glb` is present so `useGLTF` doesn't 404 before models are pushed
    void (async () => {
      try {
        const head = await fetch('/models/court_stadium.glb', { method: 'HEAD' });
        const contentType = head.headers.get('content-type') ?? '';
        // Vite SPA fallback returns text/html when a static file doesn't exist yet
        if (!head.ok || contentType.includes('text/html')) return;
        const mod = await loader();
        if (!cancelled && mod?.CourtScene) {
          setAkhilScene(() => mod.CourtScene);
        }
      } catch {
        // Keep clean 2D fallback until 3D scene + .glb models are present
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const fallback = <FallbackBroadcastCourt {...props} />;

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      {AkhilScene ? (
        <SceneErrorBoundary fallback={fallback}>
          <AkhilScene {...props} />
        </SceneErrorBoundary>
      ) : (
        fallback
      )}
    </div>
  );
};
