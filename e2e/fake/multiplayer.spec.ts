/**
 * Two people on two separate browsers (independent contexts: separate
 * storage, separate anonymous ids) play one room through the shared
 * in-memory database. Browser A is a laptop, browser B a phone.
 */

import { expect, test } from '@playwright/test';
import { BridgeHub } from '../support/bridge';
import {
  LAPTOP,
  PHONE,
  boardN,
  boardString,
  createRoom,
  joinByLink,
  openPlayer,
  playSuggested,
  waitTurn,
  type Player,
} from '../support/players';

test.describe.configure({ mode: 'serial' });

let hub: BridgeHub;
let A: Player;
let B: Player;
let code: string;

test.beforeAll(async ({ browser }) => {
  hub = new BridgeHub();
  A = await openPlayer(browser, { device: LAPTOP, setup: (ctx) => hub.attach(ctx) });
  B = await openPlayer(browser, { device: PHONE, setup: (ctx) => hub.attach(ctx) });
});

test.afterAll(async () => {
  await A?.context.close();
  await B?.context.close();
});

test('browser A creates a room and browser B joins with the invitation link', async () => {
  code = await createRoom(A, 'Ayesha', 'easy');
  await expect(A.page.locator('#btn-start')).toBeDisabled();
  await joinByLink(B, code, 'Bilal');
  // Both see the same room and both names.
  await expect(B.page.locator('#lobby-code')).toHaveText(code);
  await expect(A.page.locator('#lobby-seats')).toContainText('Bilal');
  await expect(B.page.locator('#lobby-seats')).toContainText('Ayesha');
  await expect(A.page.locator('#btn-start')).toBeEnabled();
  await expect(B.page.locator('#lobby-wait')).toContainText('Waiting for Ayesha');
  await expect(A.page.locator('#room-chip-code')).toHaveText(code);
});

test('a third browser cannot take the occupied seat', async ({ browser }) => {
  const C = await openPlayer(browser, { setup: (ctx) => hub.attach(ctx) });
  await C.page.goto(`#${code}`);
  await C.page.locator('#name').fill('Eve');
  await C.page.locator('#btn-join').click();
  await expect(C.page.locator('#home-msg')).toContainText('already has two players');
  await expect(C.page.locator('#screen-lobby')).toBeHidden();
  await C.context.close();
});

test('the game starts on both screens with Human 1 to move', async () => {
  await A.page.locator('#btn-start').click();
  await expect(A.page.locator('#screen-game')).toBeVisible();
  await expect(B.page.locator('#screen-game')).toBeVisible();
  await expect(A.page.locator('#board')).toHaveAttribute('data-turn', '0');
  await expect(B.page.locator('#board')).toHaveAttribute('data-turn', '0');
  await expect(A.page.locator('#status-text')).toContainText('Your turn (Blue)');
  await expect(B.page.locator('#status-text')).toContainText("Ayesha's turn");
  // Turn order in the seat panel: Human 1, AI 1, Human 2, AI 2.
  await expect(A.page.locator('#seats .seat-name')).toHaveText(['Ayesha', 'AI 1', 'Bilal', 'AI 2']);
});

test('an illegal move is rejected and changes nothing', async () => {
  const n = await boardN(A.page);
  await A.page.locator('.piece-btn[data-piece="I1"]').click();
  // The centre of the board is not Human 1's starting corner.
  await A.page.locator('#board .cell').nth(10 * 20 + 10).click();
  await expect(A.page.locator('#toast')).toContainText('first piece must cover your starting corner');
  expect(await boardN(A.page)).toBe(n);
  expect(await boardN(B.page)).toBe(n);
  await A.page.locator('#btn-cancel').click();
});

test("A's legal move appears on B's screen, then AI 1 moves by itself", async () => {
  await playSuggested(A.page);
  await expect.poll(() => boardString(B.page)).toContain('0');
  expect((await boardString(B.page))[0]).toBe('0');
  // AI 1 (yellow, top-right) plays without anyone doing anything.
  await waitTurn(B.page, 2);
  const board = await boardString(B.page);
  expect(board[19]).toBe('1');
  expect(board).toBe(await boardString(A.page));
});

