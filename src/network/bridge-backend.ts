/**
 * Backend for the automated browser tests: the page talks to a
 * MemoryDatabase running in the Playwright test process through an exposed
 * binding, so two separate browser contexts can share one room offline.
 *
 * It is only used when the test harness installs `window.__blokusBridge`
 * before the page loads; real visitors never have it.
 */

import type { Backend, Unsubscribe } from './backend';
import { PermissionDeniedError, clean } from './backend';

type BridgeEvent =
  | { type: 'value'; id: number; value: unknown }
  | { type: 'error'; id: number }
  | { type: 'connected'; online: boolean };

type BridgeCall = (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface BridgeWindow {
  __blokusBridge?: BridgeCall;
  __blokusBridgeEvent?: (ev: BridgeEvent) => void;
}

const UID_KEY = 'blokus.test.uid';

export function bridgeAvailable(): boolean {
  return typeof window !== 'undefined' && typeof (window as BridgeWindow).__blokusBridge === 'function';
}

export class BridgeBackend implements Backend {
  readonly kind = 'bridge' as const;
  readonly TIMESTAMP = { '.sv': 'timestamp' };
  readonly uid: string;
  private readonly call: BridgeCall;
  private online: boolean;
  private nextId = 1;
  private readonly watchers = new Map<number, { onValue: (v: unknown) => void; onError?: (e: Error) => void }>();
  private readonly connWatchers = new Set<(on: boolean) => void>();

  private constructor(call: BridgeCall, uid: string, online: boolean) {
    this.call = call;
    this.uid = uid;
    this.online = online;
    (window as BridgeWindow).__blokusBridgeEvent = (ev) => this.onEvent(ev);
  }

  /** Signs in with a uid kept in this browser's storage, like Firebase's anonymous auth. */
  static async connect(): Promise<BridgeBackend> {
    const call = (window as BridgeWindow).__blokusBridge!;
    let uid = '';
    try {
      uid = localStorage.getItem(UID_KEY) ?? '';
    } catch {
      /* storage blocked */
    }
    if (!uid) {
      uid = 'u' + Math.random().toString(36).slice(2, 12);
      try {
        localStorage.setItem(UID_KEY, uid);
      } catch {
        /* storage blocked */
      }
    }
    const res = await call('hello', { uid });
    return new BridgeBackend(call, uid, res.online === true);
  }

  private onEvent(ev: BridgeEvent): void {
    if (ev.type === 'connected') {
      this.online = ev.online;
      for (const cb of this.connWatchers) cb(ev.online);
      return;
    }
    const w = this.watchers.get(ev.id);
    if (!w) return;
    if (ev.type === 'value') w.onValue(ev.value);
    else {
      this.watchers.delete(ev.id);
      w.onError?.(new PermissionDeniedError());
    }
  }

  onConnection(cb: (online: boolean) => void): Unsubscribe {
    this.connWatchers.add(cb);
    setTimeout(() => cb(this.online), 0);
    return () => this.connWatchers.delete(cb);
  }

  watch(path: string, onValue: (v: unknown) => void, onError?: (e: Error) => void): Unsubscribe {
    const id = this.nextId++;
    this.watchers.set(id, { onValue, onError });
    void this.call('watch', { id, path });
    return () => {
      this.watchers.delete(id);
      void this.call('unwatch', { id });
    };
  }

  async get(path: string): Promise<unknown> {
    const res = await this.call('get', { path });
    if (res.error) throw new PermissionDeniedError();
    return res.value ?? null;
  }

  async update(paths: Record<string, unknown>): Promise<void> {
    const res = await this.call('update', { paths: clean(paths) });
    if (res.error) throw new PermissionDeniedError();
  }

  presence(path: string): Unsubscribe {
    const id = this.nextId++;
    void this.call('presence', { id, path });
    return () => void this.call('unpresence', { id });
  }

  dispose(): void {
    this.watchers.clear();
    this.connWatchers.clear();
  }
}
