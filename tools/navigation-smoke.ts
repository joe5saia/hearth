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
const grocery = { id: id(), name: "Navigation smoke lentils", unit: "g", quantity: 500, url: "", aisle: "Pantry", aliases: [] };
const recipe = { id: id(), title: "Navigation smoke lentil soup", description: "Disposable browser fixture", servings: 3, minutes: 20, category: collection.name, photo: "", source: "", rating: "neutral", ingredients: [{ name: grocery.name, quantity: 250, unit: "g", groceryItemId: grocery.id }], instructions: ["Simmer until tender."] };
const meal = { id: id(), recipeId: recipe.id, date: "2026-11-04", slot: "Dinner", scale: 1.5, note: "Saved household meal" };
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
  for (const [engine, profile, options] of [
    [chromium, "desktop", { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }],
    [webkit, "iphone", devices["iPhone 14"]],
    [webkit, "ipad", devices["iPad (gen 7)"]],
  ] as const) {
    const browser = await engine.launch();
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.on("pageerror", () => errors.push(`${profile}: browser exception`));
    try {
      const check = async (name: string, run: () => Promise<void>) => {
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
        await expect(page.getByRole("button", { name: "Show checked items", exact: true })).toHaveAttribute("aria-pressed", "true");
        await shot("shopping");
        await page.getByRole("button", { name: "List Builder", exact: true }).click();
        await expect(page).toHaveURL(/mode=builder/);
        await page.goBack();
        await expect(page.getByRole("button", { name: "Exit shopping mode", exact: true })).toBeVisible();
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
        await dialog().getByRole("button", { name: "Edit meal", exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`view=meal&id=${meal.id}`));
        await dialog().getByLabel(/A note for this meal/).fill("Saved by navigation E2E");
        await dialog().getByRole("button", { name: "Save to meal plan", exact: true }).click();
        await expect(dialog()).toHaveCount(0);
        await expect(page).toHaveURL(`${root}/#plan?week=2026-11-02`);
        await page.reload();
        await open(`#plan?week=2026-11-02&view=meal&id=${meal.id}`);
        await expect(dialog().getByLabel(/A note for this meal/)).toHaveValue("Saved by navigation E2E");
        await api("meals", "PUT", meal);
      });
      await check("Back during a pending save keeps the user's destination after the write completes", async () => {
        await open(`#plan?week=2026-11-02&view=recipe&id=${recipe.id}&meal=${meal.id}`);
        await page.reload();
        await dialog().getByRole("button", { name: "Edit meal", exact: true }).click();
        await dialog().getByLabel(/A note for this meal/).fill("Pending navigation save");
        let release: (() => void) | undefined;
        let requested: (() => void) | undefined;
        const held = new Promise<void>((done) => { release = done; });
        const started = new Promise<void>((done) => { requested = done; });
        const hold = async (route: Playwright.Route) => { requested?.(); await held; await route.continue(); };
        await page.route("**/api/meals", hold);
        try {
          await dialog().getByRole("button", { name: "Save to meal plan", exact: true }).click();
          await started;
          await page.goBack();
          await expect(dialog()).toHaveAttribute("aria-label", "Recipe details");
          release?.();
          await expect(page.getByText("Meal plan updated", { exact: true })).toBeVisible();
          await expect(dialog()).toHaveAttribute("aria-label", "Recipe details");
          await expect(page).toHaveURL(new RegExp(`view=recipe&id=${recipe.id}`));
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
        for (const hash of [`#recipes?view=recipe&id=${recipe.id}`, "#plan?week=2026-11-02", "#shopping?mode=focus&hideChecked=1"]) {
          await open(hash);
          await page.evaluate(() => Object.defineProperty(navigator, "share", { configurable: true, value: async (payload: ShareData) => { window.shared = payload; } }));
          await page.getByRole("button", { name: "Share link", exact: true }).last().click();
          await expect.poll(() => page.evaluate(() => window.shared?.url)).toBe(`${root}/${hash}`);
        }
        await page.evaluate(() => history.replaceState(history.state, "", `${location.pathname}?auth-secret=DO-NOT-SHARE${location.hash}&token=DO-NOT-SHARE`));
        await page.getByRole("button", { name: "Share link", exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.shared?.url)).toBe(`${root}/#shopping?mode=focus&hideChecked=1`);
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
  await api(`recipes/${recipe.id}`, "DELETE");
  await api(`groceries/${grocery.id}`, "DELETE");
  await api(`collections/${collection.id}`, "DELETE");
}
const after = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${root}/api/household`)).json());
assert.deepEqual(after, original, "Fixture cleanup must preserve original household");
console.log(`PASS ${count} navigation scenarios across desktop Chromium and touch iPhone/iPad WebKit; household unchanged.`);
