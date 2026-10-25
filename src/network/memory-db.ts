/**
 * An in-memory stand-in for the Firebase Realtime Database, for tests: one
 * MemoryDatabase is the "server", and each MemoryBackend is one browser's
 * connection to it. Reads and writes are checked with the same rules as
 * database.rules.json (those rules are tested against the official emulator
 * separately). Connections can be taken offline and back to simulate
 * network failures: writes made while offline wait, and the server runs a
 * dropped connection's onDisconnect writes, as Firebase does.
 */

import { isLevel } from '../ai/decide';
import { isPieceId } from '../engine/pieces';
import { PermissionDeniedError, clean, type Backend, type Unsubscribe } from './backend';
import { NAME_MAX, ROOM_CODE_PATTERN, SCHEMA_VERSION } from './protocol';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Tree = { [k: string]: Json };

const TIMESTAMP = { '.sv': 'timestamp' };

function parts(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function copy<T>(v: T): T {
  return v === undefined ? (null as T) : (JSON.parse(JSON.stringify(v)) as T);
}

function getAt(tree: Json, path: string): Json {
  let node: Json = tree;
  for (const p of parts(path)) {
    if (node === null || typeof node !== 'object' || Array.isArray(node) || !(p in node)) return null;
    node = (node as Tree)[p];
  }
  return node ?? null;
}

function isEmpty(v: Json): boolean {
  return v === null || (typeof v === 'object' && Object.keys(v).length === 0);
}

/** Firebase stores arrays as objects with numeric keys and drops empty nodes. */
function normalize(v: Json): Json {
  if (v === null || typeof v !== 'object') return v;
  const out: Tree = {};
  const entries: [string, Json][] = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
  for (const [k, x] of entries) {
    const n = normalize(x);
    if (!isEmpty(n)) out[k] = n;
  }
  return isEmpty(out) ? null : out;
}

/** Turns objects with keys 0..n-1 back into arrays, as the Firebase SDK does. */
function toClient(v: Json): Json {
  if (v === null || typeof v !== 'object') return v;
  const keys = Object.keys(v);
  const obj = v as Tree;
  if (keys.length > 0 && keys.every((k, i) => k === String(i))) return keys.map((k) => toClient(obj[k]));
  const out: Tree = {};
  for (const k of keys) out[k] = toClient(obj[k]);
  return out;
}

function setAt(tree: Tree, path: string, value: Json): Tree {
  const ps = parts(path);
  if (ps.length === 0) return (normalize(value) as Tree) ?? {};
  let node: Tree = tree;
  const trail: [Tree, string][] = [];
  for (let i = 0; i < ps.length - 1; i++) {
    const next = node[ps[i]];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) node[ps[i]] = {};
    trail.push([node, ps[i]]);
    node = node[ps[i]] as Tree;
  }
  const last = ps[ps.length - 1];
  const n = normalize(value);
  if (n === null) delete node[last];
  else node[last] = n;
  for (let k = trail.length - 1; k >= 0; k--) {
    const [parent, key] = trail[k];
    if (isEmpty(parent[key])) delete parent[key];
  }
  return tree;
}

function resolveServerValues(v: Json, now: number): Json {
  if (v === null || typeof v !== 'object') return v;
  if (!Array.isArray(v) && (v as Tree)['.sv'] === 'timestamp') return now;
  if (Array.isArray(v)) return v.map((x) => resolveServerValues(x, now));
  const out: Tree = {};
  for (const [k, x] of Object.entries(v)) out[k] = resolveServerValues(x, now);
  return out;
}

// ---- The rules (a TypeScript mirror of database.rules.json) -----------------

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const uidOf = (room: Obj | null, role: string): unknown => obj(obj(room?.players)?.[role])?.uid ?? null;
const isInt = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const onlyKeys = (o: Obj, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));

export function canRead(tree: Json, uid: string | null, path: string): boolean {
  const p = parts(path);
  if (!uid || p[0] !== 'rooms' || p.length < 2) return false;
  if (p[2] === 'players') return true;
  const room = obj(getAt(tree, `rooms/${p[1]}`));
  return !!room && (uidOf(room, 'host') === uid || uidOf(room, 'guest') === uid);
}

