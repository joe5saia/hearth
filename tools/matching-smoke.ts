import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { HouseholdSchema, type GroceryItem, type Recipe } from "../src/domain.ts";

// Real browser -> local Worker -> SQLite. AI output is tested separately with matching:eval.
const url = process.argv[2] ?? "http://localhost:5173";
assert(["localhost", "127.0.0.1"].includes(new URL(url).hostname), "Use a disposable local household.");
const session = `suggest-${process.pid}`;
const browser = (...args: string[]) => execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8", timeout: 90_000 }).trim();
const check = (expression: string, message: string) => {
  browser("eval", `(() => { if (!(${expression})) throw new Error(${JSON.stringify(message)}); return true; })()`);
  console.log(`PASS ${message}`);
};
const request = async (path: string, method = "GET", body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { "Content-Type": "application/json", Connection: "close" }, body: body ? JSON.stringify(body) : undefined });
  assert(response.ok, `${method} ${path}: ${response.status}`);
  return response;
};
const household = async () => Schema.decodeUnknownSync(HouseholdSchema)(await (await request("household")).json());
const initial = await household();
assert(!initial.recipes.length && !initial.groceries.length, "Use an empty local household.");
const prefix = `suggest-${crypto.randomUUID()}`;
const products: GroceryItem[] = [
  { id: `${prefix}-fresh`, name: "BelGioioso Vegetarian Parmesan Cheese", aliases: [], quantity: 8, unit: "oz", aisle: "Dairy", url: "" },
  { id: `${prefix}-kraft`, name: "Kraft Finely Shredded Parmesan Cheese", aliases: [], quantity: 6, unit: "oz", aisle: "Dairy", url: "" },
  { id: `${prefix}-carrot`, name: "Fresh Shredded Carrots", aliases: [], quantity: 10, unit: "oz", aisle: "Produce", url: "" },
];
const recipe: Recipe = {
  id: prefix, title: "Broccoli cheese bites", description: "A simple lunch with a choice of Parmesan.",
  category: "", servings: 2, minutes: 20, photo: "", source: "", rating: "neutral",
  instructions: ["Mix the ingredients, shape into small bites and bake until golden."],
  ingredients: [
    { name: "Grated Parmesan", quantity: 0.25, unit: "cup", grocerySuggestions: [products[1].id, products[0].id] },
    { name: "Matchstick carrots", quantity: 2, unit: "tbsp", grocerySuggestions: [products[2].id] },
  ],
};
const openRecipe = () => {
  browser("open", `${url}/#recipes`);
  browser("reload");
  browser("wait", "--text", recipe.title);
  browser("find", "text", recipe.title, "click", "--exact");
  browser("wait", ".ingredient-suggestions");
};
const capture = (name: string) => {
  browser("eval", "document.querySelector('.ingredient-list').scrollIntoView({block:'center'})");
  browser("eval", "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  browser("screenshot", resolve(`.amp/in/artifacts/${name}.png`));
};
try {
  for (const product of products) await request("groceries", "PUT", product);
  await request("recipes", "PUT", recipe);
  await mkdir(".amp/in/artifacts", { recursive: true });
  openRecipe();
  browser("set", "viewport", "1280", "900", "2");
  check("document.querySelectorAll('.ingredient-suggestions button').length === 3", "saved suggestions render separately from links");
  capture("matching-suggestions");
  browser("set", "viewport", "390", "844", "2");
  check("document.querySelector('.recipe-detail').scrollWidth <= document.querySelector('.recipe-detail').clientWidth && [...document.querySelectorAll('.ingredient-suggestions button')].every(el => el.getBoundingClientRect().height >= 44)", "narrow suggestions fit with 44px selection controls");
  capture("matching-suggestions-narrow");
  browser("click", ".ingredient-list li:first-child .ingredient-suggestions button:first-of-type");
  browser("wait", "--fn", "document.querySelector('.ingredient-list li').textContent.includes('Kraft') && !document.querySelector('.ingredient-list li:first-child .ingredient-suggestions')");
  const saved = (await household()).recipes[0];
  assert.equal(saved.ingredients[0].groceryItemId, products[1].id);
  assert.equal(saved.ingredients[0].grocerySuggestions, undefined);
  assert.equal(saved.ingredients[0].quantity, 0.25);
  assert.deepEqual(saved.ingredients[1], recipe.ingredients[1]);
  console.log("PASS detail selection persists without closing recipe or changing amounts/other ingredients");

  // Reset only this fixture to exercise the editor independently of the detail selection.
  await request("recipes", "PUT", recipe);
  openRecipe();
  browser("find", "role", "button", "click", "--name", "Edit recipe", "--exact");
  browser("wait", ".recipe-form");
  check("(() => { const select = document.querySelector('[aria-label=\"Grocery item for ingredient 1\"]'); return select.querySelector('optgroup').label === 'Potential matches · Jev' && select.querySelector('optgroup option').textContent.includes('Kraft') && new Set([...select.options].map(o=>o.value)).size === select.options.length; })()", "editor suggestions lead the catalog in Jev order with no duplicate options");
  browser("select", '[aria-label="Grocery item for ingredient 1"]', products[0].id);
  browser("click", ".recipe-form .form-actions .primary");
  browser("wait", "--fn", "!document.querySelector('.recipe-form')");
  assert.equal((await household()).recipes[0].ingredients[0].groceryItemId, products[0].id);
  console.log("PASS editor suggestion selection persists");

  await request("recipes", "PUT", recipe);
  openRecipe();
  browser("find", "role", "button", "click", "--name", "Edit recipe", "--exact");
  browser("fill", '[aria-label="Ingredient 1 name"]', "Different ingredient");
  check("!document.querySelector('[aria-label=\"Grocery item for ingredient 1\"] optgroup[label^=\"Potential\"]')", "renaming an ingredient clears stale suggestions");
  browser("select", '[aria-label="Grocery item for ingredient 2"]', "unlinked");
  browser("click", ".recipe-form .form-actions .primary");
  browser("wait", "--fn", "!document.querySelector('.recipe-form')");
  const excluded = (await household()).recipes[0];
  assert.equal(excluded.ingredients[0].grocerySuggestions, undefined);
  assert.equal(excluded.ingredients[1].groceryItemId, null);
  assert.equal(excluded.ingredients[1].grocerySuggestions, undefined);
  console.log("PASS explicit exclusion clears suggestions");

  await request("recipes", "PUT", recipe);
  openRecipe();
  await request(`groceries/${products[1].id}`, "DELETE");
  browser("click", ".ingredient-list li:first-child .ingredient-suggestions button:first-of-type");
  browser("wait", ".recipe-detail [role=alert]");
  check("document.querySelectorAll('.ingredient-suggestions button').length === 3 && document.querySelector('.recipe-detail [role=alert]').textContent.includes('no longer exists')", "failed selection retains suggestions and explains the error");
  assert.equal((await household()).recipes[0].ingredients[0].groceryItemId, undefined);
  capture("matching-suggestions-error");
  await request("groceries", "PUT", products[1]);
  console.log("PASS matching suggestion browser/Worker/SQLite smoke");
} finally {
  browser("close");
  const state = await household();
  for (const item of state.recipes.filter((item) => item.id === prefix)) await request(`recipes/${item.id}`, "DELETE");
  for (const item of state.groceries.filter((item) => item.id.startsWith(prefix))) await request(`groceries/${item.id}`, "DELETE");
}
