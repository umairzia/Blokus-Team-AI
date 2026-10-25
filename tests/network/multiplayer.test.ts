import { afterEach, describe, expect, it } from 'vitest';
import { chooseAction } from '../../src/ai/decide';
import { createInlineRunner } from '../../src/ai/runner';
import { legalActions, type Action, type Seat } from '../../src/engine';
import { isPermissionDenied } from '../../src/network/backend';
import { answerRequest } from '../../src/network/host';
import { MemoryDatabase, type MemoryBackend } from '../../src/network/memory-db';
import { OnlineGame, createRoom, joinRoom } from '../../src/network/online-game';
import { decodeRoom, paths, type Room } from '../../src/network/protocol';
import { createRng } from '../../src/util/rng';

const games: OnlineGame[] = [];
const backends: MemoryBackend[] = [];

afterEach(() => {
  for (const g of games.splice(0)) g.dispose();
  for (const b of backends.splice(0)) b.dispose();
});

async function waitFor<T>(fn: () => T | null | undefined | false, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function connect(db: MemoryDatabase, uid: string): MemoryBackend {
  const b = db.connect(uid);
  backends.push(b);
  return b;
}

function open(backend: MemoryBackend, code: string, role: 'host' | 'guest'): OnlineGame {
  const g = new OnlineGame(backend, code, role, { ai: createInlineRunner(), aiDelayMs: 0, random: createRng(backend.uid.length) }).start();
  games.push(g);
  return g;
}

/** A room with the host and the guest seated and both views loaded. */
async function seatedRoom(level: 'easy' | 'normal' | 'hard' = 'easy') {
  const db = new MemoryDatabase();
  const hostB = connect(db, 'host-uid');
  const guestB = connect(db, 'guest-uid');
  const code = await createRoom(hostB, 'Ayesha', level, createRng(42));
  expect(await joinRoom(guestB, code, 'Bilal')).toEqual({ ok: true, code, role: 'guest' });
  const host = open(hostB, code, 'host');
  const guest = open(guestB, code, 'guest');
  await waitFor(() => host.current.room?.players.guest && guest.current.room, 'both views loaded');
  return { db, code, hostB, guestB, host, guest };
}

function room(g: OnlineGame): Room {
  return g.current.room!;
}

/** A legal move for the seat (deterministic). */
function someMove(g: OnlineGame, seat: Seat): Action {
  const game = room(g).game!;
  return chooseAction(game, seat, { level: 'easy', seed: game.n }).action;
}

async function startedRoom() {
  const r = await seatedRoom();
  await r.host.startGame();
  await waitFor(() => room(r.guest).state.phase === 'playing', 'guest sees the game start');
  return r;
}

describe('rooms', () => {
  it('creates rooms with unique, valid codes, retrying a taken code', async () => {
    const db = new MemoryDatabase();
    const a = connect(db, 'a');
    const b = connect(db, 'b');
    const codeA = await createRoom(a, 'A', 'normal', createRng(7));
    // Same random sequence: the first code is taken, so a second one is used.
    const codeB = await createRoom(b, 'B', 'normal', createRng(7));
    expect(codeA).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(codeB).not.toBe(codeA);
    expect((db.adminGet(paths.players(codeA)) as { host: { uid: string } }).host.uid).toBe('a');
    expect((db.adminGet(paths.players(codeB)) as { host: { uid: string } }).host.uid).toBe('b');
  });

  it('lets two different clients join the same room', async () => {
    const { host, guest, code } = await seatedRoom();
    expect(room(host).players.guest?.name).toBe('Bilal');
    expect(room(guest).players.host?.name).toBe('Ayesha');
    expect(room(guest).code).toBe(code);
    await waitFor(() => room(host).presence.guest?.on && room(guest).presence.host?.on, 'presence of both');
  });

  it('keeps a third person out of the occupied seat and out of the room', async () => {
    const { db, code } = await seatedRoom();
    const stranger = connect(db, 'stranger-uid');
    const res = await joinRoom(stranger, code, 'Eve');
    expect(res).toMatchObject({ ok: false, reason: 'full' });
    await expect(stranger.update({ [paths.player(code, 'guest')]: { uid: 'stranger-uid', name: 'Eve' } })).rejects.toSatisfy(isPermissionDenied);
    await expect(stranger.get(paths.room(code))).rejects.toSatisfy(isPermissionDenied);
    await expect(stranger.get(paths.state(code))).rejects.toSatisfy(isPermissionDenied);
    expect(await joinRoom(stranger, 'NOROOM', 'Eve')).toMatchObject({ ok: false });
    expect(await joinRoom(stranger, 'ABCDEF', 'Eve')).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('returns a browser to its own seat when it joins again', async () => {
    const { db, code } = await seatedRoom();
    expect(await joinRoom(connect(db, 'guest-uid'), code, 'Bilal')).toEqual({ ok: true, code, role: 'guest' });
    expect(await joinRoom(connect(db, 'host-uid'), code, 'Ayesha')).toEqual({ ok: true, code, role: 'host' });
  });
});

describe('host-authoritative play', () => {
  it('starts a game for both players with the human turn order', async () => {
    const { host, guest } = await startedRoom();
    expect(room(host).game!.turn).toBe(0);
    expect(room(guest).game!.turn).toBe(0);
    expect(host.current.mySeat).toBe(0);
    expect(guest.current.mySeat).toBe(2);
  });

  it('applies the host move, plays the AI, and delivers the guest request to the host', async () => {
    const { host, guest } = await startedRoom();
    expect(await host.submit(someMove(host, 0))).toEqual({ ok: true });
    // AI seat 1 moves by itself, then it is the guest's turn on both screens.
    await waitFor(() => room(guest).game!.turn === 2 && room(host).game!.turn === 2, 'guest turn');
    expect(room(host).game!.history.filter((h) => h.seat === 1)).toHaveLength(1);
    const before = room(guest).state.v;
    expect(await guest.submit(someMove(guest, 2))).toEqual({ ok: true });
    await waitFor(() => room(guest).game!.turn === 0, 'back to the host after AI 2');
    expect(room(guest).state.v).toBe(before + 2);
    expect(room(guest).game!.board).toBe(room(host).game!.board);
    expect(room(guest).req).toBeNull();
  });

  it('turns down an illegal guest request without changing the board', async () => {
    const { host, guest } = await startedRoom();
    await host.submit(someMove(host, 0));
    await waitFor(() => room(guest).game!.turn === 2, 'guest turn');
    const board = room(guest).game!.board;
    // Not touching the guest's start corner.
    const bad: Action = { type: 'place', seat: 2, piece: 'I1', o: 0, x: 10, y: 10, n: room(guest).game!.n };
    const res = await guest.submit(bad);
    expect(res).toEqual({ ok: false, error: 'Your first piece must cover your starting corner.' });
    await waitFor(() => room(guest).req === null, 'request cleared');
    expect(room(host).game!.board).toBe(board);
    // A legal move still works afterwards.
    expect(await guest.submit(someMove(guest, 2))).toEqual({ ok: true });
  });

  it('refuses guest moves out of turn, stale requests and attempts to act for another seat', async () => {
    const { host, guest, guestB, code } = await startedRoom();
    // Host's turn: the rules refuse the guest's request outright.
    const res = await guest.submit({ type: 'place', seat: 2, piece: 'I5', o: 0, x: 15, y: 19, n: 0 });
    expect(res.ok).toBe(false);
    expect(await guest.submit({ ...someMove(host, 0) })).toMatchObject({ ok: false });
    await host.submit(someMove(host, 0));
    await waitFor(() => room(guest).game!.turn === 2, 'guest turn');
    const stale = { id: 'old1', v: room(guest).state.v - 1, t: 'place', p: 'I5', o: 0, x: 15, y: 19 };
    await expect(guestB.update({ [paths.req(code)]: stale })).rejects.toSatisfy(isPermissionDenied);
    await expect(guestB.update({ [paths.req(code)]: { ...stale, v: room(guest).state.v, err: 'x' } })).rejects.toSatisfy(isPermissionDenied);
  });

  it('applies a duplicated request only once', async () => {
    const { host, guest, hostB } = await startedRoom();
    await host.submit(someMove(host, 0));
    await waitFor(() => room(guest).game!.turn === 2, 'guest turn');
    const r = room(host);
    const move = someMove(guest, 2);
    const req = { id: 'dup', v: r.state.v, t: 'place' as const, p: move.type === 'place' ? move.piece : undefined, o: 0, x: 0, y: 0 };
    if (move.type === 'place') Object.assign(req, { o: move.o, x: move.x, y: move.y });
    // The host answers the same request twice from the same snapshot (two tabs, or a repeated event).
    const first = answerRequest(r, req);
    const second = answerRequest(r, req);
    expect(first.accepted && second.accepted).toBe(true);
    await hostB.update(first.updates);
    await expect(hostB.update(second.updates)).rejects.toSatisfy(isPermissionDenied);
    await waitFor(() => room(guest).state.v === r.state.v + 1 || room(guest).state.v > r.state.v + 1, 'one update');
    const placed = room(host).game!.history.filter((h) => h.seat === 2 && h.type === 'place');
    expect(placed).toHaveLength(1);
  });

  it('plays each AI turn exactly once even with two host tabs open', async () => {
    const r = await startedRoom();
    const secondTab = open(connect(r.db, 'host-uid'), r.code, 'host');
    await waitFor(() => secondTab.current.room?.state.phase === 'playing', 'second tab loaded');
    for (let round = 0; round < 3; round++) {
      await waitFor(() => room(r.host).game!.turn === 0, 'host turn');
      await r.host.submit(someMove(r.host, 0));
      await waitFor(() => room(r.guest).game!.turn === 2, 'guest turn');
      await r.guest.submit(someMove(r.guest, 2));
    }
    await waitFor(() => room(r.host).game!.turn === 0, 'host turn again');
    const g = room(r.host).game!;
    const counts = [0, 1, 2, 3].map((s) => g.history.filter((h) => h.seat === s).length);
    expect(counts).toEqual([3, 3, 3, 3]);
    // Versions went up one step per move: start (1) + 12 moves.
    expect(room(r.host).state.v).toBe(2 + 12);
  });

  it('plays a complete game to a valid end on both screens', async () => {
    const { host, guest } = await startedRoom();
    for (let i = 0; i < 200; i++) {
      const r = room(host);
      if (r.state.phase !== 'playing') break;
      const turn = r.game!.turn;
      if (turn === 0) await host.submit(someMove(host, 0));
      else if (turn === 2 && room(guest).game!.turn === 2 && !guest.current.pending) await guest.submit(someMove(guest, 2));
      else await new Promise((res) => setTimeout(res, 5));
    }
    await waitFor(() => room(guest).state.phase === 'over', 'game over for the guest');
    const end = room(host).game!;
    expect(end.status).toBe('over');
    for (const s of [0, 1, 2, 3] as Seat[]) expect(legalActions({ ...end, status: 'playing', turn: s }, s)).toHaveLength(0);
    expect(room(guest).game).toEqual(end);
  });
});

describe('connections', () => {
  it('survives a guest refresh: the same uid gets the same seat and board', async () => {
    const { db, host, guest, guestB, code } = await startedRoom();
    await host.submit(someMove(host, 0));
    await waitFor(() => room(guest).game!.turn === 2, 'guest turn');
    const board = room(guest).game!.board;
    guest.dispose();
    guestB.dispose(); // the tab closes: the server marks the guest offline
    await waitFor(() => room(host).presence.guest?.on === false, 'host sees the guest offline');
    const again = connect(db, 'guest-uid');
    expect(await joinRoom(again, code, 'Bilal')).toMatchObject({ ok: true, role: 'guest' });
    const reopened = open(again, code, 'guest');
    await waitFor(() => reopened.current.room?.game, 'reloaded');
    expect(room(reopened).game!.board).toBe(board);
    await waitFor(() => room(host).presence.guest?.on === true, 'back online');
    expect(await reopened.submit(someMove(reopened, 2))).toEqual({ ok: true });
  });

  it('pauses while the host is offline and continues when it is back', async () => {
    const { host, guest, hostB } = await startedRoom();
    await host.submit(someMove(host, 0));
    await waitFor(() => room(guest).game!.turn === 2, 'guest turn');
    hostB.setOnline(false);
    await waitFor(() => room(guest).presence.host?.on === false, 'guest sees host offline');
    const v = room(guest).state.v;
    const pending = guest.submit(someMove(guest, 2));
    await new Promise((r) => setTimeout(r, 50));
    expect(room(guest).state.v).toBe(v); // nobody can apply it yet
    expect(guest.current.pending).not.toBeNull();
    hostB.setOnline(true);
    expect(await pending).toEqual({ ok: true });
    await waitFor(() => room(guest).game!.turn === 0, 'AI 2 moved after the host came back');
  });

  it('queues a move made while offline and sends it on reconnect', async () => {
    const { host, guest, guestB } = await startedRoom();
    await host.submit(someMove(host, 0));
    await waitFor(() => room(guest).game!.turn === 2, 'guest turn');
    guestB.setOnline(false);
    const pending = guest.submit(someMove(guest, 2));
    await waitFor(() => room(host).presence.guest?.on === false, 'guest offline');
    guestB.setOnline(true);
    expect(await pending).toEqual({ ok: true });
    await waitFor(() => room(host).game!.history.some((h) => h.seat === 2), 'guest move applied');
  });

  it('closes the room for everyone when the host leaves, and cleans it up', async () => {
    const { db, host, guest, code } = await startedRoom();
    await host.leave();
    await waitFor(() => guest.current.closed, 'guest told the room closed');
    expect(db.adminGet(paths.room(code))).toBeNull();
  });

  it('frees the seat when the guest leaves, so the partner can rejoin from a new device', async () => {
    const { db, host, guest, code } = await startedRoom();
    await guest.leave();
    await waitFor(() => !room(host).players.guest, 'seat free');
    expect(await joinRoom(connect(db, 'new-phone'), code, 'Bilal')).toMatchObject({ ok: true, role: 'guest' });
    // And the host can free a seat held by a lost device.
    await waitFor(() => room(host).players.guest?.uid === 'new-phone', 'new guest seated');
    await host.freeGuestSeat();
    await waitFor(() => !room(host).players.guest, 'seat freed by host');
  });
});

describe('access rules (in-memory mirror)', () => {
  it('refuses writes to the game state, seats and room by anyone but the host', async () => {
    const { db, guestB, hostB, code, guest } = await startedRoom();
    const stranger = connect(db, 'stranger-uid');
    const state = (db.adminGet(paths.state(code)) as { v: number });
    const forged = { ...(db.adminGet(paths.state(code)) as object), v: state.v + 1 };
    await expect(guestB.update({ [paths.state(code)]: forged })).rejects.toSatisfy(isPermissionDenied);
    await expect(guestB.update({ [paths.player(code, 'host')]: { uid: 'guest-uid', name: 'x' } })).rejects.toSatisfy(isPermissionDenied);
    await expect(guestB.update({ [paths.room(code)]: null })).rejects.toSatisfy(isPermissionDenied);
    await expect(stranger.update({ [paths.req(code)]: { id: 'x', v: state.v, t: 'pass' } })).rejects.toSatisfy(isPermissionDenied);
    await expect(stranger.update({ [paths.presence(code, 'guest')]: { on: true, at: 1 } })).rejects.toSatisfy(isPermissionDenied);
    await expect(stranger.get('rooms')).rejects.toSatisfy(isPermissionDenied);
    // The host's own write must be exactly one version ahead.
    await expect(hostB.update({ [paths.state(code)]: { ...forged, v: state.v + 5 } })).rejects.toSatisfy(isPermissionDenied);
    expect(decodeRoom(code, db.adminGet(paths.room(code)))!.state.v).toBe(room(guest).state.v);
  });
});
