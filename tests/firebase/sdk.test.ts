/**
 * The real Firebase SDK (FirebaseBackend) with anonymous sign-in, against
 * the Auth and Realtime Database emulators running database.rules.json.
 * Two clients play through the same room code like two browsers would.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chooseAction } from '../../src/ai/decide';
import { createInlineRunner } from '../../src/ai/runner';
import type { Action, Seat } from '../../src/engine';
import { isPermissionDenied } from '../../src/network/backend';
import { FirebaseBackend } from '../../src/network/firebase-backend';
import { OnlineGame, createRoom, joinRoom } from '../../src/network/online-game';
import { paths, type Room } from '../../src/network/protocol';
import { EMULATOR, WEB_CONFIG, adminGet, clearDatabase, uploadRules } from './emulator';

const open: FirebaseBackend[] = [];
let appCount = 0;

async function client(): Promise<FirebaseBackend> {
  const b = await FirebaseBackend.connect(WEB_CONFIG, EMULATOR, `client-${++appCount}`);
  open.push(b);
  return b;
}

async function waitFor<T>(fn: () => T | null | undefined | false, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const room = (g: OnlineGame): Room => g.current.room!;
const move = (g: OnlineGame, seat: Seat): Action => chooseAction(room(g).game!, seat, { level: 'easy', seed: 1 }).action;

beforeAll(async () => {
  await uploadRules();
  await clearDatabase();
});

afterAll(() => {
  for (const b of open) b.dispose();
});

describe('Firebase SDK against the emulators', () => {
  let hostB: FirebaseBackend;
  let guestB: FirebaseBackend;
  let host: OnlineGame;
  let guest: OnlineGame;
  let code: string;

  it('signs two browsers in anonymously with different ids', async () => {
    hostB = await client();
    guestB = await client();
    expect(hostB.uid).toBeTruthy();
    expect(guestB.uid).not.toBe(hostB.uid);
  });

  it('creates a room and lets the second player join with the code', async () => {
    code = await createRoom(hostB, 'Ayesha', 'easy');
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(await joinRoom(guestB, code, 'Bilal')).toEqual({ ok: true, code, role: 'guest' });
    host = new OnlineGame(hostB, code, 'host', { ai: createInlineRunner(), aiDelayMs: 0 }).start();
    guest = new OnlineGame(guestB, code, 'guest', { ai: createInlineRunner(), aiDelayMs: 0 }).start();
    await waitFor(() => host.current.room?.players.guest && guest.current.room, 'both loaded');
    await waitFor(() => room(host).presence.guest?.on && room(guest).presence.host?.on, 'presence');
    await waitFor(() => host.current.connected && guest.current.connected, 'connected');
  });

  it('keeps a third person out', async () => {
    const stranger = await client();
    expect(await joinRoom(stranger, code, 'Eve')).toMatchObject({ ok: false, reason: 'full' });
    await expect(stranger.get(paths.state(code))).rejects.toSatisfy(isPermissionDenied);
    await expect(stranger.update({ [paths.player(code, 'guest')]: { uid: stranger.uid, name: 'Eve' } })).rejects.toSatisfy(
      isPermissionDenied,
    );
  });

  it('plays host, AI and guest moves through the database', async () => {
    await host.startGame();
    await waitFor(() => room(guest).state.phase === 'playing', 'game started');
    expect(await host.submit(move(host, 0))).toEqual({ ok: true });
    await waitFor(() => room(guest).game!.turn === 2, 'AI 1 moved; guest to play');
    const bad: Action = { type: 'place', seat: 2, piece: 'I1', o: 0, x: 9, y: 9, n: room(guest).game!.n };
    expect(await guest.submit(bad)).toMatchObject({ ok: false });
    expect(await guest.submit(move(guest, 2))).toEqual({ ok: true });
    await waitFor(() => room(host).game!.turn === 0 && room(guest).game!.turn === 0, 'AI 2 moved');
    expect(room(guest).game!.board).toBe(room(host).game!.board);
    expect(room(host).game!.history.map((h) => h.seat)).toEqual([0, 1, 2, 3]);
  });

  it('marks a player offline when the connection drops and recovers', async () => {
    guestB.setNetworkEnabled(false);
    await waitFor(() => room(host).presence.guest?.on === false, 'host sees guest offline');
    guestB.setNetworkEnabled(true);
    await waitFor(() => room(host).presence.guest?.on === true, 'guest back');
    await waitFor(() => guest.current.connected, 'guest connected');
  });

  it('closes the room when the host leaves', async () => {
    await host.leave();
    await waitFor(() => guest.current.closed, 'guest told');
    expect(await adminGet(paths.room(code))).toBeNull();
    guest.dispose();
  });
});
