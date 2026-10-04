import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Playwright is deliberately supplied by the UI-smoke runner, not by this project.
// @ts-expect-error The parent task installs this exact external runtime.
const { chromium, webkit, devices } = await import("/tmp/hearth-ui/node_modules/playwright/index.mjs");

const baseURL = process.argv[2] ?? "http://localhost:5173";
const parsed = new URL(baseURL);
assert(["localhost", "127.0.0.1"].includes(parsed.hostname), "UI smoke refuses non-local URLs");
assert(["http:", "https:"].includes(parsed.protocol), "UI smoke requires HTTP(S)");
const root = parsed.origin;
const artifacts = resolve(".amp/in/artifacts");
await mkdir(artifacts, { recursive: true });

type Result = { case: string; engine: string; viewport: string; check: string; status: "pass" | "fail"; detail?: string };
const results: Result[] = [];
const failures: string[] = [];
const contexts: any[] = [];
const tempExtraIds = new Set<string>();
const tempExtraNames = new Set<string>();
const changedChecks = new Set<string>();
let changedOrder = false;
let shot = 0;

async function household() {
  const response = await fetch(`${root}/api/household`);
  assert(response.ok, `GET household returned ${response.status}`);
  return response.json() as Promise<any>;
}
const original = await household();
const originalText = JSON.stringify(original);

