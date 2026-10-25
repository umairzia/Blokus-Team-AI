/**
 * One player's view of an online room, and (in the host's browser) the
 * host's game loop.
 *
 *  - Both browsers listen to rooms/CODE and redraw on every change.
 *  - The host applies its own moves, plays the AI seats and answers the
 *    guest's move requests (see host.ts). It is the only writer of the game.
 *  - The guest writes only a move request for its own turn and waits for
 *    the host's answer: either the new state (accepted) or req/err.
 *  - Each browser keeps its presence flag up to date; the server clears it
 *    when the connection drops.
 *
 * If the host goes offline the game pauses (there is no host migration);
 * it continues as soon as the host's browser is back.
 */

import type { AiRunner } from '../ai/runner';
import type { Level } from '../ai/decide';
import type { Seat } from '../engine/constants';
import { ERROR_TEXT, type Action } from '../engine/game';
import { mixSeed } from '../util/rng';
import { isPermissionDenied, type Backend, type Unsubscribe } from './backend';
import {
  answerRequest,
  lobbyUpdates,
  moveUpdates,
  newRoomData,
  nextHostTask,
  requestApplied,
  setLevelUpdates,
  startGameUpdates,
} from './host';
import {
  CorruptRoomError,
  ROLE_SEAT,
  cleanName,
  decodeRoom,
  normalizeRoomCode,
  paths,
  randomRoomCode,
  type MoveRequest,
  type Role,
  type Room,
} from './protocol';

export const RULES_HINT =
  'The database refused the request. Has the site owner published database.rules.json in Firebase (see docs/FIREBASE_SETUP.md)?';

// ---- Creating and joining -------------------------------------------------

/** Creates a room with a fresh code; retries if a code is already taken. */
export async function createRoom(backend: Backend, name: string, level: Level, random: () => number = Math.random): Promise<string> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomRoomCode(random);
    try {
      await backend.update({ [paths.room(code)]: newRoomData({ uid: backend.uid, name: cleanName(name) }, level, backend.TIMESTAMP) });
      return code;
    } catch (err) {
      // A taken code is refused by the rules; try another one.
      if (!isPermissionDenied(err)) throw err;
      lastError = err;
    }
  }
  throw new Error(isPermissionDenied(lastError) ? RULES_HINT : String(lastError));
}

export type JoinResult =
  | { ok: true; code: string; role: Role }
  | { ok: false; reason: 'invalid-code' | 'not-found' | 'full' | 'denied'; message: string };

const JOIN_MESSAGES = {
  'invalid-code': 'That is not a valid room code: it has 6 letters and digits.',
  'not-found': 'There is no room with that code. Check the code, or ask your partner for a new link.',
  full: 'That room already has two players. If the seat is yours from another device, ask the host to free it.',
  denied: RULES_HINT,
} as const;

/** Joins a room as the guest, or resumes a seat this browser already holds. */
export async function joinRoom(backend: Backend, codeText: string, name: string): Promise<JoinResult> {
  const code = normalizeRoomCode(codeText);
  const fail = (reason: keyof typeof JOIN_MESSAGES): JoinResult => ({ ok: false, reason, message: JOIN_MESSAGES[reason] });
  if (!code) return fail('invalid-code');
  let players: { host?: { uid?: string }; guest?: { uid?: string } } | null;
  try {
    players = (await backend.get(paths.players(code))) as typeof players;
  } catch (err) {
    if (isPermissionDenied(err)) return fail('denied');
    throw err;
  }
  if (!players || !players.host) return fail('not-found');
  if (players.host.uid === backend.uid) return { ok: true, code, role: 'host' };
  if (players.guest?.uid === backend.uid) return { ok: true, code, role: 'guest' };
  if (players.guest) return fail('full');
  try {
    await backend.update({ [paths.player(code, 'guest')]: { uid: backend.uid, name: cleanName(name) } });
    return { ok: true, code, role: 'guest' };
  } catch (err) {
    if (!isPermissionDenied(err)) throw err;
    // Someone else may have taken the seat a moment earlier.
    const again = (await backend.get(paths.players(code)).catch(() => null)) as typeof players;
    if (again?.guest && again.guest.uid !== backend.uid) return fail('full');
    return fail('denied');
  }
}

// ---- The live room --------------------------------------------------------

