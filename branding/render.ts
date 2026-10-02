// Renders branding/icon.svg to branding/icon-1024.png (transparent outside the squircle).
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const svgPath = process.argv[2] ?? new URL('./icon.svg', import.meta.url).pathname;
const out = process.argv[3] ?? new URL('./icon-1024.png', import.meta.url).pathname;
const svg = readFileSync(svgPath, 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await page.locator('svg').screenshot({ path: out, omitBackground: true });
await browser.close();
console.log(out);
