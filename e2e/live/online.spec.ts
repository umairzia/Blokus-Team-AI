/**
 * Opt-in check of real online play on the deployed site with its real
 * Firebase project: two fresh browsers create a NEW room, play one round and
 * close that room again. It never reads or changes any other room.
 *   LIVE_ONLINE=1 LIVE_URL=https://umairzia.github.io/Blokus-Team-AI/ npm run test:e2e:live
 */

import { expect, test } from '@playwright/test';
import { LAPTOP, PHONE, boardString, createRoom, joinByLink, openPlayer, playSuggested, waitTurn } from '../support/players';

test.skip(!process.env.LIVE_ONLINE, 'set LIVE_ONLINE=1 to run the online check against the live Firebase project');
// No retries: a retry would create another room.
test.describe.configure({ retries: 0 });

test('two browsers play one round online and then close their own test room', async ({ browser }) => {
  const A = await openPlayer(browser, { device: LAPTOP });
  const B = await openPlayer(browser, { device: PHONE });
  try {
    await expect(A.page.locator('#online-setup')).toBeHidden();
    const code = await createRoom(A, 'Smoke test A', 'easy');
    await joinByLink(B, code, 'Smoke test B');
    await A.page.locator('#btn-start').click();
    await waitTurn(A.page, 0);
    await playSuggested(A.page);
    await waitTurn(B.page, 2);
    await playSuggested(B.page);
    await waitTurn(A.page, 0);
    expect(await boardString(A.page)).toBe(await boardString(B.page));
    await A.page.locator('#btn-leave').click();
    await A.page.locator('#btn-confirm-yes').click();
    await expect(B.page.locator('#screen-home')).toBeVisible();
  } finally {
    await A.context.close();
    await B.context.close();
  }
});