export interface OnlineView {
  readonly code: string;
  readonly role: Role;
  readonly mySeat: Seat;
  readonly room: Room | null;
  readonly connected: boolean;
  /** True once the first snapshot arrived. */
  readonly loaded: boolean;
  /** Set when the room was closed or this browser lost its seat. */
  readonly closed: string | null;
  /** A problem worth showing (e.g. damaged data). */
  readonly error: string | null;
  /** Guest: the move request waiting for the host. */
  readonly pending: MoveRequest | null;
  /** Host: the AI seat whose move is being computed. */
  readonly thinking: Seat | null;
}

export type SubmitResult = { ok: true } | { ok: false; error: string };

export interface OnlineOptions {
  readonly ai: AiRunner;
  /** Minimum time an AI turn takes, so people can follow the moves. */
  readonly aiDelayMs?: number;
  readonly random?: () => number;
}

export class OnlineGame {
  readonly backend: Backend;
  readonly code: string;
  readonly role: Role;
  private readonly opts: Required<OnlineOptions>;
  private view: OnlineView;
  private readonly listeners = new Set<(v: OnlineView) => void>();
  private readonly stops: Unsubscribe[] = [];
  private disposed = false;
  private aiFor = -1;
  private answeredReq: string | null = null;
  private waiter: { req: MoveRequest; resolve: (r: SubmitResult) => void } | null = null;

  constructor(backend: Backend, code: string, role: Role, opts: OnlineOptions) {
    this.backend = backend;
    this.code = code;
    this.role = role;
    this.opts = { aiDelayMs: 900, random: Math.random, ...opts };
    this.view = {
      code,
      role,
      mySeat: ROLE_SEAT[role],
      room: null,
      connected: false,
      loaded: false,
      closed: null,
      error: null,
      pending: null,
      thinking: null,
    };
  }

  start(): this {
    this.stops.push(this.backend.onConnection((connected) => this.set({ connected })));
    this.stops.push(
      this.backend.watch(
        paths.room(this.code),
        (raw) => this.onSnapshot(raw),
        (err) => {
          this.set({ closed: isPermissionDenied(err) ? 'This room was closed, or this browser no longer has a seat in it.' : String(err) });
        },
      ),
    );
    this.stops.push(this.backend.presence(paths.presence(this.code, this.role)));
    return this;
  }

  get current(): OnlineView {
    return this.view;
  }

  subscribe(cb: (v: OnlineView) => void): Unsubscribe {
    this.listeners.add(cb);
    cb(this.view);
    return () => this.listeners.delete(cb);
  }

  private set(patch: Partial<OnlineView>): void {
    if (this.disposed) return;
    this.view = { ...this.view, ...patch };
    for (const cb of this.listeners) cb(this.view);
  }

  private onSnapshot(raw: unknown): void {
    let room: Room | null;
    try {
      room = decodeRoom(this.code, raw);
    } catch (e) {
      this.set({ loaded: true, error: e instanceof CorruptRoomError ? e.message : String(e) });
      return;
    }
    if (!room) {
      this.set({ loaded: true, room: null, closed: 'This room was closed by the host.' });
      return;
    }
    const mine = room.players[this.role];
    if (!mine || mine.uid !== this.backend.uid) {
      this.set({ loaded: true, room, closed: 'This browser no longer has a seat in this room.' });
      return;
    }
    this.set({ loaded: true, room, error: null });
    if (this.role === 'guest') this.checkPending(room);
    else this.hostTick(room);
  }

  // ---- Guest ----

  private checkPending(room: Room): void {
    const w = this.waiter;
    if (!w) return;
    if (room.req && room.req.id === w.req.id && room.req.err) {
      this.finishPending({ ok: false, error: room.req.err });
      this.backend.update({ [paths.req(this.code)]: null }).catch(() => {});
      return;
    }
    if (room.state.v > w.req.v) {
      this.finishPending(requestApplied(room, w.req) ? { ok: true } : { ok: false, error: ERROR_TEXT.stale });
    }
  }

  private finishPending(r: SubmitResult): void {
    const w = this.waiter;
    this.waiter = null;
    this.set({ pending: null });
    w?.resolve(r);
  }

  // ---- Host ----

  private hostTick(room: Room): void {
    const task = nextHostTask(room);
    if (!task) {
      if (this.view.thinking !== null) this.set({ thinking: null });
      return;
    }
    if (task.kind === 'guest' && this.answeredReq !== task.req.id) {
      this.answeredReq = task.req.id;
      const answer = answerRequest(room, task.req);
      this.write(answer.updates);
      return;
    }
    if (task.kind === 'ai' && this.aiFor !== task.v) {
      this.aiFor = task.v;
      void this.playAi(room, task.seat, task.v);
    }
  }

