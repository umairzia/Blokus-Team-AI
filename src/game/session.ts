/**
 * What the interface needs from a game in progress, whether it is an
 * offline practice game on this device or an online room.
 */

import type { Level } from '../ai/decide';
import type { Seat } from '../engine/constants';
import type { Action, GameState } from '../engine/game';
import type { Unsubscribe } from '../network/backend';

export type SubmitResult = { ok: true } | { ok: false; error: string };

export interface SeatInfo {
  readonly seat: Seat;
  readonly name: string;
  readonly kind: 'human' | 'ai';
  /** Played from this device. */
  readonly local: boolean;
  /** Humans online only: is their browser connected? null when unknown or not applicable. */
  readonly online: boolean | null;
  /** Online only: nobody has taken this human seat yet. */
  readonly vacant: boolean;
}

export type Connection = 'local' | 'connecting' | 'online' | 'offline';

export interface SessionSnapshot {
  readonly mode: 'practice' | 'online';
  readonly phase: 'lobby' | 'playing' | 'over';
  readonly game: GameState | null;
  readonly level: Level;
  readonly seats: readonly SeatInfo[];
  readonly isHost: boolean;
  readonly code: string | null;
  readonly connection: Connection;
  /** The AI seat currently computing its move. */
  readonly thinking: Seat | null;
  /** A move from this device is waiting for the host. */
  readonly pending: boolean;
  /** Something to show above the board, e.g. "The host is offline". */
  readonly notice: string | null;
  readonly error: string | null;
  /** The room is gone or this device lost its seat. */
  readonly closed: string | null;
  /** Number of games started (changes when a new game begins). */
  readonly gameNumber: number;
}

export interface Session {
  snapshot(): SessionSnapshot;
  subscribe(cb: (s: SessionSnapshot) => void): Unsubscribe;
  /** Plays a move for one of this device's seats. */
  submit(action: Action): Promise<SubmitResult>;
  /** Starts the first or a new game (host / practice only). */
  startGame(): Promise<void>;
  setLevel(level: Level): Promise<void>;
  /** Practice: ends it. Online guest: gives up the seat. Online host: closes the room. */
  leave(): Promise<void>;
  /** Online host: frees the guest seat (partner changed device). */
  freeGuestSeat?(): Promise<void>;
  dispose(): void;
}

export const AI_NAMES: Readonly<Record<number, string>> = { 1: 'AI 1', 3: 'AI 2' };
