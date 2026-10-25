/**
 * What a room looks like in the database, and conversions between the
 * engine's GameState and its stored ("wire") form.
 *
 *   rooms/CODE/meta      { created, schema }                 host writes once
 *   rooms/CODE/players   { host: {uid, name}, guest?: {...} } readable by any signed-in user
 *   rooms/CODE/presence  { host?: {on, at}, guest?: {on, at} } each member writes its own
 *   rooms/CODE/state     RoomState (version v, phase, level, game)  host only, v + 1 each write
 *   rooms/CODE/req       MoveRequest                          guest only, own turn, current v
 *
 * database.rules.json enforces this layout and who may write what.
 */

import { isLevel, type Level } from '../ai/decide';
import { SEATS, isSeat, type Seat } from '../engine/constants';
import { replayHistory, type GameState, type HistoryEntry } from '../engine/game';
import { isPieceId, type PieceId } from '../engine/pieces';

export const SCHEMA_VERSION = 1;

/** No I, O, 0 or 1, so codes can be read out loud and typed without mix-ups. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

export function randomRoomCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)];
  return code;
}

/** Cleans what a person typed or pasted (a code or a whole invite link). */
export function normalizeRoomCode(text: string): string | null {
  const fromLink = /#([A-Za-z0-9]{6})\b/.exec(text);
  const raw = (fromLink ? fromLink[1] : text).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return ROOM_CODE_PATTERN.test(raw) ? raw : null;
}

export type Role = 'host' | 'guest';
export const ROLE_SEAT: Readonly<Record<Role, Seat>> = { host: 0, guest: 2 };
export const AI_SEATS: readonly Seat[] = [1, 3];

export function isAiSeat(seat: Seat): boolean {
  return seat === 1 || seat === 3;
}

export function roleOfSeat(seat: Seat): Role | null {
  return seat === 0 ? 'host' : seat === 2 ? 'guest' : null;
}

export const NAME_MAX = 24;

export function cleanName(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return n || 'Player';
}

export interface PlayerInfo {
  readonly uid: string;
  readonly name: string;
}

export interface PresenceInfo {
  readonly on: boolean;
  readonly at: number;
}

export type Phase = 'lobby' | 'playing' | 'over';

/** The game as stored: compact, with only strings and numbers. */
export interface WireGame {
  readonly n: number;
  readonly status: 'playing' | 'over';
  readonly turn: number;
  readonly board: string;
  readonly rem: readonly number[];
  /** Four characters, '1' = out. */
  readonly out: string;
  /** Last piece per seat, comma separated, '-' for none. */
  readonly last: string;
  /** History entries: "seat:piece:o:x:y", "seat:p" (pass) or "seat:a" (automatic pass). */
  readonly h?: readonly string[];
}

export interface RoomState {
  /** Version: every write of the state must be exactly one higher. */
  readonly v: number;
  readonly phase: Phase;
  readonly level: Level;
  /** Games started in this room. */
  readonly game: number;
  /** Seed for this game's AI decisions. */
  readonly seed: number;
  readonly g?: WireGame;
}

export interface MoveRequest {
  readonly id: string;
  /** The state version the guest saw. */
  readonly v: number;
  readonly t: 'place' | 'pass';
  readonly p?: PieceId;
  readonly o?: number;
  readonly x?: number;
  readonly y?: number;
  /** Set by the host when it turns the request down. */
  readonly err?: string;
}

export interface Room {
  readonly code: string;
  readonly created: number;
  readonly players: { readonly host: PlayerInfo | null; readonly guest: PlayerInfo | null };
  readonly presence: { readonly host: PresenceInfo | null; readonly guest: PresenceInfo | null };
  readonly state: RoomState;
  /** Decoded game, or null in the lobby. */
  readonly game: GameState | null;
  readonly req: MoveRequest | null;
}

export const paths = {
  room: (code: string) => `rooms/${code}`,
  players: (code: string) => `rooms/${code}/players`,
  player: (code: string, role: Role) => `rooms/${code}/players/${role}`,
  presence: (code: string, role: Role) => `rooms/${code}/presence/${role}`,
  state: (code: string) => `rooms/${code}/state`,
  req: (code: string) => `rooms/${code}/req`,
  reqErr: (code: string) => `rooms/${code}/req/err`,
};

// ---- Game <-> wire -------------------------------------------------------

function encodeEntry(h: HistoryEntry): string {
  if (h.type === 'place') return `${h.seat}:${h.piece}:${h.o}:${h.x}:${h.y}`;
  return `${h.seat}:${h.auto ? 'a' : 'p'}`;
}

