import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { HouseholdSchema } from "../src/domain.ts";

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
const original = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
const id = () => crypto.randomUUID();
const collection = { id: id(), name: "Navigation smoke collection" };
const grocery = { id: id(), name: "Navigation smoke lentils", unit: "g", quantity: 500, url: "", aisle: "Pantry", aliases: ["Navigation lentils", "Brown lentils"] };
const recipe = { id: id(), title: "Navigation smoke lentil soup", description: "Disposable browser fixture", servings: 3, minutes: 20, category: collection.name, photo: "", source: "", rating: "neutral", ingredients: [{ name: grocery.name, quantity: 250, unit: "g", groceryItemId: grocery.id }], instructions: ["Simmer until tender."] };
const meal = { id: id(), recipeId: recipe.id, date: "2026-11-04", slot: "Dinner", scale: 1.5, note: "Saved household meal" };
const noteMeal = { ...meal, id: id(), recipeId: null, note: "Navigation smoke note-only control" };
const edgeMeals = [
  { ...noteMeal, id: id(), date: "2026-11-02", note: "Navigation first-column meal" },
  { ...noteMeal, id: id(), date: "2026-11-08", note: "Navigation final-row meal" },
];
async function api(path: string, method: string, body?: unknown) {
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
        scenario = name;
        await run(); count++; console.log(`PASS ${profile}: ${name}`);
      };
      const open = async (hash: string) => {
        await page.goto(`${root}/${hash}`);
        await expect(page.locator(".calendar,.recipe-list,.shopping-layout,.grocery-catalog,.recipe-checklist").first()).toBeVisible();
      };
      const shot = async (name: string) => {
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: resolve(artifacts, `navigation-${profile}-${name}.png`) });
      };
      const dialog = () => page.locator("dialog[open]");
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
          await open("#plan?week=2026-11-02");
          await card.tap();
          await expect(dialog()).toHaveAttribute("aria-label", "Recipe details");
          await expect(dialog().getByRole("button", { name: "Edit recipe", exact: true })).toHaveText("Edit");
          await expect(dialog().getByText("Manage ingredient links", { exact: true })).toHaveCount(0);
          await expect(dialog().getByRole("button", { name: "Edit meal", exact: true })).toHaveCount(0);
          await dialog().getByRole("button", { name: "Close dialog" }).tap();
          await touch(-16, 0, 400);
          await expect(remove).toBeHidden();
          await expect(dialog()).toHaveCount(0);
          await touch(-110, 0);
          await expect(remove).toBeVisible();
          await expect(dialog()).toHaveCount(0);
          await shot("swipe-delete");
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
          await touch(0, 0, 650);
          await expect(dialog()).toHaveAttribute("aria-label", "Edit meal");
          await shot("hold-edit");
          await dialog().getByLabel(/A note for this meal/).fill("Edited with a long press");
          await dialog().getByRole("button", { name: "Save", exact: true }).tap();
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
        await open("#plan?week=2026-11-02");
        const bodyStyle = await page.evaluate(() => document.body.style.cssText);
        await page.locator(".meal-card").filter({ hasText: recipe.title }).click();
        await dialog().getByRole("button", { name: "Edit recipe", exact: true }).click();
        await dialog().getByRole("button", { name: "Edit product", exact: true }).click();
        const nested = page.getByRole("dialog", { name: "Grocery item for ingredient", exact: true });
        await nested.getByRole("button", { name: "Cancel", exact: true }).click();
        if ((page.viewportSize()?.width ?? 0) <= 850)
          assert.equal(await page.evaluate(() => document.body.style.position), "fixed");
        await dialog().getByRole("button", { name: "Edit product", exact: true }).click();
        await expect(nested).toBeVisible();
        await page.goBack();
        await expect(dialog()).toHaveAttribute("aria-label", "Recipe details");
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
            await open("#plan?week=2026-11-02");
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
          for (const product of products) assert.deepEqual(state.groceries.find(entry => entry.id === product.id), product);
          await shot("recipe-package-list");
        } finally {
          for (const entry of reviewRecipes) await api(`recipes/${entry.id}`, "DELETE");
          for (const product of products) await api(`groceries/${product.id}`, "DELETE");
        }
      });
      await check("selected meal-plan week, Back/Forward, direct open and reload", async () => {
        await open("#plan?week=2026-11-02");
        await expect(page.getByRole("heading", { name: "Nov 2 – Nov 8, 2026" })).toBeVisible();
        await page.getByRole("button", { name: "Next week", exact: true }).click();
        await expect(page).toHaveURL(/week=2026-11-09/);
        await page.goBack();
        await expect(page.getByRole("heading", { name: "Nov 2 – Nov 8, 2026" })).toBeVisible();
        await page.goForward();
        await expect(page.getByRole("heading", { name: "Nov 9 – Nov 15, 2026" })).toBeVisible();
        await page.reload();
        await expect(page.getByRole("heading", { name: "Nov 9 – Nov 15, 2026" })).toBeVisible();
        await shot("plan");
      });
      await check("shopping focus, builder, arrange, hidden checks and navigation history", async () => {
        await open("#shopping?mode=focus&hideChecked=1");
        await expect(page.getByRole("button", { name: "Exit shopping mode", exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator(".shopping-summary button, .shopping-summary a")).toHaveCount(1);
        await shot("shopping");
        await page.getByRole("button", { name: "Exit shopping mode", exact: true }).click();
        await expect(page.getByRole("button", { name: "Show checked items", exact: true })).toHaveAttribute("aria-pressed", "true");
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
      await check("recipe details, saved meal context, scaling and editor Back", async () => {
        await open(`#plan?week=2026-11-02&view=recipe&id=${recipe.id}&meal=${meal.id}&scale=2`);
        await expect(dialog().locator("h1")).toHaveText(recipe.title);
        await expect(dialog().getByLabel("Preview recipe scale")).toHaveValue("2");
        await expect(dialog()).toContainText("6 servings");
        await dialog().getByRole("button", { name: "Edit recipe", exact: true }).click();
        await expect(page).toHaveURL(/view=editor/);
        await page.goBack();
        await expect(dialog().locator("h1")).toHaveText(recipe.title);
        await expect(dialog().getByLabel("Preview recipe scale")).toHaveValue("2");
        await page.goForward();
        await expect(dialog()).toHaveAttribute("aria-label", "Edit recipe");
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
          [`#plan?week=2026-11-02&view=meal&id=${meal.id}`, "Edit meal"],
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
          [`#plan?week=2026-11-02&view=meal&date=2026-11-06&recipe=${recipe.id}`, "Add a meal"],
        ]) {
          await open(hash);
          await expect(dialog()).toHaveAttribute("aria-label", title);
          await expect(dialog().getByRole("button", { name: "Share link" })).toBeVisible();
        }
      });
      await check("nested meal draft survives preview Back, never leaks into URL/history or reload", async () => {
        await open(`#plan?week=2026-11-02&view=meal&date=2026-11-06&recipe=${recipe.id}`);
        await dialog().getByLabel(/A note for this meal/).fill("PRIVATE DRAFT DO NOT SHARE");
        await dialog().getByRole("button", { name: /View recipe/ }).click();
        await expect(dialog()).toHaveAttribute("aria-label", "Recipe details");
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
      await check("UI navigation creates shareable meal links; saved edits close to a reloadable page", async () => {
        await open("#plan?week=2026-11-02");
        await page.locator(".meal-card").filter({ hasText: recipe.title }).click();
        await expect(page).toHaveURL(`${root}/#plan?week=2026-11-02&view=recipe&id=${recipe.id}&meal=${meal.id}`);
        await expect(dialog().getByRole("button", { name: "Edit meal", exact: true })).toHaveCount(0);
        await dialog().getByRole("button", { name: "Close dialog" }).click();
        await page.getByRole("button", { name: `Actions for meal ${recipe.title}`, exact: true }).click();
        await page.getByRole("button", { name: "Edit meal", exact: true }).focus();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("button", { name: `Actions for meal ${recipe.title}`, exact: true })).toBeFocused();
        await expect(page.getByRole("button", { name: "Edit meal", exact: true })).toHaveCount(0);
        await page.getByRole("button", { name: `Actions for meal ${recipe.title}`, exact: true }).click();
        await page.getByRole("button", { name: "Edit meal", exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`view=meal&id=${meal.id}`));
        await dialog().getByLabel(/A note for this meal/).fill("Saved by navigation E2E");
        await dialog().getByRole("button", { name: "Save", exact: true }).click();
        await expect(dialog()).toHaveCount(0);
        await expect(page).toHaveURL(`${root}/#plan?week=2026-11-02`);
        await page.reload();
        await open(`#plan?week=2026-11-02&view=meal&id=${meal.id}`);
        await expect(dialog().getByLabel(/A note for this meal/)).toHaveValue("Saved by navigation E2E");
        await api("meals", "PUT", meal);
      });
      await check("Change recipe opens choices and Save persists the replacement without losing meal fields", async () => {
        const replacement = { ...recipe, id: id(), title: "Navigation replacement dinner" };
        try {
          await api("recipes", "PUT", replacement);
          await open(`#plan?week=2026-11-02&view=meal&id=${meal.id}`);
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
          assert.deepEqual(state.meals.find(entry => entry.id === meal.id), { ...meal, recipeId: replacement.id, note: "Keep this meal note" });
        } finally {
          await api("meals", "PUT", meal);
          await api(`recipes/${replacement.id}`, "DELETE");
          await page.reload();
        }
      });
      await check("Back during a pending save keeps the user's destination after the write completes", async () => {
        await open("#plan?week=2026-11-02");
        await page.getByRole("button", { name: `Actions for meal ${recipe.title}`, exact: true }).click();
        await page.getByRole("button", { name: "Edit meal", exact: true }).click();
        await dialog().getByLabel(/A note for this meal/).fill("Pending navigation save");
        let release: (() => void) | undefined;
        let requested: (() => void) | undefined;
        const held = new Promise<void>((done) => { release = done; });
        const started = new Promise<void>((done) => { requested = done; });
        const hold = async (route: Playwright.Route) => { requested?.(); await held; await route.continue(); };
        await page.route("**/api/meals", hold);
        try {
          await dialog().getByRole("button", { name: "Save", exact: true }).click();
          await started;
          await page.goBack();
          await expect(dialog()).toHaveCount(0);
          release?.();
          await expect(page.getByText("Meal plan updated", { exact: true })).toBeVisible();
          await expect(dialog()).toHaveCount(0);
          await expect(page).toHaveURL(`${root}/#plan?week=2026-11-02`);
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
        for (const hash of [`#recipes?view=recipe&id=${recipe.id}`, "#plan?week=2026-11-02", "#shopping?hideChecked=1"]) {
          await open(hash);
          await page.evaluate(() => Object.defineProperty(navigator, "share", { configurable: true, value: async (payload: ShareData) => { window.shared = payload; } }));
          await page.getByRole("button", { name: "Share link", exact: true }).last().click();
          await expect.poll(() => page.evaluate(() => window.shared?.url)).toBe(`${root}/${hash}`);
        }
        await page.evaluate(() => history.replaceState(history.state, "", `${location.pathname}?auth-secret=DO-NOT-SHARE${location.hash}&token=DO-NOT-SHARE`));
        await page.getByRole("button", { name: "Share link", exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.shared?.url)).toBe(`${root}/#shopping?hideChecked=1`);
      });
      if (profile === "desktop") await check("clipboard fallback copies a reusable link", async () => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await open("#plan?week=2026-11-02");
        await page.evaluate(() => Object.defineProperty(navigator, "share", { configurable: true, value: undefined }));
        await page.getByRole("button", { name: "Share link", exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${root}/#plan?week=2026-11-02`);
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
assert.deepEqual(after, original, "Fixture cleanup must preserve original household");
console.log(`PASS ${count} navigation scenarios across desktop/native-touch Chromium and touch iPhone/iPad WebKit; household unchanged.`);
