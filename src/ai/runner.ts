/**
 * Runs AI decisions: in a Web Worker when the browser allows it, otherwise
 * on the main thread (yielding first so the page can paint). A worker that
 * does not answer in time is replaced and the move is computed at Easy
 * level instead, so an AI turn can never hang the game.
 */

import type { Seat } from '../engine/constants';
import type { GameState } from '../engine/game';
import { chooseAction, type AiDecision, type Level } from './decide';

export interface AiRequest {
  readonly id: number;
  readonly state: GameState;
  readonly seat: Seat;
  readonly level: Level;
  readonly seed: number;
  readonly timeLimitMs?: number;
}

export type AiResponse = { id: number; ok: true; decision: AiDecision } | { id: number; ok: false; error: string };

export interface AiRunner {
  decide(state: GameState, seat: Seat, level: Level, seed: number): Promise<AiDecision>;
  dispose(): void;
}

/** Extra time a worker gets beyond the AI's own time cap before it is abandoned. */
const WORKER_GRACE_MS = 4000;
const TIME_LIMIT: Record<Level, number> = { easy: 400, normal: 1200, hard: 2500 };

function inline(state: GameState, seat: Seat, level: Level, seed: number): Promise<AiDecision> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(chooseAction(state, seat, { level, seed, timeLimitMs: TIME_LIMIT[level] }));
      } catch (err) {
        reject(err);
      }
    }, 0);
  });
}

export function createInlineRunner(): AiRunner {
  return { decide: inline, dispose: () => {} };
}

export function createAiRunner(): AiRunner {
  if (typeof Worker === 'undefined') return createInlineRunner();
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (d: AiDecision) => void; reject: (e: Error) => void }>();

  function spawn(): Worker | null {
    try {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<AiResponse>) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        if (e.data.ok) p.resolve(e.data.decision);
        else p.reject(new Error(e.data.error));
      };
      w.onerror = () => {
        // A broken worker: fail what is waiting (callers fall back) and stop using it.
        for (const p of pending.values()) p.reject(new Error('AI worker failed'));
        pending.clear();
        worker = null;
      };
      return w;
    } catch {
      return null;
    }
  }

  return {
    decide(state, seat, level, seed) {
      worker ??= spawn();
      const w = worker;
      if (!w) return inline(state, seat, level, seed);
      const id = nextId++;
      const limit = TIME_LIMIT[level];
      const viaWorker = new Promise<AiDecision>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          w.terminate();
          if (worker === w) worker = null;
          reject(new Error('AI worker timed out'));
        }, limit + WORKER_GRACE_MS);
        pending.set(id, {
          resolve: (d) => {
            clearTimeout(timer);
            resolve(d);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        w.postMessage({ id, state, seat, level, seed, timeLimitMs: limit } satisfies AiRequest);
      });
      return viaWorker.catch(() => inline(state, seat, 'easy', seed));
    },
    dispose() {
      worker?.terminate();
      worker = null;
      pending.clear();
    },
  };
}