async function api(path: string, method: string, body?: unknown) {
  const response = await fetch(`${root}/api/${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert(response.ok, `${method} ${path} returned ${response.status}: ${await response.text()}`);
}

function record(caseName: string, engine: string, viewport: string, check: string, error?: unknown) {
  const detail = error instanceof Error ? error.message : error ? String(error) : undefined;
  results.push({ case: caseName, engine, viewport, check, status: detail ? "fail" : "pass", detail });
  if (detail) failures.push(`${caseName} / ${check}: ${detail}`);
}

async function check(caseName: string, engine: string, viewport: string, name: string, action: () => unknown | Promise<unknown>) {
  try {
    await action();
    record(caseName, engine, viewport, name);
    console.log(`PASS ${caseName}: ${name}`);
  } catch (error) {
    record(caseName, engine, viewport, name, error);
    throw error;
  }
}

async function settle(page: any) {
  await page.waitForLoadState("domcontentloaded");
  await page.locator("h1").first().waitFor({ state: "visible" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}

async function auditLayout(page: any, touch: boolean) {
  const problems = await page.evaluate((expectTouch: boolean) => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const offenders = [...document.querySelectorAll("body *, dialog[open] *")].filter((element) => {
      if (!visible(element)) return false;
      const box = element.getBoundingClientRect();
      return box.right > innerWidth + 2 || box.left < -2;
    }).slice(0, 8).map((element) => `${element.tagName.toLowerCase()}.${element.className}`);
    const dialogs = [...document.querySelectorAll("dialog[open]")].filter((element) => element.scrollWidth > element.clientWidth + 2);
    const unreachable = [...document.querySelectorAll("button,summary,a[href],input,select,textarea")]
      .filter(visible)
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.right <= 0 || box.left >= innerWidth;
      }).length;
    return {
      bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      offenders,
      dialogOverflow: dialogs.length,
      unreachable,
      coarse: matchMedia("(pointer: coarse)").matches,
      expectTouch,
      removedControls: [...document.querySelectorAll("button,a,h2")].filter((element) =>
        ["Export list", "A few familiar favorites"].includes(element.textContent?.trim() ?? "") && visible(element),
      ).length,
      phoneChat: (innerWidth <= 600 || expectTouch && innerHeight <= 500) && [...document.querySelectorAll('[aria-label="Use Hearth in ChatGPT"]')].some(visible),
      phoneHeadingMisaligned: innerWidth <= 600 && [...document.querySelectorAll(".page-heading")].some((heading) => {
        if (!visible(heading)) return false;
        const title = heading.querySelector("h1")?.getBoundingClientRect();
        const action = heading.querySelector("button")?.getBoundingClientRect();
        return !!title && !!action && Math.abs(title.top - action.top) > 16;
      }),
    };
  }, touch);
  assert(problems.bodyOverflow <= 2, `page horizontal overflow ${problems.bodyOverflow}px: ${problems.offenders.join(", ")}`);
  assert.equal(problems.dialogOverflow, 0, "open dialog has horizontal overflow");
  assert.equal(problems.unreachable, 0, "interactive controls are outside the horizontal viewport");
  assert.equal(problems.removedControls, 0, "removed favorites/export controls must not return");
  assert.equal(problems.phoneChat, false, "phone header must not show the ChatGPT icon");
  assert.equal(problems.phoneHeadingMisaligned, false, "phone heading and primary action are misaligned");
  if (touch) assert.equal(problems.coarse, true, "touch profile must match pointer: coarse");
}

async function screenshot(page: any, name: string) {
  await page.screenshot({ path: resolve(artifacts, `${String(++shot).padStart(2, "0")}-${name}.png`), fullPage: false });
}

async function activate(locator: any, touch: boolean) {
  await locator.scrollIntoViewIfNeeded();
  touch ? await locator.tap() : await locator.click();
}

async function cancelDialog(page: any) {
  const dialog = page.locator("dialog[open]").last();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await dialog.waitFor({ state: "detached" });
}

async function commonNavigation(page: any, touch: boolean, label: string, capture: boolean) {
  await check(label, page.context().browser()?.browserType().name() ?? "webkit", `${page.viewportSize().width}×${page.viewportSize().height}`, "meal plan navigation, date disclosure, and unsaved meal cancellation", async () => {
    await page.goto(`${root}/#plan`); await settle(page);
    await activate(page.getByRole("button", { name: "Next week" }), touch);
    await activate(page.getByText("Jump to date", { exact: true }).first(), touch);
    await auditLayout(page, touch);
    await activate(page.getByRole("button", { name: "Add a meal" }).first(), touch);
    const dialog = page.getByRole("dialog", { name: "Add a meal" });
    await dialog.waitFor();
    await dialog.getByLabel(/note for this meal/i).fill("UNSAVED UI smoke draft");
    await auditLayout(page, touch);
    if (capture) await screenshot(page, `${label}-meal-dialog`);
    await cancelDialog(page);
  });

  await check(label, page.context().browser()?.browserType().name() ?? "webkit", `${page.viewportSize().width}×${page.viewportSize().height}`, "recipes search, detail, scale, nested meal preview, and editor cancellation", async () => {
    await page.goto(`${root}/#recipes`); await settle(page);
    const search = page.getByLabel("Search recipes");
    await search.fill("__no_recipe_should_match__");
    await page.getByText("No recipes found").waitFor();
    await search.fill("");
    const row = page.locator(".recipe-row-main").first();
    if (await row.count()) {
      await activate(row, touch);
      const detail = page.locator(".recipe-detail"); await detail.waitFor();
      await page.getByLabel("Preview recipe scale").selectOption("2");
      if (capture) await screenshot(page, `${label}-recipe-detail`);
      await auditLayout(page, touch);
      await detail.evaluate((element: HTMLElement) => { element.scrollTop = element.scrollHeight; });
      assert(await detail.evaluate((element: HTMLElement) => element.scrollHeight <= element.clientHeight || element.scrollTop > 0), "long recipe details must scroll vertically");
      await cancelDialog(page);
      await activate(page.getByRole("button", { name: "Add to plan" }).first(), touch);
      const meal = page.getByRole("dialog", { name: "Add a meal" }); await meal.waitFor();
      const chosen = meal.locator(".selected-recipe");
      if (await chosen.count()) {
        await activate(chosen, touch);
        await page.locator(".recipe-detail").waitFor();
        await activate(page.getByRole("button", { name: "Back to meal" }), touch);
        assert(await meal.isVisible(), "Back to meal must recover the meal draft");
      }
      await cancelDialog(page);
    }
    await activate(page.getByRole("button", { name: "Add a recipe" }), touch);
    const editor = page.getByRole("dialog", { name: "Add a recipe" }); await editor.waitFor();
    await editor.getByLabel("Recipe name").fill("UNSAVED UI smoke recipe");
    await editor.getByLabel("Ingredient 1 name").fill("temporary ingredient");
    await editor.getByRole("button", { name: "New product" }).click();
    await editor.locator(".grocery-form, form").last().waitFor();
    await auditLayout(page, touch);
    await editor.getByRole("button", { name: /cancel/i }).last().click().catch(async () => {
      await editor.getByRole("button", { name: "Close" }).last().click();
    });
    await cancelDialog(page);
  });

  await check(label, page.context().browser()?.browserType().name() ?? "webkit", `${page.viewportSize().width}×${page.viewportSize().height}`, "groceries catalog and unsaved grocery cancellation", async () => {
    await page.goto(`${root}/#groceries`); await settle(page);
    const add = page.getByRole("button", { name: /add grocery item/i }).first();
    if (await add.count()) {
      await activate(add, touch);
      const dialog = page.getByRole("dialog", { name: "Grocery item" }); await dialog.waitFor();
      const text = dialog.locator('input[type="text"]').first(); if (await text.count()) await text.fill("UNSAVED UI smoke product");
      await auditLayout(page, touch); await cancelDialog(page);
    }
  });
}

