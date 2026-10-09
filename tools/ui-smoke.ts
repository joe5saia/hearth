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
const renamedAisles = new Map<string, string>();
let changedOrder = false;
let shot = 0;

async function household() {
  const response = await fetch(`${root}/api/household`);
  assert(response.ok, `GET household returned ${response.status}`);
  const data = await response.json() as any;
  // Check rows have no display order; toggling a selected item may change D1 insertion order.
  data.checks.sort((a: any, b: any) => a.key.localeCompare(b.key));
  return data;
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
      phoneChat: (innerWidth <= 600 || expectTouch && innerHeight <= 500) && [...document.querySelectorAll('[aria-label="Use Hearth in ChatGPT"]')].some(element => visible(element) && !element.closest(".page-options")),
      phoneHeadingMisaligned: innerWidth <= 600 && [...document.querySelectorAll(".topbar")].some((heading) => {
        if (!visible(heading)) return false;
        const title = heading.querySelector("h1")?.getBoundingClientRect();
        const action = heading.querySelector(".page-add")?.getBoundingClientRect();
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
    const currentWeek = await page.locator(".week-picker h2").textContent();
    await activate(page.getByRole("button", { name: "Next week" }), touch);
    const trigger = page.getByLabel("Jump to date", { exact: true });
    const date = page.getByLabel("Jump to week containing date");
    await activate(trigger, touch);
    await auditLayout(page, touch);
    assert(await page.locator(".week-jump").evaluate((form: HTMLElement) => {
      const panel = form.getBoundingClientRect();
      return [...form.children].every(child => {
        const box = child.getBoundingClientRect();
        return box.left > panel.left && box.right < panel.right && box.top > panel.top && box.bottom < panel.bottom;
      });
    }), "date-picker controls must stay inside their panel, not merely inside the viewport");
    if (capture) await screenshot(page, `${label}-week-picker`);
    await date.focus();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".week-picker[open]").count(), 0);
    assert(await trigger.evaluate((element: HTMLElement) => element === document.activeElement));
    await activate(trigger, touch);
    await date.fill("2030-01-06");
    await activate(page.getByRole("button", { name: "Go to week", exact: true }), touch);
    assert.equal(await page.locator(".week-picker[open]").count(), 0);
    assert.equal(await page.locator(".week-picker h2").textContent(), "Dec 31, 2029 – Jan 6, 2030");
    await activate(trigger, touch);
    await activate(page.getByRole("button", { name: "This week", exact: true }), touch);
    assert.equal(await page.locator(".week-picker h2").textContent(), currentWeek);
    await activate(trigger, touch);
    await activate(page.getByRole("button", { name: "Add a meal" }).first(), touch);
    assert.equal(await page.locator(".week-picker[open]").count(), 0, "an outside tap must dismiss the picker");
    const dialog = page.getByRole("dialog", { name: "Add a meal" });
    await dialog.waitFor();
    assert(await dialog.locator(".selected-recipe").evaluate((card: HTMLElement) => {
      const bounds = card.getBoundingClientRect();
      return [...card.children].every(child => {
        const box = child.getBoundingClientRect();
        return box.top >= bounds.top && box.bottom <= bounds.bottom && box.left >= bounds.left && box.right <= bounds.right;
      });
    }), "recipe preview must grow to contain its photo and wrapped title in the scrollable form");
    for (const control of [dialog.getByLabel("Date", { exact: true }), dialog.getByRole("combobox", { name: /^Meal/ })]) {
      assert(await control.evaluate((element: HTMLElement) => {
        const box = element.getBoundingClientRect();
        const label = element.closest("label")!.getBoundingClientRect();
        return box.left >= label.left && box.right <= label.right + 1;
      }), "date and meal controls must stay inside their own columns");
    }
    if (capture) await screenshot(page, `${label}-meal-preview`);
    await dialog.getByLabel(/note for this meal/i).fill("UNSAVED UI smoke draft");
    await auditLayout(page, touch);
    if (capture) await screenshot(page, `${label}-meal-dialog`);
    await cancelDialog(page);
  });

  await check(label, page.context().browser()?.browserType().name() ?? "webkit", `${page.viewportSize().width}×${page.viewportSize().height}`, "planned recipe opens shared fullscreen details and preserves nested meal drafts", async () => {
    const card = page.locator(".meal-card:not(.note-only-card)").first();
    const title = await card.locator("h3").textContent();
    await activate(card, touch);
    const detail = page.getByRole("dialog", { name: "Recipe details" });
    await detail.waitFor();
    assert.equal(await detail.locator("h1").textContent(), title);
    const bounds = await detail.boundingBox();
    assert.equal(bounds.width, page.viewportSize().width);
    assert.equal(bounds.height, page.viewportSize().height);
    assert(await detail.getByRole("button", { name: "Edit recipe", exact: true }).isVisible());
    await auditLayout(page, touch);
    if (capture) await screenshot(page, `${label}-planned-recipe-detail`);
    await page.keyboard.press("Escape");
    await detail.waitFor({ state: "detached" });
    assert.equal(await page.getByRole("dialog").count(), 0, "direct recipe close returns to the plan, not the editor");
    await activate(card, touch);
    await activate(page.getByRole("button", { name: "Edit meal", exact: true }), touch);
    const meal = page.getByRole("dialog", { name: "Edit meal" });
    await meal.waitFor();
    const viewport = page.viewportSize();
    const mobileEditor = viewport.width <= 850 || touch && viewport.height <= 500;
    const editorBounds = await meal.boundingBox();
    if (mobileEditor) {
      assert.deepEqual(editorBounds, { x: 0, y: 0, ...viewport }, "mobile meal editor fills the viewport");
      const heading = await meal.locator(".modal-heading").boundingBox();
      const footer = await meal.locator(".form-actions").boundingBox();
      const fields = meal.locator(".meal-form-fields");
      const fieldBounds = await fields.boundingBox();
      assert(fieldBounds.y >= heading.y + heading.height, "fields start below the fixed header");
      assert(fieldBounds.y + fieldBounds.height <= footer.y, "footer must not overlay scrolling fields");
      await fields.evaluate((element: HTMLElement) => { element.scrollTop = element.scrollHeight; });
      assert.deepEqual(await meal.locator(".modal-heading").boundingBox(), heading);
      assert.deepEqual(await meal.locator(".form-actions").boundingBox(), footer);
      const note = await meal.getByLabel(/note for this meal/i).boundingBox();
      assert(note.y + note.height <= footer.y, "last field stays fully reachable above the footer");
      if (capture) await screenshot(page, `${label}-fullscreen-meal-scrolled`);
      await fields.evaluate((element: HTMLElement) => { element.scrollTop = 0; });
    } else {
      assert(editorBounds.width < viewport.width && editorBounds.height < viewport.height, "desktop retains a contained dialog");
    }
    if (capture) await screenshot(page, `${label}-edit-meal`);
    await meal.getByLabel("Date", { exact: true }).fill("2030-01-06");
    await meal.getByRole("combobox", { name: /^Meal/ }).selectOption("Lunch");
    await meal.getByLabel("Recipe scale", { exact: true }).selectOption("1.5");
    await meal.getByLabel(/note for this meal/i).fill("UNSAVED planner recipe draft");
    for (const exit of ["Back to meal", "Close dialog", "Escape"]) {
      await activate(meal.locator(".selected-recipe"), touch);
      await detail.waitFor();
      assert.equal(await detail.getByLabel("Preview recipe scale").inputValue(), "1.5");
      await detail.getByLabel("Preview recipe scale").selectOption("3");
      if (exit === "Escape") await page.keyboard.press("Escape");
      else await activate(detail.getByRole("button", { name: exit, exact: true }), touch);
      await meal.waitFor();
      assert.equal(await meal.getByLabel("Date", { exact: true }).inputValue(), "2030-01-06");
      assert.equal(await meal.getByRole("combobox", { name: /^Meal/ }).inputValue(), "Lunch");
      assert.equal(await meal.getByLabel("Recipe scale", { exact: true }).inputValue(), "1.5");
      assert.equal(await meal.getByLabel(/note for this meal/i).inputValue(), "UNSAVED planner recipe draft");
    }
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
      for (const [name, destination] of [["Ingredients", "recipe-ingredients"], ["Steps", "recipe-steps"]]) {
        await page.getByRole("link", { name, exact: true }).focus();
        await page.keyboard.press("Enter");
        assert.equal(new URL(page.url()).hash, "#recipes", "Cooking shortcuts must preserve app navigation");
        assert.equal(await page.evaluate(() => document.activeElement?.id), destination, "Keyboard focus must follow the cooking shortcut");
        await page.keyboard.press("Tab");
        if (name === "Ingredients") assert(await page.getByLabel("Preview recipe scale").evaluate((element: HTMLElement) => element === document.activeElement), "Tab must continue from Ingredients, not return to the shortcut toolbar");
      }
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
    for (const name of ["Import recipe", "Manage collections"]) {
      for (const escape of [true, false]) {
        const options = page.getByLabel("Page options", { exact: true });
        await options.focus(); await page.keyboard.press("Enter");
        await page.getByRole("button", { name, exact: true }).focus();
        await page.keyboard.press("Enter");
        await page.locator("dialog[open]").waitFor();
        if (escape) {
          await page.keyboard.press("Escape");
          await page.locator("dialog[open]").waitFor({ state: "detached" });
        } else await cancelDialog(page);
        await settle(page);
        assert(await options.evaluate((element: HTMLElement) => element === document.activeElement), `${name} dismissal must return focus to visible Page options`);
      }
    }
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
  await check(label, page.context().browser()?.browserType().name() ?? "webkit", `${page.viewportSize().width}×${page.viewportSize().height}`, "focused page-options menu activates Arrange route with pointer input", async () => {
    await page.goto(`${root}/#shopping`); await settle(page);
    const options = page.getByLabel("Page options", { exact: true });
    await options.focus();
    await page.keyboard.press("Enter");
    await page.evaluate(() => {
      const menu = document.querySelector(".page-options")!;
      (window as any).optionsEvents = [];
      for (const type of ["pointerdown", "focusout", "click"]) menu.addEventListener(type, (event: Event) => {
        (window as any).optionsEvents.push({ type, target: (event.target as HTMLElement).tagName, related: (event as FocusEvent).relatedTarget instanceof HTMLElement ? ((event as FocusEvent).relatedTarget as HTMLElement).tagName : null });
      }, { capture: true });
    });
    await activate(page.getByRole("button", { name: "Arrange route", exact: true }), touch);
    assert(await page.locator(".route-editor").isVisible(), `Arrange route did not activate: ${JSON.stringify(await page.evaluate(() => (window as any).optionsEvents))}`);
    await activate(options, touch);
    await activate(page.getByRole("button", { name: "Done arranging", exact: true }), touch);
    assert.equal(await page.locator(".route-editor").count(), 0);
    await options.focus();
    await page.keyboard.press("Enter");
    // Exercise browsers that clear focus rather than focusing a pointer-activated menu button.
    await page.evaluate(() => {
      document.querySelector(".page-options-menu button")!.addEventListener("pointerdown", event => {
        event.preventDefault();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }, { once: true });
    });
    await activate(page.getByRole("button", { name: "Arrange route", exact: true }), touch);
    assert(await page.locator(".route-editor").isVisible(), `Focus loss swallowed Arrange route: ${JSON.stringify(await page.evaluate(() => (window as any).optionsEvents))}`);
    await activate(options, touch);
    await activate(page.getByRole("button", { name: "Done arranging", exact: true }), touch);
    await activate(options, touch);
    await activate(page.getByRole("heading", { name: "Shopping list", exact: true }), touch);
    assert.equal(await page.locator(".page-options").getAttribute("open"), null, "outside pointer input must still dismiss the menu");
    await options.focus(); await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Arrange route", exact: true }).focus();
    await page.getByLabel("New household item").focus();
    assert.equal(await page.locator(".page-options").getAttribute("open"), null, "moving keyboard focus outside must dismiss the menu");
  });
  await check(label, page.context().browser()?.browserType().name() ?? "webkit", `${page.viewportSize().width}×${page.viewportSize().height}`, "List Builder, details/grips, membership persistence and route recovery", async () => {
    await page.goto(`${root}/#shopping`); await settle(page);
    assert.equal(await page.locator(".shopping-range").count(), 0);
    await activate(page.getByRole("button", { name: "List Builder", exact: true }), touch);
    assert.equal(await page.locator(".purchase-row").count(), original.groceries.length);
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
        const fallback = key.startsWith('["shopping-list",') ? 1 : 0;
        const before = original.checks.find((entry: any) => entry.key === key)?.checked ?? fallback;
        const after = current.checks.find((entry: any) => entry.key === key)?.checked ?? fallback;
        if (before !== after) changedChecks.add(key);
      }
      assert.equal(await page.locator(".purchase-row").count(), original.groceries.length, "Builder must always show every grocery");
      const restored = page.getByLabel(name!); await restored.waitFor();
      if ((await restored.isChecked()) !== was) await activate(restored, touch);
      await page.locator(".shopping-save-status").waitFor({ state: "detached" });
    }
    await activate(page.getByRole("button", { name: "Exit List Builder" }), touch);
    await activate(page.getByLabel("Page options", { exact: true }), touch);
    await activate(page.getByRole("button", { name: "Arrange route" }), touch);
    assert(await page.locator(".route-editor").isVisible());
    await activate(page.getByRole("button", { name: "List Builder", exact: true }), touch);
    assert(await page.locator(".app-shell.shopping-mode").isVisible());
    assert.equal(await page.locator(".route-editor").count(), 0, "shopping mode must replace the editor with a checklist");
    assert(await page.locator('.purchase-row input[type="checkbox"]').first().isVisible());
    if (capture) await screenshot(page, `${label}-shopping-mode`);
    await activate(page.getByRole("button", { name: "Exit List Builder" }), touch);
    assert.equal(await page.locator(".route-editor").count(), 0, "exit must retain the usable checklist");
    await auditLayout(page, touch);
  });

  await check(label, page.context().browser()?.browserType().name() ?? "webkit", `${page.viewportSize().width}×${page.viewportSize().height}`, "catalog package size, product disclosure, and no single-item grips", async () => {
    await activate(page.getByRole("button", { name: "List Builder", exact: true }), touch);
    const counts = await page.locator(".purchase-group").evaluateAll((groups: Element[]) => groups.map(group => ({
      linked: group.getAttribute("aria-label") !== "Needs linking",
      rows: group.querySelectorAll(".purchase-row").length,
      grips: group.querySelectorAll(".route-drag").length,
    })));
    for (const group of counts) assert.equal(group.grips, group.linked && group.rows > 1 ? group.rows : 0);
    assert.equal(await page.locator(".purchase-review,.purchase-need").count(), 0);
    const product = page.locator(".purchase-row").first();
    const compactHeight = (await product.boundingBox()).height;
    if (page.viewportSize().width >= 393) assert(compactHeight <= 82, `collapsed warning row is too tall: ${compactHeight}px`);
    await activate(product.locator("summary"), touch);
    assert(await product.getByRole("button", { name: "Edit product" }).isVisible());
    await auditLayout(page, touch);
    if (capture) await screenshot(page, `${label}-product-expanded`);
    await activate(product.locator("summary"), touch);
    assert.equal((await product.boundingBox()).height, compactHeight);
    if (capture) await screenshot(page, `${label}-builder-compact`);
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
    await activate(page.getByRole("button", { name: "List Builder", exact: true }), touch);
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
    await activate(page.getByRole("button", { name: "List Builder", exact: true }), touch);
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
    await activate(page.getByRole("button", { name: "Exit List Builder" }), touch);
    await activate(page.getByLabel("Page options", { exact: true }), touch);
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
    await activate(page.getByRole("button", { name: "List Builder", exact: true }), touch);
    await group.locator(".purchase-row").first().waitFor();
    assert.deepEqual(await names(), originalNames);
    assert.deepEqual((await household()).checks, before.checks);
    await activate(page.getByRole("button", { name: "Exit List Builder" }), touch);
  });
  await check(label, page.context().browser()?.browserType().name() ?? "webkit", `${page.viewportSize().width}×${page.viewportSize().height}`, "whole-aisle dragging, rename, cancellation and reload persistence", async () => {
    await page.reload(); await settle(page);
    await activate(page.getByLabel("Page options", { exact: true }), touch);
    await activate(page.getByRole("button", { name: "Arrange route" }), touch);
    const before = await household();
    const sections = page.locator(".route-aisle");
    const names = () => sections.locator("h3").allTextContents();
    const initial = await names();
    assert(initial.length >= 3, "aisle smoke needs three aisles");
    const sourceIndex = 2;
    const grip = sections.nth(sourceIndex).locator(".aisle-heading > .route-drag");
    await grip.scrollIntoViewIfNeeded();
    const box = await grip.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 12);
    await sections.first().evaluate((element: HTMLElement) => element.scrollIntoView({ block: "center" }));
    const target = await sections.first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, target.y + target.height / 2 - 10, { steps: 15 });
    await page.waitForFunction(() => !!document.querySelector(".route-aisle.drop-target"));
    if (capture) await screenshot(page, `${label}-aisle-dragging`);
    changedOrder = true;
    await page.mouse.up();
    await page.locator(".shopping-save-status").waitFor({ state: "detached" });
    assert.deepEqual(await names(), [initial[2], initial[0], initial[1], ...initial.slice(3)]);
    const moved = await household();
    assert.deepEqual(moved.shoppingOrder.items, before.shoppingOrder.items);
    assert.deepEqual(moved.groceries, before.groceries);
    assert.deepEqual(moved.checks, before.checks);
    const viewport = page.viewportSize();
    const cancelGrip = sections.first().locator(".aisle-heading > .route-drag");
    await cancelGrip.scrollIntoViewIfNeeded();
    const cancelBox = await cancelGrip.boundingBox();
    await page.mouse.move(cancelBox.x + 22, cancelBox.y + 22);
    await page.mouse.down();
    await page.mouse.move(cancelBox.x + 22, cancelBox.y + 40);
    await page.waitForFunction(() => !!document.querySelector(".route-aisle.is-dragging"));
    await page.setViewportSize({ ...viewport, width: viewport.width + 20 });
    await page.waitForFunction(() => !document.querySelector(".route-aisle.is-dragging"));
    await page.mouse.up();
    await page.setViewportSize(viewport);
    assert.deepEqual((await household()).shoppingOrder, moved.shoppingOrder, "resizing must cancel an aisle drag without saving");
    await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === "running"));
    await page.evaluate(() => {
      const fetch = window.fetch;
      (window as any).aisleFetch = fetch;
      window.fetch = (...args) => String(args[0]).endsWith("/api/shopping-order") && args[1]?.method === "PUT"
        ? new Promise((_, reject) => setTimeout(() => reject(new Error("Aisle smoke rejected save")), 80)) : fetch(...args);
    });
    try {
      await page.evaluate(() => {
        const aisle = document.querySelector(".route-aisle")!;
        const product = aisle.querySelector(".route-product")!;
        const relativeTop = product.getBoundingClientRect().top - aisle.getBoundingClientRect().top;
        const start = performance.now();
        const w = window as any;
        w.aisleFrameErrors = [];
        w.aisleFramesDone = false;
        const sample = () => {
          w.aisleFrameErrors.push(Math.abs(product.getBoundingClientRect().top - aisle.getBoundingClientRect().top - relativeTop));
          if (performance.now() - start < 700) requestAnimationFrame(sample);
          else w.aisleFramesDone = true;
        };
        sample();
      });
      await activate(sections.first().locator('.aisle-heading button[aria-label$="down"]'), touch);
      await page.waitForFunction(() => (window as any).aisleFramesDone);
      await page.locator(".shopping-save-status").waitFor({ state: "detached" });
      assert.deepEqual(await names(), [initial[2], initial[0], initial[1], ...initial.slice(3)]);
      assert(await page.evaluate(() => (window as any).aisleFrameErrors.every((offset: number) => offset < 1)), "aisle animation/rollback must move products together with their heading");
      assert.deepEqual((await household()).shoppingOrder, moved.shoppingOrder);
    } finally {
      await page.evaluate(() => { window.fetch = (window as any).aisleFetch; });
    }
    await page.reload(); await settle(page);
    await activate(page.getByLabel("Page options", { exact: true }), touch);
    await activate(page.getByRole("button", { name: "Arrange route" }), touch);
    assert.deepEqual(await names(), [initial[2], initial[0], initial[1], ...initial.slice(3)]);
    if (page.context().browser()?.browserType().name() === "chromium") {
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
        const touchGrip = sections.nth(1).locator(".aisle-heading > .route-drag");
        await touchGrip.scrollIntoViewIfNeeded();
        const touchBox = await touchGrip.boundingBox();
        const touchTarget = await sections.nth(2).boundingBox();
        await page.evaluate(() => { (window as any).aislePointer = ""; document.addEventListener("pointerdown", event => { (window as any).aislePointer = event.pointerType; }, { once: true }); });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchBox.x + 22, y: touchBox.y + 22 }] });
        await page.waitForFunction(() => !!document.querySelector(".route-aisle.is-dragging"));
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: touchBox.x + 22, y: touchTarget.y + touchTarget.height / 2 + 10 }] });
        await page.waitForFunction(() => !!document.querySelector(".route-aisle.drop-target"));
        assert.equal(await page.evaluate(() => (window as any).aislePointer), "touch");
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.locator(".shopping-save-status").waitFor({ state: "detached" });
        assert.deepEqual((await household()).shoppingOrder, { ...moved.shoppingOrder, aisles: [moved.shoppingOrder.aisles[0], moved.shoppingOrder.aisles[2], moved.shoppingOrder.aisles[1], ...moved.shoppingOrder.aisles.slice(3)] });
      } finally {
        await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
        await cdp.detach();
      }
      await api("shopping-order", "PUT", moved.shoppingOrder);
      await page.reload(); await settle(page);
      await activate(page.getByLabel("Page options", { exact: true }), touch);
      await activate(page.getByRole("button", { name: "Arrange route" }), touch);
    }
    const oldName = moved.shoppingOrder.aisles[0];
    const newName = `Smoke aisle ${Date.now()}`;
    await activate(sections.first().getByRole("button", { name: /^Rename / }), touch);
    await page.getByLabel("Aisle name", { exact: true }).fill("Canceled aisle");
    await page.keyboard.press("Escape");
    assert.equal(await page.getByLabel("Aisle name", { exact: true }).count(), 0);
    assert.deepEqual((await household()).groceries, before.groceries);
    await activate(sections.first().getByRole("button", { name: /^Rename / }), touch);
    await page.getByLabel("Aisle name", { exact: true }).fill(newName);
    await auditLayout(page, touch);
    if (capture) await screenshot(page, `${label}-aisle-renaming`);
    renamedAisles.set(newName, oldName);
    await activate(page.getByRole("button", { name: "Save", exact: true }), touch);
    await page.getByLabel("Aisle name", { exact: true }).waitFor({ state: "detached" });
    const renamed = await household();
    assert.deepEqual(renamed.groceries, before.groceries.map((item: any) => item.aisle === oldName ? { ...item, aisle: newName } : item));
    assert.deepEqual(renamed.shoppingOrder, { ...moved.shoppingOrder, aisles: [newName, ...moved.shoppingOrder.aisles.slice(1)] });
    assert.deepEqual(renamed.checks, before.checks);
    await page.reload(); await settle(page);
    await activate(page.getByRole("button", { name: "List Builder", exact: true }), touch);
    assert.equal(await page.locator(".purchase-group h3").first().textContent(), `Aisle ${newName}`);
    await api("shopping-aisles", "PUT", { from: newName, to: oldName });
    renamedAisles.delete(newName);
    await api("shopping-order", "PUT", before.shoppingOrder);
    await page.reload(); await settle(page);
    await activate(page.getByLabel("Page options", { exact: true }), touch);
    await activate(page.getByRole("button", { name: "Arrange route" }), touch);
    await auditLayout(page, touch);
    if (capture) await screenshot(page, `${label}-aisle-controls`);
    await activate(page.getByLabel("Page options", { exact: true }), touch);
    await activate(page.getByRole("button", { name: "Done arranging" }), touch);
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
    await closeContext(tablet.context);

    const enlarged = await makeContext(wk, { width: 320, height: 568 }, true, true);
    const zoom = enlarged.page;
    await zoom.goto(`${root}/#recipes`); await settle(zoom);
    await activate(zoom.locator(".timer-toggle"), true);
    await zoom.locator('[name="timerName"]').fill("Large text timer");
    await zoom.locator('[name="timerMinutes"]').fill("2");
    await activate(zoom.getByRole("button", { name: "Start timer", exact: true }), true);
    await activate(zoom.getByRole("button", { name: "Collapse timers" }), true);
    await zoom.locator(".recipe-row-main").first().tap();
    await check("webkit-active-modal-320", "webkit", "320×568 DPR2", "active countdown, quick controls, title and Close do not overlap", async () => {
      await zoom.locator(".recipe-detail").waitFor();
      await auditLayout(zoom, true);
      const heading = await zoom.locator(".modal-heading").boundingBox();
      const timer = await zoom.locator(".timer-header").boundingBox();
      const close = await zoom.getByRole("button", { name: "Close dialog" }).boundingBox();
      assert(timer.y >= close.y + close.height, "active timer must use its own header row");
      assert(timer.y + timer.height <= heading.y + heading.height, "timer must stay inside the dialog header");
      for (const button of await zoom.locator(".timer-header-actions button").all()) {
        const bounds = await button.boundingBox();
        assert(bounds.width >= 44 && bounds.height >= 44);
      }
      await screenshot(zoom, "active-modal-320");
    });
    await cancelDialog(zoom);
    await zoom.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    for (const route of ["plan", "recipes", "shopping", "groceries"]) {
      await check(`webkit-text200-${route}`, "webkit", "320×568 DPR2 200% text", "no horizontal overflow; labeled tabs and active countdown remain contained", async () => {
        await zoom.locator(`nav a[href="#${route}"]`).tap();
        await settle(zoom);
        assert.equal(await zoom.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
        for (const label of await zoom.locator(".nav-label").all()) {
          const bounds = await label.boundingBox();
          const parent = await label.locator("..").boundingBox();
          assert(bounds.x >= parent.x && bounds.x + bounds.width <= parent.x + parent.width + 1, "tab text must wrap within its target");
        }
        assert(await zoom.locator(".timer-toggle strong").evaluate((element: HTMLElement) => element.scrollWidth <= element.clientWidth), "countdown must not clip");
        await screenshot(zoom, `text200-${route}`);
      });
    }
    await closeContext(enlarged.context);
  } finally {
    await Promise.allSettled(contexts.map(closeContext));
    await Promise.allSettled([chrome.close(), wk.close()]);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  // Browser writes are drained and contexts closed before restoring the exact snapshot.
  try {
    for (const [from, to] of renamedAisles) {
      if ((await household()).groceries.some((item: any) => item.aisle === from))
        await api("shopping-aisles", "PUT", { from, to });
    }
    const current = await household();
    for (const extra of current.extras) if (tempExtraIds.has(extra.id) || tempExtraNames.has(extra.name)) await api(`extras/${encodeURIComponent(extra.id)}`, "DELETE");
    if (changedOrder && JSON.stringify(current.shoppingOrder) !== JSON.stringify(original.shoppingOrder)) await api("shopping-order", "PUT", original.shoppingOrder);
    const allCheckKeys = new Set([...changedChecks, ...current.checks.map((entry: any) => entry.key), ...original.checks.map((entry: any) => entry.key)]);
    for (const key of allCheckKeys) {
      const fallback = key.startsWith('["shopping-list",') ? 1 : 0;
      const wanted = original.checks.find((entry: any) => entry.key === key)?.checked ?? fallback;
      const now = current.checks.find((entry: any) => entry.key === key)?.checked ?? fallback;
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