function canWritePath(before: Json, after: Json, uid: string, path: string): boolean {
  const p = parts(path);
  if (p[0] !== 'rooms' || p.length < 2) return false;
  const code = p[1];
  const roomBefore = obj(getAt(before, `rooms/${code}`));
  const roomAfter = obj(getAt(after, `rooms/${code}`));
  // Anyone signed in may create a room for themselves (the whole room at once).
  if (!roomBefore) return uidOf(roomAfter, 'host') === uid;
  const isHost = uidOf(roomBefore, 'host') === uid;
  const sub = p.slice(2);
  const nodeAfter = (rel: string) => getAt(after, `rooms/${code}/${rel}`);
  if (sub.length === 0) return isHost && !roomAfter; // only the host, and only to delete it
  if (sub[0] === 'players' && sub[1] === 'host') return isHost && nodeAfter('players/host') !== null;
  if (sub[0] === 'players' && sub[1] === 'guest') {
    const was = obj(getAt(before, `rooms/${code}/players/guest`));
    const now = obj(nodeAfter('players/guest'));
    if (!now && isHost) return true; // the host may free the seat
    if (!was) return uidOf(roomBefore, 'host') !== null && !isHost && now?.uid === uid;
    return was.uid === uid && (!now || now.uid === uid);
  }
  if (sub[0] === 'presence' && sub.length >= 2) {
    if (sub[1] !== 'host' && sub[1] !== 'guest') return false;
    return uidOf(roomBefore, sub[1]) === uid || (isHost && nodeAfter(`presence/${sub[1]}`) === null);
  }
  if (sub[0] === 'state') return isHost && nodeAfter('state') !== null;
  if (sub[0] === 'req' && sub[1] === 'err') return isHost && getAt(before, `rooms/${code}/req`) !== null;
  if (sub[0] === 'req') {
    const req = obj(nodeAfter('req'));
    if (!req) return isHost || uidOf(roomBefore, 'guest') === uid;
    if (uidOf(roomBefore, 'guest') !== uid) return false;
    const st = obj(roomBefore.state);
    return st?.phase === 'playing' && obj(st.g)?.turn === 2 && req.v === st.v && !('err' in req);
  }
  return false;
}

const GAME_KEYS = ['n', 'status', 'turn', 'board', 'rem', 'out', 'last', 'h'];

function validGame(g: Obj): boolean {
  if (!['n', 'status', 'turn', 'board', 'rem', 'out', 'last'].every((k) => k in g) || !onlyKeys(g, GAME_KEYS)) return false;
  if (!isInt(g.n, 0, 10000) || (g.status !== 'playing' && g.status !== 'over') || !isInt(g.turn, 0, 3)) return false;
  if (typeof g.board !== 'string' || !/^[.0-3]{400}$/.test(g.board)) return false;
  const rem = obj(g.rem);
  if (!rem || !onlyKeys(rem, ['0', '1', '2', '3']) || !Object.values(rem).every((v) => isInt(v, 0, 2097151))) return false;
  if (typeof g.out !== 'string' || !/^[01]{4}$/.test(g.out)) return false;
  if (typeof g.last !== 'string' || g.last.length > 16) return false;
  const h = g.h === undefined ? {} : obj(g.h);
  return !!h && Object.entries(h).every(([k, v]) => /^\d+$/.test(k) && typeof v === 'string' && v.length <= 16);
}

/**
 * The .validate rules for a room touched by a write. Like Firebase, the
 * state rules apply whenever the state is written, even with identical data.
 */