async function shoppingAndTimers(page: any, touch: boolean, label: string, capture: boolean) {
  await check(label, page.context().browser()?.browserType().name() ?? "webkit", `${page.viewportSize().width}×${page.viewportSize().height}`, "shopping dates, details/grips, mode, check-hide-show-restore, route recovery", async () => {
    await page.goto(`${root}/#shopping`); await settle(page);
    await activate(page.locator(".shopping-range summary"), touch);
    const start = page.getByLabel("Shopping start date"); const end = page.getByLabel("Shopping end date");
    const startValue = await start.inputValue(); const endValue = await end.inputValue();
    await start.fill(""); await end.fill("");
    await page.getByText("Choose a date range").waitFor();
    await start.fill(startValue); await end.fill(endValue);
    const extraName = `UI smoke extra ${Date.now()}`;
    tempExtraNames.add(extraName);
    await page.getByLabel("New household item").fill(extraName);
    await activate(page.getByRole("button", { name: "Add household item" }), touch);
    const removeExtra = page.getByRole("button", { name: `Remove ${extraName}` });
    await removeExtra.waitFor();
    const addedExtra = (await household()).extras.find((entry: any) => entry.name === extraName);
    assert(addedExtra, "temporary household extra was not persisted");
    tempExtraIds.add(addedExtra.id);
    await activate(removeExtra, touch);
    await removeExtra.waitFor({ state: "detached" });
    assert(!(await household()).extras.some((entry: any) => entry.id === addedExtra.id), "own extra was not removed");
    tempExtraIds.delete(addedExtra.id);
    const grips = page.locator('[aria-label^="Drag "]');
    const details = page.locator('[aria-label^="Details for "]');
    if (await grips.count() && await details.count()) {
      assert.notEqual(await grips.first().getAttribute("aria-label"), await details.first().getAttribute("aria-label"));
      await activate(details.first(), touch);
      if (capture) await screenshot(page, `${label}-shopping-details`);
      const edit = page.getByRole("button", { name: "Edit product" }).first();
      if (await edit.count()) { await activate(edit, touch); await page.getByRole("dialog", { name: "Grocery item" }).waitFor(); await auditLayout(page, touch); await cancelDialog(page); }
    }
    const box = page.locator('.purchase-row input[type="checkbox"]').first();
    if (await box.count()) {
      const name = await box.getAttribute("aria-label");
      const was = await box.isChecked();
      await activate(box, touch);
      await page.locator(".shopping-save-status").waitFor({ state: "detached" });
      const current = await household();
      for (const key of new Set([...current.checks.map((entry: any) => entry.key), ...original.checks.map((entry: any) => entry.key)])) {
        const before = original.checks.some((entry: any) => entry.key === key && entry.checked === 1);
        const after = current.checks.some((entry: any) => entry.key === key && entry.checked === 1);
        if (before !== after) changedChecks.add(key);
      }
      await activate(page.getByRole("button", { name: "Hide checked items" }), touch);
      if (!was) assert.equal(await page.getByLabel(name!).count(), 0, "checked item should hide");
      await activate(page.getByRole("button", { name: "Show checked items" }), touch);
      const restored = page.getByLabel(name!); await restored.waitFor();
      if ((await restored.isChecked()) !== was) await activate(restored, touch);
      await page.locator(".shopping-save-status").waitFor({ state: "detached" });
    }
    await activate(page.getByRole("button", { name: "Arrange route" }), touch);
    assert(await page.locator(".route-editor").isVisible());
    await activate(page.getByRole("button", { name: "Shopping mode" }), touch);
    assert(await page.locator(".app-shell.shopping-mode").isVisible());
    assert.equal(await page.locator(".route-editor").count(), 0, "shopping mode must replace the editor with a checklist");
    assert(await page.locator('.purchase-row input[type="checkbox"]').first().isVisible());
    if (capture) await screenshot(page, `${label}-shopping-mode`);
    await activate(page.getByRole("button", { name: "Exit shopping mode" }), touch);
    assert.equal(await page.locator(".route-editor").count(), 0, "exit must retain the usable checklist");
    await auditLayout(page, touch);
  });

  await check(label, page.context().browser()?.browserType().name() ?? "webkit", `${page.viewportSize().width}×${page.viewportSize().height}`, "compact visible warning cue, full accessible disclosure, and no single-item grips", async () => {
    const counts = await page.locator(".purchase-group").evaluateAll((groups: Element[]) => groups.map(group => ({
      linked: group.getAttribute("aria-label") !== "Needs linking",
      rows: group.querySelectorAll(".purchase-row").length,
      grips: group.querySelectorAll(".route-drag").length,
    })));
    for (const group of counts) assert.equal(group.grips, group.linked && group.rows > 1 ? group.rows : 0);
    const warning = page.locator(".purchase-row").filter({ has: page.locator(".purchase-review") }).first();
    await warning.locator(".purchase-review").waitFor();
    assert.equal(await warning.locator(".purchase-warning").first().isVisible(), false);
    assert((await warning.locator("summary").getAttribute("aria-description")).includes("smaller pack"), "full warning must also be available to assistive technology");
    const compactHeight = (await warning.boundingBox()).height;
    if (page.viewportSize().width >= 393) assert(compactHeight <= 82, `collapsed warning row is too tall: ${compactHeight}px`);
    await activate(warning.locator("summary"), touch);
    assert(await warning.locator(".purchase-warning").first().isVisible());
    assert((await warning.locator(".purchase-warning").allTextContents()).join(" ").includes("smaller pack"), "full warning must remain readable");
    await auditLayout(page, touch);
    if (capture) await screenshot(page, `${label}-warning-expanded`);
    await activate(warning.locator("summary"), touch);
    assert.equal((await warning.boundingBox()).height, compactHeight);
    if (capture) await screenshot(page, `${label}-warning-compact`);
  });

  await check(label, page.context().browser()?.browserType().name() ?? "webkit", `${page.viewportSize().width}×${page.viewportSize().height}`, "timer create, persistence, edit draft cancellation, focus, and cleanup", async () => {
    await page.goto(`${root}/#plan`); await settle(page);
    await activate(page.locator(".timer-toggle"), touch);
    const panel = page.getByLabel("Kitchen timers"); await panel.waitFor();
    const name = `UI smoke timer ${Date.now()}`;
    await panel.locator('input[name="timerName"]').fill(name);
    await panel.locator('input[name="timerMinutes"]').fill("2");
    await activate(panel.getByRole("button", { name: /start timer/i }), touch);
    await page.reload(); await settle(page); await activate(page.locator(".timer-toggle"), touch);
    await page.getByLabel(name, { exact: true }).waitFor();
    await activate(panel.getByText("Add a timer", { exact: true }), touch);
    await panel.locator('input[name="timerName"]').fill("UNSAVED second timer");
    await activate(panel.getByRole("button", { name: "Collapse timers" }), touch);
    assert(await page.locator(".timer-toggle").evaluate((element: Element) => element === document.activeElement), "collapsing timer drawer should restore toggle focus");
    await activate(page.locator(".timer-toggle"), touch);
    await activate(panel.getByRole("button", { name: `Cancel ${name}` }), touch);
    assert.equal(await page.getByLabel(name, { exact: true }).count(), 0);
    await activate(panel.getByRole("button", { name: "Collapse timers" }), touch);
    await auditLayout(page, touch);
  });
  await check(label, page.context().browser()?.browserType().name() ?? "webkit", `${page.viewportSize().width}×${page.viewportSize().height}`, `pointer drag, persisted insertion, ${touch ? "rotation cancellation, " : ""}keyboard arrows, quantities and checks preserved`, async () => {
    await page.goto(`${root}/#shopping`); await settle(page);
    const before = await household();
    const groupIndex = await page.locator(".purchase-group").evaluateAll((groups: Element[]) => groups.findIndex(group => group.querySelectorAll(".route-drag:not(:disabled)").length >= 3));
    assert(groupIndex >= 0, "sample meals must contain three linked products in one aisle");
    const group = page.locator(".purchase-group").nth(groupIndex);
    const groupLabel = await group.getAttribute("aria-label");
    const names = () => group.locator(".item-info strong").allTextContents();
    const originalNames = await names();
    const quantities = await group.locator(".item-info").allTextContents();
    const grip = group.locator(".route-drag").first();
    await grip.evaluate((element: HTMLElement) => element.scrollIntoView({ block: "center" }));
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const gripBox = await grip.boundingBox();
    assert(gripBox.width >= 44 && gripBox.height >= 44, "drag target must remain at least 44px");
    const start = { x: gripBox.x + gripBox.width / 2, y: gripBox.y + gripBox.height / 2 };
    const destination = await group.locator(".purchase-row").last().boundingBox();
    const hit = await page.evaluate(({ x, y }: { x: number; y: number }) => {
      const element = document.elementFromPoint(x, y);
      return { grip: !!element?.closest(".route-drag"), element: `${element?.tagName}.${element?.getAttribute("class")}`, scroll: scrollY };
    }, start);
    if (!hit.grip) await screenshot(page, `${label}-blocked-grip`);
    assert(hit.grip, `grip must not be covered: ${JSON.stringify({ hit, start })}`);
    changedOrder = true;
    // Playwright mouse input exercises pointer capture in WebKit mobile layouts; native touch dragging is covered separately in Chromium.
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(start.x, destination.y + destination.height / 2 + 5, { steps: 20 });
    await page.waitForTimeout(200);
    assert(await group.locator(".drop-target").count(), "drag must select an insertion target");
    await page.mouse.up();
    await page.locator(".shopping-save-status").waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    assert.deepEqual(await names(), [...originalNames.slice(1), originalNames[0]]);
    assert.deepEqual((await group.locator(".item-info").allTextContents()).sort(), quantities.sort(), "reordering must not change ingredient/package quantities");
    const committed = await household();
    assert.deepEqual(committed.checks, before.checks);
    assert.deepEqual(committed.shoppingOrder.aisles, before.shoppingOrder.aisles);
    const ids = committed.shoppingOrder.items.map((key: string) => JSON.parse(key)[1]);
    const persistedNames = ids.filter((id: string) => originalNames.includes(committed.groceries.find((item: any) => item.id === id)?.name)).map((id: string) => committed.groceries.find((item: any) => item.id === id).name);
    assert.deepEqual(persistedNames, [...originalNames.slice(1), originalNames[0]], "Worker must persist insertion, not a swap");
    await page.reload(); await settle(page);
    await group.locator(".purchase-row").first().waitFor();
    assert.deepEqual(await names(), persistedNames, "reload must retain the route");
    if (touch) {
      const viewport = page.viewportSize();
      await grip.evaluate((element: HTMLElement) => element.scrollIntoView({ block: "center" }));
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      const box = await grip.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 12);
      await page.waitForTimeout(50);
      assert.equal(await page.locator(".is-dragging").count(), 1);
      await page.setViewportSize({ width: viewport.height, height: viewport.width });
      await page.waitForFunction(() => !document.querySelector(".is-dragging"));
      await page.mouse.up();
      assert.deepEqual((await household()).shoppingOrder, committed.shoppingOrder, "rotation must cancel without saving");
      await auditLayout(page, touch);
      await page.setViewportSize(viewport);
    }
    await activate(page.getByRole("button", { name: "Arrange route" }), touch);
    const route = page.getByRole("region", { name: `Arrange ${groupLabel}`, exact: true });
    const routeNames = await route.locator(".route-product > span").evaluateAll((nodes: Element[]) => nodes.map(node => node.childNodes[0].textContent));
    const down = route.locator('.route-product button[aria-label$="down"]').first();
    await down.scrollIntoViewIfNeeded(); await down.focus(); await page.keyboard.press("Enter");
    await page.locator(".shopping-save-status").waitFor({ state: "detached" });
    const afterKeyboard = await route.locator(".route-product > span").evaluateAll((nodes: Element[]) => nodes.map(node => node.childNodes[0].textContent));
    assert.deepEqual(afterKeyboard, [routeNames[1], routeNames[0], ...routeNames.slice(2)]);
    await api("shopping-order", "PUT", before.shoppingOrder);
    await page.reload(); await settle(page);
    await group.locator(".purchase-row").first().waitFor();
    assert.deepEqual(await names(), originalNames);
    assert.deepEqual((await household()).checks, before.checks);
  });
}

