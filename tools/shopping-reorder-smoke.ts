import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { CheckSchema, HouseholdSchema, ShoppingOrderSchema } from "../src/domain.ts";

// Owned by the injected callbacks below, not asserted onto arbitrary application state.
interface SmokeWindow extends Window {
  smokeGroup: HTMLElement;
  smokeRow: Element;
  keyboardRow: Element;
  smokeFetch: typeof fetch;
  saveDelay: number;
  rejectSave: boolean;
  rejectNextSave?: boolean;
  rejectRefresh?: boolean;
  holdNextRefresh?: boolean;
  failNextRefresh?: boolean;
  heldRefreshReady?: boolean;
  releaseRefresh?: () => void;
  smokeSaves: Set<Promise<Response>>;
  writeHistory: { path: string; body: unknown }[];
  stopping: boolean;
  dragUp?: boolean;
  pointerType: string;
  dropTop: number;
  motionFrames: { elapsed: number; top: number; scroll: number }[];
  rollbackFrames: number[][];
  checkFrames: boolean[];
  originalAnimate: typeof Element.prototype.animate;
}
const RuntimeResultSchema = Schema.Struct({
  result: Schema.Struct({ value: Schema.optional(Schema.Unknown) }),
  exceptionDetails: Schema.optional(Schema.Unknown),
});

// Uses existing sample meals/products and restores their order; never writes a remote household.
const url = process.argv.slice(2).find(argument => !argument.startsWith("--")) ?? "http://localhost:5173";
assert(["localhost", "127.0.0.1"].includes(new URL(url).hostname), "Use local development only.");
const session = `shopping-${process.pid}`;
const browser = (...args: string[]) => execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8", timeout: 90_000 }).trim();
const toggleRoute = () => {
  if (browser("eval", "!!document.querySelector('[aria-label=\"Exit List Builder\"]')") === "true") browser("click", '[aria-label="Exit List Builder"]');
  browser("click", '[aria-label="Page options"]');
  browser("click", '.page-options-menu button[aria-pressed]');
  if (browser("eval", "!document.querySelector('.route-editor')") === "true") browser("click", '[aria-label="List Builder"]');
};
const household = async () => {
  const response = await fetch(`${url}/api/household`);
  assert(response.ok);
  const data = Schema.decodeUnknownSync(HouseholdSchema, { onExcessProperty: "error" })(await response.json());
  return { ...data, checks: [...data.checks].sort((a, b) => a.key.localeCompare(b.key)) };
};
const withoutRevision = <T extends { readonly revision?: string }>({ revision: _revision, ...value }: T) => value;
const original = await household();
if (process.argv.includes("--cleanup-check")) {
  const failure = spawnSync("npx", ["task", "shopping:smoke", "--", url, "--fail-during-save"], { encoding: "utf8", timeout: 90_000 });
  assert.notEqual(failure.status, 0);
  assert(failure.stderr.includes("Intentional cleanup regression"), failure.stderr);
  await new Promise(resolve => setTimeout(resolve, 1500));
  const restored = await household();
  assert.deepEqual({ ...restored, shoppingOrder: withoutRevision(restored.shoppingOrder) }, { ...original, shoppingOrder: withoutRevision(original.shoppingOrder) }, "Cleanup must still be correct after the delayed save would have completed.");
  console.log("PASS intentional failure during a pending save drains/stops writes and restores the exact household durably");
  process.exit(0);
}
let socket: WebSocket | undefined;
let recording = false;
let baselineChecks = original.checks;

