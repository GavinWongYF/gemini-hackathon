// Mounts Akhil's 3D `CourtScene` (`client/src/scene/CourtScene.tsx` — Gemini Arena + rigged athletes)
// wrapped in an error boundary with a clean 2D broadcast fallback. Nothing ever covers the court.

import React, { Component, useEffect, useRef } from 'react';
import type { MatchRenderState, RecordedShot } from '@shared/contracts';
import { CourtScene, type CourtSceneProps } from '../scene/CourtScene';
import { drawTacticalCourt } from './CourtFrameCapture';

export type { CourtSceneProps };

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
  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <SceneErrorBoundary fallback={<FallbackBroadcastCourt {...props} />}>
        <CourtScene {...props} />
      </SceneErrorBoundary>
    </div>
  );
};
