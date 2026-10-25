/**
 * database.rules.json against the official Firebase Realtime Database
 * emulator. Run with `npm run test:firebase` (starts the emulators with a
 * demo- project, so nothing can touch real Firebase data).
 */

import { readFileSync } from 'node:fs';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { applyAction, legalActions, newGame } from '../../src/engine';
import { encodeGame } from '../../src/network/protocol';

const PROJECT = 'demo-blokus';
let env: RulesTestEnvironment;

const HOST = 'host-uid';
const GUEST = 'guest-uid';
const STRANGER = 'stranger-uid';

const db = (uid: string | null) => (uid ? env.authenticatedContext(uid).database() : env.unauthenticatedContext().database());
const read = (uid: string | null, path: string) => db(uid).ref(path).once('value');
const put = (uid: string | null, path: string, value: unknown) => db(uid).ref(path).set(value);
const patch = (uid: string | null, paths: Record<string, unknown>) => db(uid).ref().update(paths);
const del = (uid: string | null, path: string) => db(uid).ref(path).remove();

function lobby(hostUid = HOST) {
  return {
    meta: { created: Date.now() - 1000, schema: 1 },
    players: { host: { uid: hostUid, name: 'Ayesha' } },
    state: { v: 1, phase: 'lobby', level: 'normal', game: 0, seed: 0 },
  };
}

/** A game where the host (seat 0) and AI 1 have moved: the guest is to play. */
function guestTurnState(v: number) {
  let g = newGame();
  g = applyAction(g, legalActions(g, 0)[0]);
  g = applyAction(g, legalActions(g, 1)[0]);
  return { v, phase: 'playing', level: 'normal', game: 1, seed: 7, g: encodeGame(g) };
}

async function seed(code: string, state: object = guestTurnState(5)) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx
      .database()
      .ref(`rooms/${code}`)
      .set({
        meta: { created: Date.now() - 1000, schema: 1 },
        players: { host: { uid: HOST, name: 'Ayesha' }, guest: { uid: GUEST, name: 'Bilal' } },
        state,
      });
  });
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    database: { rules: readFileSync(new URL('../../database.rules.json', import.meta.url), 'utf8') },
  });
});

beforeEach(async () => {
  await env.clearDatabase();
});

afterAll(async () => {
  await env?.cleanup();
});

describe('creating rooms', () => {
  it('only for yourself, only once, with a valid code and shape', async () => {
    await assertSucceeds(put(HOST, 'rooms/ABC234', lobby()));
    await assertFails(put(STRANGER, 'rooms/ABC234', lobby(STRANGER))); // taking over an existing room
    await assertFails(put(HOST, 'rooms/ABC234', lobby())); // re-creating your own room (version would go backwards)
    await assertFails(put(null, 'rooms/ABC235', lobby()));
    await assertFails(put(STRANGER, 'rooms/ABC236', lobby(HOST))); // for someone else
    await assertFails(put(HOST, 'rooms/abc237', lobby()));
    await assertFails(put(HOST, 'rooms/ABC23O', lobby())); // O looks like 0
    await assertFails(put(HOST, 'rooms/ABC2345', lobby()));
    await assertFails(put(HOST, 'rooms/ABC238', { ...lobby(), extra: true }));
    const { state: _state, ...noState } = lobby();
    await assertFails(put(HOST, 'rooms/ABC239', noState));
    const noName = lobby();
    noName.players.host.name = '';
    await assertFails(put(HOST, 'rooms/ABC23A', noName));
    const badLevel = lobby();
    badLevel.state.level = 'impossible';
    await assertFails(put(HOST, 'rooms/ABC23B', badLevel));
    await assertFails(put(HOST, 'rooms/ABC23C', { ...lobby(), meta: { created: Date.now() + 60_000, schema: 1 } }));
  });

  it('keeps the creation time and host fixed', async () => {
    await put(HOST, 'rooms/BCD234', lobby());
    await assertFails(put(HOST, 'rooms/BCD234/meta/created', 5));
    await assertFails(put(HOST, 'rooms/BCD234/players/host/uid', STRANGER));
    await assertSucceeds(put(HOST, 'rooms/BCD234/players/host/name', 'Ayesha K'));
    await assertFails(put(HOST, 'rooms/BCD234/meta/schema', 1)); // meta is written once, at creation
    await assertFails(del(HOST, 'rooms/BCD234/players/host'));
    await assertFails(put(STRANGER, 'rooms/BCD234/players/host/name', 'Eve'));
  });
});