function decodeEntry(text: unknown): HistoryEntry {
  if (typeof text !== 'string') throw new Error('bad history entry');
  const parts = text.split(':');
  const seat = Number(parts[0]);
  if (!isSeat(seat)) throw new Error('bad history seat');
  if (parts.length === 2 && (parts[1] === 'a' || parts[1] === 'p')) return { type: 'pass', seat, auto: parts[1] === 'a' };
  if (parts.length !== 5 || !isPieceId(parts[1])) throw new Error('bad history entry');
  const [o, x, y] = parts.slice(2).map(Number);
  if (![o, x, y].every((v) => Number.isInteger(v))) throw new Error('bad history numbers');
  return { type: 'place', seat, piece: parts[1], o, x, y };
}

export function encodeGame(state: GameState): WireGame {
  return {
    n: state.n,
    status: state.status,
    turn: state.turn,
    board: state.board,
    rem: state.remaining.slice(),
    out: state.out.map((o) => (o ? '1' : '0')).join(''),
    last: state.last.map((p) => p ?? '-').join(','),
    h: state.history.map(encodeEntry),
  };
}

/** Firebase may hand back an array as an object with numeric keys. */
function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    return Object.keys(obj)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => obj[k]);
  }
  return [];
}

/**
 * Decodes and checks a stored game: the history is replayed through the
 * rules engine and every stored field must match the replay, so a damaged
 * or tampered state is detected instead of silently shown.
 */
export function decodeGame(raw: unknown): GameState {
  if (!raw || typeof raw !== 'object') throw new Error('missing game');
  const w = raw as Record<string, unknown>;
  const history = asArray(w.h).map(decodeEntry);
  const state = replayHistory(history);
  const rem = asArray(w.rem);
  const last = typeof w.last === 'string' ? w.last.split(',') : [];
  const consistent =
    w.n === state.n &&
    w.status === state.status &&
    w.turn === state.turn &&
    w.board === state.board &&
    rem.length === 4 &&
    SEATS.every((s) => rem[s] === state.remaining[s]) &&
    w.out === state.out.map((o) => (o ? '1' : '0')).join('') &&
    last.length === 4 &&
    SEATS.every((s) => (last[s] === '-' ? null : last[s]) === state.last[s]);
  if (!consistent) throw new Error('stored game does not match its history');
  return state;
}

// ---- Room snapshots -------------------------------------------------------

function player(v: unknown): PlayerInfo | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  return typeof p.uid === 'string' && typeof p.name === 'string' ? { uid: p.uid, name: p.name } : null;
}

function presence(v: unknown): PresenceInfo | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  return typeof p.on === 'boolean' ? { on: p.on, at: typeof p.at === 'number' ? p.at : 0 } : null;
}

function request(v: unknown): MoveRequest | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.v !== 'number' || (r.t !== 'place' && r.t !== 'pass')) return null;
  return {
    id: r.id,
    v: r.v,
    t: r.t,
    p: isPieceId(r.p) ? r.p : undefined,
    o: typeof r.o === 'number' ? r.o : undefined,
    x: typeof r.x === 'number' ? r.x : undefined,
    y: typeof r.y === 'number' ? r.y : undefined,
    err: typeof r.err === 'string' ? r.err : undefined,
  };
}

export class CorruptRoomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptRoomError';
  }
}

/** Reads a room snapshot; null when it does not exist. Throws CorruptRoomError if it is unreadable. */
export function decodeRoom(code: string, raw: unknown): Room | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const players = (r.players ?? {}) as Record<string, unknown>;
  const pres = (r.presence ?? {}) as Record<string, unknown>;
  const st = r.state as Record<string, unknown> | undefined;
  if (!st || typeof st.v !== 'number' || !isLevel(st.level) || !['lobby', 'playing', 'over'].includes(st.phase as string)) {
    throw new CorruptRoomError('The room data is incomplete.');
  }
  let game: GameState | null = null;
  if (st.phase !== 'lobby') {
    try {
      game = decodeGame(st.g);
    } catch (e) {
      throw new CorruptRoomError(`The game data is damaged (${(e as Error).message}).`);
    }
  }
  const meta = (r.meta ?? {}) as Record<string, unknown>;
  return {
    code,
    created: typeof meta.created === 'number' ? meta.created : 0,
    players: { host: player(players.host), guest: player(players.guest) },
    presence: { host: presence(pres.host), guest: presence(pres.guest) },
    state: {
      v: st.v,
      phase: st.phase as Phase,
      level: st.level,
      game: typeof st.game === 'number' ? st.game : 0,
      seed: typeof st.seed === 'number' ? st.seed : 0,
      g: st.g as WireGame | undefined,
    },
    game,
    req: request(r.req),
  };
}

export function lobbyState(v: number, level: Level, game: number): RoomState {
  return { v, phase: 'lobby', level, game, seed: 0 };
}

