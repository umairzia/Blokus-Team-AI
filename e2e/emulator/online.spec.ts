/**
 * The production code path end to end: two separate browsers load the
 * built site (dist-emulator), sign in anonymously with the real Firebase SDK
 * and play through the Realtime Database emulator, with database.rules.json
 * enforced. Started by `npm run test:e2e:emulator`.
 */

import { expect, test } from '@playwright/test';
import { adminGet, clearDatabase, uploadRules } from '../../tests/firebase/emulator';
import {
  LAPTOP,
  PHONE,
  boardString,
  createRoom,
  joinByLink,
  openPlayer,
  playSuggested,
  waitTurn,
  type Player,
} from '../support/players';

test.describe.configure({ mode: 'serial' });

let A: Player;
let B: Player;
let code: string;

test.beforeAll(async ({ browser }) => {
  await uploadRules();
  await clearDatabase();
  A = await openPlayer(browser, { device: LAPTOP });
  B = await openPlayer(browser, { device: PHONE });
});

test.afterAll(async () => {
  await A?.context.close();
  await B?.context.close();
});

test('two browsers meet in a room through Firebase', async () => {
  await expect(A.page.locator('#online-setup')).toBeHidden();
  code = await createRoom(A, 'Ayesha', 'normal');
  await expect(A.page.locator('#conn-text')).toHaveText('Online');
  await joinByLink(B, code, 'Bilal');
  await expect(A.page.locator('#lobby-seats')).toContainText('Bilal');
  await expect(B.page.locator('#lobby-seats')).toContainText('Ayesha');
  const players = (await adminGet(`rooms/${code}/players`)) as { host: { uid: string }; guest: { uid: string } };
  expect(players.host.uid).not.toBe(players.guest.uid);
});

test('a third browser is kept out of the full room', async ({ browser }) => {
  const C = await openPlayer(browser);
  await C.page.goto(`#${code}`);
  await C.page.locator('#name').fill('Eve');
  await C.page.locator('#btn-join').click();
  await expect(C.page.locator('#home-msg')).toContainText('already has two players');
  await C.context.close();
});

test('moves, AI turns and the board stay in step on both browsers', async () => {
  await A.page.locator('#btn-start').click();
  await waitTurn(A.page, 0);
  await playSuggested(A.page);
  await waitTurn(B.page, 2);
  await playSuggested(B.page);
  await waitTurn(A.page, 0);
  const board = await boardString(A.page);
  expect(board).toBe(await boardString(B.page));
  expect([board[0], board[19], board[399], board[380]]).toEqual(['0', '1', '2', '3']);
  const state = (await adminGet(`rooms/${code}/state`)) as { v: number; g: { n: number } };
  expect(state.g.n).toBe(4);
});

test('a refreshed browser comes back to its seat with the same anonymous account', async () => {
  const before = await boardString(B.page);
  await B.page.reload();
  await expect(B.page.locator('#screen-game')).toBeVisible();
  expect(await boardString(B.page)).toBe(before);
  await expect(A.page.locator('#seats .seat').nth(2).locator('.presence.on')).toHaveCount(1);
  await playSuggested(A.page);
  await waitTurn(B.page, 2);
  await playSuggested(B.page);
  await waitTurn(A.page, 0);
});

test('closing the room removes it from the database and tells the partner', async () => {
  await A.page.locator('#btn-leave').click();
  await A.page.locator('#btn-confirm-yes').click();
  await expect(B.page.locator('#screen-home')).toBeVisible();
  expect(await adminGet(`rooms/${code}`)).toBeNull();
  expect(A.errors.filter((e) => !/emulator/i.test(e))).toEqual([]);
  expect(B.errors.filter((e) => !/emulator/i.test(e))).toEqual([]);
});