function validRoom(code: string, before: Obj | null, room: Obj, stateWritten: boolean): boolean {
  if (!ROOM_CODE_PATTERN.test(code)) return false;
  if (!onlyKeys(room, ['meta', 'players', 'presence', 'state', 'req'])) return false;
  const meta = obj(room.meta);
  const players = obj(room.players);
  const state = obj(room.state);
  if (!meta || !players || !state) return false;
  if (!onlyKeys(meta, ['created', 'schema']) || typeof meta.created !== 'number' || meta.created > Date.now()) return false;
  if (meta.schema !== SCHEMA_VERSION) return false;
  const metaBefore = obj(before?.meta);
  if (metaBefore && metaBefore.created !== meta.created) return false;
  if (!onlyKeys(players, ['host', 'guest']) || !players.host) return false;
  for (const role of ['host', 'guest']) {
    if (!(role in players)) continue;
    const pl = obj(players[role]);
    if (!pl || !onlyKeys(pl, ['uid', 'name']) || typeof pl.uid !== 'string' || pl.uid.length > 128) return false;
    if (typeof pl.name !== 'string' || pl.name.length < 1 || pl.name.length > NAME_MAX) return false;
  }
  const hostBefore = uidOf(before, 'host');
  if (hostBefore !== null && hostBefore !== uidOf(room, 'host')) return false;
  const pres = room.presence === undefined ? {} : obj(room.presence);
  if (!pres || !onlyKeys(pres, ['host', 'guest'])) return false;
  for (const v of Object.values(pres)) {
    const pr = obj(v);
    if (!pr || !onlyKeys(pr, ['on', 'at']) || typeof pr.on !== 'boolean' || typeof pr.at !== 'number') return false;
  }
  const stateBefore = obj(before?.state);
  if (stateWritten) {
    if (!onlyKeys(state, ['v', 'phase', 'level', 'game', 'seed', 'g'])) return false;
    if (typeof state.v !== 'number' || (stateBefore && state.v !== (stateBefore.v as number) + 1)) return false;
    if (!['lobby', 'playing', 'over'].includes(state.phase as string) || !isLevel(state.level)) return false;
    if (!isInt(state.game, 0, 1e9) || typeof state.seed !== 'number') return false;
    if (state.g !== undefined && !(obj(state.g) && validGame(obj(state.g)!))) return false;
  }
  if (room.req !== undefined) {
    const r = obj(room.req);
    if (!r || !onlyKeys(r, ['id', 'v', 't', 'p', 'o', 'x', 'y', 'err'])) return false;
    if (typeof r.id !== 'string' || r.id.length > 24 || typeof r.v !== 'number') return false;
    if (r.t !== 'place' && r.t !== 'pass') return false;
    if ('p' in r && !isPieceId(r.p)) return false;
    if ('o' in r && !isInt(r.o, 0, 7)) return false;
    if ('x' in r && !isInt(r.x, 0, 19)) return false;
    if ('y' in r && !isInt(r.y, 0, 19)) return false;
    if ('err' in r && (typeof r.err !== 'string' || r.err.length > 120)) return false;
  }
  return true;
}

// ---- Server ---------------------------------------------------------------

export class MemoryDatabase {
  private tree: Tree = {};
  private readonly clients = new Set<MemoryBackend>();
  /** Every read attempt, for tests: { uid, path, ok }. */
  readonly readLog: { uid: string | null; path: string; ok: boolean }[] = [];

  connect(uid: string, opts: { latencyMs?: number } = {}): MemoryBackend {
    const c = new MemoryBackend(this, uid, opts.latencyMs ?? 0);
    this.clients.add(c);
    return c;
  }

  /** @internal */
  detach(c: MemoryBackend): void {
    this.clients.delete(c);
  }

  /** Reads anything, ignoring the rules (test "admin"). */
  adminGet(path: string): unknown {
    return toClient(copy(getAt(this.tree, path)));
  }

  /** Writes anything, ignoring the rules (test "admin"). */
  adminSet(path: string, value: unknown): void {
    this.tree = setAt(copy(this.tree), path, resolveServerValues(copy(value) as Json, Date.now()));
    this.broadcast();
  }

  /** @internal */
  read(uid: string, path: string): unknown {
    const ok = canRead(this.tree, uid, path);
    this.readLog.push({ uid, path, ok });
    if (!ok) throw new PermissionDeniedError();
    return toClient(copy(getAt(this.tree, path)));
  }

  /** @internal */
  canRead(uid: string, path: string): boolean {
    return canRead(this.tree, uid, path);
  }

  /** Applies a multi-path update as `uid`: all of it, or nothing. @internal */
  write(uid: string, updates: Record<string, unknown>): void {
    const before = this.tree;
    let after = copy(before);
    const now = Date.now();
    const keys = Object.keys(updates);
    for (const k of keys) after = setAt(after, k, resolveServerValues(copy(updates[k]) as Json, now));
    for (const k of keys) if (!canWritePath(before, after, uid, k)) throw new PermissionDeniedError();
    const codes = new Set(keys.map((k) => parts(k)[1]).filter(Boolean));
    for (const code of codes) {
      const room = obj(getAt(after, `rooms/${code}`));
      const was = obj(getAt(before, `rooms/${code}`));
      const stateWritten = keys.some((k) => {
        const p = parts(k);
        return p[1] === code && (p.length === 2 || p[2] === 'state') && updates[k] !== null;
      });
      if (room && !validRoom(code, was, room, stateWritten)) throw new PermissionDeniedError();
    }
    this.tree = after;
    this.broadcast();
  }

  private broadcast(): void {
    for (const c of this.clients) c.refresh();
  }
}

// ---- Client ---------------------------------------------------------------

interface Watch {
  path: string;
  onValue: (v: unknown) => void;
  onError?: (e: Error) => void;
  last: string | undefined;
}

