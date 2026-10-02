import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const OUT = option('out', join(import.meta.dir, '..', 'docs', 'screenshot.png'));
const THEME = option('theme', 'dark');
const WIDTH = Number(option('width', '1480'));
const HEIGHT = Number(option('height', '900'));
const SCALE = Number(option('scale', '2'));

const { serve } = await import('./run');
await Bun.$`./node_modules/.bin/vite build -c bench/vite.config.ts --logLevel warn`;
const server = serve();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: SCALE, reducedMotion: 'reduce', colorScheme: THEME === 'light' ? 'light' : 'dark' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((themeId) => {
    localStorage.clear();
    localStorage.setItem('themeId', themeId);
    localStorage.setItem('smartFilter', 'all');
    localStorage.setItem('showBotComments', '1');
  }, THEME);
  await page.goto(`${server.url}/?demo`);
  await page.waitForFunction(() => document.querySelectorAll('#pr-list li[data-id]').length > 0);
  await page.keyboard.press('1');
  await page.evaluate((title) => {
    const row = [...document.querySelectorAll<HTMLElement>('#pr-list li[data-id]')].find((element) => element.textContent?.includes(title.slice(0, 40)));
    row?.click();
  }, 'perf(search): debounce semantic search and cancel stale requests');
  await page.waitForFunction(() => document.querySelector('#desc-pane .conversation .comment') != null && document.querySelector('#diff-root [data-line], #diff-root diffs-container') != null, undefined, { timeout: 15_000 });
  await page.evaluate(() => document.getElementById('toast')?.classList.remove('show'));
  await page.evaluate(() => document.querySelectorAll('img').forEach((image) => image.complete || image.remove()));
  await page.waitForTimeout(600);
  if (errors.length > 0) throw new Error(`page errors: ${errors.join('; ')}`);
  mkdirSync(join(OUT, '..'), { recursive: true });
  await page.screenshot({ path: OUT });
  console.log(`saved ${OUT} (${WIDTH}×${HEIGHT} @${SCALE}x, theme ${THEME})`);
} finally {
  await browser.close();
  server.stop();
}
