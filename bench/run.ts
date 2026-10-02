import { chromium, type CDPSession, type Page } from 'playwright-core';
import { join } from 'node:path';

interface Metrics {
  layouts: number;
  styleRecalcs: number;
  scriptMs: number;
  layoutMs: number;
  taskMs: number;
  heapMb: number;
  nodes: number;
}

interface ScenarioResult {
  name: string;
  wallMs: number;
  p95KeyMs: number;
  longTasks: number;
  layouts: number;
  styleRecalcs: number;
  scriptMs: number;
  taskMs: number;
  maxRenderedRows: number;
}

const DIST = join(import.meta.dir, 'dist');
const BASE_DIST = join(import.meta.dir, 'dist-base');
const args = new Set(process.argv.slice(2));

const PULLS = Number(process.env.BENCH_PULLS ?? 400);
const RUNS = Number(process.env.BENCH_RUNS ?? 5);
const CPU_THROTTLE = Number(process.env.BENCH_CPU ?? 4);
const WEIGHTS = { layouts: 0.3, styleRecalcs: 0.25, maxRenderedRows: 0.1, longTasks: 0.1, taskMs: 0.15, p95KeyMs: 0.1 } as const;

function chromePath(): string | undefined {
  return process.env.BENCH_CHROME;
}

export function serve(dist = DIST): { url: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const file = Bun.file(join(dist, path === '/' ? 'index.html' : path));
      return file.exists().then((isFound) => (isFound ? new Response(file) : new Response(null, { status: 404 })));
    },
  });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

async function metrics(cdp: CDPSession): Promise<Metrics> {
  const { metrics: list } = (await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] };
  const value = (name: string): number => list.find((metric) => metric.name === name)?.value ?? 0;
  return { layouts: value('LayoutCount'), styleRecalcs: value('RecalcStyleCount'), scriptMs: value('ScriptDuration') * 1_000, layoutMs: value('LayoutDuration') * 1_000, taskMs: value('TaskDuration') * 1_000, heapMb: value('JSHeapUsedSize') / 1_048_576, nodes: value('Nodes') };
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
}

async function keyLatencies(page: Page, keys: string[]): Promise<number[]> {
  const latencies: number[] = [];
  for (const key of keys) {
    const started = await page.evaluate(() => performance.now());
    await page.keyboard.press(key);
    const painted = await page.evaluate(() => new Promise<number>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())))));
    latencies.push(painted - started);
  }
  return latencies;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

type Scenario = { name: string; run(page: Page): Promise<number[]> };

const SCENARIOS: Scenario[] = [
  { name: 'navigate-list', run: (page) => keyLatencies(page, Array.from({ length: 60 }, () => 'j')) },
  { name: 'filter-chips', run: (page) => keyLatencies(page, ['Alt+1', 'Alt+2', 'Alt+3', 'Alt+4', 'Alt+0', 'Alt+1', 'Alt+0']) },
  { name: 'visual-select', run: (page) => keyLatencies(page, ['Shift+V', ...Array.from({ length: 30 }, () => 'j'), 'Shift+V', 'Escape']) },
  {
    name: 'type-filter',
    run: async (page) => {
      await page.keyboard.press('f');
      const latencies = await keyLatencies(page, [...'refactor'].map((character) => character));
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        const input = document.getElementById('filter') as HTMLInputElement;
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      return latencies;
    },
  },
  {
    name: 'theme-preview',
    run: async (page) => {
      await page.keyboard.press('t');
      const latencies = await keyLatencies(page, Array.from({ length: 12 }, () => 'ArrowDown'));
      await page.keyboard.press('Escape');
      return latencies;
    },
  },
  { name: 'scroll-diff', run: (page) => keyLatencies(page, Array.from({ length: 20 }, () => 'Meta+j')) },
];

