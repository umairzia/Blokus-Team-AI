/**
 * Offline practice on one device: both human colours are played here
 * (pass the device between you, or play both), against the two AI seats.
 * Nothing is sent over the network. This is not online multiplayer.
 */

import type { Level } from '../ai/decide';
import type { AiRunner } from '../ai/runner';
import { SEATS, type Seat } from '../engine/constants';
import { ERROR_TEXT, newGame, tryApplyAction, type Action, type GameState } from '../engine/game';
import type { Unsubscribe } from '../network/backend';
import { isAiSeat } from '../network/protocol';
import { mixSeed } from '../util/rng';
import { AI_NAMES, type SeatInfo, type Session, type SessionSnapshot, type SubmitResult } from './session';

export interface PracticeOptions {
  readonly level: Level;
  readonly ai: AiRunner;
  readonly aiDelayMs?: number;
  readonly names?: readonly [string, string];
  readonly seed?: number;
}

export class PracticeSession implements Session {
  private game: GameState = newGame();
  private level: Level;
  private readonly ai: AiRunner;
  private readonly aiDelayMs: number;
  private readonly names: readonly [string, string];
  private seed: number;
  private gameNumber = 1;
  private thinking: Seat | null = null;
  private error: string | null = null;
  private aiToken = 0;
  private disposed = false;
  private readonly listeners = new Set<(s: SessionSnapshot) => void>();

  constructor(opts: PracticeOptions) {
    this.level = opts.level;
    this.ai = opts.ai;
    this.aiDelayMs = opts.aiDelayMs ?? 700;
    this.names = opts.names ?? ['Blue player', 'Red player'];
    this.seed = opts.seed ?? Math.floor(Math.random() * 2 ** 32);
  }

  snapshot(): SessionSnapshot {
    const seats: SeatInfo[] = SEATS.map((seat) => ({
      seat,
      name: isAiSeat(seat) ? AI_NAMES[seat] : this.names[seat === 0 ? 0 : 1],
      kind: isAiSeat(seat) ? 'ai' : 'human',
      local: !isAiSeat(seat),
      online: null,
      vacant: false,
    }));
    return {
      mode: 'practice',
      phase: this.game.status === 'over' ? 'over' : 'playing',
      game: this.game,
      level: this.level,
      seats,
      isHost: true,
      code: null,
      connection: 'local',
      thinking: this.thinking,
      pending: false,
      notice: null,
      error: this.error,
      closed: null,
      gameNumber: this.gameNumber,
    };
  }

  subscribe(cb: (s: SessionSnapshot) => void): Unsubscribe {
    this.listeners.add(cb);
    cb(this.snapshot());
    this.scheduleAi();
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    if (this.disposed) return;
    const s = this.snapshot();
    for (const cb of this.listeners) cb(s);
  }

  async submit(action: Action): Promise<SubmitResult> {
    if (isAiSeat(action.seat)) return { ok: false, error: ERROR_TEXT['not-your-turn'] };
    return this.apply(action);
  }

  private apply(action: Action): SubmitResult {
    const res = tryApplyAction(this.game, action);
    if (!res.ok) return { ok: false, error: ERROR_TEXT[res.error] };
    this.game = res.state;
    this.emit();
    this.scheduleAi();
    return { ok: true };
  }

  private scheduleAi(): void {
    const g = this.game;
    if (this.disposed || g.status !== 'playing' || !isAiSeat(g.turn) || this.thinking !== null) return;
    const seat = g.turn;
    const token = ++this.aiToken;
    this.thinking = seat;
    this.emit();
    const started = Date.now();
    this.ai
      .decide(g, seat, this.level, mixSeed(this.seed, g.n, seat))
      .then(async (d) => {
        const wait = this.aiDelayMs - (Date.now() - started);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (token !== this.aiToken || this.disposed) return;
        this.thinking = null;
        const r = this.apply(d.action);
        if (!r.ok) this.error = `The AI could not move: ${r.error}`;
      })
      .catch((err: unknown) => {
        if (token !== this.aiToken) return;
        this.thinking = null;
        this.error = `The AI could not move: ${(err as Error).message}`;
        this.emit();
      });
  }

  async startGame(): Promise<void> {
    this.aiToken++;
    this.thinking = null;
    this.error = null;
    this.game = newGame();
    this.gameNumber++;
    this.seed = mixSeed(this.seed, this.gameNumber);
    this.emit();
    this.scheduleAi();
  }

  async setLevel(level: Level): Promise<void> {
    this.level = level;
    this.emit();
  }

  async leave(): Promise<void> {
    this.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.aiToken++;
    this.listeners.clear();
  }
}