try {
  const aisle = original.groceries.find((item) => original.groceries.filter((other) => other.aisle === item.aisle).length >= 3)?.aisle;
  const fixtures = original.groceries.filter((item) => item.aisle === aisle).slice(0, 2);
  assert.equal(fixtures.length, 2, "Load sample groceries with three products in an aisle.");
  for (const item of fixtures) {
    const response = await fetch(`${url}/api/checks`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: JSON.stringify(["shopping-list", item.id]), checked: 1 }) });
    assert(response.ok, "Prepare off-list smoke products.");
  }
  baselineChecks = (await household()).checks;
  await mkdir(".amp/in/artifacts", { recursive: true });
  browser("open", `${url}/#shopping`);
  browser("set", "viewport", "393", "844", "2");
  browser("wait", ".shopping-summary");
  browser("click", '[aria-label="List Builder"]');
  browser("wait", ".purchase-row");
  browser("eval", "document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
  const connection = new WebSocket(browser("get", "cdp-url"));
  socket = connection;
  await new Promise<void>((resolve, reject) => { connection.addEventListener("open", () => resolve(), { once: true }); connection.addEventListener("error", reject, { once: true }); });
  let sequence = 0;
  let sessionId: string | undefined;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  connection.addEventListener("message", event => {
    const message = Schema.decodeUnknownSync(Schema.Struct({
      id: Schema.optional(Schema.Number),
      error: Schema.optional(Schema.Struct({ message: Schema.String })),
      result: Schema.optional(Schema.Unknown),
    }))(JSON.parse(String(event.data)));
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const cdp = (method: string, params: object = {}) => new Promise<unknown>((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); connection.send(JSON.stringify({ id, method, params, sessionId })); });
  const evaluateExpression = async (expression: string) => {
    const result = Schema.decodeUnknownSync(RuntimeResultSchema)(await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }));
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const evaluate = (fn: (state: SmokeWindow) => unknown) => evaluateExpression(`(${fn.toString()})(window)`);
  const selectGroup = (selector: string) => evaluateExpression(`(() => {
    const group = document.querySelector(${JSON.stringify(selector)});
    if (!(group instanceof HTMLElement)) throw new Error('Expected shopping group');
    window.smokeGroup = group;
  })()`);
  const { targetInfos } = Schema.decodeUnknownSync(Schema.Struct({ targetInfos: Schema.Array(Schema.Struct({ type: Schema.String, url: Schema.String, targetId: Schema.String })) }))(await cdp("Target.getTargets"));
  const target = targetInfos.find((entry) => entry.type === "page" && entry.url.startsWith(url));
  assert(target);
  sessionId = Schema.decodeUnknownSync(Schema.Struct({ sessionId: Schema.String }))(await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  await evaluate((w) => {
    const group = [...document.querySelectorAll(".purchase-group")].find(group => group.querySelectorAll(".route-drag:not(:disabled)").length >= 3);
    if (!(group instanceof HTMLElement)) throw new Error("Load sample meals with at least three linked products in one aisle.");
    w.smokeGroup = group;
    w.smokeFetch = window.fetch;
    w.saveDelay = 900;
    w.rejectSave = false;
    w.smokeSaves = new Set();
    w.writeHistory = [];
    w.stopping = false;
    window.fetch = (...args) => {
      const save = /shopping-order|checks/.test(String(args[0])) && args[1]?.method === "PUT";
      const hold = String(args[0]).includes("household") && w.holdNextRefresh;
      if (hold) w.holdNextRefresh = false;
      const operation = (async () => {
        if (save) {
          const body = args[1]?.body;
          if (typeof body !== "string") throw new Error("Expected a JSON shopping save body");
          // Capture without inspecting; the host decodes each payload with the owning domain schema.
          w.writeHistory.push({ path: String(args[0]), body: JSON.parse(body) });
          await new Promise(resolve => setTimeout(resolve, w.saveDelay));
          if (w.stopping) throw new Error("Browser smoke: cleanup canceled pending save");
          if (w.rejectSave || w.rejectNextSave) {
            w.rejectNextSave = false;
            throw new Error("Browser smoke: simulated offline save");
          }
        }
        if (String(args[0]).includes("household") && w.failNextRefresh) {
          w.failNextRefresh = false;
          throw new Error("Browser smoke: simulated refresh failure");
        }
        const response = await w.smokeFetch(...args);
        if (hold) await new Promise<void>(resolve => { w.releaseRefresh = resolve; w.heldRefreshReady = true; });
        if (save && response.ok && w.rejectRefresh) w.failNextRefresh = true;
        return response;
      })();
      if (save) {
        w.smokeSaves.add(operation);
        operation.then(() => w.smokeSaves.delete(operation), () => w.smokeSaves.delete(operation));
      }
      return operation;
    };
  });
  const names = async () => Schema.decodeUnknownSync(Schema.Array(Schema.String))(await evaluate((w) => [...w.smokeGroup.querySelectorAll(".item-info strong, .route-product > span")].map((el) => el.childNodes[0]?.textContent)));
  const before = await names();
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const drag = async (touch: boolean, cancel = false, gesture: "hold" | "swipe" | "tap" | "drift" = "hold") => {
    const point = Schema.decodeUnknownSync(Schema.Struct({ x: Schema.Number, y: Schema.Number, end: Schema.Number }))(await evaluate(async (w) => {
      w.smokeGroup.scrollIntoView({ block: "center" });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rows = [...w.smokeGroup.querySelectorAll("[data-reorder-row]")];
      const sourceRow = w.dragUp ? rows.at(-1) : rows[0];
      const destinationRow = w.dragUp ? rows[0] : rows.at(-1);
      if (!sourceRow || !destinationRow) throw new Error("Expected reorder rows");
      w.smokeRow = sourceRow;
      const grip = sourceRow.querySelector(".route-drag");
      if (!(grip instanceof HTMLButtonElement)) throw new Error("Expected reorder grip");
      const source = grip.getBoundingClientRect();
      const destination = destinationRow.getBoundingClientRect();
      w.pointerType = "";
      document.addEventListener("pointerdown", event => { w.pointerType = event.pointerType; }, { once: true });
      return { x: source.left + source.width / 2, y: source.top + source.height / 2, end: destination.top + destination.height / 2 + (w.dragUp ? -5 : 5) };
    }));
    await pause(100);
    await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdp("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: 1 });
    const hit = Schema.decodeUnknownSync(RuntimeResultSchema)(await cdp("Runtime.evaluate", { expression: `document.elementFromPoint(${point.x}, ${point.y})?.closest('.route-drag') === window.smokeRow.querySelector('.route-drag')`, returnByValue: true }));
    assert.equal(hit.result.value, true, "Drag must start on the actual grip after layout settles.");
    const input = (phase: "start" | "move" | "end" | "cancel", y: number) => touch
      ? cdp("Input.dispatchTouchEvent", { type: { start: "touchStart", move: "touchMove", end: "touchEnd", cancel: "touchCancel" }[phase], touchPoints: phase === "end" || phase === "cancel" ? [] : [{ x: point.x, y }] })
      : cdp("Input.dispatchMouseEvent", { type: { start: "mousePressed", move: "mouseMoved", end: "mouseReleased", cancel: "mouseReleased" }[phase], x: point.x, y, button: "left", buttons: phase === "end" ? 0 : 1, clickCount: 1 });
    const scrollBefore = Schema.decodeUnknownSync(Schema.Number)(await evaluate(() => scrollY));
    const swipeOffset = scrollBefore > 20 ? 90 : -90;
    await input("start", point.y);
    if (touch) {
      assert.equal(await evaluate(() => !!document.querySelector(".is-dragging")), false, "Touch contact must not immediately start dragging.");
      if (gesture === "tap") {
        await pause(60);
        await input("end", point.y);
      } else if (gesture === "swipe") {
        for (let step = 1; step <= 6; step++) {
          await input("move", point.y + swipeOffset * step / 6);
          await pause(16);
        }
      } else if (gesture === "drift") {
        await input("move", point.y - 10);
      } else {
        // A little finger jitter is tolerated, but the first 100ms must still be scrollable.
        await input("move", point.y - 3);
        await pause(100);
        assert.equal(await evaluate(() => !!document.querySelector(".is-dragging")), false);
      }
      await pause(300);
      if (gesture !== "hold") {
        assert.equal(await evaluate(() => !!document.querySelector(".is-dragging")), false, "Released or moving touches must cancel the hold timer.");
        if (gesture !== "tap") await input("end", point.y + (gesture === "swipe" ? swipeOffset : -10));
        await pause(400);
        if (gesture === "swipe") assert(Math.abs(Schema.decodeUnknownSync(Schema.Number)(await evaluate(() => scrollY)) - scrollBefore) > 20, "Swiping from the handle must actually scroll the page.");
        return;
      }
      assert.equal(await evaluate(() => !!document.querySelector(".is-dragging")), true, "A held touch must activate dragging.");
    }
    for (let step = 1; step <= 20; step++) {
      await input("move", point.y + (point.end - point.y) * step / 20);
      await pause(16);
    }
    await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await evaluate((w) => w.pointerType), touch ? "touch" : "mouse");
    assert.equal(await evaluate(() => !!document.querySelector(".drop-target")), true);
    assert.equal(await evaluate(() => getSelection()?.toString()), "");
    assert.equal(await evaluate(() => scrollY), scrollBefore, "An activated drag must not scroll the page.");
    await evaluate((w) => {
      w.dropTop = w.smokeRow.getBoundingClientRect().top;
      w.motionFrames = [];
      const start = performance.now();
      const sample = () => {
        w.motionFrames.push({ elapsed: performance.now() - start, top: w.smokeRow.getBoundingClientRect().top, scroll: scrollY });
        if (performance.now() - start < 1400) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await input(cancel ? "cancel" : "end", point.end);
  };
  for (const gesture of ["tap", "drift", "swipe"] as const) {
    await drag(true, false, gesture);
    assert.deepEqual(await names(), before);
    assert.deepEqual((await household()).shoppingOrder, original.shoppingOrder);
    assert.equal(await evaluate((w) => w.writeHistory.length), 0, "Scrolling and short touches must not issue order writes.");
  }
  console.log("PASS native handle swipe scrolls; short tap and pre-hold movement cancel activation without saving");
  await drag(false);
  if (process.argv.includes("--fail-during-save")) throw new Error("Intentional cleanup regression: delayed save is pending");
  await pause(100);
  assert.deepEqual(await names(), [...before.slice(1), before[0]], "Order must update before the delayed save.");
  assert.deepEqual((await household()).shoppingOrder, original.shoppingOrder, "The real Worker save is still pending.");
  await pause(1450);
  const motion = Schema.decodeUnknownSync(Schema.Struct({ dropTop: Schema.Number, frames: Schema.Array(Schema.Struct({ elapsed: Schema.Number, top: Schema.Number, scroll: Schema.Number })) }))(await evaluate((w) => {
    return { dropTop: w.dropTop, frames: w.motionFrames };
  }));
  const finalFrame = motion.frames.at(-1);
  assert(finalFrame, "Motion sampling must produce frames");
  const finalTop = finalFrame.top;
  assert(motion.frames.every((frame) => frame.top >= Math.min(motion.dropTop, finalTop) - 2 && frame.top <= Math.max(motion.dropTop, finalTop) + 2), `Dropped item must settle directly, never snap back to its old slot: ${JSON.stringify({ dropTop: motion.dropTop, finalTop, minimum: Math.min(...motion.frames.map((frame) => frame.top)), maximum: Math.max(...motion.frames.map((frame) => frame.top)), scrolls: [...new Set(motion.frames.map((frame) => frame.scroll))] })}`);
  assert(motion.frames.filter((frame) => frame.elapsed > 350).every((frame) => Math.abs(frame.top - finalTop) < 1), "Save acknowledgement must not restart the animation.");
  assert.equal(new Set(motion.frames.map((frame) => frame.scroll)).size, 1, "Reordering must not jump the viewport.");
  const saved = await household();
  assert.notDeepEqual(saved.shoppingOrder.items, original.shoppingOrder.items);
  assert.deepEqual(saved.shoppingOrder.aisles, original.shoppingOrder.aisles);
  assert.deepEqual(saved.checks, baselineChecks);
  console.log("PASS mouse drag updates immediately, settles without snapback, and persists through a delayed real Worker save");

  browser("wait", "--fn", "!document.querySelector('.toast')");
  // H.264 avoids the VP8 encoder falling behind on DPR2 orb captures; motion assertions still sample every animation frame.
  if (!process.argv.includes("--no-record")) {
    browser("record", "start", resolve(".amp/in/artifacts/shopping-reorder.mp4"), "--fps", "10", "--cursor");
    recording = true;
  }
  const beforeCancel = await names();
  await drag(true, true);
  await pause(400);
  assert.deepEqual(await names(), beforeCancel);
  assert.deepEqual((await household()).shoppingOrder, saved.shoppingOrder);
  browser("wait", "--fn", "document.getAnimations().length === 0");
  assert.equal(await evaluate(() => document.getAnimations().length), 0);
  console.log("PASS native touch cancellation smoothly restores rows without saving");

  await evaluate((w) => { w.saveDelay = 0; });
  await drag(true);
  await pause(1500);
  assert.deepEqual(await names(), [...beforeCancel.slice(1), beforeCancel[0]]);
  assert.deepEqual((await household()).checks, baselineChecks);
  if (recording) browser("record", "stop");
  recording = false;
  console.log("PASS native touch reorder in shopping mode with fast save acknowledgement");

  const beforeFailure = await names();
  const persisted = (await household()).shoppingOrder;
  await evaluate((w) => { w.rejectSave = true; w.saveDelay = 80; });
  await drag(true);
  await pause(1500);
  assert.deepEqual(await names(), beforeFailure);
  assert.deepEqual((await household()).shoppingOrder, persisted);
  assert.equal(await evaluate(() => document.getAnimations().length), 0);
  assert.equal(await evaluate(() => document.body.textContent?.includes("Your shopping change couldn’t be confirmed.")), true);
  assert.equal(await evaluate(() => document.body.textContent?.includes("simulated offline save")), false, "Private dependency failures must not be rendered.");
  console.log("PASS failed save rolls back and leaves no lingering animations or disabled grips");

  // Exercise rollback after both geometry and viewport coordinates have changed.
  await evaluate((w) => { w.saveDelay = 900; });
  await drag(true);
  await pause(80);
  await evaluate(async (w) => {
    const details = w.smokeGroup.querySelectorAll(".purchase-details")[1];
    if (!(details instanceof HTMLDetailsElement)) throw new Error("Expected shopping disclosure");
    details.open = true;
    scrollBy(0, 120);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rows = [...w.smokeGroup.querySelectorAll("[data-reorder-row]")];
    w.rollbackFrames = [];
    const start = performance.now();
    const sample = () => {
      const top = w.smokeGroup.getBoundingClientRect().top;
      w.rollbackFrames.push(rows.map(row => row.getBoundingClientRect().top - top));
      if (performance.now() - start < 1400) requestAnimationFrame(sample);
    };
    sample();
  });
  await pause(1500);
  assert.deepEqual(await names(), beforeFailure);
  const rollbackFrames = Schema.decodeUnknownSync(Schema.Array(Schema.Array(Schema.Number)))(await evaluate((w) => w.rollbackFrames));
  const firstRollback = rollbackFrames[0];
  const lastRollback = rollbackFrames.at(-1);
  assert(firstRollback && lastRollback, "Rollback sampling must produce frames");
  firstRollback.forEach((start, index) => {
    const end = lastRollback[index];
    assert(rollbackFrames.every((frame) => frame[index] >= Math.min(start, end) - 2 && frame[index] <= Math.max(start, end) + 2), "Rollback after scrolling/disclosure must not overshoot or reuse viewport coordinates.");
  });
  assert.equal(await evaluate(() => document.getAnimations().length), 0);
  await evaluate((w) => {
    const details = w.smokeGroup.querySelectorAll(".purchase-details")[1];
    if (!(details instanceof HTMLDetailsElement)) throw new Error("Expected shopping disclosure");
    details.open = false;
  });
  console.log("PASS delayed rollback after scrolling and variable-height disclosure remains bounded and settles cleanly");

  await evaluate((w) => { w.rejectSave = false; w.rejectRefresh = true; w.saveDelay = 0; });
  await drag(true);
  await pause(500);
  const afterRefreshFailure = [...beforeFailure.slice(1), beforeFailure[0]];
  assert.deepEqual(await names(), afterRefreshFailure, "An acknowledged write must not roll back when refresh fails.");
  assert.notDeepEqual((await household()).shoppingOrder, persisted);
  assert.equal(await evaluate(() => document.body.textContent?.includes("was saved, but")), true);
  await evaluate((w) => { w.rejectRefresh = false; });
  console.log("PASS successful PUT followed by failed household refresh retains the committed order");

  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await evaluate((w) => { w.rejectSave = false; w.saveDelay = 900; });
  await drag(true);
  await pause(100);
  assert.equal(await evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches && document.getAnimations().length === 0), true);
  assert.deepEqual(await names(), [...afterRefreshFailure.slice(1), afterRefreshFailure[0]]);
  await pause(1000);
  console.log("PASS reduced motion preserves dragging and immediate ordering without settling animations");
  assert.deepEqual((await household()).checks, baselineChecks);
  browser("wait", "--fn", "!document.querySelector('.toast')");
  browser("eval", "document.querySelector('[data-reorder-group]').scrollIntoView(); scrollBy(0,-70)");
  browser("screenshot", resolve(".amp/in/artifacts/shopping-reorder.png"));

  const groupLabel = Schema.decodeUnknownSync(Schema.String)(await evaluate((w) => w.smokeGroup.getAttribute("aria-label")));
  await cdp("Emulation.setEmulatedMedia", { features: [] });
  browser("click", '[aria-label="Exit List Builder"]');
  toggleRoute();
  browser("set", "viewport", "1280", "900", "2");
  await evaluate((w) => {
    const label = `Arrange ${w.smokeGroup.getAttribute("aria-label")}`;
    const group = [...document.querySelectorAll(".route-aisle")].find(group => group.getAttribute("aria-label") === label);
    if (!(group instanceof HTMLElement)) throw new Error("Expected route aisle");
    w.smokeGroup = group;
    w.dragUp = true;
    w.saveDelay = 0;
  });
  const routeBefore = await names();
  const lastRouteName = routeBefore.at(-1);
  assert(lastRouteName !== undefined, "Route group must contain a product");
  await drag(true);
  await pause(1500);
  const routeAfter = [lastRouteName, ...routeBefore.slice(0, -1)];
  assert.deepEqual(await names(), routeAfter, "Upward route-editor drag must insert rather than swap.");
  await evaluate((w) => {
    const button = w.smokeGroup.querySelector('.route-product [aria-label$="down"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error("Expected route move button");
    button.focus();
  });
  browser("press", "Enter");
  await pause(1000);
  const afterKeyboard = [routeAfter[1], routeAfter[0], ...routeAfter.slice(2)];
  assert.deepEqual(await names(), afterKeyboard);
  assert.equal(await evaluate(() => document.getAnimations().length), 0);
  // Slow only playback so the active-animation interleaving is deterministic even on a slow Worker.
  await evaluate((w) => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (this.matches("[data-reorder-row]")) animation.playbackRate = 0.1;
      return animation;
    };
    w.originalAnimate = animate;
  });
  const keyMove = async (direction: "down" | "up") => {
    await evaluateExpression(`(() => {
      const row = window.smokeGroup.querySelectorAll('.route-product')[${direction === "down" ? 1 : 2}];
      if (!(row instanceof HTMLElement)) throw new Error('Expected keyboard reorder row');
      window.keyboardRow = row;
      const button = row.querySelector('[aria-label$="${direction}"]');
      if (!(button instanceof HTMLButtonElement)) throw new Error('Expected route move button');
      button.focus();
    })()`);
    browser("press", "Enter");
    for (let attempt = 0; attempt < 50; attempt++) {
      if (Schema.decodeUnknownSync(Schema.Boolean)(await evaluate((w) => {
        const grip = w.smokeGroup.querySelector('.route-product .route-drag');
        if (!(grip instanceof HTMLButtonElement)) throw new Error("Expected route grip");
        return !grip.disabled;
      }))) return;
      await pause(5);
    }
    throw new Error("Rapid keyboard save did not finish");
  };
  await keyMove("down");
  assert.deepEqual(await names(), [afterKeyboard[0], afterKeyboard[2], afterKeyboard[1], ...afterKeyboard.slice(3)]);
  assert.equal(await evaluate(() => document.getAnimations().length > 0), true, "Second interaction must happen during settling, not after it.");
  const grab = Schema.decodeUnknownSync(Schema.Struct({ top: Schema.Number, x: Schema.Number, y: Schema.Number }))(await evaluate((w) => {
    const row = w.keyboardRow;
    const button = row.querySelector(".route-drag");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Expected route grip");
    const grip = button.getBoundingClientRect();
    return { top: row.getBoundingClientRect().top, x: grip.left + grip.width / 2, y: grip.top + grip.height / 2 };
  }));
  await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: grab.x, y: grab.y, button: "left", buttons: 1, clickCount: 1 });
  assert.equal(await evaluate((w) => w.keyboardRow.classList.contains("is-dragging")), true);
  const grabbedTop = Schema.decodeUnknownSync(Schema.Number)(await evaluate((w) => w.keyboardRow.getBoundingClientRect().top));
  assert(Math.abs(grabbedTop - grab.top) < 6, "Re-grabbing an animated row must not jump to its layout position.");
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: grab.x, y: grab.y, button: "left", buttons: 0, clickCount: 1 });
  await keyMove("up");
  await pause(2500);
  assert.deepEqual(await names(), afterKeyboard, "Opposite rapid moves must restore the exact order.");
  assert.equal(await evaluate(() => document.getAnimations().length), 0);
  await evaluate((w) => { Element.prototype.animate = w.originalAnimate; });
  console.log("PASS animated-row re-grab continuity and opposite keyboard reorders during settling (slowed playback, real saves)");

  await evaluate((w) => { w.saveDelay = 900; w.writeHistory = []; });
  const queuedBaseline = (await household()).shoppingOrder;
  await keyMove("down");
  await keyMove("up");
  assert.deepEqual(await names(), afterKeyboard, "Both moves must be usable while the first save is pending.");
  assert.deepEqual((await household()).shoppingOrder, queuedBaseline);
  assert.equal(await evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true, "Pending changes must install an unsaved-exit warning.");
  toggleRoute();
  await selectGroup(`[aria-label="${groupLabel}"]`);
  const checkboxLabels = Schema.decodeUnknownSync(Schema.Array(Schema.String))(await evaluate((w) => [...w.smokeGroup.querySelectorAll('input[type="checkbox"]')].filter((box) => {
    if (!(box instanceof HTMLInputElement)) throw new Error("Expected shopping checkbox");
    return box.checked;
  }).slice(0, 2).map((box) => box.getAttribute("aria-label"))));
  assert.equal(checkboxLabels.length, 2, "Use two off-list sample products.");
  assert.equal(await evaluate(() => [...document.querySelectorAll('.purchase-row input, .route-drag')].every((control) => (control instanceof HTMLInputElement || control instanceof HTMLButtonElement) && !control.disabled)), true, "Pending route saves must not lock checking or dragging.");
  for (const label of [checkboxLabels[0], checkboxLabels[0], checkboxLabels[1]]) browser("click", `[aria-label=${JSON.stringify(label)}]`);
  const immediateCheck = Schema.decodeUnknownSync(RuntimeResultSchema)(await cdp("Runtime.evaluate", { expression: `(() => { const box = document.querySelector(${JSON.stringify(`[aria-label=${JSON.stringify(checkboxLabels[1])}]`)}); if (!(box instanceof HTMLInputElement)) throw new Error('Expected shopping checkbox'); return box.checked; })()`, returnByValue: true }));
  assert.equal(immediateCheck.result.value, false, "Membership must update before the queued write is sent.");
  await evaluate((w) => {
    const boxes = [...w.smokeGroup.querySelectorAll('input[type="checkbox"]')].filter((box) => {
      if (!(box instanceof HTMLInputElement)) throw new Error("Expected shopping checkbox");
      return !box.checked;
    });
    const pendingCheckbox = boxes.at(-1);
    if (!(pendingCheckbox instanceof HTMLInputElement)) throw new Error("Expected pending shopping checkbox");
    w.checkFrames = [];
    const sample = () => {
      w.checkFrames.push(pendingCheckbox.checked);
      if (document.querySelector(".shopping-save-status")) requestAnimationFrame(sample);
    };
    sample();
  });
  browser("eval", "scrollTo(0,0)");
  assert.equal(await evaluate(() => document.querySelector('.shopping-save-status')?.textContent), "Saving…");
  browser("screenshot", resolve(".amp/in/artifacts/shopping-saving-desktop.png"));
  browser("wait", "--fn", "!document.querySelector('.shopping-save-status')");
  const history = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ path: Schema.String, body: Schema.Union([Schema.Struct({ ...ShoppingOrderSchema.fields, expectedRevision: Schema.String }), CheckSchema]) })), { onExcessProperty: "error" })(await evaluate((w) => w.writeHistory));
  assert.deepEqual(history.map((write) => write.path.split("/").at(-1)), ["shopping-order", "shopping-order", "checks", "checks", "checks"]);
  assert.deepEqual(history.slice(2).map((write) => {
    assert("checked" in write.body, "Expected membership write body");
    return write.body.checked;
  }), [0, 1, 0]);
  assert.equal(await evaluate((w) => w.checkFrames.every((value) => !value)), true, "Older saves/refreshes must not flicker newer optimistic membership.");
  const orderWrite = history[1].body;
  assert("expectedRevision" in orderWrite, "Expected guarded order write");
  const { expectedRevision: _expectedRevision, ...writtenOrder } = orderWrite;
  assert.deepEqual(withoutRevision((await household()).shoppingOrder), withoutRevision(writtenOrder));
  const pendingWrite = history.at(-1);
  assert(pendingWrite, "Expected final membership write");
  assert("key" in pendingWrite.body, "Expected final membership write body");
  const pendingCheck = pendingWrite.body;
  assert((await household()).checks.some((check) => check.key === pendingCheck.key && check.checked === 0));
  browser("click", `[aria-label=${JSON.stringify(checkboxLabels[1])}]`);
  browser("wait", "--fn", "!document.querySelector('.shopping-save-status')");
  assert.deepEqual((await household()).checks, baselineChecks);
  console.log("PASS delayed saves allow consecutive reorders and rapid check/uncheck across products, preserve order, and do not flicker");

  toggleRoute();
  await selectGroup(`[aria-label="Arrange ${groupLabel}"]`);
  await evaluate((w) => { w.saveDelay = 500; w.rejectNextSave = true; });
  await keyMove("down"); await keyMove("up");
  browser("wait", "--fn", "!document.querySelector('.shopping-save-status')");
  assert.deepEqual(await names(), afterKeyboard);
  assert.deepEqual((await household()).shoppingOrder.items, queuedBaseline.items);
  assert.equal(await evaluate(() => !!document.querySelector('.error')), false, "A superseded failed write must not report failure for a successful later intent.");
  console.log("PASS a failed earlier queued write neither rolls back nor blocks a later successful route save");

  await evaluate((w) => { w.saveDelay = 80; w.rejectSave = true; });
  await keyMove("down");
  browser("wait", ".error");
  browser("wait", "--fn", "!document.querySelector('.shopping-save-status')");
  assert.deepEqual(await names(), afterKeyboard, "A failed last edit must restore the last acknowledged order.");
  await evaluate((w) => { w.rejectSave = false; w.holdNextRefresh = true; });
  browser("eval", "scrollTo(0,0)");
  browser("click", ".error button");
  browser("wait", "--fn", "window.heldRefreshReady");
  await keyMove("down");
  browser("wait", "--fn", "!document.querySelector('.shopping-save-status')");
  const newerNames = [afterKeyboard[0], afterKeyboard[2], afterKeyboard[1], ...afterKeyboard.slice(3)];
  assert.deepEqual(await names(), newerNames);
  await evaluate((w) => {
    if (!w.releaseRefresh) throw new Error("Expected held household refresh");
    w.releaseRefresh();
  });
  await pause(300);
  assert.deepEqual(await names(), newerNames, "An old household response must not replace a newer acknowledged route.");
  await keyMove("up");
  browser("wait", "--fn", "!document.querySelector('.shopping-save-status')");
  assert.deepEqual(await names(), afterKeyboard);
  console.log("PASS latest-write failure rolls back correctly, and stale refresh cannot overwrite a newer acknowledged save");

  toggleRoute();
  await selectGroup(`[aria-label="${groupLabel}"]`);
  await evaluate((w) => { w.rejectNextSave = true; w.saveDelay = 500; });
  for (const label of checkboxLabels) browser("click", `[aria-label=${JSON.stringify(label)}]`);
  browser("wait", "--fn", "!document.querySelector('.shopping-save-status')");
  const checkedAfterFailure = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ label: Schema.String, checked: Schema.Boolean })))(await evaluate((w) => [...w.smokeGroup.querySelectorAll('input[type="checkbox"]')].map((box) => {
    if (!(box instanceof HTMLInputElement)) throw new Error("Expected shopping checkbox");
    return { label: box.getAttribute("aria-label"), checked: box.checked };
  })));
  assert.equal(checkedAfterFailure.find((box) => box.label === checkboxLabels[0])?.checked, true, "Only the failed membership change should roll back.");
  assert.equal(checkedAfterFailure.find((box) => box.label === checkboxLabels[1])?.checked, false, "An independent later membership change must remain saved.");
  assert.equal(await evaluate(() => document.querySelector('.error')?.textContent?.includes("Your shopping change couldn’t be confirmed.")), true, "Independent failures must not be hidden by a later success.");
  assert.equal(await evaluate(() => document.body.textContent?.includes("simulated offline save")), false, "Private dependency failures must not be rendered.");
  browser("click", `[aria-label=${JSON.stringify(checkboxLabels[1])}]`);
  browser("wait", "--fn", "!document.querySelector('.shopping-save-status')");
  assert.deepEqual((await household()).checks, baselineChecks);
  assert.equal(await evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), false, "Exit warning must clear once the queue drains.");
  console.log("PASS an offline check rolls back only that item, independent later checks persist, and pending-exit protection clears");
  const afterRoute = (await household()).shoppingOrder;
  browser("reload");
  browser("wait", ".shopping-summary");
  // The route keeps mode=builder, so the reloaded page may already be in List Builder.
  if (browser("eval", "!document.querySelector('[aria-label=\"Exit List Builder\"]')") === "true") browser("click", '[aria-label="List Builder"]');
  browser("wait", ".purchase-row");
  await selectGroup(`[aria-label="${groupLabel}"]`);
  assert.deepEqual(await names(), afterKeyboard.filter(name => before.includes(name)));
  assert.deepEqual((await household()).shoppingOrder, afterRoute);
  console.log("PASS desktop route-editor upward insertion, keyboard ordering and reload persistence");
} finally {
  try {
    // Stop delayed writes and drain any request already sent before closing the page and restoring.
    try {
      browser("eval", "(async () => { window.stopping = true; await Promise.allSettled([...(window.smokeSaves ?? [])]); return true; })()");
    } finally {
      socket?.close();
      try { if (recording) browser("record", "stop"); }
      finally { browser("close"); }
    }
  } finally {
    const expectedRevision = (await household()).shoppingOrder.revision;
    const response = await fetch(`${url}/api/shopping-order`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...original.shoppingOrder, expectedRevision }) });
    assert(response.ok, "Restore the original shopping order.");
    const current = await household();
    for (const key of new Set([...current.checks.map((check) => check.key), ...original.checks.map((check) => check.key)])) {
      const fallback = key.startsWith('["shopping-list",') ? 1 : 0;
      const wanted = original.checks.find((check) => check.key === key);
      const now = current.checks.find((check) => check.key === key);
      if ((wanted?.checked ?? fallback) !== (now?.checked ?? fallback) || (wanted?.packages ?? 1) !== (now?.packages ?? 1)) {
        const response = await fetch(`${url}/api/checks`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, checked: wanted?.checked ?? fallback, packages: wanted?.packages ?? 1 }) });
        assert(response.ok, "Restore the original checkmark.");
      }
    }
    const restored = await household();
    assert.deepEqual(withoutRevision(restored.shoppingOrder), withoutRevision(original.shoppingOrder));
    assert.deepEqual(restored.checks, original.checks);
    console.log("PASS original order and checkmarks restored");
  }
}