async function runOnce(url: string): Promise<ScenarioResult[]> {
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage({ viewport: { width: 1480, height: 940 }, deviceScaleFactor: 1, reducedMotion: process.env.BENCH_MOTION === '1' ? 'no-preference' : 'reduce' });
  page.on('pageerror', (error) => console.error('pageerror', error.message));
  await page.addInitScript(() => {
    localStorage.setItem('smartFilter', 'all');
    localStorage.setItem('themeId', 'dark');
    Object.assign(window, { __longTasks: 0 });
    new PerformanceObserver((list) => Object.assign(window, { __longTasks: (window as unknown as { __longTasks: number }).__longTasks + list.getEntries().length })).observe({ type: 'longtask', buffered: true });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.goto(`${url}/?pulls=${PULLS}`);
  await page.waitForFunction(() => document.querySelectorAll('#pr-list li[data-id]').length > 0, undefined, { timeout: 20_000 });
  await settle(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  const results: ScenarioResult[] = [];
  for (const scenario of SCENARIOS) {
    const before = await metrics(cdp);
    const longBefore = await page.evaluate(() => (window as unknown as { __longTasks: number }).__longTasks);
    let maxRenderedRows = 0;
    const started = Date.now();
    const latencies = await scenario.run(page);
    await settle(page);
    maxRenderedRows = await page.evaluate(() => document.querySelectorAll('#pr-list li[data-id]').length);
    const after = await metrics(cdp);
    const longAfter = await page.evaluate(() => (window as unknown as { __longTasks: number }).__longTasks);
    results.push({
      name: scenario.name,
      wallMs: Date.now() - started,
      p95KeyMs: percentile(latencies, 0.95),
      longTasks: longAfter - longBefore,
      layouts: after.layouts - before.layouts,
      styleRecalcs: after.styleRecalcs - before.styleRecalcs,
      scriptMs: after.scriptMs - before.scriptMs,
      taskMs: after.taskMs - before.taskMs,
      maxRenderedRows,
    });
  }
  await browser.close();
  return results;
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function combine(runs: ScenarioResult[][]): ScenarioResult[] {
  return runs[0]!.map((first, index) => {
    const pick = (key: keyof Omit<ScenarioResult, 'name'>): number => median(runs.map((run) => run[index]![key]));
    return { name: first.name, wallMs: pick('wallMs'), p95KeyMs: pick('p95KeyMs'), longTasks: pick('longTasks'), layouts: pick('layouts'), styleRecalcs: pick('styleRecalcs'), scriptMs: pick('scriptMs'), taskMs: pick('taskMs'), maxRenderedRows: pick('maxRenderedRows') };
  });
}

function score(scenarios: ScenarioResult[], baseline: ScenarioResult[]): number {
  const ratios = scenarios.flatMap((scenario) => {
    const base = baseline.find((candidate) => candidate.name === scenario.name);
    if (base == null) return [];
    return (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).map((key) => WEIGHTS[key] * Math.log((base[key] + 1) / (scenario[key] + 1)));
  });
  const total = ratios.reduce((sum, value) => sum + value, 0) / Math.max(1, scenarios.length);
  return Number(Math.exp(total).toFixed(4));
}

async function buildRef(ref: string): Promise<void> {
  const source = join(import.meta.dir, '.base-src');
  await Bun.$`rm -rf ${source} ${BASE_DIST} && mkdir -p ${source}`.quiet();
  await Bun.$`git archive ${ref} index.html src public | tar -x -C ${source}`.quiet();
  await Bun.$`ln -s ${join(import.meta.dir, '..', 'node_modules')} ${join(source, 'node_modules')}`.quiet();
  await Bun.$`./node_modules/.bin/vite build -c bench/vite.config.ts`.env({ ...process.env, BENCH_ROOT: source, BENCH_OUT: BASE_DIST }).quiet();
}

function table(scenarios: ScenarioResult[]): void {
  console.table(scenarios.map((scenario) => ({ ...scenario, scriptMs: Math.round(scenario.scriptMs), taskMs: Math.round(scenario.taskMs), p95KeyMs: Number(scenario.p95KeyMs.toFixed(1)) })));
}

async function main(): Promise<void> {
  const ref = process.argv.find((arg, index) => process.argv[index - 1] === '--against') ?? 'HEAD';
  const isSelfTest = args.has('--self-test');
  const commit = (await Bun.$`git rev-parse --short ${ref}`.quiet().text()).trim();
  if (!args.has('--no-build')) await Bun.$`./node_modules/.bin/vite build -c bench/vite.config.ts`.quiet();
  if (!isSelfTest) await buildRef(ref);
  const candidateServer = serve(DIST);
  const baseServer = serve(isSelfTest ? DIST : BASE_DIST);
  try {
    const candidateRuns: ScenarioResult[][] = [];
    const baseRuns: ScenarioResult[][] = [];
    for (let run = 0; run < RUNS; run += 1) {
      baseRuns.push(await runOnce(baseServer.url));
      candidateRuns.push(await runOnce(candidateServer.url));
    }
    const scenarios = combine(candidateRuns);
    const baseline = combine(baseRuns);
    const report = { against: isSelfTest ? 'self' : commit, pulls: PULLS, cpuThrottle: CPU_THROTTLE, runs: RUNS, baseline, scenarios, score: score(scenarios, baseline) };
    if (args.has('--json')) console.log(JSON.stringify(report));
    else {
      console.log(`working tree vs ${report.against} · ${RUNS} interleaved runs · ${PULLS} PRs · ${CPU_THROTTLE}× CPU throttle`);
      table(scenarios);
    }
    console.log(`SCORE ${report.score}`);
  } finally {
    candidateServer.stop();
    baseServer.stop();
  }
}

if (import.meta.main) await main();
