/**
 * Test side of the browser bridge (see src/network/bridge-backend.ts): one
 * MemoryDatabase in the test process, shared by every page of every browser
 * context attached to the hub, so two "devices" can play each other offline.
 * Each page load is one connection; reloading or closing the page drops it
 * (running its onDisconnect writes, as Firebase does).
 */

import type { BrowserContext, Page } from '@playwright/test';
import { MemoryDatabase, type MemoryBackend } from '../../src/network/memory-db';

interface Conn {
  backend: MemoryBackend;
  stops: Map<number, () => void>;
  chain: Promise<unknown>;
}

export class BridgeHub {
  readonly db = new MemoryDatabase();
  private readonly conns = new Map<Page, Conn>();

  async attach(context: BrowserContext): Promise<void> {
    await context.exposeBinding('__blokusBridge', ({ page }, op: string, args: Record<string, unknown>) => this.handle(page, op, args ?? {}));
    context.on('page', (page) => page.on('close', () => this.drop(page)));
  }

  private push(page: Page, conn: Conn, ev: unknown): void {
    conn.chain = conn.chain
      .then(() => page.evaluate((e) => (window as unknown as { __blokusBridgeEvent?: (x: unknown) => void }).__blokusBridgeEvent?.(e), ev))
      .catch(() => {
        /* page closed or navigating */
      });
  }

  private drop(page: Page): void {
    const c = this.conns.get(page);
    if (!c) return;
    for (const stop of c.stops.values()) stop();
    c.backend.dispose();
    this.conns.delete(page);
  }

  private async handle(page: Page, op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (op === 'hello') {
      this.drop(page); // a new page load replaces the old connection
      const backend = this.db.connect(String(args.uid));
      const conn: Conn = { backend, stops: new Map(), chain: Promise.resolve() };
      this.conns.set(page, conn);
      backend.onConnection((online) => this.push(page, conn, { type: 'connected', online }));
      return { online: backend.isOnline() };
    }
    const c = this.conns.get(page);
    if (!c) return { error: 'not connected' };
    const id = Number(args.id);
    switch (op) {
      case 'watch':
        c.stops.set(
          id,
          c.backend.watch(
            String(args.path),
            (value) => this.push(page, c, { type: 'value', id, value }),
            () => this.push(page, c, { type: 'error', id }),
          ),
        );
        return {};
      case 'presence':
        c.stops.set(id, c.backend.presence(String(args.path)));
        return {};
      case 'unwatch':
      case 'unpresence':
        c.stops.get(id)?.();
        c.stops.delete(id);
        return {};
      case 'get':
        try {
          return { value: await c.backend.get(String(args.path)) };
        } catch {
          return { error: 'denied' };
        }
      case 'update':
        try {
          await c.backend.update(args.paths as Record<string, unknown>);
          return {};
        } catch {
          return { error: 'denied' };
        }
      default:
        return { error: `unknown op ${op}` };
    }
  }

  /** Simulates the page's device losing (false) or regaining (true) its network. */
  setOnline(page: Page, online: boolean): void {
    this.conns.get(page)?.backend.setOnline(online);
  }
}
