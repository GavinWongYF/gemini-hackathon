// Non-blocking WebSocket client to Felix & Gavin's Agentic Backend (`ws://AGENT_HOST:8000/ws`)
// Implements all 7 messages from Notion "API Design" Draft 2:
//   Outbound: setup, event, frames, round_end
//   Inbound:  ready, player_read, strategy_update (quick + full)
//
// Works in both Browser (native WebSocket) and Node headless practice mode (inject WebSocket ctor).
// Includes a deterministic local mock fallback so the live demo never stalls if backend is offline.

import type {
  AgentPlayerReadMessage,
  AgentReadyMessage,
  AgentStrategyUpdateMessage,
  BehaviourJson,
} from '@shared/contracts';
import {
  DEFAULT_TENNIS_BEHAVIOUR,
  TENNIS_SETTINGS_BOUNDS,
  createTennisSetup,
  type AgentErrorMessage,
  type AgentPracticeRunMessage,
  type AgentToGameMessage,
  type GameEventMessage,
  type GameFramesMessage,
  type GamePracticeResultMessage,
  type GameRoundEndMessage,
  type GameSetupMessage,
  type GameToAgentMessage,
  type MatchMode,
} from '@shared/agentProtocol';

export type AgentConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'mock';

export interface AgentClientCallbacks {
  onStatus?: (status: AgentConnectionStatus) => void;
  onReady?: (msg: AgentReadyMessage) => void;
  onPlayerRead?: (msg: AgentPlayerReadMessage) => void;
  onStrategyUpdate?: (msg: AgentStrategyUpdateMessage) => void;
  onPracticeRun?: (msg: AgentPracticeRunMessage) => void;
  onError?: (msg: AgentErrorMessage) => void;
  onServerClose?: () => void;
}

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export interface AgentClientOptions {
  wsUrl?: string;
  mode?: MatchMode;
  matchId?: string;
  /** If true, never opens a real socket and uses local mock adaptation immediately */
  forceMock?: boolean;
  /** Whether to reconnect automatically when the socket closes (default: true in live, false in practice) */
  autoReconnect?: boolean;
  /** Timeout (ms) to wait for `ready` before starting with default_behaviour */
  readyTimeoutMs?: number;
  /** Optional WebSocket constructor for Node headless practice runs */
  WebSocketCtor?: new (url: string) => WebSocketLike;
  callbacks?: AgentClientCallbacks;
}

const WS_OPEN = 1;

export class AgentClient {
  private wsUrl: string;
  private setupMsg: GameSetupMessage;
  private forceMock: boolean;
  private autoReconnect: boolean;
  private readyTimeoutMs: number;
  private WebSocketCtor: (new (url: string) => WebSocketLike) | null;
  private callbacks: AgentClientCallbacks;

  private ws: WebSocketLike | null = null;
  private status: AgentConnectionStatus = 'disconnected';
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readyReceived = false;
  private outboundQueue: GameToAgentMessage[] = [];

  // Lightweight local stats for offline mock fallback
  private mockShotCount = 0;
  private mockBackhandCount = 0;
  private mockForehandCount = 0;
  private mockDropshotCount = 0;
  private mockVersion = 1;

