/** Helpers that drive the real page like a person would. */

import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
export const LAPTOP = { viewport: { width: 1366, height: 800 } };

export interface Player {
  context: BrowserContext;
  page: Page;
  errors: string[];
}

export async function openPlayer(
  browser: Browser,
  opts: { device?: typeof PHONE | typeof LAPTOP; setup?: (ctx: BrowserContext) => Promise<void>; path?: string } = {},
): Promise<Player> {
  const context = await browser.newContext({ ...(opts.device ?? LAPTOP), serviceWorkers: 'block' });
  await context.addInitScript(() => {
    (window as unknown as { __BLOKUS_TEST__: object }).__BLOKUS_TEST__ = { aiDelayMs: 60 };
  });
  if (opts.setup) await opts.setup(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(opts.path ?? '');
  return { context, page, errors };
}

export async function boardN(page: Page): Promise<number> {
  return Number(await page.locator('#board').getAttribute('data-n'));
}

/** Waits until it is this seat's turn on this page. */
export async function waitTurn(page: Page, seat: number, timeout = 30_000): Promise<void> {
  await expect(page.locator('#board')).toHaveAttribute('data-turn', String(seat), { timeout });
  await expect(page.locator('#status')).toHaveClass(/mine/, { timeout });
}

/** Plays the suggested move through the UI (Suggest, then Place). */
export async function playSuggested(page: Page): Promise<void> {
  const before = await boardN(page);
  await page.locator('#btn-suggest').click();
  await expect(page.locator('#btn-place')).toBeEnabled();
  await page.locator('#btn-place').click();
  await expect.poll(() => boardN(page), { timeout: 20_000 }).toBeGreaterThan(before);
}

/** Board ownership string read from the cells' classes ('.' or seat digit). */
export async function boardString(page: Page): Promise<string> {
  return page.$$eval('#board .cell', (cells) =>
    cells.map((c) => (/(?:^| )p([0-3])(?: |$)/.exec(c.className)?.[1] ?? '.')).join(''),
  );
}

export async function createRoom(p: Player, name: string, level = 'easy'): Promise<string> {
  await p.page.locator('#name').fill(name);
  await p.page.locator('#level').selectOption(level);
  await p.page.locator('#btn-create').click();
  await expect(p.page.locator('#screen-lobby')).toBeVisible();
  const code = (await p.page.locator('#lobby-code').textContent())!.trim();
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  return code;
}

export async function joinByLink(p: Player, code: string, name: string): Promise<void> {
  await p.page.goto(`#${code}`);
  await expect(p.page.locator('#join-code')).toHaveValue(code);
  await p.page.locator('#name').fill(name);
  await p.page.locator('#btn-join').click();
  await expect(p.page.locator('#screen-lobby')).toBeVisible();
}
