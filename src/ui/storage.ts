/**
 * Per-browser conveniences (name, last room, display options). Storage can be
 * unavailable (private windows, blocked site data), so every access is
 * guarded and the game works without it.
 */

const PREFIX = 'blokus.';

export function load(key: string): string {
  try {
    return localStorage.getItem(PREFIX + key) ?? '';
  } catch {
    return '';
  }
}

export function save(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(PREFIX + key, value);
    else localStorage.removeItem(PREFIX + key);
  } catch {
    /* storage unavailable */
  }
}
