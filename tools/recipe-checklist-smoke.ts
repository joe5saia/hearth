import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { addDays, HouseholdSchema, weekStart, type GroceryDraft, type IngredientDraft, type MealDraft, type RecipeDraft } from "../src/domain.ts";

// Real browser + Worker/D1; fixture records are removed even on failure.
const url = process.argv[2] ?? "http://localhost:5173";
assert(["localhost", "127.0.0.1"].includes(new URL(url).hostname), "Use local development only.");
const session = `checklist-${process.pid}`;
const browser = (...args: string[]) => execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8", timeout: 90_000 }).trim();
const check = (expression: string, message: string) => {
  browser("eval", `(() => { if (!(${expression})) throw new Error(${JSON.stringify(message)}); return true; })()`);
  console.log(`PASS ${message}`);
};
const request = async (path: string, method = "GET", body?: GroceryDraft | RecipeDraft | MealDraft) => {
  // Only fixture setup/cleanup uses a freshly read revision; UI requests stay untouched.
  let payload = body ? JSON.stringify(body) : undefined;
  const resource = path.split("/")[0];
  if ((method === "PUT" || method === "DELETE") && (resource === "recipes" || resource === "groceries" || resource === "meals")) {
    const current = await household();
    const id = method === "DELETE" ? decodeURIComponent(path.slice(resource.length + 1)) : body?.id;
    const saved = current[resource].find(item => item.id === id);
    if (method === "DELETE" && !saved) return new Response(null, { status: 200 });
    payload = JSON.stringify({ ...body, expectedRevision: saved?.revision ?? null });
  }
  const response = await fetch(`${url}/api/${path}`, { method, headers: { "Content-Type": "application/json" }, body: payload });
  assert(response.ok, `${method} ${path}: ${response.status}`);
  return response;
};
const household = async () => {
  const value: unknown = await (await request("household")).json();
  assert.ok(Schema.is(HouseholdSchema)(value), "Household response must match its contract.");
  return value;
};
const original = await household();
assert(!original.recipes.length && !original.groceries.length && !original.meals.length, "Use an empty disposable local household.");
const prefix = `checklist-${crypto.randomUUID()}`;
const groceries: GroceryDraft[] = [
  { id: `${prefix}-rice`, name: "Long-grain rice", aliases: ["rice", "white rice"], quantity: 500, unit: "g", aisle: "", url: "" },
  { id: `${prefix}-oil`, name: "Olive oil", aliases: ["oil"], quantity: 500, unit: "ml", aisle: "", url: "" },
  { id: `${prefix}-butter`, name: "Butter", aliases: [], quantity: 1, unit: "lb", aisle: "", url: "" },
  { id: `${prefix}-salt`, name: "Salt", aliases: [], quantity: 100, unit: "g", aisle: "", url: "" },
  { id: `${prefix}-panko`, name: "Panko bread crumbs", aliases: ["panko"], quantity: 8, unit: "oz", aisle: "", url: "" },
];
const recipe = (id: string, title: string, ingredients: IngredientDraft[]): RecipeDraft => ({ id: `${prefix}-${id}`, title, ingredients, description: "", servings: 2, minutes: 20, category: "", photo: "", source: "", rating: "neutral", instructions: ["Cook and serve."] });
const recipes = [
  recipe("dinner", "Rice dinner", [
    { name: "rice", quantity: 250, unit: "g" },
    { name: "oil", quantity: 1, unit: "cup" },
    { name: "Butter", quantity: 4, unit: "oz" },
    { name: "Salt", quantity: 10, unit: "g" },
    { name: "Parsley", quantity: 1, unit: "bunch", groceryItemId: null },
    { name: "Lime", quantity: 2, unit: "each" },
    { name: "Sugar", quantity: 1, unit: "cup" },
    { name: "Milk", quantity: 750, unit: "ml" },
    // Half a US cup precedes the customary entries: metric-first ordering must not choose ml.
    { name: "panko", quantity: 118.29411825, unit: "ml" },
    { name: "panko", quantity: 1.25, unit: "cup" },
  ]),
  recipe("lunch", "Rice lunch", [
    { name: "white rice", quantity: 0.75, unit: "kg" },
    { name: "oil", quantity: 2, unit: "tbsp" },
    { name: "oil", quantity: 3, unit: "tsp" },
    { name: "Butter", quantity: 0.5, unit: "lb" },
    { name: "Salt", quantity: 1, unit: "tsp" },
    { name: " parsley ", quantity: 2, unit: "bunch", groceryItemId: null },
    { name: "lime", quantity: 3, unit: "each" },
    { name: "sugar", quantity: 4, unit: "tbsp" },
    { name: "milk", quantity: 0.5, unit: "l" },
    { name: "panko", quantity: 4, unit: "tbsp" },
  ]),
  recipe("other", "Unselected recipe", [{ name: "rice", quantity: 9, unit: "kg" }]),
];
// This week repeats and scales one recipe; each meal contributes its own planned quantities.
const week = weekStart();
const meal = (id: string, recipeId: string, date: string, scale = 1): MealDraft => ({ id: `${prefix}-${id}`, recipeId: `${prefix}-${recipeId}`, date, slot: "Dinner", scale, note: "" });
const meals = [
  meal("monday", "dinner", week),
  meal("wednesday", "lunch", addDays(week, 2)),
  meal("friday", "dinner", addDays(week, 4), 2),
  meal("next-week", "other", addDays(week, 7)),
];
const totals = () => JSON.parse(browser("eval", "Object.fromEntries([...document.querySelectorAll('[aria-label=\"Ingredients needed\"] label')].map(row => [row.querySelector('strong').textContent, row.querySelector('strong + span').textContent]))"));
const weekButton = "document.querySelector('.recipe-checklist-week .secondary')";
const screenshot = (name: string) => {
  browser("eval", "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  browser("screenshot", "--full", resolve(`.amp/in/artifacts/${name}.png`));
};

try {
  await mkdir(".amp/in/artifacts", { recursive: true });
  browser("open", `${url}/#recipe-checklist`);
  browser("set", "viewport", "1280", "900", "2");
  browser("wait", ".recipe-checklist form");
  check("document.body.textContent.includes('No recipes yet') && document.querySelector('.primary').disabled", "empty household has guidance and cannot generate a checklist");
  for (const grocery of groceries) await request("groceries", "PUT", grocery);
  for (const item of recipes) await request("recipes", "PUT", item);
  for (const item of meals) await request("meals", "PUT", item);
  const before = await household();
  browser("open", `${url}/#shopping`);
  browser("wait", '.shopping-controls a[href="#recipe-checklist"]');
  screenshot("recipe-checklist-shopping-button");
  browser("set", "viewport", "390", "844", "2");
  check("document.documentElement.scrollWidth <= innerWidth", "new shopping button fits narrow controls");
  screenshot("recipe-checklist-shopping-button-narrow");
  browser("click", '.shopping-controls a[href="#recipe-checklist"]');
  const tabs = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Struct({ tabs: Schema.Array(Schema.Struct({ url: Schema.String, tabId: Schema.String })) }) }))(JSON.parse(browser("tab", "list", "--json"))).data.tabs;
  assert.equal(tabs.length, 2, "The real link opens a new tab.");
  const checklistTab = tabs.find(tab => tab.url.endsWith("#recipe-checklist"));
  assert(checklistTab, "The new checklist tab must exist.");
  browser("tab", checklistTab.tabId);
  browser("set", "viewport", "1280", "900", "2");
  browser("wait", '.recipe-checklist form .recipe-checklist-row');
  check("!document.querySelector('.sidebar') && document.querySelector('.primary').disabled", "new tab has a standalone, initially unselected recipe picker");
  screenshot("recipe-checklist-picker");
  check(`${weekButton}.textContent.includes('(3 meals)') && !${weekButton}.disabled`, "current meal-plan week offers all three meals, including repeated sources");
  browser("click", '[aria-label="Previous week"]');
  check(`${weekButton}.disabled && ${weekButton}.textContent === 'No recipes planned this week'`, "week without planned recipes cannot generate a checklist");
  browser("click", '[aria-label="Next week"]');
  browser("click", '[aria-label="Next week"]');
  check(`${weekButton}.textContent.includes('(1 meal)')`, "next week offers only its planned meal");
  browser("click", ".recipe-checklist-week .secondary");
  browser("wait", '[aria-label="Ingredients needed"]');
  assert.deepEqual(totals(), { "Long-grain rice": "9 kg" });
  console.log("PASS next week's checklist contains only next week's recipe");
  browser("click", ".secondary");
  browser("click", '[aria-label="Previous week"]');
  browser("set", "viewport", "390", "844", "2");
  check("document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.recipe-checklist-week button')].every(button => button.getBoundingClientRect().height >= 44)", "narrow meal-plan week controls fit and have touch-sized targets");
  screenshot("recipe-checklist-week-narrow");
  browser("set", "viewport", "1280", "900", "2");
  screenshot("recipe-checklist-week");
  browser("click", ".recipe-checklist-week .secondary");
  browser("wait", '[aria-label="Ingredients needed"]');
  check("document.body.textContent.includes('Rice dinner (4 servings, 2×)') && document.body.textContent.includes('Rice lunch (2 servings, 1×)') && !document.body.textContent.includes('Unselected recipe')", "week checklist names this week's scaled meals and replaces the previous selection");
  assert.deepEqual(totals(), { Butter: "1.25 lb", Lime: "9", "Long-grain rice": "1.5 kg", Milk: "2.75 l", "Olive oil": "754.13 ml", "Panko bread crumbs": "5.5 cup", Parsley: "5 bunch", Salt: "30 g + 1 tsp", Sugar: "3.25 cup" });
  browser("reload");
  browser("wait", '[aria-label="Ingredients needed"]');
  assert.equal(totals()["Long-grain rice"], "1.5 kg");
  console.log("PASS this week's checklist totals every scaled meal and survives reload");
  screenshot("recipe-checklist-week-totals");
  browser("click", ".secondary");
  browser("wait", ".recipe-checklist form");
  for (let index = 0; index < 3; index++) browser("click", '[aria-label="Selected meals"] label:first-child input');
  browser("find", "label", "Rice dinner", "check");
  browser("fill", 'input[type="search"]', "lunch");
  browser("find", "label", "Rice lunch", "check");
  browser("fill", 'input[type="search"]', "not a recipe");
  check("document.body.textContent.includes('No recipes match') && document.querySelector('.primary').textContent.includes('2 recipes')", "search preserves selections and has a no-match state");
  browser("click", ".primary");
  browser("wait", '[aria-label="Ingredients needed"]');
  // Exact equality below validates every key and amount, including unexpected rows.
  const amounts: unknown = JSON.parse(browser("eval", "Object.fromEntries([...document.querySelectorAll('[aria-label=\"Ingredients needed\"] label')].map(row => [row.querySelector('strong').textContent, row.querySelector('strong + span').textContent]))"));
  assert.deepEqual(amounts, { Butter: "0.75 lb", Lime: "5", "Long-grain rice": "1 kg", Milk: "1.25 l", "Olive oil": "280.95 ml", "Panko bread crumbs": "2 cup", Parsley: "3 bunch", Salt: "10 g + 1 tsp", Sugar: "1.25 cup" });
  console.log("PASS combined weights, US volumes, metric volumes, counts, linked aliases and unlinked names; incompatible units retain honest subtotals; unselected recipe excluded");
  screenshot("recipe-checklist-totals");
  browser("find", "label", "Long-grain rice", "check");
  check("document.querySelector('[role=status]').textContent.includes('8 of 9') && document.querySelectorAll('[aria-label=\"Ingredients needed\"] input:checked').length === 1", "manual checkbox changes only its row and progress");
  browser("set", "viewport", "390", "844", "2");
  check("document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.recipe-checklist-row')].every(row => row.getBoundingClientRect().height >= 44)", "narrow checklist fits and has accessible row targets");
  screenshot("recipe-checklist-checked-narrow");
  browser("find", "label", "Long-grain rice", "click");
  check("document.querySelector('[role=status]').textContent.includes('9 of 9')", "manual checkbox can be unchecked");
  browser("click", ".secondary");
  browser("fill", 'input[type="search"]', "Rice");
  browser("wait", "--fn", "document.querySelectorAll('input:checked').length === 2");
  check("document.querySelectorAll('input:checked').length === 2", "changing recipes retains selections");
  browser("find", "label", "Rice lunch", "click");
  browser("click", ".primary");
  check("[...document.querySelectorAll('strong')].some(el => el.textContent === 'Long-grain rice' && el.nextElementSibling.textContent === '250 g') && !document.querySelector('input:checked')", "regeneration recalculates totals and resets checks");
  browser("reload");
  browser("wait", '[aria-label="Ingredients needed"]');
  check("[...document.querySelectorAll('strong')].some(el => el.textContent === 'Long-grain rice' && el.nextElementSibling.textContent === '250 g') && !document.querySelector('input:checked')", "reload preserves shareable selections and list but resets disposable checks");
  assert.deepEqual(await household(), before, "All checklist operations must leave the real household unchanged.");
  console.log("Recipe checklist browser smoke passed; household unchanged.");

  // Reuse only our disposable fixtures to exercise the shopping picker's Friday/Saturday boundary.
  await request("meals", "PUT", meal("monday", "dinner", "2026-10-23"));
  await request("meals", "PUT", meal("friday", "dinner", "2026-10-24"));
  await request("meals", "PUT", meal("wednesday", "lunch", "2026-10-23"));
  await request(`meals/${encodeURIComponent(`${prefix}-next-week`)}`, "DELETE");
  browser("open", `${url}/#shopping`);
  browser("reload");
  browser("wait", ".shopping-controls");
  browser("find", "role", "button", "click", "--name", "Add from recipes", "--exact");
  browser("wait", ".shopping-recipe-week");
  const shoppingGroups = "[...document.querySelectorAll('section[aria-labelledby^=\"recipe-week-\"]')].map(group => ({ heading: group.querySelector('h4').innerText.replaceAll('\\n', ' '), recipes: [...group.querySelectorAll('strong')].map(title => title.textContent) }))";
  assert.deepEqual(JSON.parse(browser("eval", shoppingGroups)), [
    { heading: "Saturday, October 24 – Friday, October 30, 2026", recipes: ["Rice dinner"] },
    { heading: "Saturday, October 17 – Friday, October 23, 2026", recipes: ["Rice dinner", "Rice lunch"] },
    { heading: "Not yet planned", recipes: ["Unselected recipe"] },
  ]);
  console.log("PASS each meal stays in its own week, Friday and Saturday split weeks, unplanned recipes remain available");
  browser("click", 'section[aria-labelledby="recipe-week-2026-10-24"] input');
  browser("find", "label", "Search recipes", "fill", "lunch");
  check("document.querySelectorAll('.shopping-recipe-week').length === 1 && document.querySelector('.shopping-recipe-week').textContent.includes('Saturday, October 17')", "search removes empty weeks and keeps the matching recipe's heading");
  browser("find", "label", "Rice lunch", "click");
  browser("find", "label", "Search recipes", "fill", "no-such-recipe");
  check("!document.querySelector('.shopping-recipe-week') && document.body.textContent.includes('No recipes match your search.')", "no-match search has no orphan week headings");
  browser("press", "Control+a");
  browser("press", "Backspace");
  check("document.querySelectorAll('.shopping-recipe-week input:checked').length === 2", "selections survive filtering across weeks");
  browser("find", "role", "button", "click", "--name", "Review items", "--exact");
  check("document.querySelector('h3').textContent === 'Review items' && document.querySelectorAll('.shopping-review-item').length > 0", "cross-week selection reaches item review");
  check("[...document.querySelectorAll('.shopping-review-item')].some(row => row.querySelector('strong').textContent === 'Panko bread crumbs' && row.textContent.includes('Recipes need 2 cup') && row.textContent.includes('8 oz per package') && row.querySelector('input[type=number]').value === '')", "mixed recipe volumes prefer cups over an earlier metric amount when the package uses weight, without guessing package counts");
  check("[...document.querySelectorAll('.shopping-review-item')].some(row => row.querySelector('strong').textContent === 'Olive oil' && row.textContent.includes('Recipes need 280.95 ml') && row.querySelector('input[type=number]').value === '1')", "compatible recipe volumes still use package units and suggest package counts");
  browser("find", "role", "button", "click", "--name", "Back", "--exact");
  check("document.querySelectorAll('.shopping-recipe-week input:checked').length === 2", "returning from review preserves both selections");
  browser("find", "role", "button", "click", "--name", "Cancel", "--exact");

  await request("meals", "PUT", meal("friday", "dinner", "2026-11-01"));
  await request("meals", "PUT", meal("wednesday", "lunch", "2026-12-31"));
  browser("reload");
  browser("wait", ".shopping-controls");
  browser("find", "role", "button", "click", "--name", "Add from recipes", "--exact");
  browser("wait", ".shopping-recipe-week");
  assert.deepEqual(JSON.parse(browser("eval", shoppingGroups)), [
    { heading: "Saturday, December 26 – Friday, January 1, 2027", recipes: ["Rice lunch"] },
    { heading: "Saturday, October 31 – Friday, November 6, 2026", recipes: ["Rice dinner"] },
    { heading: "Saturday, October 17 – Friday, October 23, 2026", recipes: ["Rice dinner"] },
    { heading: "Not yet planned", recipes: ["Unselected recipe"] },
  ]);
  console.log("PASS week ranges cross month/year boundaries and the November daylight-saving transition");
} finally {
  try { browser("close"); } finally {
    for (const item of (await household()).meals.filter(item => item.id.startsWith(prefix))) await request(`meals/${encodeURIComponent(item.id)}`, "DELETE");
    const current = await household();
    for (const item of current.recipes.filter(item => item.id.startsWith(prefix))) await request(`recipes/${encodeURIComponent(item.id)}`, "DELETE");
    for (const grocery of current.groceries.filter(item => item.id.startsWith(prefix))) await request(`groceries/${encodeURIComponent(grocery.id)}`, "DELETE");
    assert.deepEqual(await household(), original, "Fixture cleanup must restore the starting household.");
  }
}
