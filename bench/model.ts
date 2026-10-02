import fc from 'fast-check';
import { chromium, type Page } from 'playwright-core';
import { join } from 'node:path';

interface Snapshot {
  selectedId: string | null;
  checkedIds: string[];
  visibleIds: string[];
  smartFilter: string;
  isVisual: boolean;
}

interface Model {
  cursor: number;
  checked: Set<string>;
  anchor: number | null;
  filter: string;
}

const DIST = join(import.meta.dir, 'dist');
const RUNS = Number(process.env.MODEL_RUNS ?? 40);
const STEPS = Number(process.env.MODEL_STEPS ?? 30);

async function snapshot(page: Page): Promise<Snapshot> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
  return page.evaluate(() => (window as unknown as { __prReview: { snapshot(): Snapshot } }).__prReview.snapshot());
}

function invariant(condition: boolean, message: string): void {
  if (!condition) throw new Error(`invariant violated: ${message}`);
}

function checkCommon(real: Snapshot): void {
  if (real.visibleIds.length > 0) invariant(real.selectedId != null && real.visibleIds.includes(real.selectedId), 'selection is always a visible pull');
  invariant(new Set(real.checkedIds).size === real.checkedIds.length, 'checked ids are unique');
}

class Move implements fc.AsyncCommand<Model, Page> {
  constructor(readonly delta: 1 | -1) {}
  check(): boolean { return true; }
  async run(model: Model, page: Page): Promise<void> {
    const before = await snapshot(page);
    await page.keyboard.press(this.delta === 1 ? 'j' : 'k');
    const real = await snapshot(page);
    checkCommon(real);
    if (real.visibleIds.length === 0) {
      invariant(real.selectedId === before.selectedId, `${this.toString()} on an empty list changes nothing`);
      return;
    }
    const expected = Math.min(real.visibleIds.length - 1, Math.max(0, before.visibleIds.indexOf(before.selectedId ?? '') + this.delta));
    invariant(real.selectedId === real.visibleIds[expected], `${this.toString()} moves the cursor by one, clamped`);
    model.cursor = expected;
    if (model.anchor != null) {
      const [start, end] = model.anchor < expected ? [model.anchor, expected] : [expected, model.anchor];
      model.checked = new Set(real.visibleIds.slice(start, end + 1));
      invariant(JSON.stringify([...model.checked].sort()) === JSON.stringify(real.checkedIds), 'visual mode checks exactly the anchor..cursor range');
    }
  }
  toString(): string { return this.delta === 1 ? 'j' : 'k'; }
}

class ToggleCheck implements fc.AsyncCommand<Model, Page> {
  check(model: Model): boolean { return model.anchor == null; }
  async run(model: Model, page: Page): Promise<void> {
    const before = await snapshot(page);
    await page.keyboard.press('e');
    const real = await snapshot(page);
    checkCommon(real);
    const id = before.selectedId;
    if (id == null) return;
    const wasChecked = before.checkedIds.includes(id);
    invariant(real.checkedIds.includes(id) === !wasChecked, 'e toggles the current pull');
    invariant(real.checkedIds.length === before.checkedIds.length + (wasChecked ? -1 : 1), 'e changes nothing else');
    if (wasChecked) model.checked.delete(id);
    else model.checked.add(id);
  }
  toString(): string { return 'e'; }
}

class Visual implements fc.AsyncCommand<Model, Page> {
  check(): boolean { return true; }
  async run(model: Model, page: Page): Promise<void> {
    const before = await snapshot(page);
    await page.keyboard.press('Shift+V');
    const real = await snapshot(page);
    checkCommon(real);
    invariant(real.isVisual === !before.isVisual, '⇧V toggles visual mode');
    model.anchor = real.isVisual ? real.visibleIds.indexOf(real.selectedId ?? '') : null;
    if (real.isVisual) invariant(real.selectedId != null && real.checkedIds.includes(real.selectedId), 'entering visual mode checks the cursor');
  }
  toString(): string { return '⇧V'; }
}

class ClearChecks implements fc.AsyncCommand<Model, Page> {
  check(model: Model): boolean { return model.anchor == null; }
  async run(model: Model, page: Page): Promise<void> {
    await page.keyboard.press('Escape');
    const real = await snapshot(page);
    checkCommon(real);
    invariant(real.checkedIds.length === 0, 'esc clears the selection');
    model.checked.clear();
  }
  toString(): string { return 'esc'; }
}

class Filter implements fc.AsyncCommand<Model, Page> {
  constructor(readonly digit: 0 | 1 | 2 | 3 | 4) {}
  check(model: Model): boolean { return model.anchor == null; }
  async run(model: Model, page: Page): Promise<void> {
    const before = await snapshot(page);
    await page.keyboard.press(`Alt+${this.digit}`);
    const real = await snapshot(page);
    checkCommon(real);
    const all = await page.evaluate(() => (window as unknown as { __prReview: { snapshot(): Snapshot } }).__prReview.snapshot().visibleIds.length);
    invariant(all === real.visibleIds.length, 'snapshot is stable');
    if (this.digit === 0) invariant(real.smartFilter === 'all', '⌥0 shows all');
    else invariant(real.smartFilter === 'all' || real.smartFilter !== before.smartFilter || before.smartFilter === 'all', 'filter chips toggle');
    model.filter = real.smartFilter;
  }
  toString(): string { return `⌥${this.digit}`; }
}

const commands = [
  fc.constant(new Move(1)),
  fc.constant(new Move(-1)),
  fc.constant(new ToggleCheck()),
  fc.constant(new Visual()),
  fc.constant(new ClearChecks()),
  fc.constantFrom(0, 1, 2, 3, 4).map((digit) => new Filter(digit as 0 | 1 | 2 | 3 | 4)),
];

const { serve } = await import('./run');
if (!process.argv.includes('--no-build')) await Bun.$`./node_modules/.bin/vite build -c bench/vite.config.ts`.quiet();
const server = serve();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1480, height: 940 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await fc.assert(
    fc.asyncProperty(fc.commands(commands, { maxCommands: STEPS }), async (sequence) => {
      await page.goto(`${server.url}/?pulls=60`);
      await page.evaluate(() => { localStorage.clear(); localStorage.setItem('smartFilter', 'all'); });
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('#pr-list li[data-id]').length > 0);
      const initial = await snapshot(page);
      await fc.asyncModelRun(() => ({ model: { cursor: Math.max(0, initial.visibleIds.indexOf(initial.selectedId ?? '')), checked: new Set<string>(), anchor: null, filter: initial.smartFilter }, real: page }), sequence);
      if (errors.length > 0) throw new Error(`page errors: ${errors.join('; ')}`);
    }),
    { numRuns: RUNS, seed: process.env.MODEL_SEED == null ? undefined : Number(process.env.MODEL_SEED), verbose: 1 },
  );
  console.log(`MODEL OK ${RUNS} runs × ≤${STEPS} steps`);
} finally {
  await browser.close();
  server.stop();
}
