/**
 * Smoke test of the deployed site. Read-only towards Firebase: it loads the
 * page, checks that every asset resolves under the repository path without
 * console errors, and plays a few moves of offline practice.
 *   LIVE_URL=https://umairzia.github.io/Blokus-Team-AI/ npm run test:e2e:live
 * With EXPECT_ONLINE=1 it also requires online play to be configured.
 */

import { expect, test } from '@playwright/test';

test('the published site loads, its assets resolve and a practice game runs', async ({ page, baseURL }) => {
  const errors: string[] = [];
  const failed: string[] = [];
  const assets: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('response', (r) => {
    const url = r.url();
    if (url.startsWith(new URL(baseURL!).origin)) {
      assets.push(url);
      if (r.status() >= 400) failed.push(`${r.status()} ${url}`);
    }
  });
  await page.addInitScript(() => {
    (window as unknown as { __BLOKUS_TEST__: object }).__BLOKUS_TEST__ = { aiDelayMs: 50 };
  });
  const res = await page.goto('');
  expect(res?.status()).toBe(200);
  await expect(page).toHaveTitle(/Blokus Team AI/);
  await expect(page.locator('#screen-home')).toBeVisible();
  // EXPECT_ONLINE=1 (set by CI when the Firebase variables exist): the build
  // must have picked up a valid config and offer online rooms, not the setup notice.
  if (process.env.EXPECT_ONLINE === '1') {
    await expect(page.locator('#btn-create')).toBeVisible();
    await expect(page.locator('#online-setup')).toBeHidden();
  }
  const path = new URL(baseURL!).pathname;
  expect(assets.some((u) => new URL(u).pathname.startsWith(`${path}assets/index-`))).toBe(true);
  for (const u of assets) expect(new URL(u).pathname.startsWith(path)).toBe(true);

  await page.locator('#btn-practice').click();
  await expect(page.locator('#board')).toHaveAttribute('data-turn', '0');
  await page.locator('#btn-suggest').click();
  await page.locator('#btn-place').click();
  await expect(page.locator('#board')).toHaveAttribute('data-turn', '2'); // AI 1 moved by itself
  expect(failed).toEqual([]);
  expect(errors).toEqual([]);
});