describe('reading rooms', () => {
  it('outsiders see only who is seated, never the game', async () => {
    await seed('CDE234');
    await assertSucceeds(read(STRANGER, 'rooms/CDE234/players'));
    await assertFails(read(STRANGER, 'rooms/CDE234'));
    await assertFails(read(STRANGER, 'rooms/CDE234/state'));
    await assertFails(read(STRANGER, 'rooms/CDE234/presence'));
    await assertFails(read(STRANGER, 'rooms/CDE234/req'));
    await assertFails(read(null, 'rooms/CDE234/players'));
    await assertFails(read(HOST, 'rooms'));
    await assertSucceeds(read(HOST, 'rooms/CDE234'));
    await assertSucceeds(read(GUEST, 'rooms/CDE234'));
  });
});

describe('joining', () => {
  it('the first person takes the guest seat; then it is closed', async () => {
    await put(HOST, 'rooms/DEF234', lobby());
    await assertFails(put(GUEST, 'rooms/DEF234/players/guest', { uid: STRANGER, name: 'Bilal' })); // as someone else
    await assertFails(put(HOST, 'rooms/DEF234/players/guest', { uid: HOST, name: 'Me again' })); // host in both seats
    await assertSucceeds(put(GUEST, 'rooms/DEF234/players/guest', { uid: GUEST, name: 'Bilal' }));
    await assertFails(put(STRANGER, 'rooms/DEF234/players/guest', { uid: STRANGER, name: 'Eve' })); // third human
    await assertSucceeds(read(GUEST, 'rooms/DEF234'));
    await assertSucceeds(put(GUEST, 'rooms/DEF234/players/guest/name', 'Bilal K'));
    await assertFails(put(GUEST, 'rooms/DEF234/players/guest/uid', STRANGER)); // handing the seat on
    await assertFails(put(GUEST, 'rooms/DEF234/players/host', { uid: GUEST, name: 'x' }));
    await assertFails(put(GUEST, 'rooms/NOROOM/players/guest', { uid: GUEST, name: 'Bilal' }));
    await assertFails(put(GUEST, 'rooms/DEF234/players/guest', { uid: GUEST, name: 'x'.repeat(25) }));
  });

  it('leaving frees the seat and ends read access', async () => {
    await put(HOST, 'rooms/EFG234', lobby());
    await put(GUEST, 'rooms/EFG234/players/guest', { uid: GUEST, name: 'Bilal' });
    await assertSucceeds(del(GUEST, 'rooms/EFG234/players/guest'));
    await assertSucceeds(put(STRANGER, 'rooms/EFG234/players/guest', { uid: STRANGER, name: 'Eve' }));
    await assertFails(read(GUEST, 'rooms/EFG234'));
    // The host can free a seat (e.g. the partner lost their device), but not sit in it.
    await assertSucceeds(del(HOST, 'rooms/EFG234/players/guest'));
    await assertFails(put(HOST, 'rooms/EFG234/players/guest', { uid: HOST, name: 'Ayesha' }));
  });
});

describe('presence', () => {
  it('each member sets only their own', async () => {
    await seed('FGH234');
    const on = { on: true, at: Date.now() };
    await assertSucceeds(put(GUEST, 'rooms/FGH234/presence/guest', on));
    await assertFails(put(GUEST, 'rooms/FGH234/presence/host', on));
    await assertSucceeds(put(HOST, 'rooms/FGH234/presence/host', on));
    await assertFails(put(STRANGER, 'rooms/FGH234/presence/guest', on));
    await assertFails(put(GUEST, 'rooms/FGH234/presence/guest', { on: 'yes', at: 1 }));
    await assertFails(put(GUEST, 'rooms/FGH234/presence/ai', on));
  });
});

describe('game state', () => {
  it('only the host writes it, exactly one version at a time', async () => {
    await seed('GHJ234');
    await assertSucceeds(put(HOST, 'rooms/GHJ234/state', guestTurnState(6)));
    await assertFails(put(HOST, 'rooms/GHJ234/state', guestTurnState(6))); // same version again
    await assertFails(put(HOST, 'rooms/GHJ234/state', guestTurnState(5))); // older
    await assertFails(put(HOST, 'rooms/GHJ234/state', guestTurnState(9))); // skipping ahead
    await assertFails(put(HOST, 'rooms/GHJ234/state/g/turn', 3)); // a field without a new version
    await assertFails(put(GUEST, 'rooms/GHJ234/state', guestTurnState(7)));
    await assertFails(put(STRANGER, 'rooms/GHJ234/state', guestTurnState(7)));
    await assertFails(put(GUEST, 'rooms/GHJ234/meta/created', 5));
  });

  it('rejects malformed game data', async () => {
    await seed('HJK234');
    const bad = (mut: (s: ReturnType<typeof guestTurnState>) => void) => {
      const s = guestTurnState(6);
      mut(s);
      return put(HOST, 'rooms/HJK234/state', s);
    };
    await assertFails(bad((s) => ((s.g as { board: string }).board = 'x'.repeat(400))));
    await assertFails(bad((s) => ((s.g as { board: string }).board = '.'.repeat(399))));
    await assertFails(bad((s) => ((s.g as { turn: number }).turn = 4)));
    await assertFails(bad((s) => (s.phase = 'paused')));
    await assertFails(bad((s) => ((s as Record<string, unknown>).cheat = 1)));
    await assertSucceeds(bad(() => {}));
  });
});

