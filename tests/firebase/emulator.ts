/**
 * Helpers for tests that run against the local Firebase emulators started by
 * `firebase emulators:exec --config firebase.test.json` (a demo- project, so
 * nothing here can reach real Firebase data).
 *
 * firebase.test.json does not name a rules file: the tests upload
 * database.rules.json themselves, so the rules under test are always the
 * current file (and the upload goes straight to the local emulator).
 */

import { readFileSync } from 'node:fs';

export const PROJECT_ID = 'demo-blokus';
export const NAMESPACE = `${PROJECT_ID}-default-rtdb`;
export const EMULATOR = { host: '127.0.0.1', databasePort: 9000, authPort: 9099 };
export const DB_URL = `http://${EMULATOR.host}:${EMULATOR.databasePort}`;

export const WEB_CONFIG = {
  apiKey: 'demo-api-key',
  authDomain: `${PROJECT_ID}.firebaseapp.com`,
  databaseURL: `https://${NAMESPACE}.firebaseio.com`,
  projectId: PROJECT_ID,
  appId: '1:000000000000:web:demo',
};

export function rulesText(): string {
  return readFileSync(new URL('../../database.rules.json', import.meta.url), 'utf8');
}

/** Installs database.rules.json in the emulator (as the emulator "owner"). */
export async function uploadRules(): Promise<void> {
  const res = await fetch(`${DB_URL}/.settings/rules.json?ns=${NAMESPACE}`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer owner' },
    body: rulesText(),
  });
  if (!res.ok) throw new Error(`The emulator refused the rules: ${res.status} ${await res.text()}`);
}

/** Reads a path ignoring the rules. */
export async function adminGet(path: string): Promise<unknown> {
  const res = await fetch(`${DB_URL}/${path}.json?ns=${NAMESPACE}`, { headers: { Authorization: 'Bearer owner' } });
  return res.json();
}

export async function clearDatabase(): Promise<void> {
  await fetch(`${DB_URL}/.json?ns=${NAMESPACE}`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } });
}
