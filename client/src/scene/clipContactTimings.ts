import type { AthleteRenderState, AvatarAnimState } from '@shared/contracts';

export type SceneAnimState =
  | AvatarAnimState
  | 'volley_forehand'
  | 'volley_backhand'
  | 'split_step';

export interface ClipContactTiming {
  /** Clip-local time (seconds) where the racket strikes the ball (0 if non-contact clip). */
  contact: number;
  /** Default playback speed multiplier for the clip. */
  speed: number;
}

/**
 * Authoritative contact frame timings (seconds in clip space) and default speeds
 * for the external tennis animation clips in `/models/animations/`.
 */
export const CLIP_CONTACT_TABLE: Record<string, ClipContactTiming> = {
  forehand: { contact: 9 / 30, speed: 1.5 },
  backhand: { contact: 10 / 30, speed: 1.5 },
  slice: { contact: 11 / 30, speed: 1.5 },
  dropshot: { contact: 11 / 30, speed: 1.5 },
  volley_forehand: { contact: 9 / 30, speed: 1.5 },
  volley_backhand: { contact: 9 / 30, speed: 1.5 },
  serve: { contact: 2.054, speed: 1.2 },
  split_step: { contact: 0, speed: 1.8 },
};

export const ONE_SHOT_CLIP_NAMES = new Set<string>([
  'forehand',
  'backhand',
  'slice',
  'dropshot',
  'serve',
  'volley_forehand',
  'volley_backhand',
  'split_step',
  'celebrate',
]);

/**
 * Resolves the intended stroke clip name strictly from `shared/contracts.ts` `AthleteRenderState`.
 */
export function resolveStrokeClipName(athlete: AthleteRenderState): SceneAnimState {
  if (athlete.animState === 'serve') {
    return 'serve';
  }
  if (athlete.swingShotType === 'volley') {
    return athlete.swingSide === 'backhand' ? 'volley_backhand' : 'volley_forehand';
  }
  if (athlete.swingShotType === 'slice') {
    return 'slice';
  }
  if (athlete.swingShotType === 'dropshot') {
    return 'dropshot';
  }
  return athlete.swingSide === 'backhand' ? 'backhand' : 'forehand';
}

export interface StrokePlaybackPlan {
  startTime: number;
  timeScale: number;
}

/**
 * Computes starting clip time and playback timeScale so immediate stroke triggers
 * sweep cleanly through contact within ~60ms and finish with follow-through.
 */
export function computeStrokePlaybackPlan(clipName: string): StrokePlaybackPlan {
  const timing = CLIP_CONTACT_TABLE[clipName];
  if (!timing) {
    return { startTime: 0, timeScale: 1.15 };
  }

  const { contact, speed: baseSpeed } = timing;
  const startTime =
    contact > 0
      ? Math.min(contact * 0.75, Math.max(0, contact - 0.06 * baseSpeed))
      : 0;

  return {
    startTime,
    timeScale: baseSpeed,
  };
}
