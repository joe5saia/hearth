// Browser performance of the built React app against a local Worker (`npx task dev`, or the
// orb's `hearth` service on port 8787), measured in headless Chromium at a 1280×800 desktop
// viewport. Each round uses a fresh browser context, so the HTTP cache starts empty.
//
// Per round:
// - load: navigation start until the meal plan is drawn (two animation frames after it renders);
// - transfer: bytes over the network while loading the plan, then visiting and scrolling Recipes,
//   in total and for images alone;
// - heap: JS heap after loading the plan, after garbage collection;
// - recipes / groceries: a hash navigation until the page's list is drawn;
// - scroll: animation-frame intervals while wheel input scrolls the recipe list 3,000 px.
//
// Usage: npx task benchmark:browser -- [--url http://localhost:8787] [--rounds 5] [--cpu 4] [--out report.json]
// `--cpu 4` slows Chromium's CPU fourfold, closer to a phone. Compare runs on the same idle
// machine and household; timings are relative, not thresholds.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
// @ts-ignore Browser declarations exist only after task ui:setup, outside the checkout.
import type { Page } from "/tmp/hearth-ui/node_modules/playwright/index.d.ts";

// Playwright is deliberately supplied by the UI-smoke runner, not by this project.
// @ts-expect-error The parent task installs this exact external runtime.
const { chromium }: typeof import("/tmp/hearth-ui/node_modules/playwright/index.d.ts") = await import("/tmp/hearth-ui/node_modules/playwright/index.mjs");

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8787" },
    rounds: { type: "string", default: "5" },
    cpu: { type: "string", default: "1" },
    out: { type: "string" },
  },
});
const base = new URL(values.url);
assert(["localhost", "127.0.0.1"].includes(base.hostname), "The browser benchmark refuses non-local URLs");
const rounds = Number(values.rounds);
const cpu = Number(values.cpu);
assert(Number.isInteger(rounds) && rounds > 0, "--rounds must be a positive integer");
assert(cpu >= 1, "--cpu must be at least 1");

type Sample = {
  load: number;
  transfer: number;
  images: number;
  heap: number;
  recipes: number;
  groceries: number;
  frameP50: number;
  frameP95: number;
};

/** Resolves after two animation frames: the frame that paints the current DOM has run. */
const twoFrames = "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))";
const planReady = "document.querySelector('.plan-week') !== null";

/** Milliseconds from setting `hash` until `ready` holds and the next frame has painted. */
function hashNavigation(page: Page, hash: string, ready: string): Promise<number> {
  return page.evaluate(`(async () => {
    const started = performance.now();
    location.hash = ${JSON.stringify(hash)};
    while (!(${ready})) await new Promise((resolve) => setTimeout(resolve, 0));
    await ${twoFrames};
    return performance.now() - started;
  })()`);
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
}

async function measure(): Promise<Sample> {
  const browser = await chromium.launch();

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Performance.enable");
    if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });

    const types = new Map<string, string>();
    let transfer = 0;
    let images = 0;
    cdp.on("Network.responseReceived", (event: { requestId: string; type: string }) => types.set(event.requestId, event.type));
    cdp.on("Network.loadingFinished", (event: { requestId: string; encodedDataLength: number }) => {
      transfer += event.encodedDataLength;
      if (types.get(event.requestId) === "Image") images += event.encodedDataLength;
    });

    await page.goto(new URL("/#plan", base).href);
    await page.waitForFunction(planReady, undefined, { timeout: 60_000 });
    const load = await page.evaluate<number>(`${twoFrames}.then(() => performance.now())`);
    await page.waitForLoadState("networkidle");
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] };
    const heap = metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? Number.NaN;

    const recipes = await hashNavigation(page, "#recipes", "document.querySelector('.recipe-row')");
    await page.waitForTimeout(500);

    // Record frame intervals in the page while wheel input scrolls the recipe list.
    await page.evaluate(`(() => {
      window.benchmarkFrames = [];
      let last = performance.now();
      const tick = (now) => {
        window.benchmarkFrames.push(now - last);
        last = now;
        if (window.benchmarkFrames.length < 600) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })()`);
    await page.mouse.move(730, 400);
    for (let step = 0; step < 30; step++) {
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(300);
    const frames = (await page.evaluate<number[]>("window.benchmarkFrames")).slice(1);
    await page.waitForLoadState("networkidle");
    const sample = { load, transfer, images, heap, recipes, frameP50: quantile(frames, 0.5), frameP95: quantile(frames, 0.95) };

    const groceries = await hashNavigation(page, "#groceries", "document.querySelector('.grocery-item')");

    return { ...sample, groceries };
  } finally {
    await browser.close();
  }
}

const samples: Sample[] = [];

// One warm-up round so the Worker and its local D1 are warm for every timed round.
await measure();
for (let round = 1; round <= rounds; round++) {
  samples.push(await measure());
  console.log(`round ${round}/${rounds} done`);
}

const rows: [string, (sample: Sample) => number, number][] = [
  ["Load to plan drawn (ms)", (s) => s.load, 0],
  ["Transfer: plan, Recipes, scroll (KB)", (s) => s.transfer / 1024, 0],
  ["  of which images (KB)", (s) => s.images / 1024, 0],
  ["JS heap after load (MB)", (s) => s.heap / 2 ** 20, 1],
  ["Plan → Recipes drawn (ms)", (s) => s.recipes, 0],
  ["Recipes → Groceries drawn (ms)", (s) => s.groceries, 0],
  ["Scroll frame p50 (ms)", (s) => s.frameP50, 1],
  ["Scroll frame p95 (ms)", (s) => s.frameP95, 1],
];
const report = rows.map(([metric, pick, digits]) => ({ metric, median: quantile(samples.map(pick), 0.5).toFixed(digits) }));
console.log(`\nMedians of ${rounds} rounds at 1280×800, headless Chromium, CPU ×${cpu}, ${base.origin}:`);
console.table(report);
if (values.out) await writeFile(values.out, `${JSON.stringify({ url: base.origin, rounds, cpu, report, samples }, null, 2)}\n`);
