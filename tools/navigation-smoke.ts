import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { HouseholdSchema, RecipeId } from "../src/domain.ts";

// Supplied by ui:setup alongside the browser runtime below.
// @ts-ignore Browser declarations exist only after task ui:setup, outside the checkout.
import type * as Playwright from "/tmp/hearth-ui/node_modules/@playwright/test/index.d.ts";

declare global {
  /** Browser-only capture used to verify the share payload without opening a native sheet. */
  interface Window {
    /** Share payload captured by this smoke's platform-boundary replacement. */
    shared?: ShareData;
  }
}

// Supplied by the repository's ui:setup task, not a project dependency.
// @ts-expect-error External browser runtime.
const { chromium, webkit, devices, expect }: typeof Playwright = await import("/tmp/hearth-ui/node_modules/@playwright/test/index.mjs");
const root = new URL(process.argv[2] ?? "http://localhost:5173").origin;
assert(["localhost", "127.0.0.1"].includes(new URL(root).hostname), "Disposable local data only");
const artifacts = resolve(".amp/in/artifacts");
await mkdir(artifacts, { recursive: true });
const withoutRevision = <T extends { readonly revision?: string }>({ revision: _revision, ...value }: T) => value;
// Fixture restoration rotates tokens; compare every household domain field separately.
const householdContent = (state: typeof HouseholdSchema.Encoded) => ({ ...state,
  recipes: state.recipes.map(withoutRevision), meals: state.meals.map(withoutRevision),
  groceries: state.groceries.map(withoutRevision), collections: state.collections.map(withoutRevision),
  extras: state.extras.map(withoutRevision), shoppingOrder: withoutRevision(state.shoppingOrder),
});
const original = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
const id = () => crypto.randomUUID();
const collection = { id: id(), name: "Navigation smoke collection" };
const grocery = { id: id(), name: "Navigation smoke lentils", unit: "g", quantity: 500, url: "", aisle: "Pantry", aliases: ["Navigation lentils", "Brown lentils"] };
const recipe = { id: RecipeId.make(id()), title: "Navigation smoke lentil soup", description: "Disposable browser fixture", servings: 3, minutes: 20, category: collection.name, photo: "", source: "", rating: "neutral", ingredients: [{ name: grocery.name, quantity: 250, unit: "g", groceryItemId: grocery.id }], instructions: ["Simmer until tender."] };
const meal = { id: id(), recipeId: recipe.id, date: "2026-11-02", slot: "Dinner", scale: 1.5, note: "Soak the lentils before cooking and keep a portion mild for the kids.\nPack the leftovers for tomorrow's lunch. This final sentence must remain visible, not truncated." };
const noteMeal = { ...meal, id: id(), recipeId: null, note: "Navigation smoke note-only control" };
const edgeMeals = [
  { ...noteMeal, id: id(), date: "2026-10-31", note: "Navigation first-column meal" },
  { ...noteMeal, id: id(), date: "2026-11-06", note: "Navigation final-row meal" },
  { ...noteMeal, id: id(), date: "2026-11-08", note: "Navigation next-week meal" },
  { ...noteMeal, id: id(), date: "2026-10-23", note: "Navigation earlier-week meal" },
];
async function api(path: string, method: string, body?: unknown) {
  // These are intentional fixture writes, not the browser's stale-write requests.
  const resource = path.split("/")[0];
  if ((method === "PUT" || method === "DELETE") && (resource === "recipes" || resource === "meals" || resource === "groceries" || resource === "collections" || resource === "extras")) {
    const current = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
    const id = method === "DELETE" ? decodeURIComponent(path.slice(resource.length + 1)) : Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(body).id;
    const saved = current[resource].find(item => item.id === id);
    if (method === "DELETE" && !saved) return;
    body = { ...(typeof body === "object" && body !== null ? body : {}), expectedRevision: saved?.revision ?? null };
  }
  const response = await fetch(`${root}/api/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert(response.ok, `${method} ${path}: HTTP ${response.status}`);
}
const errors: string[] = [];
let count = 0;
try {
  await api("collections", "PUT", collection);
  await api("groceries", "PUT", grocery);
  await api("recipes", "PUT", { ...recipe, expectedIngredients: null });
  await api("meals", "PUT", meal);
  await api("meals", "PUT", noteMeal);
  for (const entry of edgeMeals) await api("meals", "PUT", entry);
  for (const [engine, profile, options] of [
    [chromium, "desktop", { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }],
    [chromium, "touch", { ...devices["iPhone SE"], deviceScaleFactor: 2 }],
    [webkit, "iphone", devices["iPhone 14"]],
    [webkit, "ipad", devices["iPad (gen 7)"]],
  ] as const) {
    const browser = await engine.launch();
    const context = await browser.newContext(options);
    const page = await context.newPage();
    let scenario = "initial load";
    page.on("pageerror", error => {
      const message = `${profile}: ${scenario}: ${error.name}: ${error.message}`;
      errors.push(message);
      console.error(message);
    });
    try {
      const check = async (name: string, run: () => Promise<void>) => {
        if (process.argv.includes("--plan-only") && !/meal.plan/.test(name)) return;
        if (process.argv.includes("--meals-only") && !/meal|nested editors/.test(name)) return;
        if (process.argv.includes("--substitutions-only") && !/same-source meals/.test(name)) return;
        if (process.argv.includes("--grocery-links-only") && !/meal grocery link counts/.test(name)) return;
        scenario = name;
        await run(); count++; console.log(`PASS ${profile}: ${name}`);
      };
      const open = async (hash: string) => {
        await page.goto(`${root}/${hash}`, { waitUntil: "networkidle" });
        // Hash-only navigation does not reread fixtures restored through the API between scenarios.
        await page.reload({ waitUntil: "networkidle" });
        await expect(page.locator(".calendar,.recipe-list,.shopping-layout,.grocery-catalog,.recipe-checklist").first()).toBeVisible();
      };
      const shot = async (name: string) => {
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: resolve(artifacts, `navigation-${profile}-${name}.png`) });
      };
      const dialog = () => page.locator("dialog[open]");
      if (profile === "touch") await check("scrolled iPhone SE meal actions survive activation and dismiss only when moved", async () => {
        await open("#plan?week=2026-11-02");
        const toggle = page.getByRole("button", { name: `Actions for meal ${recipe.title}`, exact: true });
        const nextFrame = () => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        await toggle.evaluate(element => element.scrollIntoView({ block: "center" }));
        await nextFrame();
        assert(await page.evaluate(() => scrollY) > 0, "Regression requires a scrolled small screen");
        // Chromium's pointer activation can queue a same-position scroll after opening.
        // Cover it as well as native touch; neither should close an anchored menu.
        for (const input of ["click", "tap"] as const) {
          await toggle[input]();
          // Re-deliver a queued scroll at the current position deterministically.
          await page.evaluate(() => document.dispatchEvent(new Event("scroll")));
          await nextFrame();
          await expect(toggle).toHaveAttribute("aria-expanded", "true");
          const edit = page.getByRole("button", { name: "Edit meal", exact: true });
          await expect(edit).toBeVisible();
          if (input === "click") await shot("scrolled-meal-actions");
          await edit[input]();
          await expect(dialog()).toHaveAttribute("aria-label", "Edit meal");
          await expect(dialog().getByLabel("Meal note", { exact: true })).toHaveValue(meal.note);
          await dialog().getByRole("button", { name: "Close dialog", exact: true })[input]();
          await expect(dialog()).toHaveCount(0);
        }
        await toggle.tap();
        await nextFrame();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        const before = await toggle.boundingBox();
        assert(before);
        await page.evaluate(() => scrollBy(0, -60));
        await expect.poll(async () => (await toggle.boundingBox())?.y).not.toBe(before.y);
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await expect(page.locator(".meal-actions")).toHaveCount(0);
        await toggle.tap();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await page.touchscreen.tap(8, 300);
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await toggle.tap();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        const viewport = page.viewportSize();
        assert(viewport);
        await page.setViewportSize({ ...viewport, width: viewport.width + 1 });
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await page.setViewportSize(viewport);
      });
      if (profile === "touch") await check("native touch tap, swipe, cancellation, scrolling, hold-to-edit and exact meal deletion", async () => {
        const cdp = await context.newCDPSession(page);
        const card = page.locator(".meal-card").filter({ hasText: recipe.title });
        const remove = page.getByRole("button", { name: `Delete meal ${recipe.title}`, exact: true });
        const touch = async (dx: number, dy: number, duration = 160, cancel = false) => {
          await card.scrollIntoViewIfNeeded();
          const box = await card.boundingBox();
          assert(box);
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
          for (let step = 1; step <= 8; step++) {
            await page.waitForTimeout(duration / 8);
            await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * step / 8, y: y + dy * step / 8 }] });
          }
          await cdp.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
        };
        try {
          await open("#plan?week=2026-10-31");
          await card.tap();
          await expect(dialog()).toHaveAttribute("aria-label", "Meal details");
          await expect(dialog().getByRole("button", { name: "Edit meal", exact: true })).toHaveText("Edit meal");
          await expect(dialog().getByText("Manage ingredient links", { exact: true })).toHaveCount(0);
          await expect(dialog().getByRole("button", { name: "Edit recipe", exact: true })).toHaveCount(0);
          await dialog().getByRole("button", { name: "Close dialog" }).tap();
          await touch(-16, 0, 400);
          await expect(remove).toBeHidden();
          await expect(dialog()).toHaveCount(0);
          await touch(-110, 0);
          await expect(remove).toBeVisible();
          await expect(dialog()).toHaveCount(0);
          await shot("swipe-delete");
          await page.evaluate(() => document.dispatchEvent(new Event("scroll")));
          await expect(remove).toBeHidden();
          await touch(-110, 0);
          await expect(remove).toBeVisible();
          await touch(110, 0);
          await expect(remove).toBeHidden();
          await touch(-110, 0, 160, true);
          await expect(remove).toBeHidden();
          await card.scrollIntoViewIfNeeded();
          const beforeScroll = await page.evaluate(() => scrollY);
          await touch(2, -100);
          await page.waitForTimeout(600);
          assert(await page.evaluate(() => scrollY) > beforeScroll, "Vertical touch on a card must scroll the page");
          await expect(dialog()).toHaveCount(0);
          await expect(remove).toBeHidden();
          await card.scrollIntoViewIfNeeded();
          const heldBox = await card.boundingBox();
          assert(heldBox);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: heldBox.x + heldBox.width / 2, y: heldBox.y + heldBox.height / 2 }] });
          await page.evaluate(() => document.dispatchEvent(new Event("scroll")));
          await page.waitForTimeout(650);
          await expect(dialog()).toHaveCount(0);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
          await touch(0, 0, 650);
          await expect(dialog()).toHaveAttribute("aria-label", "Edit meal");
          await shot("hold-edit");
          await dialog().getByLabel("Meal note", { exact: true }).fill("Edited with a long press");
          await dialog().getByRole("button", { name: "Save meal", exact: true }).tap();
          await expect(dialog()).toHaveCount(0);
          const edited = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
          assert.equal(edited.meals.find(item => item.id === meal.id)?.note, "Edited with a long press");
          await touch(-110, 0);
          // Chromium briefly suppresses taps after a native swipe to prevent accidental activation.
          await page.waitForTimeout(400);
          await remove.tap();
          await expect(card).toHaveCount(0);
          const remaining = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
          assert(!remaining.meals.some(item => item.id === meal.id));
          assert(remaining.meals.some(item => item.id === noteMeal.id));
          assert(remaining.recipes.some(item => item.id === recipe.id), "Deleting a meal must preserve its recipe");
          await page.reload();
          await expect(card).toHaveCount(0);
          await page.locator(".meal-card").filter({ hasText: noteMeal.note }).tap();
          await expect(dialog()).toHaveAttribute("aria-label", "Edit meal");
          await expect(dialog().getByLabel(/^What’s the plan\?/)).toHaveValue(noteMeal.note);
          await expect(dialog().getByRole("button", { name: "Save", exact: true })).toBeVisible();
        } finally {
          await cdp.detach();
          await api("meals", "PUT", meal);
        }
      });
      await check("grocery packaging and individual alternative names save, cancel and reopen in the mobile fullscreen editor", async () => {
        try {
          await open(`#groceries?view=grocery&id=${grocery.id}`);
          const editor = page.getByRole("dialog", { name: "Grocery item", exact: true });
          if ((page.viewportSize()?.width ?? 0) <= 850) {
            const box = await editor.boundingBox();
            assert.deepEqual(box, { x: 0, y: 0, ...page.viewportSize() });
          }
          await editor.getByRole("button", { name: "Navigation lentils", exact: true }).click();
          await editor.getByLabel("Alternative 1", { exact: true }).fill("  Red lentils  ");
          await editor.getByLabel("Alternative 1", { exact: true }).press("Enter");
          await editor.getByRole("button", { name: "Remove alternative Brown lentils", exact: true }).click();
          await editor.getByRole("button", { name: "Add Alternative", exact: true }).click();
          await editor.getByLabel("Alternative 2", { exact: true }).fill("Puy lentils");
          await editor.getByLabel("Alternative 2", { exact: true }).press("Enter");
          await editor.getByLabel("Package quantity", { exact: true }).selectOption("custom");
          await editor.getByLabel("Custom package quantity", { exact: true }).fill("3.75");
          await editor.getByLabel("Package unit", { exact: true }).selectOption("cup");
          await shot("grocery-packaging-alternatives");
          await editor.getByRole("button", { name: "Save grocery item", exact: true }).click();
          await expect(dialog()).toHaveCount(0);
          const saved = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
          const product = saved.groceries.find(item => item.id === grocery.id);
          assert(product);
          assert.deepEqual(product.aliases, ["Red lentils", "Puy lentils"]);
          assert.equal(product.quantity, 3.75);
          assert.equal(product.unit, "cup");
          await open(`#groceries?view=grocery&id=${grocery.id}`);
          await expect(editor.getByRole("button", { name: "Red lentils", exact: true })).toBeVisible();
          await expect(editor.getByLabel("Package quantity", { exact: true })).toHaveValue("3.75");
          await editor.getByRole("button", { name: "Add Alternative", exact: true }).click();
          await editor.getByLabel("Alternative 3", { exact: true }).fill("Unsaved alternative");
          await editor.getByRole("button", { name: "Cancel", exact: true }).click();
          const canceled = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
          assert.deepEqual(canceled.groceries.find(item => item.id === grocery.id), product);
          await open(`#recipes?view=editor&id=${recipe.id}`);
          await dialog().getByLabel("Recipe name", { exact: true }).fill("Unsaved nested recipe");
          await dialog().locator(".ingredient-link-editor > summary").first().click();
          await dialog().getByRole("button", { name: "Edit product", exact: true }).click();
          const nested = page.getByRole("dialog", { name: "Grocery item for ingredient", exact: true });
          await expect(nested.getByRole("heading", { name: "Packaging", exact: true })).toBeVisible();
          if ((page.viewportSize()?.width ?? 0) <= 850)
            assert.deepEqual(await nested.boundingBox(), { x: 0, y: 0, ...page.viewportSize() });
          await nested.getByRole("button", { name: "Cancel", exact: true }).click();
          await expect(dialog().getByLabel("Recipe name", { exact: true })).toHaveValue("Unsaved nested recipe");
        } finally { await api("groceries", "PUT", grocery); }
      });
      await check("nested editors keep the outer scroll lock and Back restores page scrolling", async () => {
        await open("#plan?week=2026-10-31");
        const bodyStyle = await page.evaluate(() => document.body.style.cssText);
        await page.locator(".meal-card").filter({ hasText: recipe.title }).click();
        await dialog().getByRole("button", { name: "Edit meal", exact: true }).click();
        await dialog().locator(".ingredient-link-editor > summary").first().click();
        await dialog().getByRole("button", { name: "Edit product", exact: true }).click();
        const nested = page.getByRole("dialog", { name: "Grocery item for ingredient", exact: true });
        await nested.getByRole("button", { name: "Cancel", exact: true }).click();
        if ((page.viewportSize()?.width ?? 0) <= 850)
          assert.equal(await page.evaluate(() => document.body.style.position), "fixed");
        await dialog().getByRole("button", { name: "Edit product", exact: true }).click();
        await expect(nested).toBeVisible();
        await page.goBack();
        await expect(dialog()).toHaveAttribute("aria-label", "Meal details");
        await page.goBack();
        await expect(dialog()).toHaveCount(0);
        assert.equal(await page.evaluate(() => document.body.style.cssText), bodyStyle);
        if ((page.viewportSize()?.width ?? 0) <= 600) {
          await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
          await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
        }
      });
      await check("meal actions remain pointer-accessible at the calendar's first column and final row", async () => {
        try {
          for (const entry of edgeMeals) {
            await open(`#plan?week=${entry.date}`);
            const toggle = page.getByRole("button", { name: `Actions for meal ${entry.note}`, exact: true });
            await toggle.scrollIntoViewIfNeeded();
            await toggle.click();
            const panel = page.locator(".meal-actions");
            await expect(panel).toBeVisible();
            for (const name of ["Edit meal", "Delete meal"]) {
              const button = panel.getByRole("button", { name, exact: true });
              assert(await button.evaluate(element => {
                const box = element.getBoundingClientRect();
                return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
              }), `${name} must not be clipped or covered`);
            }
            await shot(entry === edgeMeals[0] ? "meal-actions-first" : "meal-actions-last");
            await panel.getByRole("button", { name: "Edit meal", exact: true }).click();
            await expect(dialog()).toHaveAttribute("aria-label", "Edit meal");
            await dialog().getByRole("button", { name: "Close dialog", exact: true }).click();
            await toggle.click();
            await panel.getByRole("button", { name: "Delete meal", exact: true }).click();
            await expect(toggle).toHaveCount(0);
            const state = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
            assert(!state.meals.some(item => item.id === entry.id));
          }
        } finally { for (const entry of edgeMeals) await api("meals", "PUT", entry); }
      });
      await check("recipe review normalizes totals, retains pantry edits and preserves an intervening client's count", async () => {
        const prototypeId = ["__proto__", "constructor", "toString"].find(candidate => !original.groceries.some(item => item.id === candidate));
        assert(prototypeId, "An unused prototype-key ID is needed for the disposable grocery fixture");
        const products = [
          { ...grocery, id: id(), name: "Review rice", quantity: 500, unit: "g", aliases: [] },
          { ...grocery, id: id(), name: "Review oil", quantity: 250, unit: "ml", aliases: [] },
          { ...grocery, id: id(), name: "Review butter", quantity: 1, unit: "lb", aliases: [] },
          { ...grocery, id: id(), name: "Review salt", quantity: 100, unit: "g", aliases: [] },
          { ...grocery, id: id(), name: "Review exact boundary", quantity: 0.3, unit: "g", aliases: [] },
          { ...grocery, id: id(), name: "Review above boundary", quantity: 300, unit: "g", aliases: [] },
          { ...grocery, id: prototypeId, name: "Review pantry", quantity: 1, unit: "each", aliases: [] },
          { ...grocery, id: id(), name: "Review existing", quantity: 500, unit: "g", aliases: [] },
        ];
        const ingredient = (index: number, quantity: number, unit: string) => ({ name: products[index].name, groceryItemId: products[index].id, quantity, unit });
        const reviewRecipes = [
          { ...recipe, id: id(), title: "Package review dinner", ingredients: [ingredient(0, 400, "g"), ingredient(1, 1, "cup"), ingredient(2, 8, "oz"), ingredient(3, 10, "g"), ingredient(4, 0.1, "g"), ingredient(5, 300.00001, "g"), ingredient(6, 3, "each"), ingredient(7, 200, "g")] },
          { ...recipe, id: id(), title: "Package review lunch", ingredients: [ingredient(0, 0.8, "kg"), ingredient(1, 2, "tbsp"), ingredient(1, 3, "tsp"), ingredient(2, 0.75, "lb"), ingredient(3, 1, "tsp"), ingredient(4, 0.2, "g")] },
        ];
        try {
          for (const product of products) await api("groceries", "PUT", product);
          for (const entry of reviewRecipes) await api("recipes", "PUT", entry);
          await api("checks", "PUT", { key: JSON.stringify(["shopping-list", products[7].id]), checked: 0, packages: 5 });
          await open("#shopping?view=shopping-recipes");
          await page.reload();
          for (const entry of reviewRecipes) await dialog().getByRole("checkbox", { name: new RegExp(entry.title) }).check();
          await dialog().getByRole("button", { name: "Review items", exact: true }).click();
          const count = (index: number) => dialog().getByRole("spinbutton", { name: `Packages to buy for ${products[index].name}`, exact: true });
          const row = (index: number) => dialog().locator(".shopping-review-item").filter({ hasText: products[index].name });
          await expect(row(0)).toContainText("Recipes need 1.2 kg");
          await expect(row(1)).toContainText("Recipes need 280.95 ml");
          await expect(row(2)).toContainText("Recipes need 1.25 lb");
          await expect(row(3)).toContainText("Recipes need 10 g + 4.93 ml");
          for (const [index, expected] of [[0, "3"], [1, "2"], [2, "2"], [3, ""], [4, "1"], [5, "2"], [6, "3"]] as const)
            await expect(count(index)).toHaveValue(expected);
          await expect(count(7)).toHaveCount(0);
          await expect(dialog().locator(".primary")).toBeDisabled();
          await count(3).fill("4");
          await count(0).fill("1.5");
          await expect(dialog().locator(".primary")).toBeDisabled();
          await count(0).fill("2");
          await count(6).fill("0");
          await expect(dialog().getByRole("button", { name: "Add 6 items", exact: true })).toBeEnabled();
          await dialog().getByRole("button", { name: "Back", exact: true }).click();
          await dialog().getByRole("button", { name: "Review items", exact: true }).click();
          await expect(count(0)).toHaveValue("2");
          await expect(count(6)).toHaveValue("0");
          await row(0).scrollIntoViewIfNeeded();
          await shot("recipe-package-review");
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          // A second client adds products during review, including the last queued addition.
          for (const index of [1, 3])
            await api("checks", "PUT", { key: JSON.stringify(["shopping-list", products[index].id]), checked: 0, packages: 5 });
          await dialog().getByRole("button", { name: "Add 6 items", exact: true }).click();
          await expect(dialog()).toHaveCount(0);
          await expect(page.locator(".purchase-row").filter({ hasText: products[1].name })).toContainText("5 × 250 ml");
          await expect(page.locator(".purchase-row").filter({ hasText: products[3].name })).toContainText("5 × 100 g");
          await page.reload();
          await expect(page.locator(".purchase-row").filter({ hasText: products[0].name })).toContainText("2 × 500 g");
          const state = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
          for (const [index, packages] of [[0, 2], [1, 5], [2, 2], [3, 5], [4, 1], [5, 2], [7, 5]] as const)
            assert.equal(state.checks.find(entry => entry.key === JSON.stringify(["shopping-list", products[index].id]))?.packages, packages);
          assert(!state.checks.some(entry => entry.key === JSON.stringify(["shopping-list", products[6].id])));
          for (const product of products) {
            const saved = state.groceries.find(entry => entry.id === product.id);
            assert(saved?.revision, "Saved grocery has a revision");
            assert.deepEqual(withoutRevision(saved), product);
          }
          await shot("recipe-package-list");
        } finally {
          for (const entry of reviewRecipes) await api(`recipes/${entry.id}`, "DELETE");
          for (const product of products) await api(`groceries/${product.id}`, "DELETE");
        }
      });
      await check("selected meal-plan week, Back/Forward, direct open and reload", async () => {
        await open("#plan?week=2026-10-31");
        await expect(page.getByRole("heading", { name: "Oct 31 – Nov 6, 2026" })).toBeVisible();
        await expect(page.getByRole("button", { name: /^(Next|Previous) week$/ })).toHaveCount(0);
        const note = page.locator(".meal-note").filter({ hasText: meal.note });
        await expect(note).toBeVisible();
        assert(await note.evaluate(element => {
          const style = getComputedStyle(element);
          return parseFloat(style.fontSize) >= 16 && style.whiteSpace === "pre-wrap" &&
            style.webkitLineClamp === "none" && element.scrollHeight <= element.clientHeight + 1;
        }), "Meal notes must be readable, preserve line breaks and remain fully visible");
        assert(await page.locator(".meal-card h3").first().evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 18));
        if (profile !== "desktop") {
          assert(await page.evaluate(() => matchMedia("(pointer: coarse)").matches));
          const days = await page.locator(".day").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
          assert(days.every((day, index) => day.x === days[0].x && (index === 0 || day.y >= days[index - 1].bottom)), "Touch layouts must stack all seven days vertically");
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Meal plan must not scroll horizontally");
        await shot("readable-plan");
        await note.scrollIntoViewIfNeeded();
        await shot("meal-notes");
        if (profile === "ipad" || profile === "desktop") {
          await page.setViewportSize({ width: 1366, height: 1024 });
          assert(await page.locator(".calendar").first().evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length === 1), "Landscape tablet widths must retain one vertical day column, with or without touch input");
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await shot("landscape-plan");
          await page.setViewportSize(options.viewport);
        }
        await page.getByText("Jump to date", { exact: true }).click();
        await expect(page.locator(".date-picker-weekday")).toHaveText(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
        await page.getByRole("button", { name: "Next month", exact: true }).click();
        await expect(page.locator(".date-picker-heading strong")).toHaveText("November 2026");
        await expect(page.locator(".date-picker-grid button").first()).toHaveAttribute("aria-label", "Monday, October 26, 2026");
        await shot("date-picker");
        await page.getByRole("button", { name: "Tuesday, November 10, 2026", exact: true }).click();
        await expect(page).toHaveURL(/week=2026-11-07/);
        await expect(page.locator("#plan-2026-11-10")).toBeFocused();
        await expect(page.locator(".date-picker[open]")).toHaveCount(0);
        await page.getByText("Jump to date", { exact: true }).click();
        await expect(page.getByRole("button", { name: "Tuesday, November 10, 2026", exact: true })).toHaveAttribute("aria-pressed", "true");
        await page.getByRole("button", { name: "Wednesday, November 11, 2026", exact: true }).click();
        await expect(page.locator("#plan-2026-11-11")).toBeFocused();
        const selected = await page.locator("#plan-2026-11-11").boundingBox();
        const viewport = page.viewportSize();
        const header = await page.locator(".topbar").boundingBox();
        assert(selected && viewport && header && selected.y >= header.y + header.height && selected.y < viewport.height, "The exact selected day must be scrolled below the sticky header, even within the same week");
        await page.goBack();
        await expect(page.getByRole("heading", { name: "Oct 31 – Nov 6, 2026" })).toBeVisible();
        await page.goForward();
        await expect(page.getByRole("heading", { name: "Nov 7 – Nov 13, 2026" })).toBeVisible();
        await page.reload();
        await expect(page.getByRole("heading", { name: "Nov 7 – Nov 13, 2026" })).toBeVisible();
        await shot("plan");
      });
      await check("meal plan scrolls through successive weeks without moving existing days", async () => {
        await open("#plan?week=2026-10-31");
        for (const [last, next] of [["2026-11-06", "2026-11-07"], ["2026-11-13", "2026-11-14"], ["2026-11-20", "2026-11-21"]]) {
          const lastDay = page.locator(`#plan-${last}`);
          await lastDay.evaluate(element => element.scrollIntoView({ block: "center" }));
          const before = await lastDay.boundingBox();
          await expect(page.locator(`#plan-${next}`)).toHaveCount(1);
          const after = await lastDay.boundingBox();
          assert(before && after && Math.abs(before.y - after.y) < 2, "Appending a week must preserve the existing day position");
        }
        await expect(page.locator("#plan-2026-11-08")).toContainText("Navigation next-week meal");
        await expect(page).toHaveURL(/week=2026-10-31$/);
        const appended = page.locator("#plan-2026-11-22");
        await appended.getByRole("button", { name: /Add meal for/ }).click();
        await expect(dialog().getByLabel("Date", { exact: true })).toHaveValue("2026-11-22");
        await dialog().getByRole("button", { name: "Close dialog", exact: true }).click();
        await page.evaluate(() => scrollTo(0, 0));
        await page.getByText("Jump to date", { exact: true }).click();
        await page.getByRole("button", { name: "Next month", exact: true }).click();
        await page.getByRole("button", { name: "Tuesday, November 10, 2026", exact: true }).click();
        await expect(page.locator("#plan-2026-11-10")).toBeFocused();
        await expect(page.locator("#plan-2026-11-22")).toHaveCount(0);
        await open("#plan?week=2026-12-26");
        await page.locator("#plan-2027-01-01").evaluate(element => element.scrollIntoView({ block: "center" }));
        await expect(page.getByRole("heading", { name: "Jan 2 – Jan 8, 2027" })).toBeVisible();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      });
      await check("meal plan scrolls backwards with stable days and usable date navigation", async () => {
        await open("#plan?week=2026-10-31");
        await expect(page.locator("#plan-2026-10-24")).toHaveCount(1);
        await shot("bidirectional-plan");
        for (const [first, previous] of [["2026-10-24", "2026-10-17"], ["2026-10-17", "2026-10-10"], ["2026-10-10", "2026-10-03"]]) {
          const firstDay = page.locator(`#plan-${first}`);
          await firstDay.evaluate(element => element.scrollIntoView({ block: "center" }));
          const before = await firstDay.boundingBox();
          await expect(page.locator(`#plan-${previous}`)).toHaveCount(1);
          const after = await firstDay.boundingBox();
          assert(before && after && Math.abs(before.y - after.y) < 2, "Prepending a week must preserve the existing day position");
        }
        await shot("earlier-weeks");
        await expect(page.locator("#plan-2026-10-23")).toContainText("Navigation earlier-week meal");
        await expect(page).toHaveURL(/week=2026-10-31$/);
        await page.locator("#plan-2026-10-11").getByRole("button", { name: /Add meal for/ }).click();
        await expect(dialog().getByLabel("Date", { exact: true })).toHaveValue("2026-10-11");
        await dialog().getByRole("button", { name: "Close dialog", exact: true }).click();
        await expect(page).toHaveURL(/week=2026-10-31$/);
        const jump = page.getByText("Jump to date", { exact: true });
        const box = await jump.boundingBox();
        const toolbar = await page.locator(".topbar").boundingBox();
        assert(box && toolbar && box.y >= toolbar.y + toolbar.height && box.y < 160, "Date navigation must remain on screen while scrolling backwards");
        await jump.click();
        await page.getByRole("button", { name: "Saturday, October 31, 2026", exact: true }).click();
        await expect(page.locator("#plan-2026-10-31")).toBeFocused();
        const selected = await page.locator("#plan-2026-10-31").boundingBox();
        const controls = await page.locator(".plan-toolbar").boundingBox();
        assert(selected && controls && selected.y >= controls.y + controls.height, "A jumped day must not be hidden behind sticky date controls");
        await open("#plan?week=2027-01-02");
        await expect(page.getByRole("heading", { name: "Dec 26, 2026 – Jan 1, 2027" })).toBeVisible();
        await page.locator("#plan-2026-12-26").evaluate(element => element.scrollIntoView({ block: "center" }));
        await expect(page.locator("#plan-2026-12-19")).toHaveCount(1);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      });
      await check("shopping focus, builder, arrange and navigation history", async () => {
        await open("#shopping?mode=focus");
        await expect(page.getByRole("button", { name: "Exit shopping mode", exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator(".shopping-summary button, .shopping-summary a")).toHaveCount(1);
        await shot("shopping");
        await page.getByRole("button", { name: "Exit shopping mode", exact: true }).click();
        await expect(page.getByRole("button", { name: /(Hide|Show) checked/ })).toHaveCount(0);
        await page.getByRole("button", { name: "List Builder", exact: true }).click();
        await expect(page).toHaveURL(/mode=builder/);
        await page.goBack();
        await expect(page.getByRole("button", { name: "Shopping mode", exact: true })).toBeVisible();
        await page.goBack();
        await expect(page.getByRole("button", { name: "Exit shopping mode", exact: true })).toBeVisible();
        await page.goForward();
        await page.goForward();
        await page.reload();
        await expect(page.getByRole("button", { name: "Exit List Builder", exact: true })).toBeVisible();
        await page.getByLabel("Search grocery items", { exact: true }).fill(grocery.name);
        await expect(page).toHaveURL(/search=Navigation/);
        await page.reload();
        await expect(page.getByLabel("Search grocery items", { exact: true })).toHaveValue(grocery.name);
        await open("#shopping?mode=arrange");
        await expect(page.locator(".page-options summary")).toBeVisible();
        await page.locator(".page-options summary").click();
        await expect(page.getByRole("button", { name: "Done arranging", exact: true })).toHaveAttribute("aria-pressed", "true");
      });
      await check("meal details, saved meal context, scaling and editor Back", async () => {
        await open(`#plan?week=2026-10-31&view=recipe&id=${recipe.id}&meal=${meal.id}&scale=2`);
        await expect(dialog()).toHaveAttribute("aria-label", "Meal details");
        await expect(dialog().locator("h1")).toHaveText(recipe.title);
        await expect(dialog().getByLabel("Preview recipe scale")).toHaveValue("2");
        await expect(dialog()).toContainText("6 servings");
        await dialog().getByRole("button", { name: "Edit meal", exact: true }).click();
        await expect(page).toHaveURL(/view=editor/);
        await page.goBack();
        await expect(dialog().locator("h1")).toHaveText(recipe.title);
        await expect(dialog().getByLabel("Preview recipe scale")).toHaveValue("2");
        await page.goForward();
        await expect(dialog()).toHaveAttribute("aria-label", "Edit meal");
        await page.goBack();
        await shot("recipe");
      });
      await check("fresh deep link Back stays in Hearth; reload does not grow history", async () => {
        const direct = await context.newPage();
        try {
          await direct.goto(`${root}/#recipes?view=recipe&id=${recipe.id}`);
          await expect(direct.locator("dialog[open] h1")).toHaveText(recipe.title);
          const length = await direct.evaluate(() => history.length);
          await direct.reload();
          await expect(direct.locator("dialog[open] h1")).toHaveText(recipe.title);
          assert.equal(await direct.evaluate(() => history.length), length);
          await direct.goBack();
          await expect(direct).toHaveURL(`${root}/#recipes`);
          await expect(direct.locator("dialog[open]")).toHaveCount(0);
          await direct.goForward();
          await expect(direct.locator("dialog[open] h1")).toHaveText(recipe.title);
        } finally { await direct.close(); }
      });
      await check("direct recipe close stays in Hearth; missing/deleted entities recover", async () => {
        await open(`#recipes?view=recipe&id=${recipe.id}`);
        await dialog().getByRole("button", { name: "Close dialog" }).click();
        await expect(dialog()).toHaveCount(0);
        await expect(page).toHaveURL(`${root}/#recipes`);
        await open(`#recipes?view=recipe&id=${id()}`);
        await expect(page.getByRole("alert")).toContainText("no longer available");
        await expect(dialog()).toHaveCount(0);
        await shot("missing");
      });
      await check("all saved entity and flow links hydrate from household data", async () => {
        for (const [hash, title] of [
          [`#plan?week=2026-10-31&view=meal&id=${meal.id}`, "Edit meal"],
          [`#plan?week=2026-10-31&view=editor&id=${recipe.id}&meal=${meal.id}`, "Edit meal"],
          [`#plan?week=2026-10-31&view=meal&id=${noteMeal.id}`, "Edit meal"],
          [`#groceries?view=grocery&id=${grocery.id}`, "Grocery item"],
          [`#recipes?view=collection&id=${collection.id}`, "Edit collection"],
          [`#recipes?view=editor&id=${recipe.id}`, "Edit recipe"],
          ["#recipes?view=collections", "Manage collections"],
          ["#recipes?view=import", "Import a recipe"],
          ["#shopping?view=shopping-recipes", "Add from recipes"],
          ["#plan?view=chatgpt", "Use Hearth in ChatGPT"],
          ["#recipes?view=editor", "Add a recipe"],
          ["#groceries?view=grocery", "Grocery item"],
          ["#recipes?view=collection", "Add collection"],
          [`#plan?week=2026-10-31&view=meal&date=2026-11-06&recipe=${recipe.id}`, "Add a meal"],
        ]) {
          await open(hash);
          await expect(dialog()).toHaveAttribute("aria-label", title);
          await expect(dialog().getByRole("button", { name: "Share link" })).toBeVisible();
        }
      });
      await check("nested meal draft survives preview Back, never leaks into URL/history or reload", async () => {
        await open(`#plan?week=2026-10-31&view=meal&date=2026-11-06&recipe=${recipe.id}`);
        await dialog().getByLabel(/A note for this meal/).fill("PRIVATE DRAFT DO NOT SHARE");
        await dialog().getByRole("button", { name: /View recipe/ }).click();
        await expect(dialog()).toHaveAttribute("aria-label", "Meal details");
        assert(!page.url().includes("PRIVATE"));
        assert(!JSON.stringify(await page.evaluate(() => history.state)).includes("PRIVATE"));
        await page.goBack();
        await expect(dialog().getByLabel(/A note for this meal/)).toHaveValue("PRIVATE DRAFT DO NOT SHARE");
        await page.reload();
        await expect(dialog().getByLabel(/A note for this meal/)).toHaveValue("");
      });
      await check("recipe collection/search and grocery search links restore filters", async () => {
        await open(`#recipes?collection=${collection.id}&search=lentil`);
        await expect(page.locator(".recipe-row-main")).toHaveCount(1);
        await expect(page.locator(".recipe-row-main")).toContainText(recipe.title);
        await page.reload();
        await expect(page.locator(".recipe-row-main")).toHaveCount(1);
        await page.locator(".recipe-row-main").click();
        await expect(page).toHaveURL(new RegExp(`view=recipe&id=${recipe.id}`));
        await dialog().getByRole("button", { name: "Close dialog" }).click();
        await expect(dialog()).toHaveCount(0);
        await expect(page).toHaveURL(`${root}/#recipes?collection=${collection.id}&search=lentil`);
        await expect(page.locator(".recipe-row-main")).toHaveCount(1);
        await open(`#groceries?search=${encodeURIComponent(grocery.name)}`);
        await expect(page.getByRole("button", { name: `Edit grocery item ${grocery.name}` })).toBeVisible();
      });
      await check("recipe sort by title or addition order is shareable and follows Back", async () => {
        const titles = new Map([...original.recipes.map((entry) => [entry.id, entry.title] as const), [recipe.id, recipe.title]]);
        const oldest = [...original.recipesAdded, recipe.id].map((entry) => titles.get(entry) ?? entry);
        const az = [...titles.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
        const rows = page.locator(".recipe-row h2");
        const sort = page.getByLabel("Sort recipes");
        await open("#recipes");
        await expect(sort).toHaveValue("az");
        await expect(rows).toHaveText(az);
        await sort.selectOption("newest");
        await expect(page).toHaveURL(`${root}/#recipes?sort=newest`);
        await expect(rows).toHaveText([...oldest].reverse());
        await sort.selectOption("za");
        await expect(rows).toHaveText([...az].reverse());
        await page.goBack();
        await expect(sort).toHaveValue("newest");
        await expect(rows.first()).toHaveText(recipe.title);
        await open(`#recipes?collection=${collection.id}&sort=oldest`);
        await page.reload();
        await expect(sort).toHaveValue("oldest");
        await expect(rows).toHaveText([recipe.title]);
        await open("#recipes?sort=oldest");
        await expect(rows).toHaveText(oldest);
      });
      await check("UI navigation creates shareable meal links; saved edits close to a reloadable page", async () => {
        try {
          await open("#plan?week=2026-10-31");
          await page.locator(".meal-card").filter({ hasText: recipe.title }).click();
          await expect(page).toHaveURL(`${root}/#plan?week=2026-10-31&view=recipe&id=${recipe.id}&meal=${meal.id}`);
          await expect(dialog()).toHaveAttribute("aria-label", "Meal details");
          await expect(dialog().getByRole("button", { name: "Edit meal", exact: true })).toBeVisible();
          await dialog().getByRole("button", { name: "Close dialog" }).click();
          await page.getByRole("button", { name: `Actions for meal ${recipe.title}`, exact: true }).click();
          await page.getByRole("button", { name: "Edit meal", exact: true }).focus();
          await page.keyboard.press("Escape");
          await expect(page.getByRole("button", { name: `Actions for meal ${recipe.title}`, exact: true })).toBeFocused();
          await expect(page.getByRole("button", { name: "Edit meal", exact: true })).toHaveCount(0);
          await page.getByRole("button", { name: `Actions for meal ${recipe.title}`, exact: true }).click();
          await page.getByRole("button", { name: "Edit meal", exact: true }).click();
          await expect(page).toHaveURL(new RegExp(`view=editor&id=${recipe.id}&meal=${meal.id}`));
          await expect(dialog()).toHaveAttribute("aria-label", "Edit meal");
          await dialog().getByLabel("Meal note", { exact: true }).fill("Saved by navigation E2E");
          const saved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/meals" && response.request().method() === "PUT");
          await dialog().getByRole("button", { name: "Save meal", exact: true }).click();
          assert.equal((await saved).status(), 200, "Meal editor save must be accepted before closing");
          await expect(dialog()).toHaveCount(0);
          await expect(page).toHaveURL(`${root}/#plan?week=2026-10-31`);
          await page.reload();
          await open(`#plan?week=2026-10-31&view=editor&id=${recipe.id}&meal=${meal.id}`);
          await expect(dialog().getByLabel("Meal note", { exact: true })).toHaveValue("Saved by navigation E2E");
        } finally { await api("meals", "PUT", meal); }
      });
      await check("same-source meals keep independent snapshots, inline notes and navigation identity", async () => {
        const before = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
        const first = before.meals.find(entry => entry.id === meal.id);
        assert(first?.recipe, "The first fixture must have a persisted meal snapshot");
        const second = { ...meal, id: id(), note: "Independent second meal control" };
        const substitute = { ...grocery, id: id(), name: "Navigation smoke chickpeas", aliases: [] };
        const edited = {
          ...first,
          note: "Only the first meal gets this editor note.",
          recipe: {
            ...first.recipe,
            title: "Navigation independently edited lentil dinner",
            ingredients: first.recipe.ingredients.map(item => ({ ...item, name: substitute.name, quantity: 375, groceryItemId: substitute.id })),
            instructions: ["Simmer this dinner gently, then rest for five minutes."],
          },
        };
        try {
          await api("groceries", "PUT", substitute);
          await api("meals", "PUT", second);
          const seeded = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
          const secondSaved = seeded.meals.find(entry => entry.id === second.id);
          assert(secondSaved?.recipe);
          assert.deepEqual(secondSaved.recipe, first.recipe, "Both meals start with the same source content");
          await open("#plan?week=2026-10-31");
          await page.locator(".meal-card").filter({ hasText: first.note }).click();
          await expect(dialog()).toHaveAttribute("aria-label", "Meal details");
          const detailUrl = page.url();
          assert.equal(new URLSearchParams(new URL(detailUrl).hash.split("?")[1]).get("meal"), first.id);
          await dialog().getByRole("button", { name: "Edit meal", exact: true }).click();
          await expect(dialog()).toHaveAttribute("aria-label", "Edit meal");
          await expect(dialog().getByLabel("Meal name", { exact: true })).toHaveValue(first.recipe.title);
          await expect(dialog().getByLabel("Date", { exact: true })).toHaveValue(first.date);
          await expect(dialog().getByLabel("Meal", { exact: true })).toHaveValue(first.slot);
          await expect(dialog().getByLabel("Scale", { exact: true })).toHaveValue(String(first.scale));
          await dialog().getByLabel("Meal name", { exact: true }).fill(edited.recipe.title);
          await dialog().getByLabel("Ingredient 1 name", { exact: true }).fill(edited.recipe.ingredients[0].name);
          await dialog().getByLabel("Ingredient 1 quantity", { exact: true }).fill("375");
          await dialog().getByLabel("Step 1", { exact: true }).fill(edited.recipe.instructions[0]);
          await dialog().getByLabel("Meal note", { exact: true }).fill(edited.note);
          const editorUrl = page.url();
          await dialog().getByRole("button", { name: "Save meal", exact: true }).click();
          await expect(dialog()).toHaveCount(0);
          await page.reload();
          await expect(page.locator(".meal-card").filter({ hasText: edited.recipe.title })).toContainText(edited.note);
          await expect(page.locator(".meal-card").filter({ hasText: second.note })).toContainText(recipe.title);
          const saved = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
          assert.deepEqual(householdContent(saved), householdContent({ ...seeded, meals: seeded.meals.map(entry => entry.id === first.id ? edited : entry) }), "Editing one meal must preserve the second snapshot, source recipes and the rest of the household");

          await page.locator(".meal-card").filter({ hasText: edited.recipe.title }).click();
          await expect(page).toHaveURL(detailUrl);
          await expect(dialog().locator(".ingredient-list")).toContainText(edited.recipe.ingredients[0].name);
          await expect(dialog().locator(".instructions")).toContainText(edited.recipe.instructions[0]);
          await dialog().getByRole("button", { name: "View recipe", exact: true }).click();
          await expect(dialog()).toHaveAttribute("aria-label", "Recipe details");
          await expect(dialog().locator("h1")).toHaveText(recipe.title);
          await expect(dialog().getByRole("button", { name: "Edit recipe", exact: true })).toHaveText("Edit recipe");
          await expect(dialog().locator(".ingredient-list li")).toHaveCount(1);
          await expect(dialog().locator(".ingredient-list")).toContainText(grocery.name);
          await expect(dialog().locator(".ingredient-list strong")).toHaveText("250 g");
          await expect(dialog().locator(".instructions li p")).toHaveText(recipe.instructions);
          const historyEntries = dialog().locator(".meal-history-entry");
          await expect(historyEntries).toHaveCount(2);
          await expect(historyEntries.filter({ hasText: edited.recipe.title })).toContainText(edited.note);
          await historyEntries.filter({ hasText: edited.recipe.title }).click();
          await expect(page).toHaveURL(detailUrl);
          await expect(dialog()).toHaveAttribute("aria-label", "Meal details");
          await expect(dialog().locator("h1")).toHaveText(edited.recipe.title);
          await page.goBack();
          await expect(dialog()).toHaveAttribute("aria-label", "Recipe details");
          await page.goBack();
          await expect(page).toHaveURL(detailUrl);
          await expect(dialog().locator("h1")).toHaveText(edited.recipe.title);

          const firstNote = "First meal inline note; keep its edited ingredients and steps.";
          await dialog().getByRole("button", { name: "Edit meal note", exact: true }).click();
          await dialog().getByLabel("Meal note", { exact: true }).fill(firstNote);
          await dialog().getByRole("button", { name: "Save note", exact: true }).click();
          await expect(dialog().locator(".meal-detail-note p")).toHaveText(firstNote);
          await expect(page).toHaveURL(detailUrl);
          const firstNoted = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
          assert.deepEqual(householdContent(firstNoted), householdContent({ ...saved, meals: saved.meals.map(entry => entry.id === first.id ? { ...edited, note: firstNote } : entry) }));
          await dialog().getByRole("button", { name: "Close dialog", exact: true }).click();
          await page.locator(".meal-card").filter({ hasText: second.note }).click();
          await expect(dialog().locator("h1")).toHaveText(recipe.title);
          const secondNote = "Second meal inline note; keep the original snapshot.";
          await dialog().getByRole("button", { name: "Edit meal note", exact: true }).click();
          await dialog().getByLabel("Meal note", { exact: true }).fill(secondNote);
          await dialog().getByRole("button", { name: "Save note", exact: true }).click();
          await expect(dialog().locator(".meal-detail-note p")).toHaveText(secondNote);
          await page.reload();
          await expect(dialog().locator("h1")).toHaveText(recipe.title);
          await expect(dialog().locator(".meal-detail-note p")).toHaveText(secondNote);
          await expect(dialog().locator(".ingredient-list strong")).toHaveText("375 g");
          await expect(dialog().locator(".instructions li p")).toHaveText(recipe.instructions);
          const bothNoted = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
          assert.deepEqual(householdContent(bothNoted), householdContent({ ...firstNoted, meals: firstNoted.meals.map(entry => entry.id === second.id ? { ...secondSaved, note: secondNote } : entry) }));

          const direct = await context.newPage();
          try {
            await direct.goto(detailUrl);
            await expect(direct.getByRole("dialog", { name: "Meal details", exact: true })).toBeVisible();
            await expect(direct.locator("dialog[open] h1")).toHaveText(edited.recipe.title);
            await expect(direct.locator(".meal-detail-note p")).toHaveText(firstNote);
            const length = await direct.evaluate(() => history.length);
            await direct.reload();
            await expect(direct.locator("dialog[open] h1")).toHaveText(edited.recipe.title);
            assert.equal(await direct.evaluate(() => history.length), length);
            await direct.goBack();
            await expect(direct).toHaveURL(`${root}/#plan?week=2026-10-31`);
            await expect(direct.locator("dialog[open]")).toHaveCount(0);
            await direct.goForward();
            await expect(direct).toHaveURL(detailUrl);
            await expect(direct.locator("dialog[open] h1")).toHaveText(edited.recipe.title);
          } finally { await direct.close(); }
          await page.goto(editorUrl);
          await expect(dialog().getByLabel("Meal name", { exact: true })).toHaveValue(edited.recipe.title);
          await expect(dialog().getByLabel("Ingredient 1 name", { exact: true })).toHaveValue(edited.recipe.ingredients[0].name);
          await expect(dialog().getByLabel("Ingredient 1 quantity", { exact: true })).toHaveValue("375");
          await expect(dialog().getByLabel("Step 1", { exact: true })).toHaveValue(edited.recipe.instructions[0]);
          await expect(dialog().getByLabel("Meal note", { exact: true })).toHaveValue(firstNote);
          await shot("independent-meal-editor");

          await open("#shopping?view=shopping-recipes");
          await dialog().getByRole("checkbox", { name: new RegExp(edited.recipe.title) }).check();
          await dialog().getByRole("button", { name: "Review items", exact: true }).click();
          await expect(dialog().locator(".shopping-review-item")).toHaveCount(1);
          await expect(dialog().locator(".shopping-review-item")).toContainText(substitute.name);
          await expect(dialog().locator(".shopping-review-item")).toContainText("Recipes need 562.5 g");
          await expect(dialog().getByLabel(`Packages to buy for ${substitute.name}`, { exact: true })).toHaveValue("2");
          await shot("substituted-meal-groceries");
          await dialog().getByRole("button", { name: "Back", exact: true }).click();
          await dialog().getByRole("checkbox", { name: new RegExp(recipe.title) }).check();
          await dialog().getByRole("button", { name: "Review items", exact: true }).click();
          await expect(dialog().locator(".shopping-review-item")).toHaveCount(2);
          await expect(dialog().getByLabel(`Packages to buy for ${grocery.name}`, { exact: true })).toHaveValue("1");
          await dialog().getByRole("button", { name: "Add 2 items", exact: true }).click();
          await expect(dialog()).toHaveCount(0);
          await page.reload();
          const shopped = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
          assert.equal(shopped.checks.find(entry => entry.key === JSON.stringify(["shopping-list", substitute.id]))?.packages, 2);
          assert.equal(shopped.checks.find(entry => entry.key === JSON.stringify(["shopping-list", grocery.id]))?.packages, 1);
          assert.deepEqual(shopped.recipes, bothNoted.recipes);
          assert.deepEqual(shopped.meals, bothNoted.meals);

          const checklist = `#recipe-checklist?selectedMeal=${first.id}&selectedMeal=${second.id}&checklist=1`;
          await open(checklist);
          const ingredientsNeeded = page.getByLabel("Ingredients needed", { exact: true });
          await expect(ingredientsNeeded.locator("label")).toHaveCount(2);
          await expect(ingredientsNeeded.locator("label").filter({ hasText: substitute.name })).toContainText("562.5 g");
          await expect(ingredientsNeeded.locator("label").filter({ hasText: grocery.name })).toContainText("375 g");
          await page.reload();
          await expect(ingredientsNeeded.locator("label").filter({ hasText: substitute.name })).toContainText("562.5 g");
          await ingredientsNeeded.scrollIntoViewIfNeeded();
          await shot("substituted-meal-checklist");
        } finally {
          // Omission preserves a snapshot, so restoration must send the captured content explicitly.
          try { await api("meals", "PUT", first); }
          finally {
            await api(`meals/${second.id}`, "DELETE");
            await api("checks", "PUT", { key: JSON.stringify(["shopping-list", grocery.id]), checked: 1 });
            await api(`groceries/${substitute.id}`, "DELETE");
          }
          const restored = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
          assert.deepEqual(householdContent(restored), householdContent(before), "Independent-meal cleanup must preserve all pre-scenario data");
        }
      });
      await check("meal grocery link counts agree with review and recovery names the owning editor", async () => {
        const automatic = { ...grocery, id: id(), name: "Late matching chickpeas", aliases: [] };
        const deleted = { ...grocery, id: id(), name: "Deleted grocery", aliases: [] };
        const ambiguous = [
          { ...grocery, id: id(), name: "First ambiguous product", aliases: ["Ambiguous ingredient"] },
          { ...grocery, id: id(), name: "Second ambiguous product", aliases: ["Ambiguous ingredient"] },
        ];
        const source = { ...recipe, id: id(), title: "Grocery link meal", ingredients: [
          { name: automatic.name, quantity: 100, unit: "g" },
          { name: automatic.name, quantity: 200, unit: "g" },
          { name: deleted.name, quantity: 100, unit: "g", groceryItemId: deleted.id },
          { name: automatic.name, quantity: 100, unit: "g", groceryItemId: null },
          { name: "Ambiguous ingredient", quantity: 100, unit: "g" },
        ] };
        const unplanned = { ...recipe, id: id(), title: "Unlinked source recipe", ingredients: [{ name: automatic.name, quantity: 100, unit: "g", groceryItemId: null }] };
        const planned = { ...meal, id: id(), recipeId: source.id, scale: 2 };
        try {
          await api("groceries", "PUT", deleted);
          await api("recipes", "PUT", source);
          await api("recipes", "PUT", unplanned);
          await api("meals", "PUT", planned);
          for (const product of [automatic, ...ambiguous]) await api("groceries", "PUT", product);
          await api(`groceries/${deleted.id}`, "DELETE");
          await open("#shopping?view=shopping-recipes");
          const row = dialog().locator("label.shopping-recipe-option").filter({ hasText: source.title });
          const preview = dialog().locator(".shopping-recipe-preview");
          await expect(row).toContainText("2 of 5 ingredients linked");
          await row.getByRole("checkbox").check();
          await expect(preview).toContainText("3 unlinked ingredients will be skipped. Open Edit meal");
          await dialog().getByRole("button", { name: "Review items", exact: true }).click();
          await expect(dialog().locator(".shopping-review-item")).toHaveCount(1);
          await expect(dialog().locator(".shopping-review-item")).toContainText("Recipes need 600 g");
          await expect(dialog().getByLabel(`Packages to buy for ${automatic.name}`, { exact: true })).toHaveValue("2");
          await dialog().getByRole("button", { name: "Back", exact: true }).click();
          await shot("meal-grocery-links");

          // Losing the sole usable product must disable review, without reviving explicit null/deleted links.
          await api(`groceries/${automatic.id}`, "DELETE");
          await open("#shopping?view=shopping-recipes");
          await expect(row).toContainText("0 of 5 ingredients linked");
          await row.getByRole("checkbox").check();
          await expect(dialog().getByRole("button", { name: "Review items", exact: true })).toBeDisabled();
          await expect(dialog().locator("#shopping-recipe-blocked")).toHaveText("No linked grocery items. Open Edit meal to link these ingredients.");
          await preview.scrollIntoViewIfNeeded();
          await shot("meal-grocery-recovery");
          const recipeRow = dialog().locator("label.shopping-recipe-option").filter({ hasText: unplanned.title });
          await recipeRow.getByRole("checkbox").check();
          await expect(preview).toContainText("Use Edit meal for planned meals and Edit recipe for unplanned recipes");
          await expect(dialog().locator("#shopping-recipe-blocked")).toContainText("Use Edit meal for planned meals and Edit recipe for unplanned recipes");
          await preview.scrollIntoViewIfNeeded();
          await shot("mixed-grocery-recovery");
          await row.getByRole("checkbox").uncheck();
          await expect(preview).toContainText("Open Edit recipe to link these ingredients.");
          await expect(dialog().locator("#shopping-recipe-blocked")).toHaveText("No linked grocery items. Open Edit recipe to link these ingredients.");
          await preview.scrollIntoViewIfNeeded();
          await shot("recipe-grocery-recovery");
        } finally {
          await api(`meals/${planned.id}`, "DELETE");
          for (const entry of [source, unplanned]) await api(`recipes/${entry.id}`, "DELETE");
          for (const product of [automatic, deleted, ...ambiguous]) await api(`groceries/${product.id}`, "DELETE");
        }
      });
      await check("Change recipe opens choices and Save persists the replacement without losing meal fields", async () => {
        const replacement = { ...recipe, id: id(), title: "Navigation replacement dinner" };
        try {
          await api("recipes", "PUT", replacement);
          await open(`#plan?week=2026-10-31&view=meal&id=${meal.id}`);
          await page.reload();
          await dialog().getByLabel(/A note for this meal/).fill("Keep this meal note");
          await dialog().getByRole("button", { name: "Change recipe", exact: true }).click();
          await expect(dialog().getByRole("list", { name: "Matching recipes", exact: true })).toBeVisible();
          await dialog().getByRole("searchbox", { name: "Recipe", exact: true }).fill(replacement.title);
          await dialog().getByRole("button", { name: new RegExp(replacement.title) }).click();
          await expect(dialog().locator(".selected-recipe")).toContainText(replacement.title);
          await expect(dialog().getByLabel("Date", { exact: true })).toHaveValue(meal.date);
          await expect(dialog().getByLabel("Recipe scale", { exact: true })).toHaveValue("1.5");
          await dialog().locator(".selected-recipe").click();
          await dialog().getByRole("button", { name: "Back to meal", exact: true }).click();
          await expect(dialog().locator(".selected-recipe")).toContainText(replacement.title);
          await expect(dialog().getByLabel(/A note for this meal/)).toHaveValue("Keep this meal note");
          await shot("meal-change-recipe");
          await dialog().getByRole("button", { name: "Save", exact: true }).click();
          await expect(dialog()).toHaveCount(0);
          const state = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
          const replacementSource = state.recipes.find(entry => entry.id === replacement.id);
          assert(replacementSource);
          const saved = state.meals.find(entry => entry.id === meal.id);
          assert(saved?.revision, "Saved meal has a revision");
          assert(saved.recipe, "Replacement meal has a recipe snapshot");
          assert.deepEqual({ ...withoutRevision(saved), recipe: withoutRevision(saved.recipe) }, { ...meal, recipeId: replacement.id, recipe: withoutRevision(replacementSource), note: "Keep this meal note" });
        } finally {
          await api("meals", "PUT", meal);
          await api(`recipes/${replacement.id}`, "DELETE");
          await page.reload();
        }
      });
      await check("Back during a pending meal save keeps the user's destination after the write completes", async () => {
        await open("#plan?week=2026-10-31");
        await page.getByRole("button", { name: `Actions for meal ${recipe.title}`, exact: true }).click();
        await page.getByRole("button", { name: "Edit meal", exact: true }).click();
        await dialog().getByLabel("Meal note", { exact: true }).fill("Pending navigation save");
        let release: (() => void) | undefined;
        let requested: (() => void) | undefined;
        const held = new Promise<void>((done) => { release = done; });
        const started = new Promise<void>((done) => { requested = done; });
        const hold = async (route: Playwright.Route) => { requested?.(); await held; await route.continue(); };
        await page.route("**/api/meals", hold);
        try {
          await dialog().getByRole("button", { name: "Save meal", exact: true }).click();
          await started;
          await page.goBack();
          await expect(dialog()).toHaveCount(0);
          release?.();
          await expect(page.getByText("Meal saved", { exact: true })).toBeVisible();
          await expect(dialog()).toHaveCount(0);
          await expect(page).toHaveURL(`${root}/#plan?week=2026-10-31`);
          const saved = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
          assert.equal(saved.meals.find((item) => item.id === meal.id)?.note, "Pending navigation save");
        } finally {
          release?.(); await page.unroute("**/api/meals", hold);
          await api("meals", "PUT", meal);
        }
      });
      await check("deleted recipe links show unavailable instead of a stale recipe or blank editor", async () => {
        await open(`#recipes?view=recipe&id=${recipe.id}`);
        await expect(dialog().locator("h1")).toHaveText(recipe.title);
        await api(`meals/${meal.id}`, "DELETE");
        await api(`recipes/${recipe.id}`, "DELETE");
        await page.reload();
        await expect(page.getByRole("alert")).toContainText("no longer available");
        await expect(dialog()).toHaveCount(0);
        await open(`#recipes?view=editor&id=${recipe.id}`);
        await expect(page.getByRole("alert")).toContainText("no longer available");
        await expect(dialog()).toHaveCount(0);
        await api("recipes", "PUT", { ...recipe, expectedIngredients: null });
        await api("meals", "PUT", meal);
        await page.reload();
        await expect(dialog()).toHaveAttribute("aria-label", "Edit recipe");
      });
      await check("recipe checklist selection and generated list are shareable; Back changes view", async () => {
        await open(`#recipe-checklist?selected=${recipe.id}&checklist=1`);
        await expect(page.getByRole("button", { name: "Change recipes" })).toBeVisible();
        await expect(page.getByLabel("Ingredients needed")).toContainText(grocery.name);
        await page.getByRole("button", { name: "Change recipes" }).click();
        await expect(page.getByRole("checkbox", { name: new RegExp(recipe.title) })).toBeChecked();
        await page.goBack();
        await expect(page.getByRole("button", { name: "Change recipes" })).toBeVisible();
      });
      await check("share affordance delivers exact recipe, plan and shopping links without credentials", async () => {
        // Exercise the UI-to-platform boundary on both engines; real native sheet needs an Apple device.
        await page.evaluate(() => Object.defineProperty(navigator, "share", { configurable: true, value: async (payload: ShareData) => { window.shared = payload; } }));
        for (const hash of [`#recipes?view=recipe&id=${recipe.id}`, "#plan?week=2026-10-31", "#shopping?mode=arrange"]) {
          await open(hash);
          await page.evaluate(() => Object.defineProperty(navigator, "share", { configurable: true, value: async (payload: ShareData) => { window.shared = payload; } }));
          await page.getByRole("button", { name: "Share link", exact: true }).last().click();
          await expect.poll(() => page.evaluate(() => window.shared?.url)).toBe(`${root}/${hash}`);
        }
        await page.evaluate(() => history.replaceState(history.state, "", `${location.pathname}?auth-secret=DO-NOT-SHARE${location.hash}&token=DO-NOT-SHARE`));
        await page.getByRole("button", { name: "Share link", exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.shared?.url)).toBe(`${root}/#shopping?mode=arrange`);
      });
      if (profile === "desktop") await check("clipboard fallback copies a reusable link", async () => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await open("#plan?week=2026-10-31");
        await page.evaluate(() => Object.defineProperty(navigator, "share", { configurable: true, value: undefined }));
        await page.getByRole("button", { name: "Share link", exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${root}/#plan?week=2026-10-31`);
      });
      if (profile !== "desktop") assert(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "Touch profile required");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "No page overflow");
    } finally {
      await context.close(); await browser.close();
    }
  }
  assert.deepEqual(errors, [], "No browser exceptions");
} finally {
  await api(`meals/${meal.id}`, "DELETE");
  await api(`meals/${noteMeal.id}`, "DELETE");
  for (const entry of edgeMeals) await api(`meals/${entry.id}`, "DELETE");
  await api(`recipes/${recipe.id}`, "DELETE");
  await api(`groceries/${grocery.id}`, "DELETE");
  await api(`collections/${collection.id}`, "DELETE");
}
const after = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
assert.deepEqual(householdContent(after), householdContent(original), "Fixture cleanup must preserve original household");
console.log(`PASS ${count} navigation scenarios across desktop/native-touch Chromium and touch iPhone/iPad WebKit; household unchanged.`);