test('B plays from the phone (tap to preview, then Place) and AI 2 follows', async () => {
  await expect(B.page.locator('#opt-confirm')).toBeChecked(); // touch devices confirm placements
  await playSuggested(B.page);
  await waitTurn(A.page, 0);
  const board = await boardString(A.page);
  expect(board[399]).toBe('2');
  expect(board[380]).toBe('3');
  expect(board).toBe(await boardString(B.page));
  await expect(A.page.locator('#log li')).toHaveCount(4);
});

test('refreshing a browser returns it to the same seat and board', async () => {
  const before = await boardString(B.page);
  await B.page.reload();
  await expect(B.page.locator('#screen-game')).toBeVisible();
  expect(await boardString(B.page)).toBe(before);
  await expect(B.page.locator('#status-text')).toContainText("Ayesha's turn");
  // The host sees the partner back online.
  await expect(A.page.locator('#seats .seat').nth(2).locator('.presence.on')).toHaveCount(1);
  expect(B.errors).toEqual([]);
});

test('a dropped connection is shown and play continues after it comes back', async () => {
  hub.setOnline(B.page, false);
  await expect(B.page.locator('#conn-text')).toHaveText(/Offline/);
  await expect(A.page.locator('#seats .seat').nth(2).locator('.presence.on')).toHaveCount(0);
  await playSuggested(A.page); // the host keeps playing; AI 1 follows
  hub.setOnline(B.page, true);
  await expect(B.page.locator('#conn-text')).toHaveText('Online');
  await waitTurn(B.page, 2);
  expect(await boardString(B.page)).toBe(await boardString(A.page));
});

test('the phone layout keeps the whole board and the controls on screen', async () => {
  const box = (await B.page.locator('#board').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.width / 20).toBeGreaterThan(15); // squares stay big enough to tap
  for (const id of ['#btn-rotate', '#btn-flip', '#btn-place']) {
    const b = (await B.page.locator(id).boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(40);
    expect(b.x + b.width).toBeLessThanOrEqual(390);
  }
  const scrollWidth = await B.page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
  await B.page.screenshot({ path: 'test-results/fake/phone-game.png' });
  await A.page.screenshot({ path: 'test-results/fake/laptop-game.png' });
});

test('the game reaches a valid end on both screens', async () => {
  test.setTimeout(240_000);
  for (let i = 0; i < 120; i++) {
    const status = await A.page.locator('#board').getAttribute('data-status');
    if (status === 'over') break;
    const turn = await A.page.locator('#board').getAttribute('data-turn');
    if (turn === '0' && (await A.page.locator('#status').getAttribute('class'))!.includes('mine')) await playSuggested(A.page);
    else if (turn === '2' && (await B.page.locator('#status').getAttribute('class'))!.includes('mine')) await playSuggested(B.page);
    else await A.page.waitForTimeout(100);
  }
  await expect(A.page.locator('#board')).toHaveAttribute('data-status', 'over');
  await expect(B.page.locator('#board')).toHaveAttribute('data-status', 'over');
  await expect(A.page.locator('#dlg-over')).toBeVisible();
  await expect(B.page.locator('#dlg-over')).toBeVisible();
  await expect(A.page.locator('#over-title')).toHaveText(/wins!|draw/);
  await expect(B.page.locator('#over-title')).toHaveText((await A.page.locator('#over-title').textContent())!);
  expect(await boardString(A.page)).toBe(await boardString(B.page));
  await expect(B.page.locator('#btn-over-new')).toBeHidden(); // only the host starts the next game
  await B.page.locator('#btn-over-close').click();
  await A.page.locator('#btn-over-new').click();
  await expect(B.page.locator('#board')).toHaveAttribute('data-n', '0');
  await expect(B.page.locator('#board')).toHaveAttribute('data-status', 'playing');
});

test('when the host closes the room, the partner is told and returned home', async () => {
  await A.page.locator('#btn-leave').click();
  await A.page.locator('#btn-confirm-yes').click();
  await expect(A.page.locator('#screen-home')).toBeVisible();
  await expect(B.page.locator('#screen-home')).toBeVisible();
  await expect(B.page.locator('#home-msg')).toContainText(/closed|no longer/);
  expect(hub.db.adminGet(`rooms/${code}`)).toBeNull();
  expect(A.errors).toEqual([]);
  expect(B.errors).toEqual([]);
});
