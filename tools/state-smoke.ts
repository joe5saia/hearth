import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { HouseholdSchema, type Household } from "../src/domain.ts";

// Supplied by task ui:setup, outside the production dependency graph.
// @ts-ignore External browser declarations.
import type * as Playwright from "/tmp/hearth-ui/node_modules/@playwright/test/index.d.ts";
// @ts-expect-error External browser runtime.
const { chromium, webkit, devices, expect }: typeof Playwright = await import("/tmp/hearth-ui/node_modules/@playwright/test/index.mjs");

const root = new URL(process.argv[2] ?? "http://localhost:5173").origin;
assert(["localhost", "127.0.0.1"].includes(new URL(root).hostname), "Disposable local fixtures only");
const artifacts = resolve(".amp/in/artifacts");
await mkdir(artifacts, { recursive: true });
const household = async () => Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
const original = await household();
const content = (data: Household) => JSON.parse(JSON.stringify(data, (key, value) => key === "revision" ? undefined : value));
const ids = { recipe: crypto.randomUUID(), meal: crypto.randomUUID(), grocery: crypto.randomUUID(), collection: crypto.randomUUID(), list: crypto.randomUUID() };
const owned = [
  ["meals", "meals", ids.meal], ["recipes", "recipes", ids.recipe], ["shopping-lists", "shoppingLists", ids.list],
  ["groceries", "groceries", ids.grocery], ["collections", "collections", ids.collection],
] as const;

