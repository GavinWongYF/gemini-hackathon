// Dynamic slot for Akhil's `client/src/scene/CourtScene.tsx`.
// Automatically mounts Akhil's 3D scene when `client/src/scene/CourtScene.tsx` + `/models/court_stadium.glb`
// are present, and renders a clean architectural 2D court before that. Nothing sits over the court.

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
      const arcs = replayMode ? replayArcs : [];
      drawTacticalCourt(ctx, w, h, matchStateRef.current, arcs, replayMode);
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

    void (async () => {
      try {
        const head = await fetch('/models/court_stadium.glb', { method: 'HEAD' });
        const contentType = head.headers.get('content-type') ?? '';
        if (!head.ok || contentType.includes('text/html')) return;
        const mod = await loader();
        if (!cancelled && mod?.CourtScene) {
          setAkhilScene(() => mod.CourtScene);
        }
      } catch {
        // Keep 2D court until 3D scene + .glb models are present
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
