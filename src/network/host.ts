/**
 * The host's authority, as pure functions: given the current room, what
 * should be written. Only the host's browser runs these. It validates every
 * move (its own, the guest's requests and the AI's) with the rules engine
 * and is the only writer of the game state; every write carries version
 * v + 1, which the database rules enforce, so a stale or duplicated write
 * (for example from a second open tab of the host) is refused as a whole.
 */

import type { Level } from '../ai/decide';
import { type Seat } from '../engine/constants';
import { ERROR_TEXT, newGame, tryApplyAction, type Action, type GameState } from '../engine/game';
import { pieceById } from '../engine/pieces';
import {
  ROLE_SEAT,
  SCHEMA_VERSION,
  encodeGame,
  isAiSeat,
  lobbyState,
  paths,
  type MoveRequest,
  type PlayerInfo,
  type Room,
  type RoomState,
} from './protocol';

export type Updates = Record<string, unknown>;

export function newRoomData(host: PlayerInfo, level: Level, timestamp: unknown): Record<string, unknown> {
  return {
    meta: { created: timestamp, schema: SCHEMA_VERSION },
    players: { host },
    state: lobbyState(1, level, 0),
  };
}

function writeState(room: Room, next: Omit<RoomState, 'v'>): Updates {
  return {
    [paths.state(room.code)]: { ...next, v: room.state.v + 1 },
    [paths.req(room.code)]: null,
  };
}

function withGame(room: Room, game: GameState): Updates {
  return writeState(room, {
    phase: game.status === 'over' ? 'over' : 'playing',
    level: room.state.level,
    game: room.state.game,
    seed: room.state.seed,
    g: encodeGame(game),
  });
}

/** Starts a (new) game. Needs both humans in the room. */
export function startGameUpdates(room: Room, seed: number): Updates {
  if (!room.players.guest) throw new Error('Wait for your partner to join before starting.');
  return writeState(room, {
    phase: 'playing',
    level: room.state.level,
    game: room.state.game + 1,
    seed: seed >>> 0,
    g: encodeGame(newGame()),
  });
}

export function setLevelUpdates(room: Room, level: Level): Updates {
  const s = room.state;
  return writeState(room, { phase: s.phase, level, game: s.game, seed: s.seed, ...(s.g ? { g: s.g } : {}) });
}

/** Back to the lobby (used when the host wants to change the AI level mid-room). */
export function lobbyUpdates(room: Room): Updates {
  return writeState(room, { phase: 'lobby', level: room.state.level, game: room.state.game, seed: 0 });
}

export type MoveOutcome = { ok: true; updates: Updates; game: GameState } | { ok: false; error: string; code: string };

/** Checks an action with the rules engine and returns the state write. */
export function moveUpdates(room: Room, action: Action): MoveOutcome {
  if (room.state.phase !== 'playing' || !room.game) return { ok: false, error: ERROR_TEXT['game-over'], code: 'game-over' };
  const res = tryApplyAction(room.game, action);
  if (!res.ok) return { ok: false, error: ERROR_TEXT[res.error], code: res.error };
  return { ok: true, updates: withGame(room, res.state), game: res.state };
}

/** The guest's request as an engine action for the guest's own seat. */
export function requestToAction(req: MoveRequest, game: GameState): Action | null {
  const seat = ROLE_SEAT.guest;
  if (req.t === 'pass') return { type: 'pass', seat, n: game.n };
  if (req.p === undefined || req.o === undefined || req.x === undefined || req.y === undefined) return null;
  return { type: 'place', seat, piece: req.p, o: req.o, x: req.x, y: req.y, n: game.n };
}

export type HostTask = { kind: 'ai'; seat: Seat; v: number } | { kind: 'guest'; req: MoveRequest } | null;

/** What the host should do next for this room snapshot, if anything. */
export function nextHostTask(room: Room): HostTask {
  const game = room.game;
  if (room.state.phase !== 'playing' || !game || game.status !== 'playing') return null;
  if (isAiSeat(game.turn)) return { kind: 'ai', seat: game.turn, v: room.state.v };
  if (room.req && !room.req.err) return { kind: 'guest', req: room.req };
  return null;
}

/**
 * Answers the guest's request: applies it (state v + 1, request cleared, in
 * one atomic write) or turns it down with a reason in req/err. A request
 * for an older version, for a move out of turn or for an illegal move never
 * changes the board.
 */
export function answerRequest(room: Room, req: MoveRequest): { accepted: boolean; updates: Updates; error?: string } {
  const reject = (error: string) => ({ accepted: false, updates: { [paths.reqErr(room.code)]: error.slice(0, 120) }, error });
  const game = room.game;
  if (!game || room.state.phase !== 'playing') return reject(ERROR_TEXT['game-over']);
  if (req.v !== room.state.v) return reject(ERROR_TEXT.stale);
  if (game.turn !== ROLE_SEAT.guest) return reject(ERROR_TEXT['not-your-turn']);
  const action = requestToAction(req, game);
  if (!action) return reject(ERROR_TEXT['bad-action']);
  const out = moveUpdates(room, action);
  if (!out.ok) return reject(out.error);
  return { accepted: true, updates: out.updates };
}

/** Whether the guest's request with this piece made it onto the board. */
export function requestApplied(room: Room, req: MoveRequest): boolean {
  if (!room.game) return false;
  if (req.t === 'pass') return room.game.out[ROLE_SEAT.guest];
  if (!req.p) return false;
  return (room.game.remaining[ROLE_SEAT.guest] & (1 << pieceById(req.p).index)) === 0;
}