describe('move requests', () => {
  const req = (v: number, extra: object = {}) => ({ id: 'r1', v, t: 'place', p: 'I5', o: 1, x: 19, y: 15, ...extra });

  it('only from the guest, on its turn, for the current version, well formed', async () => {
    await seed('JKL234');
    await assertFails(put(GUEST, 'rooms/JKL234/req', req(4))); // stale
    await assertFails(put(GUEST, 'rooms/JKL234/req', req(6))); // from the future
    await assertFails(put(GUEST, 'rooms/JKL234/req', req(5, { err: 'x' }))); // answering itself
    await assertFails(put(GUEST, 'rooms/JKL234/req', req(5, { x: 20 })));
    await assertFails(put(GUEST, 'rooms/JKL234/req', req(5, { p: 'Q9!' })));
    await assertFails(put(GUEST, 'rooms/JKL234/req', req(5, { seat: 0 }))); // no acting for another seat
    await assertFails(put(GUEST, 'rooms/JKL234/req', req(5, { t: 'teleport' })));
    await assertFails(put(STRANGER, 'rooms/JKL234/req', req(5)));
    await assertSucceeds(put(GUEST, 'rooms/JKL234/req', req(5)));
    await assertSucceeds(put(GUEST, 'rooms/JKL234/req', { id: 'r2', v: 5, t: 'pass' }));
    await assertFails(put(HOST, 'rooms/JKL234/req', req(5))); // the host answers requests but cannot make them
    await assertSucceeds(put(HOST, 'rooms/JKL234/req/err', 'That piece overlaps.'));
    await assertFails(put(HOST, 'rooms/JKL234/req/err', 'x'.repeat(121)));
    await assertSucceeds(del(GUEST, 'rooms/JKL234/req'));
    await assertFails(put(HOST, 'rooms/JKL234/req/err', 'No request to answer.'));
    await assertSucceeds(del(HOST, 'rooms/JKL234/req'));
  });

  it('are refused when it is not the guest\'s turn or no game is on', async () => {
    const hostTurn = { ...guestTurnState(5), g: encodeGame(newGame()) };
    await seed('KLM234', hostTurn);
    await assertFails(put(GUEST, 'rooms/KLM234/req', req(5)));
    await seed('LMN234', { v: 3, phase: 'lobby', level: 'easy', game: 0, seed: 0 });
    await assertFails(put(GUEST, 'rooms/LMN234/req', { id: 'r', v: 3, t: 'pass' }));
  });

  it('the host applies a move atomically, and a duplicate of that write is refused as a whole', async () => {
    await seed('MNP234');
    await put(GUEST, 'rooms/MNP234/req', req(5));
    const apply = { 'rooms/MNP234/state': guestTurnState(6), 'rooms/MNP234/req': null };
    await assertSucceeds(patch(HOST, apply));
    await assertFails(patch(HOST, apply)); // replayed (e.g. a second host tab)
    await assertFails(patch(GUEST, { 'rooms/MNP234/state': guestTurnState(7), 'rooms/MNP234/req': null }));
    let v: unknown = null;
    await env.withSecurityRulesDisabled(async (ctx) => {
      v = (await ctx.database().ref('rooms/MNP234/state/v').once('value')).val();
    });
    if (v !== 6) throw new Error(`expected version 6, got ${String(v)}`);
  });
});

describe('closing rooms', () => {
  it('only the host can delete a room', async () => {
    await seed('NPQ234');
    await assertFails(del(GUEST, 'rooms/NPQ234'));
    await assertFails(del(STRANGER, 'rooms/NPQ234'));
    await assertFails(patch(GUEST, { 'rooms/NPQ234/state': null }));
    await assertSucceeds(del(HOST, 'rooms/NPQ234'));
  });
});