async function write(path: string, method: string, body: object, status = 200) {
  const response = await fetch(`${root}/api/${path}`, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(response.status, status, `${method} ${path}: ${await response.text()}`);
}

async function clean() {
  for (const [path, key, id] of owned) {
    const entry = (await household())[key].find(entry => entry.id === id);
    if (entry) await write(`${path}/${id}`, "DELETE", { expectedRevision: entry.revision });
  }
}

async function seed() {
  await write("collections", "PUT", { id: ids.collection, name: "State smoke collection", expectedRevision: null });
  await write("groceries", "PUT", { id: ids.grocery, name: "State smoke lentils", quantity: 500, unit: "g", aisle: "State smoke", url: "", aliases: [], expectedRevision: null });
  await write("recipes", "PUT", { id: ids.recipe, title: "State smoke soup", description: "Disposable two-device fixture", servings: 3, minutes: 20, category: "State smoke collection", photo: "", source: "", rating: "neutral", ingredients: [{ name: "Lentils", quantity: 100, unit: "g", groceryItemId: ids.grocery }], instructions: ["Simmer for twenty minutes."], expectedRevision: null });
  await write("meals", "PUT", { id: ids.meal, recipeId: ids.recipe, date: "2026-11-02", slot: "Dinner", scale: 1.5, note: "Add cauliflower", expectedRevision: null });
  await write("shopping-lists", "PUT", { id: ids.list, date: "2026-11-01", label: "State smoke", expectedRevision: null });
  await write(`shopping-lists/${ids.list}/items`, "POST", { items: [{ groceryId: ids.grocery }] });
}

let count = 0;
try {
  for (const [profile, engine, options] of [
    ["desktop", chromium, { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 }],
    ["iphone", webkit, { ...devices["iPhone 14"], deviceScaleFactor: 2 }],
  ] as const) {
    await seed();
    const browser = await engine.launch();
    const context = await browser.newContext(options);
    const a = await context.newPage();
    const b = await context.newPage();
    const errors: string[] = [];
    for (const page of [a, b]) page.on("pageerror", error => errors.push(error.message));
    const open = async (page: Playwright.Page, hash: string) => {
      await page.goto(`${root}/${hash}`, { waitUntil: "networkidle" });
      // Hash-only navigation need not remount the app; reload to capture a new editor base.
      await page.reload({ waitUntil: "networkidle" });
    };
    const resume = async (page: Playwright.Page, event = "focus") => {
      const response = page.waitForResponse(response => response.url().endsWith("/api/household"));
      await page.evaluate(event => {
        if (event === "visibilitychange") document.dispatchEvent(new Event(event));
        else window.dispatchEvent(new Event(event));
      }, event);
      await response;
    };
    const submit = async (page: Playwright.Page, label: string, path: string, status: number) => {
      const response = page.waitForResponse(response => new URL(response.url()).pathname === `/api/${path}` && response.request().method() !== "GET");
      await page.getByRole("button", { name: label, exact: true }).click();
      assert.equal((await response).status(), status);
      if (status === 409) await expect(page.getByRole("button", { name: "Load latest", exact: true })).toBeVisible();
    };
    const check = async (name: string, run: () => Promise<void>) => {
      await run(); count++; console.log(`PASS ${profile}: ${name}`);
    };
    try {
      await check("recipe conflict survives resume and explicit recovery", async () => {
        const route = `#recipes?view=editor&id=${ids.recipe}`;
        await open(a, route); await open(b, route);
        await b.getByLabel("Recipe name", { exact: true }).fill("My unsaved soup title");
        await a.getByLabel("Step 1", { exact: true }).fill("Roast the vegetables first, then simmer.");
        await submit(a, "Save recipe", "recipes", 200);
        await resume(b, "visibilitychange");
        await expect(b.getByLabel("Recipe name", { exact: true })).toHaveValue("My unsaved soup title");
        await expect(b.getByLabel("Step 1", { exact: true })).toHaveValue("Simmer for twenty minutes.");
        await b.getByLabel("Recipe name", { exact: true }).scrollIntoViewIfNeeded();
        await b.screenshot({ path: `${artifacts}/state-draft-${profile}.png` });
        await submit(b, "Save recipe", "recipes", 409);
        await expect(b.getByLabel("Recipe name", { exact: true })).toHaveValue("My unsaved soup title");
        assert.equal((await household()).recipes.find(entry => entry.id === ids.recipe)?.title, "State smoke soup");
        await b.getByRole("button", { name: "Load latest", exact: true }).scrollIntoViewIfNeeded();
        await b.screenshot({ path: `${artifacts}/state-conflict-${profile}.png` });
        await b.getByRole("button", { name: "Load latest", exact: true }).click();
        await b.screenshot({ path: `${artifacts}/state-confirm-${profile}.png` });
        await b.getByRole("button", { name: "Keep editing", exact: true }).click();
        await expect(b.getByLabel("Recipe name", { exact: true })).toHaveValue("My unsaved soup title");
        await b.getByRole("button", { name: "Load latest", exact: true }).click();
        await b.getByRole("button", { name: "Replace draft", exact: true }).click();
        await expect(b.getByLabel("Step 1", { exact: true })).toHaveValue("Roast the vegetables first, then simmer.");
        await expect(b.getByLabel("Recipe name", { exact: true })).toHaveValue("State smoke soup");
        await b.getByLabel("Recipe name", { exact: true }).fill("My reviewed soup title");
        let releaseSave = () => {};
        const saving = new Promise<void>(resolve => { releaseSave = resolve; });
        await b.route("**/api/recipes", async route => { await saving; await route.continue(); });
        const savedResponse = b.waitForResponse(response => response.url().endsWith("/api/recipes") && response.request().method() === "PUT");
        try {
          await b.getByRole("button", { name: "Save recipe", exact: true }).click();
          await expect(b.getByLabel("Recipe name", { exact: true })).toBeDisabled();
          await expect(b.getByLabel("Step 1", { exact: true })).toBeDisabled();
          await b.screenshot({ path: `${artifacts}/state-saving-${profile}.png` });
        } finally { releaseSave(); }
        assert.equal((await savedResponse).status(), 200);
        await b.unroute("**/api/recipes");
        await expect(b.getByRole("dialog")).toHaveCount(0);
        const saved = (await household()).recipes.find(entry => entry.id === ids.recipe);
        assert.equal(saved?.title, "My reviewed soup title");
        assert.deepEqual(saved?.instructions, ["Roast the vegetables first, then simmer."]);
      });
      await check("meal edits cannot overwrite another device", async () => {
        const route = `#plan?week=2026-10-31&view=editor&id=${ids.recipe}&meal=${ids.meal}`;
        await open(a, route); await open(b, route);
        await b.getByLabel("Meal note", { exact: true }).fill("My dinner note draft");
        await a.getByLabel("Ingredient 1 quantity", { exact: true }).fill("500");
        await submit(a, "Save meal", "meals", 200);
        await resume(b, "online");
        await submit(b, "Save meal", "meals", 409);
        await expect(b.getByLabel("Meal note", { exact: true })).toHaveValue("My dinner note draft");
        assert.equal((await household()).meals.find(entry => entry.id === ids.meal)?.recipe?.ingredients[0].quantity, 500);
      });
      await check("inline note preserves concurrent schedule and detects competing note", async () => {
        await open(b, `#plan?week=2026-10-31&view=recipe&id=${ids.recipe}&meal=${ids.meal}`);
        await b.getByRole("button", { name: "Edit meal note", exact: true }).click();
        await b.getByLabel("Meal note", { exact: true }).fill("Bring the cauliflower");
        const meal = (await household()).meals.find(entry => entry.id === ids.meal);
        assert(meal);
        await write("meals", "PUT", { ...meal, date: "2026-11-05", scale: 2, expectedRevision: meal.revision });
        await resume(b);
        await expect(b.getByLabel("Meal note", { exact: true })).toHaveValue("Bring the cauliflower");
        await submit(b, "Save note", `meals/${ids.meal}`, 200);
        const saved = (await household()).meals.find(entry => entry.id === ids.meal);
        assert.equal(saved?.date, "2026-11-05"); assert.equal(saved?.scale, 2);
        assert.equal(saved?.recipe?.ingredients[0].quantity, 500);
        await b.getByRole("button", { name: "Edit meal note", exact: true }).click();
        await b.getByLabel("Meal note", { exact: true }).fill("My competing note");
        await write(`meals/${ids.meal}`, "PATCH", { note: "Their saved note", expectedNote: "Bring the cauliflower" });
        await resume(b, "online");
        await expect(b.getByLabel("Meal note", { exact: true })).toHaveValue("My competing note");
        await submit(b, "Save note", `meals/${ids.meal}`, 409);
        assert.equal((await household()).meals.find(entry => entry.id === ids.meal)?.note, "Their saved note");
      });
      await check("late background response cannot roll back a successful save", async () => {
        await open(b, `#plan?week=2026-10-31&view=recipe&id=${ids.recipe}&meal=${ids.meal}`);
        await b.getByRole("button", { name: "Edit meal note", exact: true }).click();
        await b.getByLabel("Meal note", { exact: true }).fill("Newest saved note");
        let release = () => {};
        let captured = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        const ready = new Promise<void>(resolve => { captured = resolve; });
        let first = true;
        await b.route("**/api/household", async route => {
          if (!first) { await route.continue(); return; }
          first = false;
          const response = await route.fetch();
          captured();
          await gate;
          await route.fulfill({ response });
        });
        try {
          await b.evaluate(() => window.dispatchEvent(new Event("focus")));
          await ready;
          await submit(b, "Save note", `meals/${ids.meal}`, 200);
          await expect(b.locator(".meal-detail-note")).toContainText("Newest saved note");
        } finally { release(); }
        await b.waitForLoadState("networkidle");
        await b.unroute("**/api/household");
        await expect(b.locator(".meal-detail-note")).toContainText("Newest saved note");
      });
      await check("grocery and collection editors retain stale drafts", async () => {
        for (const config of [
          { table: "groceries", id: ids.grocery, route: `#groceries?view=grocery&id=${ids.grocery}`, label: "Store product name", save: "Save grocery item" },
          { table: "collections", id: ids.collection, route: `#recipes?view=collection&id=${ids.collection}`, label: "Collection name", save: "Save collection" },
        ] as const) {
          await open(b, config.route);
          await b.getByLabel(config.label, { exact: true }).fill("My unsaved name");
          const saved = (await household())[config.table].find(entry => entry.id === config.id);
          assert(saved);
          await write(config.table, "PUT", { ...saved, name: `New ${config.table} name`, expectedRevision: saved.revision });
          await resume(b);
          await submit(b, config.save, config.table, 409);
          await expect(b.getByLabel(config.label, { exact: true })).toHaveValue("My unsaved name");
          assert.equal((await household())[config.table].find(entry => entry.id === config.id)?.name, `New ${config.table} name`);
        }
      });
      await check("deleted meal cannot be recreated by an open editor", async () => {
        await open(b, `#plan?week=2026-10-31&view=editor&id=${ids.recipe}&meal=${ids.meal}`);
        await b.getByLabel("Meal name", { exact: true }).fill("A draft for a deleted dinner");
        const meal = (await household()).meals.find(entry => entry.id === ids.meal);
        assert(meal);
        await write(`meals/${ids.meal}`, "DELETE", { expectedRevision: meal.revision });
        await resume(b);
        await submit(b, "Save meal", "meals", 409);
        await expect(b.getByLabel("Meal name", { exact: true })).toHaveValue("A draft for a deleted dinner");
        assert(!(await household()).meals.some(entry => entry.id === ids.meal));
      });
      await check("Shop Mode check preserves a concurrent count and list edit", async () => {
        // The editor scenario above renamed the grocery on purpose.
        const picked = `Picked up ${(await household()).groceries.find(entry => entry.id === ids.grocery)?.name}`;
        await open(b, `#shopping?list=${ids.list}&mode=focus`);
        await expect(b.getByLabel(picked, { exact: true })).not.toBeChecked();
        const list = (await household()).shoppingLists.find(entry => entry.id === ids.list);
        assert(list);
        await write("shopping-lists", "PUT", { ...list, label: "Renamed list", expectedRevision: list.revision });
        await write(`shopping-lists/${ids.list}/items/${ids.grocery}`, "PATCH", { packages: 3 });
        const response = b.waitForResponse(response => response.url().endsWith(`/api/shopping-lists/${ids.list}/items/${ids.grocery}`) && response.request().method() === "PATCH");
        await b.getByLabel(picked, { exact: true }).click();
        assert.equal((await response).status(), 200);
        await expect(b.getByLabel(picked, { exact: true })).toBeChecked();
        const saved = await household();
        assert.equal(saved.shoppingLists.find(entry => entry.id === ids.list)?.label, "Renamed list");
        const item = saved.shoppingItems.find(entry => entry.listId === ids.list && entry.groceryId === ids.grocery);
        assert.equal(item?.checked, 1); assert.equal(item?.packages, 3);
      });
      assert.deepEqual(errors, [], "No uncaught browser errors");
    } catch (error) {
      console.error({ profile, a: a.url(), b: b.url(), errors, alerts: await b.getByRole("alert").allTextContents() });
      throw error;
    } finally {
      await browser.close();
      await clean();
    }
  }
} finally {
  await clean();
  assert.deepEqual(content(await household()), content(original), "All household content restored; only revision metadata may rotate");
}
console.log(`PASS ${count} state-safety browser scenarios; original household content preserved`);