  constructor(opts: AgentClientOptions = {}) {
    const envUrl =
      typeof import.meta !== 'undefined'
        ? (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_AGENT_WS_URL
        : undefined;
    this.wsUrl = opts.wsUrl ?? envUrl ?? 'ws://localhost:8000/ws';
    const mode = opts.mode ?? 'live';
    this.forceMock = opts.forceMock ?? false;
    this.autoReconnect = opts.autoReconnect ?? mode !== 'practice';
    this.readyTimeoutMs = opts.readyTimeoutMs ?? (mode === 'practice' ? 300_000 : 120_000);
    this.callbacks = opts.callbacks ?? {};
    this.WebSocketCtor =
      opts.WebSocketCtor ??
      (typeof globalThis.WebSocket !== 'undefined'
        ? (globalThis.WebSocket as unknown as new (url: string) => WebSocketLike)
        : null);

    this.setupMsg = createTennisSetup({
      matchId: opts.matchId ?? `tennis_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      mode,
    });
  }

  getMatchId(): string {
    return this.setupMsg.match_id;
  }

  getSetupMessage(): GameSetupMessage {
    return this.setupMsg;
  }

  getStatus(): AgentConnectionStatus {
    return this.status;
  }

  /** Override setup payload before connecting (e.g., custom rounds/break cadence or practice mode). */
  setSetup(setup: GameSetupMessage) {
    this.setupMsg = setup;
  }

  /**
   * Opens the WebSocket, sends `setup`, and resolves when `ready` arrives OR when `readyTimeoutMs`
   * elapses (so the game never deadlocks if the agent server is offline).
   */
  connectAndSetup(): Promise<AgentReadyMessage> {
    this.closedByUser = false;
    this.readyReceived = false;

    if (this.forceMock || !this.WebSocketCtor) {
      this.setStatus('mock');
      const mockReady = this.buildMockReady();
      this.readyReceived = true;
      this.callbacks.onReady?.(mockReady);
      return Promise.resolve(mockReady);
    }

    return new Promise<AgentReadyMessage>((resolve) => {
      let settled = false;
      const finish = (msg: AgentReadyMessage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(msg);
      };

      const timer = setTimeout(() => {
        if (!this.readyReceived) {
          this.setStatus('mock');
          const fallback = this.buildMockReady();
          this.callbacks.onReady?.(fallback);
          finish(fallback);
        }
      }, this.readyTimeoutMs);

      this.openSocket(
        (readyMsg) => {
          finish(readyMsg);
        },
        () => {
          // Server is unreachable (connection refused) -> switch to offline mock right away
          if (!this.readyReceived) {
            this.setStatus('mock');
            const fallback = this.buildMockReady();
            this.callbacks.onReady?.(fallback);
            finish(fallback);
          }
        },
      );
    });
  }

  /** Updates a live setting value on the stored `setup` so any mid-match reconnect reports the active value. */
  updateActiveSetting(name: string, value: number | string) {
    const existing = this.setupMsg.settings[name];
    if (!existing) return;
    if ('min' in existing && typeof value === 'number') {
      existing.now = Math.max(existing.min, Math.min(existing.max, value));
    } else if ('options' in existing && typeof value === 'string') {
      existing.now = value;
    }
  }

  /**
   * Starts a brand-new match with a fresh `match_id`, reconnecting and resending `setup`
   * so restarted matches never merge into a previous `match_id` on the agent server.
   */
  startNewMatch(newMatchId?: string): Promise<AgentReadyMessage> {
    this.disconnect();
    this.outboundQueue = [];
    this.mockShotCount = 0;
    this.mockBackhandCount = 0;
    this.mockForehandCount = 0;
    this.mockDropshotCount = 0;
    this.mockVersion = 1;
    this.setupMsg = createTennisSetup({
      matchId:
        newMatchId ?? `tennis_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      mode: this.setupMsg.mode,
    });
    return this.connectAndSetup();
  }

  disconnect() {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setStatus('disconnected');
  }

  /** Fire-and-forget `event` message (never blocks gameplay). */
  sendEvent(event: Omit<GameEventMessage, 'type' | 'match_id'>) {
    const msg: GameEventMessage = {
      type: 'event',
      match_id: this.setupMsg.match_id,
      ...event,
    };

    if (this.status === 'connected' && this.sendJson(msg)) {
      return;
    }

    // Buffer events during transient socket connect/reconnect so early or mid-match events aren't lost
    if (this.status === 'connecting' || (this.status === 'disconnected' && !this.closedByUser && !this.forceMock)) {
      this.enqueueOutbound(msg);
      return;
    }

    // Only synthesize mock reads when `forceMock` was explicitly requested (never disguise an offline server!)
    if (this.forceMock && this.status === 'mock' && event.by === 'player' && event.name === 'shot') {
      this.mockShotCount += 1;
      if (event.data.side === 'backhand') this.mockBackhandCount += 1;
      else this.mockForehandCount += 1;
      if (event.data.shot_type === 'dropshot') this.mockDropshotCount += 1;

      const fhRatio = this.mockForehandCount / Math.max(1, this.mockShotCount);
      const bhWeak = clamp01(0.35 + (this.mockBackhandCount > 0 ? 0.35 : 0.2));
      const dropRatio = this.mockDropshotCount / Math.max(1, this.mockShotCount);

      const mockRead: AgentPlayerReadMessage = {
        type: 'player_read',
        match_id: this.setupMsg.match_id,
        round: event.round,
        t: event.t,
        values: {
          favors_forehand: Number(fhRatio.toFixed(2)),
          weak_backhand: Number(bhWeak.toFixed(2)),
          likes_dropshots: Number(dropRatio.toFixed(2)),
        },
        based_on_events: this.mockShotCount,
        why: `[Mock] ${this.mockForehandCount}/${this.mockShotCount} player shots were forehands.`,
      };
      this.callbacks.onPlayerRead?.(mockRead);
    }
  }

  /** Fire-and-forget ~1Hz `frames` message (~384px JPEG views). */
  sendFrames(round: number, t: number, views: GameFramesMessage['views']) {
    if (this.setupMsg.mode === 'practice') return;
    if (Object.keys(views).length === 0) return;
    const msg: GameFramesMessage = {
      type: 'frames',
      match_id: this.setupMsg.match_id,
      round,
      t,
      views,
    };
    this.sendJson(msg);
  }

  /** Sends `round_end` when a point finishes. */
  sendRoundEnd(payload: Omit<GameRoundEndMessage, 'type' | 'match_id'>) {
    const msg: GameRoundEndMessage = {
      type: 'round_end',
      match_id: this.setupMsg.match_id,
      ...payload,
    };

    if (this.status === 'connected' && this.sendJson(msg)) {
      return;
    }

    if (this.status === 'connecting' || (this.status === 'disconnected' && !this.closedByUser && !this.forceMock)) {
      this.enqueueOutbound(msg);
      return;
    }

    if (this.forceMock && this.status === 'mock') {
      const update = this.buildMockStrategyUpdate();
      this.callbacks.onStrategyUpdate?.(update);
    }
  }

  /** Sends `practice_result` in reply to a `practice_run` request (headless mode). */
  sendPracticeResult(payload: Omit<GamePracticeResultMessage, 'type' | 'match_id'>) {
    const msg: GamePracticeResultMessage = {
      type: 'practice_result',
      match_id: this.setupMsg.match_id,
      ...payload,
    };
    this.sendJson(msg);
  }

  /** Reports a client-side validation error (e.g. unknown practice player name). */
  sendError(payload: Omit<AgentErrorMessage, 'type' | 'match_id'>) {
    const msg: AgentErrorMessage = {
      type: 'error',
      match_id: this.setupMsg.match_id,
      ...payload,
    };
    this.sendJson(msg);
  }

  private openSocket(onFirstReady?: (msg: AgentReadyMessage) => void, onInitialConnectFail?: () => void) {
    if (!this.WebSocketCtor) return;
    this.setStatus('connecting');
    let opened = false;

    try {
      const ws = new this.WebSocketCtor(this.wsUrl);
      this.ws = ws;

      ws.onopen = () => {
        opened = true;
        this.setStatus('connected');
        // Per Notion API Design: send `setup` on connect AND on reconnect with same `match_id`
        this.sendJson(this.setupMsg);
        this.flushOutboundQueue();
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let parsed: AgentToGameMessage;
        try {
          parsed = JSON.parse(ev.data) as AgentToGameMessage;
        } catch {
          return;
        }
        if (parsed.match_id && parsed.match_id !== this.setupMsg.match_id) return;

        if (parsed.type === 'ready') {
          this.readyReceived = true;
          this.callbacks.onReady?.(parsed);
          onFirstReady?.(parsed);
        } else if (parsed.type === 'player_read') {
          this.callbacks.onPlayerRead?.(parsed);
        } else if (parsed.type === 'strategy_update') {
          if (parsed.settings && typeof parsed.settings.opponent_speed === 'number') {
            const clamped = Math.max(
              TENNIS_SETTINGS_BOUNDS.opponent_speed.min,
              Math.min(TENNIS_SETTINGS_BOUNDS.opponent_speed.max, parsed.settings.opponent_speed),
            );
            this.updateActiveSetting('opponent_speed', clamped);
          }
          this.callbacks.onStrategyUpdate?.(parsed);
        } else if (parsed.type === 'practice_run') {
          this.callbacks.onPracticeRun?.(parsed);
        } else if (parsed.type === 'error') {
          console.warn(
            `[AgentClient] Server validation error at ${parsed.where ?? 'unknown'}: ${parsed.about}`,
            parsed.got,
          );
          this.callbacks.onError?.(parsed);
        }
      };

      ws.onclose = () => {
        if (this.closedByUser) return;
        if (!opened) {
          onInitialConnectFail?.();
        }
        if (this.status === 'connected' || this.status === 'connecting') {
          this.setStatus(this.readyReceived ? 'disconnected' : 'mock');
        }
        this.callbacks.onServerClose?.();
        if (this.autoReconnect) {
          this.scheduleReconnect();
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      this.setStatus('mock');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.closedByUser || this.forceMock || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, 2500);
  }

  private enqueueOutbound(msg: GameToAgentMessage) {
    if (this.outboundQueue.length >= 128) {
      this.outboundQueue.shift();
    }
    this.outboundQueue.push(msg);
  }

  private flushOutboundQueue() {
    if (!this.ws || this.ws.readyState !== WS_OPEN || this.outboundQueue.length === 0) return;
    const pending = this.outboundQueue.splice(0, this.outboundQueue.length);
    for (const m of pending) {
      this.sendJson(m);
    }
  }

  private sendJson(msg: GameToAgentMessage): boolean {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private setStatus(next: AgentConnectionStatus) {
    if (this.status === next) return;
    this.status = next;
    this.callbacks.onStatus?.(next);
  }

  private buildMockReady(): AgentReadyMessage {
    return {
      type: 'ready',
      match_id: this.setupMsg.match_id,
      values: {
        favors_forehand: { label: 'Leans heavily on forehand swings' },
        weak_backhand: { label: 'Loses pace or misses on the backhand side' },
        likes_dropshots: { label: 'Plays soft dropshots frequently' },
      },
      behaviour: {
        ...structuredClone(DEFAULT_TENNIS_BEHAVIOUR),
        version: 1,
      },
    };
  }

  private buildMockStrategyUpdate(): AgentStrategyUpdateMessage {
    this.mockVersion += 1;
    const behaviour: BehaviourJson = structuredClone(DEFAULT_TENNIS_BEHAVIOUR);
    behaviour.version = this.mockVersion;
    behaviour.npcs.opponent.decisions.aim.left_deep = {
      base: 0.34,
      when: { favors_forehand: 0.5, weak_backhand: 0.45 },
    };
    behaviour.npcs.opponent.decisions.shot_type.slice = {
      base: 0.3,
      when: { weak_backhand: 0.5 },
    };
    behaviour.npcs.opponent.rules = [
      {
        if: [{ fact: 'player_last_side', is: 'forehand' }],
        do: { aim: 'left_deep', shot_type: 'slice' },
        why: 'Player relies heavily on forehand; drive low slices deep to the backhand corner.',
      },
    ];

    return {
      type: 'strategy_update',
      match_id: this.setupMsg.match_id,
      version: this.mockVersion,
      source: 'quick',
      observations: [
        `Offline mock active: ${this.mockForehandCount} forehands vs ${this.mockBackhandCount} backhands recorded.`,
        'Player stays deep at the baseline and favors forehand swings.',
      ],
      plan: [
        'Attack the left_deep backhand corner with low-skidding slices.',
        'Increase opponent court coverage speed slightly for longer rallies.',
      ],
      changes: [
        {
          where: 'opponent.aim.left_deep',
          from: { base: 0.22 },
          to: { base: 0.34, when: { favors_forehand: 0.5, weak_backhand: 0.45 } },
          why: 'Push the player off their dominant forehand side.',
        },
        {
          where: 'opponent.rules',
          from: null,
          to: 'After a player forehand, reply with a low slice to left_deep.',
          why: 'Forces backhand recovery under pressure.',
        },
      ],
      settings: { opponent_speed: Math.min(1.15, 0.85 + 0.08 * (this.mockVersion - 1)) },
      behaviour,
    };
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
