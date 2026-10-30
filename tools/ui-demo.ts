import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Schema } from "effect";
import { HouseholdSchema, type Household } from "../src/domain.ts";
import { restoreShoppingLists, shoppingContent } from "./shopping-fixtures.ts";
// @ts-ignore Browser declarations exist only after task ui:setup, outside the checkout.
import type * as Playwright from "/tmp/hearth-ui/node_modules/playwright/index.d.ts";

declare global {
  interface Window {
    /** Recording-owned in-flight writes, drained before household restoration. */
    demoWrites: Set<Promise<Response>>;
  }
}

// The pinned browser runtime is installed outside the checkout by task ui:setup.
// @ts-expect-error task ui:setup supplies this external runtime.
const { chromium, devices }: typeof Playwright = await import("/tmp/hearth-ui/node_modules/playwright/index.mjs");
const root = new URL(process.argv[2] ?? "http://localhost:5173").origin;
assert(["localhost", "127.0.0.1"].includes(new URL(root).hostname), "Demo refuses remote household writes");
const output = resolve(".amp/in/artifacts/concept-a");
const scratch = await mkdtemp(join(tmpdir(), "hearth-demo-"));
await mkdir(output, { recursive: true });
const household = async () => {
  const response = await fetch(`${root}/api/household`);
  assert(response.ok);
  const data: unknown = await response.json();
  assert(Schema.is(HouseholdSchema)(data), "Expected a valid household snapshot");
  return data;
};
const withoutRevision = <T extends { readonly revision?: string }>({ revision: _revision, ...value }: T) => value;
// Cleanup restores all domain content, not the write tokens rotated by the demo.
const householdContent = (state: Household) => ({ ...state,
  recipes: state.recipes.map(withoutRevision), meals: state.meals.map(withoutRevision),
  groceries: state.groceries.map(withoutRevision), collections: state.collections.map(withoutRevision),
  ...shoppingContent(state), shoppingOrder: withoutRevision(state.shoppingOrder),
});
const original = await household();
assert(original.recipes.length && original.meals.length, "Load a disposable sample week first");
const owned = {
  recipes: new Set<string>(),
  groceries: new Set<string>(),
  meals: new Set<string>(),
  collections: new Set<string>(),
};
function isOwnedKind(kind: string | undefined): kind is keyof typeof owned {
  return kind !== undefined && Object.hasOwn(owned, kind);
}
const stamp = crypto.randomUUID().slice(0, 6);
const recipeName = `Lemon rice bowls · demo ${stamp}`;
const productName = `Brown rice · demo ${stamp}`;
const collectionName = `Quick dinners · ${stamp}`;
const note = `Dinner with friends · demo ${stamp}`;
const extraName = `Dish soap · demo ${stamp}`;
const listLabel = `Demo ${stamp}`;
const chapters: { time: number; title: string; caption: string }[] = [];
const limitations: string[] = [];
const errors: string[] = [];
let started = 0;
let failure: unknown;
let videoPath = "";
try {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...devices["Pixel 7"],
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    recordVideo: { dir: scratch, size: { width: 390, height: 844 } },
  });
  context.setDefaultTimeout(12_000);
  const page = await context.newPage();
  page.on("pageerror", (error: Error) => errors.push(error.message));
  page.on("request", (request: Playwright.Request) => {
    const segment = new URL(request.url()).pathname.split("/")[2];
    // Quick add creates a catalog item through its own list endpoint.
    const kind = segment === "shopping-items" ? "groceries" : segment;
    if (!["PUT", "POST"].includes(request.method()) || !isOwnedKind(kind)) return;
    const body: unknown = request.postDataJSON();
    if (typeof body === "object" && body !== null && "id" in body && typeof body.id === "string" &&
      !original[kind].some((item) => item.id === body.id)) owned[kind].add(body.id);
  });
  await context.addInitScript(() => {
    const w = window;
    const fetch = window.fetch;
    w.demoWrites = new Set();
    window.fetch = (...args) => {
      const write = args[1]?.method && args[1].method !== "GET";
      const result = fetch(...args);
      if (write) {
        w.demoWrites.add(result);
        result.then(
          () => w.demoWrites.delete(result),
          () => w.demoWrites.delete(result),
        );
      }
      return result;
    };
    document.addEventListener("pointerdown", (event) => {
      const dot = document.createElement("div");
      dot.style.cssText = `position:fixed;left:${event.clientX - 16}px;top:${event.clientY - 16}px;width:32px;height:32px;border:2px solid #ad7754;border-radius:50%;background:#ad775422;pointer-events:none;z-index:99999`;
      document.body.appendChild(dot);
      setTimeout(() => dot.remove(), 500);
    });
  });
  const pause = (ms = 1400) => page.waitForTimeout(ms);
  async function chapter(title: string, caption: string) {
    chapters.push({ time: (Date.now() - started) / 1000, title, caption });
    console.log(`DEMO ${title}`);
    await pause();
  }
  async function click(locator: Playwright.Locator) {
    await locator.click();
    await pause(450);
  }
  async function nav(name: string) {
    await click(page.locator(`nav a[href="#${name}"]`));
    await page.locator(".topbar h1").waitFor();
  }
  async function menu(name: string) {
    await click(page.getByLabel("Page options", { exact: true }));
    await click(page.getByRole("button", { name, exact: true }));
  }
  const dialog = () => page.locator("dialog[open]").last();
  async function close() {
    await click(dialog().getByRole("button", { name: "Close dialog" }));
  }
  async function persisted(predicate: (data: Household) => boolean) {
    for (let i = 0; i < 80; i++) {
      const data = await household();
      if (predicate(data)) return data;
      await pause(100);
    }
    throw new Error("Expected household change did not persist");
  }
  async function capture(name: string) {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    });
    await page.screenshot({ path: join(output, `${name}.png`) });
  }
  async function chooseDate(date: string) {
    await click(page.getByText("Jump to date", { exact: true }));
    const shown = new Date(`1 ${await page.locator(".date-picker-heading strong").textContent()}`);
    const target = new Date(`${date}T12:00:00`);
    const months = (target.getFullYear() - shown.getFullYear()) * 12 + target.getMonth() - shown.getMonth();
    for (let index = 0; index < Math.abs(months); index++)
      await click(page.getByRole("button", { name: months > 0 ? "Next month" : "Previous month", exact: true }));
    await click(page.getByRole("button", { name: target.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }), exact: true }));
  }
  async function saveVisible(name: string) {
    const button = dialog().getByRole("button", { name, exact: true });
    const box = await button.boundingBox();
    assert(box && box.y >= 0 && box.y + box.height <= 844, `${name} must be reachable without scrolling`);
    assert(
      await button.evaluate((element: HTMLElement) => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }),
      `${name} must not be covered`,
    );
  }

  try {
    started = Date.now();
    await page.goto(`${root}/#plan`);
    await page.locator(".calendar").first().waitFor();
    assert(await page.evaluate(() => matchMedia("(pointer: coarse)").matches));
    await chapter(
      "01 · Content-first navigation",
      "A real local app, with sample data. Compact headers and four labeled tabs leave room for meals, recipes and shopping.",
    );
    await capture("mobile-plan");
    await chooseDate("2026-10-07");
    await click(page.getByText("Jump to date", { exact: true }));
    await click(page.getByRole("button", { name: "Today", exact: true }));
    await nav("recipes");
    await capture("mobile-recipes");
    await nav("shopping");
    await capture("mobile-shopping");
    await nav("groceries");
    await capture("mobile-groceries");

    await chapter(
      "02 · Grocery catalog",
      "Search products, create a package with aisle and alternate names, then edit it. Save stays reachable while the form scrolls.",
    );
    await page.getByLabel("Search grocery items").fill("no such grocery");
    await pause();
    assert(await page.getByText("No grocery items match your search.").isVisible());
    await page.getByLabel("Search grocery items").fill("");
    await click(page.getByRole("button", { name: "Add grocery item", exact: true }));
    await saveVisible("Save grocery item");
    await dialog().getByLabel("Store product name").fill(productName);
    await dialog().getByLabel("Aisle (optional)").fill("7");
    await dialog().getByLabel("Package quantity", { exact: true }).fill("500");
    await dialog().getByLabel("Package unit").selectOption("g");
    await click(dialog().getByRole("button", { name: "Add Alternative", exact: true }));
    await dialog().getByLabel("Alternative 1", { exact: true }).fill("brown rice");
    await dialog().getByLabel("Alternative 1", { exact: true }).press("Enter");
    await click(dialog().getByRole("button", { name: "Save grocery item" }));
    let data = await persisted((h) => h.groceries.some((g) => g.name === productName));
    const product = data.groceries.find((g) => g.name === productName);
    assert(product, "Saved demo grocery must exist");
    await page.getByLabel("Search grocery items").fill(productName);
    await click(page.getByRole("button", { name: `Edit grocery item ${productName}` }));
    await dialog().getByLabel("Product URL (optional)").fill("https://example.com/brown-rice");
    await click(dialog().getByRole("button", { name: "Save grocery item" }));
    await persisted(
      (h) => h.groceries.find((g) => g.id === product.id)?.url === "https://example.com/brown-rice",
    );
    await page.getByLabel("Search grocery items").fill("");
    await click(page.locator(".grocery-coverage > summary"));
    await pause();
    assert(await page.getByRole("button", { name: "Match ingredients", exact: true }).isVisible());
    limitations.push(
      "Live Cloudflare AI matching was not invoked; the local Worker has no AI binding. Coverage, manual linking and nested product editing were exercised.",
    );

    await nav("recipes");
    await chapter(
      "03 · Collections and a new recipe",
      "Create a collection and a recipe. Pair quantities with units, link the store product, add cooking steps, and save.",
    );
    await menu("Manage collections");
    await click(dialog().getByRole("button", { name: "Add collection", exact: true }));
    await dialog().getByLabel("Collection name").fill(collectionName);
    await click(dialog().getByRole("button", { name: "Save collection" }));
    data = await persisted((h) => h.collections.some((c) => c.name === collectionName));
    const collection = data.collections.find((c) => c.name === collectionName);
    assert(collection, "Saved demo collection must exist");
    await close();
    await click(page.getByRole("button", { name: "Add a recipe", exact: true }));
    await saveVisible("Save recipe");
    await capture("mobile-editor");
    await dialog().getByLabel("Recipe name", { exact: true }).fill(recipeName);
    await click(dialog().getByText("About this recipe", { exact: true }));
    await dialog().getByLabel("A few words about it").fill("A bright, quick dinner with rice and lemon.");
    await dialog().getByLabel("Servings", { exact: true }).fill("2");
    await dialog().getByLabel("Time (minutes)").fill("20");
    await dialog().getByLabel("Collection").selectOption(collectionName);
    await click(dialog().getByText("Source & photo (optional)", { exact: true }));
    await dialog()
      .getByLabel(/Source URL/)
      .fill("https://example.com/lemon-rice");
    await click(dialog().getByText("Source & photo (optional)", { exact: true }));
    await dialog().getByLabel("Ingredient 1 name", { exact: true }).fill("brown rice");
    await dialog().getByLabel("Ingredient 1 quantity").fill("150");
    await dialog().getByLabel("Ingredient 1 unit").selectOption("g");
    await click(dialog().locator(".ingredient-link-editor > summary").first());
    await dialog().getByLabel("Grocery item for ingredient 1").fill(productName);
    await click(dialog().getByRole("region", { name: "Matches for ingredient 1" }).getByRole("button").filter({ hasText: productName }).first());
    await click(dialog().getByRole("button", { name: "Edit product", exact: true }));
    await click(dialog().getByRole("button", { name: "Add Alternative", exact: true }));
    await dialog().getByLabel("Alternative 2", { exact: true }).fill("wholegrain rice");
    await dialog().getByLabel("Alternative 2", { exact: true }).press("Enter");
    await click(dialog().getByRole("button", { name: "Save grocery item" }));
    assert.equal(
      await dialog().getByLabel("Recipe name", { exact: true }).inputValue(),
      recipeName,
      "Nested editor must preserve the draft",
    );
    await dialog()
      .getByLabel("Step 1", { exact: true })
      .fill("Cook the rice until tender, then fold in lemon zest.");
    await click(dialog().getByRole("button", { name: "Add step", exact: true }));
    await dialog().getByLabel("Step 2", { exact: true }).fill("Divide between bowls and serve warm.");
    await click(dialog().getByRole("button", { name: "Save recipe", exact: true }));
    data = await persisted((h) => h.recipes.some((r) => r.title === recipeName));
    const recipe = data.recipes.find((r) => r.title === recipeName);
    assert(recipe, "Saved demo recipe must exist");
    assert.equal(recipe.ingredients[0].groceryItemId, product.id);

    await chapter(
      "04 · Browse, rate and cook",
      "Search by ingredient, filter by collection, choose a rating, preview doubled quantities, and jump straight to the steps. Preview scale does not change the saved recipe.",
    );
    await page.getByLabel("Search recipes").fill("wholegrain rice");
    await pause();
    await page.getByLabel("Search recipes").fill("brown rice");
    await page.getByLabel("Filter by collection").selectOption(collection.id);
    await page.locator(".recipe-row").filter({ hasText: recipeName }).waitFor();
    await click(page.getByLabel(`Rate ${recipeName}`, { exact: true }));
    await click(page.getByRole("button", { name: `Thumbs up for ${recipeName}`, exact: true }));
    await persisted((h) => h.recipes.find((r) => r.id === recipe.id)?.rating === "up");
    await click(page.locator(".recipe-row-main").filter({ hasText: recipeName }));
    await capture("mobile-detail");
    await page.getByLabel("Preview recipe scale").selectOption("2");
    await pause();
    assert.equal((await page.locator(".ingredient-list strong").first().innerText()).trim(), "300 g");
    assert.equal(
      (await household()).recipes.find((r) => r.id === recipe.id)?.ingredients[0]?.quantity,
      150,
    );
    const detailHash = new URL(page.url()).hash;
    await click(page.getByRole("link", { name: "Steps", exact: true }));
    assert.equal(new URL(page.url()).hash, detailHash, "Cooking shortcuts must not change app navigation");
    await page.locator(".recipe-detail").evaluate((element: HTMLElement) => {
      element.scrollTop = 0;
    });
    await click(page.getByRole("button", { name: "Edit recipe", exact: true }));
    await dialog().getByLabel("Time (minutes)").fill("25");
    await click(dialog().getByRole("button", { name: "Save recipe", exact: true }));
    await persisted((h) => h.recipes.find((r) => r.id === recipe.id)?.minutes === 25);

    await chapter(
      "05 · Plan recipes and notes",
      "Save a scaled dinner with a note. Visit its recipe and return without losing the meal draft. Add a note-only lunch, edit it, and remove it.",
    );
    await click(page.getByRole("button", { name: "Add to plan", exact: true }).first());
    const date = await dialog().getByLabel("Date", { exact: true }).inputValue();
    await dialog().getByLabel("Recipe scale", { exact: true }).selectOption("1.5");
    await dialog()
      .getByLabel(/note for this meal/i)
      .fill(note);
    await click(dialog().locator(".selected-recipe"));
    assert.equal(await page.getByLabel("Preview recipe scale").inputValue(), "1.5");
    await click(page.getByRole("button", { name: "Back to meal", exact: true }));
    assert.equal(
      await dialog()
        .getByLabel(/note for this meal/i)
        .inputValue(),
      note,
    );
    await click(dialog().getByRole("button", { name: "Save", exact: true }));
    data = await persisted((h) => h.meals.some((m) => m.recipeId === recipe.id));
    const meal = data.meals.find((m) => m.recipeId === recipe.id);
    assert(meal, "Saved demo meal must exist");
    assert.equal(meal.scale, 1.5);
    await nav("plan");
    await chooseDate(date);
    await click(page.getByRole("button", { name: `Actions for meal ${recipeName}`, exact: true }));
    await click(page.getByRole("button", { name: "Edit meal", exact: true }));
    await dialog()
      .getByLabel("Meal note", { exact: true })
      .fill(`${note} — save leftovers`);
    await click(dialog().getByRole("button", { name: "Save meal", exact: true }));
    await persisted((h) => h.meals.find((m) => m.id === meal.id)?.note.endsWith("save leftovers") === true);
    await click(page.getByRole("button", { name: "Add a meal", exact: true }));
    await dialog().getByLabel("Plan type").selectOption("note");
    await dialog().getByLabel("Date", { exact: true }).fill(date);
    await dialog().getByLabel("Meal").selectOption("Lunch");
    await dialog().getByLabel("What’s the plan?").fill(`Leftovers · ${stamp}`);
    await click(dialog().getByRole("button", { name: "Save", exact: true }));
    await persisted((h) => h.meals.some((m) => m.note === `Leftovers · ${stamp}`));
    await click(page.locator(".meal-card").filter({ hasText: `Leftovers · ${stamp}` }));
    await click(dialog().getByRole("button", { name: "Remove meal", exact: true }));
    await persisted((h) => !h.meals.some((m) => m.note === `Leftovers · ${stamp}`));

    await chapter(
      "06 · Build a shopping list",
      "Start a dated list, then use List Builder to add from the full grocery catalog. In Shop Mode, picked-up items move to In cart, with a short Undo. Arrange the store route with keyboard-accessible arrows. Recipes do not automatically populate a list.",
    );
    await click(page.getByRole("button", { name: "Shopping list", exact: true }));
    const switcher = page.locator(".list-switcher > summary");
    if (await switcher.isVisible()) {
      await click(switcher);
      await click(page.getByRole("button", { name: "All lists…", exact: true }));
    } else await click(page.getByRole("button", { name: "Choose another date", exact: true }));
    await dialog().getByLabel("Date", { exact: true }).first().fill(date);
    await dialog().getByLabel("Label (optional)").first().fill(listLabel);
    await click(dialog().getByRole("button", { name: "Create list", exact: true }));
    data = await persisted((h) => h.shoppingLists.some((list) => list.label === listLabel));
    const list = data.shoppingLists.find((entry) => entry.label === listLabel);
    assert(list, "Saved demo list must exist");
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("list"), list.id, "A new list opens");
    const row = (h: Household, groceryId: string) => h.shoppingItems.find((item) => item.listId === list.id && item.groceryId === groceryId);
    await click(page.getByRole("button", { name: "List Builder", exact: true }));
    const purchase = page.locator(".purchase-row").filter({ hasText: productName });
    await purchase.waitFor();
    const membership = purchase.getByRole("button", { name: `Add ${productName} to this list`, exact: true });
    assert.equal(await membership.getAttribute("aria-pressed"), "false", "New product must start off the list");
    await click(membership);
    await persisted((h) => row(h, product.id)?.checked === 0);
    await capture("mobile-list-builder");
    await click(page.getByRole("button", { name: "Exit List Builder", exact: true }));
    await click(page.getByRole("button", { name: "Shopping mode", exact: true }));
    await click(page.getByRole("checkbox", { name: `Picked up ${productName}`, exact: true }));
    await persisted((h) => row(h, product.id)?.checked === 1);
    await page.getByRole("region", { name: "In cart", exact: true }).getByText(productName, { exact: true }).waitFor();
    await click(page.getByRole("button", { name: "Undo", exact: true }));
    await persisted((h) => row(h, product.id)?.checked === 0);
    await click(page.getByRole("button", { name: "Exit shopping mode", exact: true }));
    await click(purchase.locator("summary"));
    await pause();
    await click(purchase.getByRole("button", { name: "Edit product", exact: true }));
    assert(
      await dialog().getByRole("button", { name: "Delete item", exact: true }).isEnabled(),
      "Saved linked products must be deletable",
    );
    await click(dialog().getByRole("button", { name: "Cancel", exact: true }));
    await menu("Arrange route");
    const expectedAisles = (await page.locator(".route-aisle > .aisle-heading h3").allTextContents()).map(
      // Headings also contain the rename button's icon spacing.
      (heading: string) => (heading.trim() === "No aisle assigned" ? "" : heading.trim().slice("Aisle ".length)),
    );
    assert(expectedAisles.length >= 2, "Demo needs two aisles to exercise route arrangement");
    [expectedAisles[0], expectedAisles[1]] = [expectedAisles[1], expectedAisles[0]];
    const beforeOrder = (await household()).shoppingOrder;
    const move = page
      .locator('.route-aisle > .aisle-heading button[aria-label$="down"]:not(:disabled)')
      .first();
    await click(move);
    await persisted(
      (h) => JSON.stringify(withoutRevision(h.shoppingOrder)) === JSON.stringify({ ...withoutRevision(beforeOrder), aisles: expectedAisles }),
    );
    await menu("Done arranging");
    await pause();

    await chapter(
      "07 · Quick add and focus mode",
      "Quick add saves a new grocery for next time and puts it on the list. Add one, use the immersive shopping view, pick it up, then return to navigation.",
    );
    await page.getByLabel("New household item").fill(extraName);
    await click(page.getByRole("button", { name: "Add household item", exact: true }));
    const create = page.getByRole("button", { name: `Create “${extraName}”`, exact: true });
    if (await create.isVisible()) await click(create);
    data = await persisted((h) => h.groceries.some((g) => g.name === extraName));
    const extra = data.groceries.find((g) => g.name === extraName);
    assert(extra, "Saved demo grocery must exist");
    owned.groceries.add(extra.id);
    await persisted((h) => row(h, extra.id)?.checked === 0);
    await click(page.getByRole("button", { name: "Shopping mode", exact: true }));
    await pause();
    assert(await page.locator(".shopping-mode").isVisible());
    await capture("mobile-focus");
    await click(page.getByRole("checkbox", { name: `Picked up ${extraName}`, exact: true }));
    await persisted((h) => row(h, extra.id)?.checked === 1);
    await click(page.getByRole("button", { name: "Exit shopping mode", exact: true }));

    await nav("recipes");
    await chapter(
      "08 · Import and integrations",
      "Import lives in Page options, with source validation and review before saving. ChatGPT setup retains installation steps and the household-access warning; no external account is connected in this demo.",
    );
    await menu("Import recipe");
    await dialog().getByLabel("Recipe URL").fill("https://example.com/recipe");
    await click(dialog().getByRole("button", { name: "Import and review" }));
    await dialog().getByRole("alert").waitFor();
    await pause();
    await dialog().getByLabel("Recipe URL").fill("https://cooking.nytimes.com/recipes/1018529-coq-au-vin");
    await click(dialog().getByRole("button", { name: "Import and review" }));
    await page.waitForFunction(
      () =>
        !!document.querySelector(".recipe-form") || !!document.querySelector('dialog[open] [role="alert"]'),
      null,
      { timeout: 25_000 },
    );
    if (await page.locator(".recipe-form").count()) {
      await pause();
      await capture("mobile-import-review");
      // Review an actual upstream recipe, but cancel rather than add irrelevant demo data.
      await close();
    } else {
      limitations.push(
        "Live NYT import was attempted but NYT could not be read. The video shows the real error and manual-entry fallback, not a simulated success. Fixture-backed import/review/save is covered by task test.",
      );
      await capture("mobile-import-error");
      await pause();
      await close();
    }
    await menu("Use Hearth in ChatGPT");
    await pause();
    assert(
      await dialog()
        .getByText(/does not grant access/)
        .isVisible(),
    );
    await capture("mobile-chatgpt");
    await close();
    limitations.push(
      "ChatGPT installation/Google sign-in were not performed; they require the user's external account and permission.",
    );

    await chapter(
      "09 · Timers while cooking",
      "Timers are local to this browser. Create a one-minute timer, reload to verify persistence, and watch its real expiry. Then add one/five minutes and dismiss it without opening the drawer.",
    );
    await click(page.locator(".recipe-row-main").filter({ hasText: recipeName }));
    await click(page.locator(".timer-toggle"));
    const timerPanel = page.getByLabel("Kitchen timers", { exact: true });
    await timerPanel.locator('input[name="timerName"]').fill("Rice is ready");
    await timerPanel.locator('input[name="timerHours"]').fill("0");
    await timerPanel.locator('input[name="timerMinutes"]').fill("1");
    await click(timerPanel.getByRole("button", { name: "Start timer", exact: true }));
    await click(timerPanel.getByRole("button", { name: "Collapse timers", exact: true }));
    await close();
    await page.reload();
    await page.locator(".timer-toggle strong").waitFor();
    await capture("mobile-running-timer");
    await click(page.locator(".timer-toggle"));
    await click(page.getByRole("button", { name: "Collapse timers", exact: true }));
    await page.locator(".timer-toggle.timer-due").waitFor({ timeout: 65_000 });
    await capture("mobile-finished-timer");
    await pause(3000);
    assert.equal(await page.locator(".timer-toggle strong").innerText(), "00:00:00");
    await click(page.getByRole("button", { name: "Add 1 minute to Rice is ready", exact: true }));
    await click(page.getByRole("button", { name: "Add 5 minutes to Rice is ready", exact: true }));
    await click(page.getByRole("button", { name: "Dismiss timer Rice is ready", exact: true }));
    assert.equal(await page.locator(".timer-header-actions").count(), 0);

    await chapter(
      "10 · Remove without losing other data",
      "Remove the demo meal, delete its collection (the recipe stays Uncollected), delete the recipe and now-unused grocery product, then delete the demo list. Original sample data is restored after recording.",
    );
    await nav("plan");
    await chooseDate(date);
    await click(page.getByRole("button", { name: `Actions for meal ${recipeName}`, exact: true }));
    await click(page.getByRole("button", { name: "Edit meal", exact: true }));
    await click(dialog().getByRole("button", { name: "Remove meal", exact: true }));
    await persisted((h) => !h.meals.some((m) => m.id === meal.id));
    await nav("recipes");
    await menu("Manage collections");
    await click(dialog().getByRole("button", { name: `Edit ${collectionName}`, exact: true }));
    await click(dialog().getByRole("button", { name: "Delete collection", exact: true }));
    await click(dialog().getByRole("button", { name: "Delete collection", exact: true }));
    await persisted(
      (h) =>
        !h.collections.some((c) => c.id === collection.id) &&
        h.recipes.find((r) => r.id === recipe.id)?.category === "",
    );
    await close();
    await page.getByLabel("Filter by collection").selectOption("all");
    await page.getByLabel("Search recipes").fill(recipeName);
    await click(page.locator(".recipe-row-main").filter({ hasText: recipeName }));
    await click(page.getByRole("button", { name: "Edit recipe", exact: true }));
    await click(dialog().getByRole("button", { name: "Delete recipe", exact: true }));
    await click(dialog().getByRole("button", { name: "Yes, delete recipe", exact: true }));
    await persisted((h) => !h.recipes.some((r) => r.id === recipe.id));
    await nav("groceries");
    await click(page.getByRole("button", { name: `Edit grocery item ${productName}`, exact: true }));
    await click(dialog().getByRole("button", { name: "Delete item", exact: true }));
    await persisted((h) => !h.groceries.some((g) => g.id === product.id));
    await nav("shopping");
    await click(page.locator(".list-switcher > summary"));
    await click(page.getByRole("button", { name: "All lists…", exact: true }));
    await click(dialog().getByRole("button", { name: new RegExp(`^Edit .* · ${listLabel}$`) }));
    await click(dialog().getByRole("button", { name: "Delete list", exact: true }));
    await click(dialog().getByRole("button", { name: "Delete list", exact: true }));
    await persisted((h) => !h.shoppingLists.some((entry) => entry.id === list.id));
    await close();
    await nav("plan");
    await pause(2500);
    assert.deepEqual(errors, [], "No unhandled browser errors");
  } catch (error) {
    failure = error;
    console.error(error);
    await capture("demo-failure").catch(() => {});
  } finally {
    await page
      .evaluate(async () => {
        await Promise.allSettled([...window.demoWrites]);
      })
      .catch(() => {});
    const teardown = await Promise.allSettled([
      (async () => {
        const video = page.video();
        assert(video, "Demo context must record a video");
        videoPath = await video.path();
      })(),
      context.close(),
    ]);
    teardown.push(...(await Promise.allSettled([browser.close()])));
    const teardownErrors = teardown.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (teardownErrors.length)
      failure = new AggregateError(
        [...(failure ? [failure] : []), ...teardownErrors],
        "Demo recording teardown failed",
      );
    const restore = async (path: string, method: string, body?: unknown) => {
      const resource = path.split("/")[0];
      if (method === "DELETE" && isOwnedKind(resource)) {
        const saved = (await household())[resource].find(item => item.id === decodeURIComponent(path.slice(resource.length + 1)));
        if (!saved) return;
        body = { expectedRevision: saved.revision };
      } else if (path === "shopping-order") {
        body = { ...original.shoppingOrder, expectedRevision: (await household()).shoppingOrder.revision };
      }
      const response = await fetch(`${root}/api/${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert(response.ok, `Cleanup ${method} ${path}: ${response.status}`);
    };
    const current = await household();
    for (const kind of ["meals", "recipes", "groceries", "collections"] as const) {
      for (const item of current[kind])
        if (owned[kind].has(item.id) || ("name" in item && kind === "groceries" && item.name === extraName))
          await restore(`${kind}/${encodeURIComponent(item.id)}`, "DELETE");
    }
    const after = await household();
    if (JSON.stringify(after.shoppingOrder) !== JSON.stringify(original.shoppingOrder))
      await restore("shopping-order", "PUT", original.shoppingOrder);
    // Removes the demo's list and restores rows on lists that existed before recording.
    await restoreShoppingLists(root, original);
    assert.deepEqual(householdContent(await household()), householdContent(original), "Exact original household domain content must be restored");
    console.log("PASS demo cleanup: exact household restored");
  }

  if (failure) throw failure;
  const wrap = (text: string) =>
    text
      .match(/.{1,33}(?:\s|$)|\S+?(?:\s|$)/g)
      ?.map((line) => line.trim())
      .join(String.raw`\N`) ?? "";
  const assTime = (seconds: number) => {
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 3600)}:${String(Math.floor(whole / 60) % 60).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}.${String(Math.floor((seconds % 1) * 100)).padStart(2, "0")}`;
  };
  const events = chapters
    .map(
      (chapter, index) =>
        String.raw`Dialogue: 0,${assTime(chapter.time)},${assTime(chapters[index + 1]?.time ?? 3600)},Caption,,0,0,0,,${wrap(chapter.title)}\N\N${wrap(chapter.caption)}`,
    )
    .join("\n");
  const subtitles = join(scratch, "captions.ass");
  await writeFile(
    subtitles,
    `[Script Info]
ScriptType: v4.00+
PlayResX: 1000
PlayResY: 900
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,DejaVu Sans,24,&H00232E25,&H00232E25,&H00F5F9FA,&H00F5F9FA,0,0,0,0,100,100,0,0,1,0,0,4,460,30,80,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`,
  );
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      videoPath,
      "-vf",
      `pad=1000:900:30:28:color=0xfaf9f5,drawtext=text='HEARTH  /  CONCEPT A':x=460:y=100:fontsize=28:fontcolor=0x405438,ass=${subtitles}`,
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-an",
      join(output, "hearth-concept-a-demo.mp4"),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const timestamp = (time: number) =>
    `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, "0")}`;
  await writeFile(
    join(output, "demo-guide.md"),
    `# Concept A walkthrough

[Watch the captioned demo](file://${join(output, "hearth-concept-a-demo.mp4")})

Recorded from the real local Worker/D1 app using Chromium's touch-enabled 390×844 profile. This is emulation, not a physical phone. Captions and tap markers were added to the recording only; no application behavior was mocked. No narration/audio is included.

${chapters.map((c) => `- **${timestamp(c.time)} — ${c.title}**: ${c.caption}`).join("\n")}

## Coverage limits
${limitations.map((l) => `- ${l}`).join("\n")}
- Onboarding/sample-week creation was exercised during the preceding review, not repeated in this recording.
- Keyboard appearance and physical-device safe areas are not verified by desktop emulation.

All demo mutations were checked against persisted household state. Original household data was exactly restored.

Next step: review the recording and try the live portal before requesting shipment.
`,
  );
  console.log(
    `PASS captioned demo: ${chapters.length} chapters; ${join(output, "hearth-concept-a-demo.mp4")}`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
