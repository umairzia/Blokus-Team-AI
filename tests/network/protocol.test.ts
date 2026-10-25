import { describe, expect, it } from 'vitest';
import { readFirebaseConfig } from '../../src/network/firebase-config';
import {
  ROOM_CODE_PATTERN,
  decodeGame,
  decodeRoom,
  encodeGame,
  normalizeRoomCode,
  randomRoomCode,
  CorruptRoomError,
} from '../../src/network/protocol';
import { createRng } from '../../src/util/rng';
import { playRandomGame } from '../helpers';

/** What Firebase does to arrays: objects keyed "0", "1", … */
function firebaseify(v: unknown): unknown {
  if (Array.isArray(v)) return Object.fromEntries(v.map((x, i) => [String(i), firebaseify(x)]));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, firebaseify(x)]));
  return v;
}

describe('room codes', () => {
  it('are 6 unambiguous characters and practically unique', () => {
    const rng = createRng(1);
    const codes = new Set<string>();
    for (let i = 0; i < 20000; i++) {
      const c = randomRoomCode(rng);
      expect(c).toMatch(ROOM_CODE_PATTERN);
      expect(c).not.toMatch(/[IO01]/);
      codes.add(c);
    }
    expect(codes.size).toBeGreaterThan(19990);
  });

  it('are read from typed text or a pasted invite link', () => {
    expect(normalizeRoomCode('abc234')).toBe('ABC234');
    expect(normalizeRoomCode(' AB C2-34 ')).toBe('ABC234');
    expect(normalizeRoomCode('https://umairzia.github.io/Blokus-Team-AI/#XYZ789')).toBe('XYZ789');
    expect(normalizeRoomCode('ABC10O')).toBeNull();
    expect(normalizeRoomCode('ABC')).toBeNull();
  });
});

describe('game encoding', () => {
  it('round-trips games, including the array-to-object conversion Firebase applies', () => {
    for (const seed of [1, 2, 3]) {
      for (const st of playRandomGame(seed).filter((_, i) => i % 11 === 0)) {
        expect(decodeGame(encodeGame(st))).toEqual(st);
        expect(decodeGame(firebaseify(JSON.parse(JSON.stringify(encodeGame(st)))))).toEqual(st);
      }
    }
  });

  it('accepts the empty history Firebase drops', () => {
    const w = { ...encodeGame(playRandomGame(1)[0]) } as Record<string, unknown>;
    delete w.h;
    expect(decodeGame(w).n).toBe(0);
  });

  it('detects a stored game that does not match its own history', () => {
    const st = playRandomGame(4)[20];
    const w = encodeGame(st);
    expect(() => decodeGame({ ...w, board: '.' + w.board.slice(1) })).toThrow(/does not match/);
    expect(() => decodeGame({ ...w, turn: (w.turn + 1) % 4 })).toThrow();
    expect(() => decodeGame({ ...w, rem: [0, 0, 0, 0] })).toThrow();
    expect(() => decodeGame({ ...w, h: ['0:I5:9:0:0'] })).toThrow();
    expect(() => decodeRoom('ABC234', { state: { v: 2, phase: 'playing', level: 'hard', game: 1, seed: 1, g: { ...w, n: 3 } } })).toThrow(
      CorruptRoomError,
    );
  });
});

describe('firebase config', () => {
  const good = {
    VITE_FIREBASE_API_KEY: 'AIzaSyExample',
    VITE_FIREBASE_AUTH_DOMAIN: 'blokus-team-ai.firebaseapp.com',
    VITE_FIREBASE_DATABASE_URL: 'https://blokus-team-ai-default-rtdb.europe-west1.firebasedatabase.app',
    VITE_FIREBASE_PROJECT_ID: 'blokus-team-ai',
    VITE_FIREBASE_APP_ID: '1:1234567890:web:abc123def456',
  };

  it('is "missing" until every value is filled in', () => {
    expect(readFirebaseConfig({}).kind).toBe('missing');
    expect(readFirebaseConfig({ ...good, VITE_FIREBASE_APP_ID: ' ' })).toEqual({ kind: 'missing', missing: ['VITE_FIREBASE_APP_ID'] });
  });

  it('accepts a real-looking config and rejects malformed or secret values', () => {
    expect(readFirebaseConfig(good)).toMatchObject({ kind: 'ready', emulator: null });
    expect(readFirebaseConfig({ ...good, VITE_FIREBASE_DATABASE_URL: 'http://evil.example.com' }).kind).toBe('invalid');
    expect(readFirebaseConfig({ ...good, VITE_FIREBASE_API_KEY: '-----BEGIN PRIVATE KEY-----' }).kind).toBe('invalid');
  });

  it('uses emulators only for demo- projects', () => {
    expect(readFirebaseConfig({ ...good, VITE_FIREBASE_EMULATOR: '127.0.0.1:9000:9099' }).kind).toBe('invalid');
    const demo = { ...good, VITE_FIREBASE_PROJECT_ID: 'demo-blokus', VITE_FIREBASE_EMULATOR: '127.0.0.1:9000:9099' };
    expect(readFirebaseConfig(demo)).toMatchObject({ kind: 'ready', emulator: { host: '127.0.0.1', databasePort: 9000, authPort: 9099 } });
  });
});