const consoleErrors: string[] = [];
async function makeContext(browser: any, viewport: { width: number; height: number }, touch: boolean, mobile: boolean) {
  const profile = mobile ? devices[viewport.width >= 768 && viewport.height >= 600 ? "iPad (gen 7)" : "iPhone 14"] : {};
  const context = await browser.newContext({ ...profile, viewport, deviceScaleFactor: 2, hasTouch: touch, isMobile: mobile });
  context.setDefaultTimeout(10_000);
  contexts.push(context);
  await context.addInitScript(() => {
    const w = window as any;
    const fetch = window.fetch;
    w.uiWrites = new Set();
    window.fetch = (...args) => {
      const write = args[1]?.method && args[1].method !== "GET";
      if (write && w.uiStopping) return Promise.reject(new Error("UI smoke cleanup canceled a new write"));
      const result = fetch(...args);
      if (write) {
        w.uiWrites.add(result);
        result.then(() => w.uiWrites.delete(result), () => w.uiWrites.delete(result));
      }
      return result;
    };
  });
  const page = await context.newPage();
  page.on("console", (message: any) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error: Error) => consoleErrors.push(error.message));
  return { context, page };
}

async function closeContext(context: any) {
  for (const page of context.pages()) {
    await page.evaluate(async () => {
      const w = window as any;
      w.uiStopping = true;
      await Promise.allSettled([...(w.uiWrites ?? [])]);
    }).catch(error => failures.push(`Write-drain cleanup: ${error.message}`));
  }
  await context.close();
}

