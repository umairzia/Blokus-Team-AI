/**
 * Web Worker entry: runs AI decisions off the main thread so the page stays
 * responsive while the AI thinks.
 */

import { chooseAction } from './decide';
import type { AiRequest, AiResponse } from './runner';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<AiRequest>) => void) | null;
  postMessage(message: AiResponse): void;
};

ctx.onmessage = (e) => {
  const { id, state, seat, level, seed, timeLimitMs } = e.data;
  try {
    const decision = chooseAction(state, seat, { level, seed, timeLimitMs });
    ctx.postMessage({ id, ok: true, decision });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