  private async playAi(room: Room, seat: Seat, v: number): Promise<void> {
    const game = room.game!;
    this.set({ thinking: seat });
    const started = Date.now();
    try {
      const seed = mixSeed(room.state.seed, game.n, seat);
      const decision = await this.opts.ai.decide(game, seat, room.state.level, seed);
      const wait = this.opts.aiDelayMs - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const now = this.view.room;
      if (this.disposed || !now || now.state.v !== v) return; // the room moved on
      const out = moveUpdates(now, decision.action);
      if (!out.ok) throw new Error(out.error);
      await this.write(out.updates);
    } catch (err) {
      this.set({ error: `The AI could not move: ${(err as Error).message}` });
      this.aiFor = -1;
    } finally {
      if (this.view.thinking === seat) this.set({ thinking: null });
    }
  }

  /** Writes; a refusal because another write got there first is expected and ignored. */
  private async write(updates: Record<string, unknown>): Promise<boolean> {
    try {
      await this.backend.update(updates);
      return true;
    } catch (err) {
      if (!isPermissionDenied(err)) this.set({ error: `Could not save: ${(err as Error).message}` });
      return false;
    }
  }

  // ---- Actions ----

  /** Plays a move for this browser's seat. */
  async submit(action: Action): Promise<SubmitResult> {
    const room = this.view.room;
    if (!room || !room.game) return { ok: false, error: 'The game has not started.' };
    if (action.seat !== this.view.mySeat) return { ok: false, error: ERROR_TEXT['not-your-turn'] };
    if (this.role === 'host') {
      const out = moveUpdates(room, action);
      if (!out.ok) return { ok: false, error: out.error };
      return (await this.write(out.updates)) ? { ok: true } : { ok: false, error: ERROR_TEXT.stale };
    }
    if (this.waiter) return { ok: false, error: 'Your previous move is still on its way to the host.' };
    const req: MoveRequest = {
      id: Math.floor(this.opts.random() * 2 ** 48).toString(36),
      v: room.state.v,
      t: action.type,
      ...(action.type === 'place' ? { p: action.piece, o: action.o, x: action.x, y: action.y } : {}),
    };
    const result = new Promise<SubmitResult>((resolve) => {
      this.waiter = { req, resolve };
    });
    this.set({ pending: req });
    try {
      await this.backend.update({ [paths.req(this.code)]: req });
    } catch (err) {
      this.finishPending({ ok: false, error: isPermissionDenied(err) ? ERROR_TEXT.stale : String(err) });
    }
    return result;
  }

  private requireHost(): Room {
    if (this.role !== 'host') throw new Error('Only the host can do that.');
    const room = this.view.room;
    if (!room) throw new Error('The room is not loaded yet.');
    return room;
  }

  async startGame(): Promise<void> {
    const room = this.requireHost();
    const seed = Math.floor(this.opts.random() * 2 ** 32);
    await this.backend.update(startGameUpdates(room, seed));
  }

  async setLevel(level: Level): Promise<void> {
    const room = this.requireHost();
    if (room.state.level === level) return;
    await this.backend.update(setLevelUpdates(room, level));
  }

  async backToLobby(): Promise<void> {
    await this.backend.update(lobbyUpdates(this.requireHost()));
  }

  /** Host: frees the guest seat (e.g. the partner changed device). */
  async freeGuestSeat(): Promise<void> {
    this.requireHost();
    await this.backend.update({
      [paths.player(this.code, 'guest')]: null,
      [paths.presence(this.code, 'guest')]: null,
      [paths.req(this.code)]: null,
    });
  }

  /** Guest: gives up the seat. Host: closes (deletes) the room. */
  async leave(): Promise<void> {
    const updates =
      this.role === 'host'
        ? { [paths.room(this.code)]: null }
        : { [paths.player(this.code, 'guest')]: null, [paths.presence(this.code, 'guest')]: null, [paths.req(this.code)]: null };
    this.dispose();
    await this.backend.update(updates);
  }

  dispose(): void {
    if (this.disposed) return;
    for (const stop of this.stops.splice(0)) stop();
    this.waiter?.resolve({ ok: false, error: 'Left the room.' });
    this.waiter = null;
    this.disposed = true;
    this.listeners.clear();
  }
}