try {
  const chrome = await chromium.launch({ headless: true });
  const wk = await webkit.launch({ headless: true });
  try {
    const desktopChrome = await makeContext(chrome, { width: 1440, height: 900 }, false, false);
    await commonNavigation(desktopChrome.page, false, "desktop-chromium", true);
    await shoppingAndTimers(desktopChrome.page, false, "desktop-chromium", true);
    await closeContext(desktopChrome.context);

    const desktopWk = await makeContext(wk, { width: 1440, height: 900 }, false, false);
    await commonNavigation(desktopWk.page, false, "desktop-webkit", false);
    await shoppingAndTimers(desktopWk.page, false, "desktop-webkit", false);
    await closeContext(desktopWk.context);

    const phone = await makeContext(wk, { width: 393, height: 852 }, true, true);
    await commonNavigation(phone.page, true, "webkit-phone-portrait", true);
    await shoppingAndTimers(phone.page, true, "webkit-phone-portrait", true);
    await phone.page.setViewportSize({ width: 852, height: 393 });
    await auditLayout(phone.page, true); await screenshot(phone.page, "webkit-phone-landscape");
    record("webkit-phone-landscape", "webkit", "852×393 DPR2", "same-context rotation with open page state and layout audit");
    await commonNavigation(phone.page, true, "webkit-phone-landscape", true);
    await shoppingAndTimers(phone.page, true, "webkit-phone-landscape", true);
    await closeContext(phone.context);

    const small = await makeContext(wk, { width: 320, height: 568 }, true, true);
    await commonNavigation(small.page, true, "webkit-phone-320", false);
    await shoppingAndTimers(small.page, true, "webkit-phone-320", false);
    await small.page.setViewportSize({ width: 568, height: 320 });
    await commonNavigation(small.page, true, "webkit-phone-320-landscape", false);
    await shoppingAndTimers(small.page, true, "webkit-phone-320-landscape", false);
    await closeContext(small.context);

    const tablet = await makeContext(wk, { width: 820, height: 1180 }, true, true);
    await commonNavigation(tablet.page, true, "webkit-ipad-portrait", true);
    await shoppingAndTimers(tablet.page, true, "webkit-ipad-portrait", true);
    await tablet.page.goto(`${root}/#recipes`); await settle(tablet.page);
    const first = tablet.page.locator(".recipe-row-main").first(); if (await first.count()) await first.tap();
    await auditLayout(tablet.page, true); await screenshot(tablet.page, "webkit-ipad-portrait-detail");
    await tablet.page.setViewportSize({ width: 1180, height: 820 });
    await auditLayout(tablet.page, true); await screenshot(tablet.page, "webkit-ipad-landscape-detail");
    record("webkit-ipad-rotation", "webkit", "820×1180 → 1180×820 DPR2", "same-context rotation while details remain open");
    if (await tablet.page.locator("dialog[open]").count()) await cancelDialog(tablet.page);
    await commonNavigation(tablet.page, true, "webkit-ipad-landscape", true);
    await shoppingAndTimers(tablet.page, true, "webkit-ipad-landscape", true);
  } finally {
    await Promise.allSettled(contexts.map(closeContext));
    await Promise.allSettled([chrome.close(), wk.close()]);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  // Browser writes are drained and contexts closed before restoring the exact snapshot.
  try {
    const current = await household();
    for (const extra of current.extras) if (tempExtraIds.has(extra.id) || tempExtraNames.has(extra.name)) await api(`extras/${encodeURIComponent(extra.id)}`, "DELETE");
    if (changedOrder && JSON.stringify(current.shoppingOrder) !== JSON.stringify(original.shoppingOrder)) await api("shopping-order", "PUT", original.shoppingOrder);
    const allCheckKeys = new Set([...changedChecks, ...current.checks.map((entry: any) => entry.key), ...original.checks.map((entry: any) => entry.key)]);
    for (const key of allCheckKeys) {
      const wanted = original.checks.some((entry: any) => entry.key === key && entry.checked === 1) ? 1 : 0;
      const now = current.checks.some((entry: any) => entry.key === key && entry.checked === 1) ? 1 : 0;
      if (wanted !== now) await api("checks", "PUT", { key, checked: wanted });
    }
    const restored = await household();
    assert.equal(JSON.stringify(restored), originalText, "household differs from exact starting snapshot after cleanup");
    record("cleanup", "worker", "n/a", "household exactly restored");
  } catch (error) {
    record("cleanup", "worker", "n/a", "household exactly restored", error);
  }
}

if (consoleErrors.length) failures.push(`Browser console/page errors:\n${[...new Set(consoleErrors)].join("\n")}`);
else record("all", "all", "all", "no page console errors");
const report = { generatedAt: new Date().toISOString(), baseURL, note: "WebKit browser profiles on Linux; not physical iOS/iPadOS or Safari.", results, consoleErrors, failures };
await writeFile(resolve(artifacts, "ui-usability-report.json"), `${JSON.stringify(report, null, 2)}\n`);
const matrix = results.map((entry) => `| ${entry.case} | ${entry.engine} | ${entry.viewport} | ${entry.check.replaceAll("|", "\\|")} | ${entry.status.toUpperCase()} |`).join("\n");
await writeFile(resolve(artifacts, "ui-usability-report.md"), `# Hearth UI usability smoke\n\nWebKit runs use Linux WebKit profiles and are **not** actual iOS/iPadOS or Safari device results. All touch profiles use real Playwright touch/mobile contexts at DPR2 and are checked for \`pointer: coarse\`.\n\n| Case | Engine | Viewport | Check | Result |\n|---|---|---|---|---|\n${matrix}\n\n## Failures\n${failures.length ? failures.map((failure) => `- ${failure.replaceAll("\n", " ")}`).join("\n") : "None."}\n`);
if (failures.length) throw new AggregateError(failures.map((failure) => new Error(failure)), `${failures.length} UI smoke failure(s); see ${artifacts}/ui-usability-report.md`);
console.log(`PASS ${results.length} UI usability checks; reports and ${shot} review screenshots in ${artifacts}`);