/** One browser's connection to a MemoryDatabase. */
export class MemoryBackend implements Backend {
  readonly kind = 'memory' as const;
  readonly TIMESTAMP = TIMESTAMP;
  readonly uid: string;
  private readonly db: MemoryDatabase;
  private readonly latency: number;
  private online = true;
  private disposed = false;
  private readonly watches = new Set<Watch>();
  private readonly connWatchers = new Set<(on: boolean) => void>();
  private readonly queue: { updates: Record<string, unknown>; resolve: () => void; reject: (e: Error) => void }[] = [];
  private readonly onDisconnect = new Map<string, unknown>();
  private readonly presences = new Set<string>();

  constructor(db: MemoryDatabase, uid: string, latency: number) {
    this.db = db;
    this.uid = uid;
    this.latency = latency;
  }

  private later(fn: () => void): void {
    setTimeout(() => {
      if (!this.disposed) fn();
    }, this.latency);
  }

  isOnline(): boolean {
    return this.online;
  }

  onConnection(cb: (online: boolean) => void): Unsubscribe {
    this.connWatchers.add(cb);
    this.later(() => cb(this.online));
    return () => this.connWatchers.delete(cb);
  }

  watch(path: string, onValue: (v: unknown) => void, onError?: (e: Error) => void): Unsubscribe {
    const w: Watch = { path, onValue, onError, last: undefined };
    this.watches.add(w);
    if (this.online) this.later(() => this.deliver(w));
    return () => this.watches.delete(w);
  }

  get(path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const run = () => {
        try {
          resolve(this.db.read(this.uid, path));
        } catch (e) {
          reject(e as Error);
        }
      };
      if (this.online) this.later(run);
      else this.queue.push({ updates: {}, resolve: () => run(), reject });
    });
  }

  update(paths: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const updates = clean(paths);
      if (!this.online) {
        this.queue.push({ updates, resolve, reject });
        return;
      }
      this.applyNow(updates, resolve, reject);
    });
  }

  private applyNow(updates: Record<string, unknown>, resolve: () => void, reject: (e: Error) => void): void {
    try {
      if (Object.keys(updates).length) this.db.write(this.uid, updates);
      this.later(resolve);
    } catch (e) {
      this.later(() => reject(e as Error));
    }
  }

  presence(path: string): Unsubscribe {
    this.presences.add(path);
    if (this.online) this.armPresence(path);
    return () => {
      this.presences.delete(path);
      this.onDisconnect.delete(path);
      this.update({ [path]: { on: false, at: TIMESTAMP } }).catch(() => {});
    };
  }

  private armPresence(path: string): void {
    this.onDisconnect.set(path, { on: false, at: TIMESTAMP });
    this.update({ [path]: { on: true, at: TIMESTAMP } }).catch(() => {});
  }

  /** Simulates losing (false) or regaining (true) the network. */
  setOnline(online: boolean): void {
    if (this.online === online || this.disposed) return;
    this.online = online;
    if (!online) {
      this.runOnDisconnect();
    } else {
      for (const w of this.watches) w.last = undefined;
      for (const p of this.presences) this.armPresence(p);
      const q = this.queue.splice(0);
      for (const item of q) this.applyNow(item.updates, item.resolve, item.reject);
      this.refresh();
    }
    for (const cb of this.connWatchers) this.later(() => cb(online));
  }

  private runOnDisconnect(): void {
    const ops = [...this.onDisconnect.entries()];
    this.onDisconnect.clear();
    for (const [path, value] of ops) {
      try {
        this.db.write(this.uid, { [path]: value });
      } catch {
        // No longer allowed (e.g. left the room); Firebase drops it too.
      }
    }
  }

  /** Re-delivers any watched value that changed. @internal */
  refresh(): void {
    if (!this.online || this.disposed) return;
    for (const w of this.watches) this.deliver(w);
  }

  private deliver(w: Watch): void {
    if (!this.watches.has(w) || !this.online) return;
    if (!this.db.canRead(this.uid, w.path)) {
      this.watches.delete(w);
      const err = new PermissionDeniedError();
      this.later(() => w.onError?.(err));
      return;
    }
    const value = this.db.adminGet(w.path);
    const json = JSON.stringify(value);
    if (json === w.last) return;
    w.last = json;
    this.later(() => {
      if (this.watches.has(w)) w.onValue(JSON.parse(json));
    });
  }

  /** Closes the connection as a closed tab would: onDisconnect writes run. */
  dispose(): void {
    if (this.disposed) return;
    if (this.online) this.runOnDisconnect();
    this.disposed = true;
    this.watches.clear();
    this.connWatchers.clear();
    this.db.detach(this);
  }
}
