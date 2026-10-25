/** Adapts an OnlineGame (one browser's view of a room) to the Session interface. */

import type { Level } from '../ai/decide';
import { SEATS, type Seat } from '../engine/constants';
import type { Action } from '../engine/game';
import type { Unsubscribe } from '../network/backend';
import type { OnlineGame, OnlineView } from '../network/online-game';
import { isAiSeat } from '../network/protocol';
import { AI_NAMES, type Connection, type SeatInfo, type Session, type SessionSnapshot, type SubmitResult } from './session';

export class OnlineSession implements Session {
  readonly online: OnlineGame;
  private everConnected = false;

  constructor(online: OnlineGame) {
    this.online = online;
  }

  snapshot(): SessionSnapshot {
    return this.toSnapshot(this.online.current);
  }

  private toSnapshot(v: OnlineView): SessionSnapshot {
    if (v.connected) this.everConnected = true;
    const room = v.room;
    const isHost = v.role === 'host';
    const seats: SeatInfo[] = SEATS.map((seat: Seat) => {
      if (isAiSeat(seat)) return { seat, name: AI_NAMES[seat], kind: 'ai', local: false, online: null, vacant: false };
      const role = seat === 0 ? 'host' : 'guest';
      const p = room?.players[role] ?? null;
      const pres = room?.presence[role] ?? null;
      const mine = seat === v.mySeat;
      return {
        seat,
        name: p?.name ?? (role === 'guest' ? 'Waiting for partner…' : 'Host'),
        kind: 'human',
        local: mine,
        online: mine ? v.connected : p ? (pres?.on ?? false) : null,
        vacant: !p,
      };
    });
    const connection: Connection = v.connected ? 'online' : this.everConnected ? 'offline' : 'connecting';
    const game = room?.game ?? null;
    let notice: string | null = null;
    const otherRole = isHost ? 'guest' : 'host';
    const otherOnline = room?.presence[otherRole]?.on ?? false;
    if (!v.connected && this.everConnected) notice = 'You are offline. Reconnecting…';
    else if (room && !isHost && !otherOnline && room.state.phase === 'playing') {
      notice = 'The host is offline, so the game is paused until they are back.';
    } else if (room && isHost && room.players.guest && !otherOnline && game?.turn === 2 && room.state.phase === 'playing') {
      notice = 'Your partner is offline. Waiting for them to come back.';
    } else if (room && isHost && !room.players.guest && room.state.phase === 'playing') {
      notice = 'Your partner left the room. They can rejoin with the room code.';
    }
    // The guest cannot see the host computing; an AI turn means the host is on it.
    const thinking = isHost ? v.thinking : game && game.status === 'playing' && isAiSeat(game.turn) && otherOnline ? game.turn : null;
    return {
      mode: 'online',
      phase: room?.state.phase ?? 'lobby',
      game,
      level: room?.state.level ?? 'normal',
      seats,
      isHost,
      code: v.code,
      connection,
      thinking,
      pending: v.pending !== null,
      notice,
      error: v.error,
      closed: v.closed,
      gameNumber: room?.state.game ?? 0,
    };
  }

  subscribe(cb: (s: SessionSnapshot) => void): Unsubscribe {
    return this.online.subscribe((v) => cb(this.toSnapshot(v)));
  }

  submit(action: Action): Promise<SubmitResult> {
    return this.online.submit(action);
  }

  startGame(): Promise<void> {
    return this.online.startGame();
  }

  setLevel(level: Level): Promise<void> {
    return this.online.setLevel(level);
  }

  leave(): Promise<void> {
    return this.online.leave();
  }

  freeGuestSeat(): Promise<void> {
    return this.online.freeGuestSeat();
  }

  dispose(): void {
    this.online.dispose();
  }
}
