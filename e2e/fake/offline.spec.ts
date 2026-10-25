/** The page without any online backend: setup message and offline practice. */

import { expect, test } from '@playwright/test';
import { LAPTOP, PHONE, boardN, openPlayer, playSuggested, waitTurn } from '../support/players';

test('without Firebase settings it says online play is not set up, and practice still works', async ({ browser }) => {
  const p = await openPlayer(browser, { device: LAPTOP });
  await expect(p.page).toHaveTitle(/Blokus Team AI/);
  // A build made with Firebase settings (e.g. a developer's .env.local) offers online play instead.
  if (await p.page.locator('#online-setup').isVisible()) {
    await expect(p.page.locator('#online-setup')).toContainText('not set up');
    await expect(p.page.locator('#conn-text')).toHaveText('Online play not set up');
    await expect(p.page.locator('#btn-create')).toBeHidden();
  } else {
    await expect(p.page.locator('#btn-create')).toBeVisible();
  }
  await p.page.locator('#btn-practice').click();
  await expect(p.page.locator('#mode-banner')).toContainText('not online play');
  await waitTurn(p.page, 0);
  await playSuggested(p.page);
  // AI 1 moves, then the second human colour is played on the same device.
  await waitTurn(p.page, 2);
  await playSuggested(p.page);
  await waitTurn(p.page, 0);
  expect(await boardN(p.page)).toBe(4);
  expect(p.errors).toEqual([]);
  await p.context.close();
});

test('keyboard: choose a piece, move with the arrows, rotate and place', async ({ browser }) => {
  const p = await openPlayer(browser, { device: LAPTOP });
  await p.page.locator('#btn-practice').click();
  await waitTurn(p.page, 0);
  await p.page.locator('#board').focus();
  await p.page.keyboard.press(']'); // first piece: the monomino
  await expect(p.page.locator('.piece-btn[aria-pressed="true"]')).toHaveAttribute('data-piece', 'I1');
  await p.page.keyboard.press(']');
  await expect(p.page.locator('.piece-btn[aria-pressed="true"]')).toHaveAttribute('data-piece', 'I2');
  await p.page.keyboard.press('r');
  // The vertical domino is held by its top square: put the cursor on the corner (0,0).
  await p.page.keyboard.press('ArrowDown');
  await p.page.keyboard.press('ArrowUp');
  await p.page.keyboard.press('Enter');
  await expect.poll(() => boardN(p.page)).toBeGreaterThan(0);
  const first = await p.page.locator('#board .cell').nth(0).getAttribute('class');
  expect(first).toContain('p0');
  expect(p.errors).toEqual([]);
  await p.context.close();
});

test('the rules panel opens and explains the scoring', async ({ browser }) => {
  const p = await openPlayer(browser, { device: PHONE });
  await p.page.locator('#btn-help').click();
  await expect(p.page.locator('#dlg-help')).toBeVisible();
  await expect(p.page.locator('#dlg-help')).toContainText('+15 points if you place all 21 pieces');
  await expect(p.page.locator('#dlg-help')).toContainText('Human 1 → AI 1 → Human 2 → AI 2');
  await p.page.locator('#btn-help-close').click();
  await expect(p.page.locator('#dlg-help')).toBeHidden();
  await p.context.close();
});
