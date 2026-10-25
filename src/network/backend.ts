/**
 * The small slice of a realtime database the game needs. FirebaseBackend
 * implements it with the real Firebase SDK; MemoryBackend and BridgeBackend
 * implement it for tests, so the room and host logic is the same code in
 * every case.
 */

export type Unsubscribe = () => void;

export interface Backend {
  readonly kind: 'firebase' | 'memory' | 'bridge';
  /** The anonymous user id; stable across page reloads in the same browser. */
  readonly uid: string;
  /** Server-side timestamp placeholder for writes. */
  readonly TIMESTAMP: unknown;
  /** Calls back with true/false whenever the link to the server comes or goes. */
  onConnection(cb: (online: boolean) => void): Unsubscribe;
  /**
   * Listens to a path: onValue gets its value (null when absent) now and on
   * every change; onError if reading is refused (e.g. after leaving a room).
   */
  watch(path: string, onValue: (value: unknown) => void, onError?: (err: Error) => void): Unsubscribe;
  get(path: string): Promise<unknown>;
  /** Writes several paths atomically: all are saved or none. null deletes. */
  update(paths: Record<string, unknown>): Promise<void>;
  /**
   * Keeps `path` at {on: true, at} while connected; the server sets
   * {on: false, at} by itself when the connection drops.
   */
  presence(path: string): Unsubscribe;
  dispose(): void;
}

export class PermissionDeniedError extends Error {
  readonly code = 'PERMISSION_DENIED';
  constructor(message = 'PERMISSION_DENIED: Permission denied') {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

export function isPermissionDenied(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: unknown; message?: unknown };
  return e.code === 'PERMISSION_DENIED' || /permission[_ ]denied/i.test(String(e.message ?? err));
}

/** Firebase refuses `undefined` anywhere in a value; drop those fields. */
export function clean<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => clean(v)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== undefined) out[k] = clean(v);
  return out as T;
}
