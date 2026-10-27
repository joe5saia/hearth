import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { HouseholdSchema, GroceryItemSchema, RecipeSchema } from "../src/domain.ts";

// Real browser -> local Worker -> SQLite. AI output is tested separately with matching:eval.
const url = process.argv[2] ?? "http://localhost:5173";
assert(["localhost", "127.0.0.1"].includes(new URL(url).hostname), "Use a disposable local household.");
const session = `suggest-${process.pid}`;
const browser = (...args: string[]) => execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8", timeout: 90_000 }).trim();
const check = (expression: string, message: string) => {
  browser("eval", `(() => { if (!(${expression})) throw new Error(${JSON.stringify(message)}); return true; })()`);
  console.log(`PASS ${message}`);
};
const request = async (path: string, method = "GET", body?: typeof GroceryItemSchema.Encoded | typeof RecipeSchema.Encoded) => {
  // Fresh fixture writes must not alter the browser's captured concurrency guards.
  let payload = body ? JSON.stringify(body) : undefined;
  const resource = path.split("/")[0];
  if ((method === "PUT" || method === "DELETE") && (resource === "recipes" || resource === "groceries")) {
    const current = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${url}/api/household`)).json());
    const id = method === "DELETE" ? decodeURIComponent(path.slice(resource.length + 1)) : body?.id;
    const saved = current[resource].find(item => item.id === id);
    if (method === "DELETE" && !saved) return new Response(null, { status: 200 });
    payload = JSON.stringify({ ...body, expectedRevision: saved?.revision ?? null });
  }
  const response = await fetch(`${url}/api/${path}`, { method, headers: { "Content-Type": "application/json", Connection: "close" }, body: payload });
  assert(response.ok, `${method} ${path}: ${response.status}`);
  return response;
};
const household = async () => Schema.decodeUnknownSync(HouseholdSchema)(await (await request("household")).json());
const initial = await household();
assert(!initial.recipes.length && !initial.groceries.length, "Use an empty local household.");
const prefix = `suggest-${crypto.randomUUID()}`;
const products = Schema.decodeSync(Schema.Array(GroceryItemSchema))([
  { id: `${prefix}-fresh`, name: "BelGioioso Vegetarian Parmesan Cheese", aliases: [], quantity: 8, unit: "oz", aisle: "Dairy", url: "" },
  { id: `${prefix}-kraft`, name: "Kraft Finely Shredded Parmesan Cheese", aliases: [], quantity: 6, unit: "oz", aisle: "Dairy", url: "" },
  { id: `${prefix}-carrot`, name: "Fresh Shredded Carrots", aliases: [], quantity: 10, unit: "oz", aisle: "Produce", url: "" },
  { id: `${prefix}-chicken`, name: "Organic Chicken Breast", aliases: [], quantity: 1, unit: "lb", aisle: "Meat", url: "" },
  { id: `${prefix}-poultry`, name: "Boneless poultry portions", aliases: ["Chicken cutlets"], quantity: 2, unit: "lb", aisle: "Meat", url: "" },
]);
const recipe = Schema.decodeSync(RecipeSchema)({
  id: prefix, title: "Broccoli cheese bites", description: "A simple lunch with a choice of Parmesan.",
  category: "", servings: 2, minutes: 20, photo: "", source: "", rating: "neutral",
  instructions: ["Mix the ingredients, shape into small bites and bake until golden."],
  ingredients: [
    { name: "Grated Parmesan", quantity: 0.25, unit: "cup", grocerySuggestions: [products[1].id, products[0].id] },
    { name: "Matchstick carrots", quantity: 2, unit: "tbsp", grocerySuggestions: [products[2].id] },
  ],
});
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
  check("(() => { const dialog = document.querySelector('dialog[open]'); const rect = dialog.getBoundingClientRect(); const footer = dialog.querySelector('.form-actions').getBoundingClientRect(); return dialog.classList.contains('fullscreen') && rect.x === 0 && rect.y === 0 && rect.width === innerWidth && rect.height === innerHeight && footer.bottom <= innerHeight; })()", "mobile recipe editor fills viewport with visible save actions");
  browser("screenshot", resolve(".amp/in/artifacts/recipe-editor-mobile.png"));
  browser("click", '.ingredient-editor:has([aria-label="Ingredient 1 name"]) summary');
  browser("fill", '[aria-label="Grocery item for ingredient 1"]', "");
  check("document.querySelector('.ingredient-match-results > button').textContent.trim() === 'New Product' && !!document.querySelector('.ingredient-match-results > button svg') && ![...document.querySelectorAll('.ingredient-link-editor > button')].some(el => el.textContent.includes('New'))", "New Product is the first search action with a plus icon, not a standalone button");
  check("(() => { const results = [...document.querySelectorAll('.ingredient-match-results strong')]; return results[0].textContent.includes('Kraft') && results[1].textContent.includes('BelGioioso') && new Set(results.map(o=>o.textContent)).size === results.length; })()", "editor suggestions lead search results in Jev order without duplicates");
  browser("fill", '[aria-label="Grocery item for ingredient 1"]', "  cHiCkEn  ");
  check("(() => { const names = [...document.querySelectorAll('.ingredient-match-results strong')].map(el => el.textContent); return names.length === 2 && names.includes('Organic Chicken Breast') && names.includes('Boneless poultry portions'); })()", "contains search is case-insensitive, trims spaces and includes aliases but excludes unrelated products");
  browser("press", "Enter");
  check("!!document.querySelector('.recipe-form') && !!document.querySelector('.ingredient-match-results')", "Enter in search does not accidentally save the recipe");
  browser("eval", "document.querySelector('.ingredient-editor').scrollIntoView({block:'start'})");
  check("document.querySelector('.recipe-fields').scrollWidth <= document.querySelector('.recipe-fields').clientWidth && [...document.querySelectorAll('.ingredient-match-results button')].every(el => el.getBoundingClientRect().height >= 44)", "mobile search results fit and have 44px targets");
  browser("screenshot", resolve(".amp/in/artifacts/ingredient-search-mobile.png"));
  browser("fill", '[aria-label="Grocery item for ingredient 1"]', "no-such-product");
  check("document.querySelector('.ingredient-match-results [role=status]').textContent.includes('No grocery items match') && !document.querySelector('.ingredient-match-results strong')", "search explains empty results");
  browser("screenshot", resolve(".amp/in/artifacts/ingredient-search-empty-mobile.png"));
  browser("click", ".ingredient-match-results > .ingredient-create");
  browser("wait", ".grocery-form");
  check("[...document.querySelectorAll('.grocery-form input')].some(el => el.value === 'Grated Parmesan')", "New Product opens the ingredient-prefilled product editor even with no search matches");
  browser("find", "role", "button", "click", "--name", "Cancel", "--exact");
  check("!!document.querySelector('.recipe-form') && !document.querySelector('.grocery-form') && document.querySelector('[aria-label=\"Ingredient 1 quantity\"]').value === '0.25' && !document.querySelector('.ingredient-match-results')", "canceling product creation preserves the recipe draft and closes the search dropdown");
  browser("fill", '[aria-label="Grocery item for ingredient 1"]', "poultry");
  browser("click", ".ingredient-match-results button:has(strong)");
  check("document.querySelector('.ingredient-match-status').textContent.includes('Linked: Boneless poultry portions') && !document.querySelector('.ingredient-match-results')", "choosing a result updates the draft and closes the results");
  browser("screenshot", resolve(".amp/in/artifacts/ingredient-search-selected-mobile.png"));
  browser("click", ".recipe-form .form-actions .primary");
  browser("wait", "--fn", "!document.querySelector('.recipe-form')");
  assert.equal((await household()).recipes[0].ingredients[0].groceryItemId, products[4].id);
  console.log("PASS search result persists through Worker/SQLite");
  await request("recipes", "PUT", recipe);
  openRecipe();
  browser("find", "role", "button", "click", "--name", "Edit recipe", "--exact");
  browser("click", '.ingredient-editor:has([aria-label="Ingredient 1 name"]) summary');
  browser("fill", '[aria-label="Grocery item for ingredient 1"]', "BelGioioso");
  browser("click", ".ingredient-match-results button:has(strong)");
  browser("click", ".recipe-form .form-actions .primary");
  browser("wait", "--fn", "!document.querySelector('.recipe-form')");
  assert.equal((await household()).recipes[0].ingredients[0].groceryItemId, products[0].id);
  console.log("PASS editor suggestion selection persists");

  await request("recipes", "PUT", recipe);
  openRecipe();
  browser("find", "role", "button", "click", "--name", "Edit recipe", "--exact");
  browser("fill", '[aria-label="Ingredient 1 name"]', "Different ingredient");
  browser("click", '.ingredient-editor:has([aria-label="Ingredient 1 name"]) summary');
  browser("fill", '[aria-label="Grocery item for ingredient 1"]', "");
  check("!document.querySelector('.ingredient-match-results').textContent.includes('Potential match')", "renaming an ingredient clears stale suggestions");
  browser("press", "Escape");
  check("!!document.querySelector('.recipe-form') && !document.querySelector('.ingredient-match-results')", "Escape dismisses search without closing recipe editor");
  browser("click", '.ingredient-editor:has([aria-label="Ingredient 2 name"]) summary');
  browser("fill", '[aria-label="Grocery item for ingredient 2"]', "");
  browser("eval", "document.querySelector('.ingredient-match-results > button:last-of-type').scrollIntoView({block:'center'})");
  browser("find", "role", "button", "click", "--name", "Leave unlinked (manual review)", "--exact");
  browser("click", ".recipe-form .form-actions .primary");
  browser("wait", "--fn", "!document.querySelector('.recipe-form')");
  const excluded = (await household()).recipes[0];
  assert.equal(excluded.ingredients[0].grocerySuggestions, undefined);
  assert.equal(excluded.ingredients[1].groceryItemId, null);
  assert.equal(excluded.ingredients[1].grocerySuggestions, undefined);
  console.log("PASS explicit exclusion clears suggestions");

  // Simulate matching committing after the browser opened an editor; use the real API/SQLite writer.
  await request("recipes", "PUT", recipe);
  openRecipe();
  browser("set", "viewport", "1280", "900", "2");
  browser("find", "role", "button", "click", "--name", "Edit recipe", "--exact");
  check("!document.querySelector('dialog[open]').classList.contains('fullscreen')", "desktop recipe editor retains centered dialog");
  browser("find", "label", "Time (minutes)", "fill", "47");
  browser("click", '.ingredient-editor:has([aria-label="Ingredient 1 name"]) summary');
  browser("fill", '[aria-label="Grocery item for ingredient 1"]', "chicken");
  browser("eval", "document.querySelector('.ingredient-match').scrollIntoView({block:'center'})");
  browser("screenshot", resolve(".amp/in/artifacts/ingredient-search-desktop.png"));
  browser("press", "Escape");
  browser("eval", "document.querySelector('.recipe-form .form-actions').scrollIntoView({block:'center'})");
  browser("screenshot", resolve(".amp/in/artifacts/matching-editor-draft.png"));
  await request("recipes", "PUT", {
    ...recipe,
    ingredients: [{ ...recipe.ingredients[0], groceryItemId: products[0].id }, recipe.ingredients[1]],
  });
  browser("click", ".recipe-form .form-actions .primary");
  browser("wait", ".recipe-form [role=alert]");
  check("!!document.querySelector('dialog[open] .save-conflict') && [...document.querySelectorAll('.recipe-form input')].some(el => el.value === '47')", "stale save keeps the editor and metadata draft open");
  const protectedRecipe = (await household()).recipes[0];
  assert.equal(protectedRecipe.minutes, 20);
  assert.equal(protectedRecipe.ingredients[0].groceryItemId, products[0].id);
  browser("eval", "document.querySelector('.recipe-form [role=alert]').scrollIntoView({block:'center'})");
  browser("screenshot", resolve(".amp/in/artifacts/matching-editor-conflict.png"));
  browser("set", "viewport", "390", "844", "2");
  browser("eval", "document.querySelector('.recipe-form [role=alert]').scrollIntoView({block:'center'})");
  check("document.querySelector('.recipe-form').scrollWidth <= document.querySelector('.recipe-form').clientWidth", "conflict recovery fits a narrow viewport");
  browser("screenshot", resolve(".amp/in/artifacts/matching-editor-conflict-narrow.png"));
  browser("set", "viewport", "1280", "900", "2");
  browser("find", "role", "button", "click", "--name", "Load latest", "--exact");
  browser("find", "role", "button", "click", "--name", "Keep editing", "--exact");
  check("[...document.querySelectorAll('.recipe-form input')].some(el => el.value === '47')", "canceling replacement retains the stale draft");
  browser("find", "role", "button", "click", "--name", "Load latest", "--exact");
  browser("find", "role", "button", "click", "--name", "Replace draft", "--exact");
  browser("wait", "--fn", "!document.querySelector('dialog[open] .save-conflict')");
  check("!document.querySelector('.recipe-form [role=alert]') && document.querySelector('.ingredient-match-status').textContent.includes('Linked: BelGioioso') && ![...document.querySelectorAll('.recipe-form input')].some(el => el.value === '47')", "confirmed recovery replaces the whole draft with the latest saved version");
  browser("find", "label", "Time (minutes)", "fill", "47");
  browser("click", ".recipe-form .form-actions .primary");
  browser("wait", "--fn", "!document.querySelector('.recipe-form')");
  const recovered = (await household()).recipes[0];
  assert.equal(recovered.minutes, 47);
  assert.equal(recovered.ingredients[0].groceryItemId, products[0].id);
  console.log("PASS whole-draft reload keeps background matches and permits explicitly reapplied edits");

  await request("recipes", "PUT", recipe);
  openRecipe();
  browser("find", "role", "button", "click", "--name", "Edit recipe", "--exact");
  browser("find", "label", "Recipe name", "fill", "Broccoli bites with lemon and Parmesan");
  browser("find", "label", "Servings", "fill", "3.5");
  browser("fill", '[aria-label="Ingredient 1 name"]', "Finely grated Parmesan cheese");
  browser("fill", '[aria-label="Ingredient 1 quantity"]', "1.75");
  browser("select", '[aria-label="Ingredient 1 unit"]', "tbsp");
  browser("fill", '[aria-label="Step 1"]', "Mix gently, then bake until golden. Rest for 5 minutes before serving.");
  browser("find", "role", "button", "click", "--name", "Add step", "--exact");
  browser("fill", '[aria-label="Step 2"]', "Serve with lemon.");
  browser("click", ".recipe-edit-about > summary");
  browser("find", "label", "A few words about it", "fill", "A bright lunch.");
  browser("eval", "document.querySelector('.recipe-edit-about .form-details > summary').scrollIntoView({block:'center'})");
  browser("click", ".recipe-edit-about .form-details > summary");
  browser("find", "label", "Source URL", "fill", "https://example.com/broccoli-bites");
  browser("click", ".recipe-form .form-actions .primary");
  browser("wait", "--fn", "!document.querySelector('.recipe-form')");
  const edited = (await household()).recipes[0];
  assert.equal(edited.title, "Broccoli bites with lemon and Parmesan");
  assert.equal(edited.servings, 3.5);
  assert.equal(edited.ingredients[0].name, "Finely grated Parmesan cheese");
  assert.equal(edited.ingredients[0].quantity, 1.75);
  assert.equal(edited.ingredients[0].unit, "tbsp");
  assert.deepEqual(edited.ingredients[1], recipe.ingredients[1]);
  assert.deepEqual(edited.instructions, ["Mix gently, then bake until golden. Rest for 5 minutes before serving.", "Serve with lemon."]);
  assert.equal(edited.description, "A bright lunch.");
  assert.equal(edited.source, "https://example.com/broccoli-bites");
  console.log("PASS inline recipe fields, added step and collapsed metadata persist through Worker/SQLite without changing other ingredients");

  // Detail selection also submits its loaded ingredient baseline, so unrelated matches survive.
  await request("recipes", "PUT", recipe);
  openRecipe();
  await request("recipes", "PUT", {
    ...recipe,
    ingredients: [recipe.ingredients[0], { ...recipe.ingredients[1], groceryItemId: products[2].id }],
  });
  browser("click", ".ingredient-list li:first-child .ingredient-suggestions button:first-of-type");
  browser("wait", ".recipe-detail [role=alert]");
  assert.equal((await household()).recipes[0].ingredients[0].groceryItemId, undefined);
  assert.equal((await household()).recipes[0].ingredients[1].groceryItemId, products[2].id);
  browser("click", ".ingredient-list li:first-child .ingredient-suggestions button:first-of-type");
  browser("wait", "--fn", "!document.querySelector('.recipe-detail [role=alert]') && !document.querySelector('.ingredient-list li:first-child .ingredient-suggestions')");
  assert.equal((await household()).recipes[0].ingredients[0].groceryItemId, products[1].id);
  assert.equal((await household()).recipes[0].ingredients[1].groceryItemId, products[2].id);
  console.log("PASS stale detail selection refreshes and retries without erasing another match");

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
