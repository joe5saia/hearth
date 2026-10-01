import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { HouseholdSchema, type GroceryItem, type Recipe, type Meal, type ShoppingOrder } from "../src/domain.ts";

// Exercises the real browser, Worker and local SQLite. Never writes a remote household.
const url = process.argv[2] ?? "http://localhost:5173";
assert(["localhost", "127.0.0.1"].includes(new URL(url).hostname), "Use local development only.");
const session = `groceries-${process.pid}`;
const browser = (...args: string[]) => execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8", timeout: 90_000 }).trim();
const check = (expression: string, message: string) => {
  browser("eval", `(() => { if (!(${expression})) throw new Error(${JSON.stringify(message)}); return true; })()`);
  console.log(`PASS ${message}`);
};
const request = async (path: string, method = "GET", value?: GroceryItem | Recipe | Meal | ShoppingOrder | { key: string; checked: number }) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { "Content-Type": "application/json", Connection: "close" }, body: value ? JSON.stringify(value) : undefined });
  assert(response.ok, `${method} ${path}: ${response.status} ${response.ok ? "" : await response.text()}`);

  return response;
};
const household = async () => Schema.decodeUnknownSync(HouseholdSchema)(await (await request("household")).json());
const original = await household();
assert(!original.recipes.length && !original.groceries.length && !original.meals.length && !original.extras.length, "Use an empty disposable local household for grocery browser smoke.");
const prefix = `grocery-smoke-${crypto.randomUUID()}`;
const products: GroceryItem[] = [
  { id: `${prefix}-rice`, name: "Long-grain rice", aliases: ["rice", "white rice"], quantity: 500, unit: "g", aisle: "10", url: "https://example.com/rice" },
  { id: `${prefix}-oil`, name: "Olive oil", aliases: ["oil"], quantity: 500, unit: "ml", aisle: "10", url: "https://example.com/oil" },
  { id: `${prefix}-bread`, name: "Whole-wheat bread", aliases: ["bread"], quantity: 20, unit: "slice", aisle: "Bakery", url: "https://example.com/bread" },
  { id: `${prefix}-limes`, name: "Fresh limes · 2 lb bag", aliases: ["lime"], quantity: 2, unit: "lb", aisle: "Produce", url: "https://www.shoprite.com/sm/pickup/rsid/3000/product/fresh-limes-2-lb-bag-id-00000000096867" },
];
const recipes: Recipe[] = [
  { id: `${prefix}-dinner`, title: "Lime rice bowls", description: "A simple weeknight dinner.", servings: 2, minutes: 30, category: "", photo: "", source: "", rating: "neutral", instructions: ["Cook the rice and serve with lime."], ingredients: [
    { name: "rice", quantity: 200, unit: "g" }, { name: "lime", quantity: 2, unit: "each" },
    { name: "oil", quantity: 1, unit: "tbsp" }, { name: "bread", quantity: 2, unit: "slice" },
    { name: "parsley", quantity: 1, unit: "bunch" },
  ] },
  { id: `${prefix}-lunch`, title: "Rice for lunch", description: "Use the rest of the rice.", servings: 1, minutes: 20, category: "", photo: "", source: "", rating: "neutral", instructions: ["Cook and serve."], ingredients: [{ name: "white rice", quantity: 200, unit: "g" }] },
];
const start = "2099-01-05";
const end = "2099-01-11";
const shopping = () => {
  browser("open", `${url}/#shopping`);
  browser("wait", ".shopping-range");
  browser("click", ".shopping-range summary");
  // agent-browser fill treats Chromium date controls as text; use the native input setter and real events.
  browser("eval", `(() => { for (const [label, value] of [["Shopping end date", "${end}"], ["Shopping start date", "${start}"]]) {
    const input = document.querySelector('[aria-label="' + label + '"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } })()`);
  browser("click", ".shopping-range summary");
  browser("wait", ".purchase-row");
};
const screenshot = (name: string) => {
  browser("wait", "--fn", "!document.querySelector('.toast')");
  browser("eval", "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  browser("screenshot", resolve(`.amp/in/artifacts/${name}.png`));
};
const formFill = (label: string, value: string) => browser("find", "label", label, "fill", value);
const finishSave = () => browser("wait", "--fn", "!document.querySelector('.grocery-form')");
const submit = (selector: string) => {
  // Native dialog scrolling must settle before a physical click after validation changes its height.
  browser("eval", `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`);
  browser("eval", "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  browser("click", selector);
};

try {
  for (const item of products) await request("groceries", "PUT", item);
  for (const recipe of recipes) await request("recipes", "PUT", recipe);
  for (const [index, recipe] of recipes.entries()) await request("meals", "PUT", { id: `${prefix}-meal-${index}`, recipeId: recipe.id, date: start, slot: "Dinner", scale: 1, note: "" });
  await request("shopping-order", "PUT", { aisles: [], items: [] });
  await mkdir(".amp/in/artifacts", { recursive: true });
  browser("open", `${url}/#groceries`);
  browser("set", "viewport", "1280", "900", "2");
  browser("wait", ".grocery-manager");
  check("document.querySelector('.grocery-coverage').textContent.includes('5 / 6 ingredients linked')", "automatic linking and central coverage");
  submit('[aria-label="Edit recipe Lime rice bowls"]');
  browser("wait", '[aria-label="Ingredient 1 quantity"]');
  browser("fill", '[aria-label="Ingredient 1 quantity"]', "250");
  browser("click", '.ingredient-editor:nth-of-type(5) .ingredient-link-editor button');
  browser("wait", ".grocery-form");
  formFill("Store product name", "Flat-leaf parsley");
  formFill("Aisle (optional)", "2");
  browser("set", "viewport", "390", "844", "2");
  check("document.querySelector('.grocery-form').scrollWidth <= document.querySelector('.grocery-form').clientWidth", "narrow product form fits inside recipe dialog");
  screenshot("grocery-product-form");
  formFill("Package quantity", "0");
  submit('.grocery-form button[type="submit"]');
  check("document.querySelector('.grocery-form [role=alert]').textContent.includes('positive')", "invalid package quantity keeps product draft");
  formFill("Package quantity", "1");
  submit('.grocery-form button[type="submit"]');
  finishSave();
  check("document.querySelector('[aria-label=\"Ingredient 1 quantity\"]').value === '250' && document.querySelector('[aria-label=\"Grocery item for ingredient 5\"]').selectedOptions[0].textContent.includes('Flat-leaf parsley')", "nested product creation preserves unsaved recipe edits and selects link");
  browser("eval", "document.querySelector('.ingredient-editor').scrollIntoView()");
  check("document.querySelector('.recipe-form').scrollWidth <= document.querySelector('.recipe-form').clientWidth", "narrow ingredient-link editor has no horizontal overflow");
  screenshot("recipe-grocery-links");
  submit('.recipe-form .form-actions .primary');
  browser("wait", "--fn", "!document.querySelector('dialog[open]')");
  check("document.querySelector('.grocery-coverage').textContent.includes('6 / 6 ingredients linked')", "recipe link saved and coverage refreshed");
  browser("set", "viewport", "1280", "1050", "2");
  browser("eval", "scrollTo(0,0)");
  check("[...document.querySelectorAll('.grocery-item')].every(el => el.getBoundingClientRect().height <= 76)", "desktop catalog rows stay compact");
  check("[...document.querySelectorAll('.grocery-item')].find(el => el.textContent.includes('Long-grain rice')).textContent.includes('Linked: 2 ingredients') && [...document.querySelectorAll('.grocery-item')].find(el => el.textContent.includes('Flat-leaf parsley')).textContent.includes('Missing URL')", "compact metadata retains ingredient counts and setup gaps");
  screenshot("grocery-catalog");
  const longProduct: GroceryItem = { id: `${prefix}-long`, name: "Organic whole-grain breakfast crackers with rosemary and extra virgin olive oil", aliases: ["compact-fixture"], quantity: 1, unit: "each", aisle: "", url: "" };
  await request("groceries", "PUT", longProduct);
  browser("reload");
  browser("wait", ".grocery-item");
  browser("set", "viewport", "390", "844", "2");
  check("document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.grocery-edit')].every(el => el.getBoundingClientRect().width >= 44 && el.getBoundingClientRect().height >= 44)", "narrow compact catalog fits and retains 44px edit controls");
  check("[...document.querySelectorAll('.grocery-item')].filter(el => !el.textContent.includes('Organic')).every(el => el.getBoundingClientRect().height <= 110)", "narrow standard catalog rows stay compact");
  browser("eval", "document.querySelector('.grocery-items').scrollIntoView(); scrollBy(0, -document.querySelector('.topbar').getBoundingClientRect().height - 16)");
  screenshot("grocery-catalog-narrow");
  browser("fill", '.grocery-search input', "compact-fixture");
  check("document.querySelectorAll('.grocery-item').length === 1 && document.querySelector('.grocery-item h2').textContent === 'Organic whole-grain breakfast crackers with rosemary and extra virgin olive oil' && document.querySelector('.grocery-item').textContent.includes('Package: 1 each') && document.querySelectorAll('.grocery-item .grocery-gap').length === 2 && document.querySelector('.grocery-item').textContent.includes('Not linked')", "alias search preserves long names, each units, unlinked state and both gaps");
  screenshot("grocery-catalog-long-name");
  browser("click", '.grocery-edit');
  browser("wait", ".grocery-form");
  check("document.querySelector('.grocery-form input').value === 'Organic whole-grain breakfast crackers with rosemary and extra virgin olive oil'", "compact edit button opens the correct product");
  browser("find", "role", "button", "click", "--name", "Cancel", "--exact");
  browser("fill", '.grocery-search input', "no-such-product");
  check("!document.querySelector('.grocery-item') && document.querySelector('.grocery-empty').textContent.includes('No grocery items match')", "catalog empty search state remains available");
  await request(`groceries/${longProduct.id}`, "DELETE");
  browser("set", "viewport", "1280", "1050", "2");
  shopping();
  check("[...document.querySelectorAll('.purchase-group h3')].map(el => el.textContent).join('|') === 'Aisle 2|Aisle 10|Aisle Bakery|Aisle Produce'", "numeric then alphabetical aisle order");
  check("[...document.querySelectorAll('.purchase-row')].find(el => el.textContent.includes('Long-grain rice')).textContent.includes('Buy 1 × 500 g') && [...document.querySelectorAll('.purchase-row')].find(el => el.textContent.includes('Long-grain rice')).textContent.includes('Need 450 g')", "combined recipes round up only after aggregation");
  check("[...document.querySelectorAll('.purchase-row')].find(el => el.textContent.includes('Fresh limes')).textContent.includes('Cannot convert') && [...document.querySelectorAll('.purchase-row')].find(el => el.textContent.includes('Whole-wheat bread')).textContent.includes('10×')", "incompatible units and excess-purchase warnings visible");
  browser("find", "role", "button", "click", "--name", "Arrange route", "--exact");
  browser("click", '[aria-label="Move Aisle Bakery up"]');
  browser("wait", "--fn", "!document.querySelector('[aria-label=\"Move Aisle Bakery up\"]').disabled");
  browser("click", '[aria-label="Move Aisle Bakery up"]');
  browser("wait", "--fn", "document.querySelector('.route-aisle h3').textContent === 'Aisle Bakery'");
  browser("click", '[aria-label="Move Olive oil up"]');
  browser("wait", "--fn", "!document.querySelector('[aria-label=\"Move Olive oil down\"]').disabled");
  browser("set", "viewport", "390", "844", "2");
  check("document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.route-move button')].every(el => el.getBoundingClientRect().width >= 44 && el.getBoundingClientRect().height >= 44)", "narrow route editor fits and has 44px reorder controls");
  browser("eval", "document.querySelector('.route-editor').scrollIntoView()");
  screenshot("grocery-route");
  browser("reload");
  shopping();
  check("document.querySelector('.purchase-group h3').textContent === 'Aisle Bakery' && document.querySelector('[aria-label=\"Aisle 10\"] .item-info strong').textContent === 'Olive oil'", "aisle and within-aisle ordering survive reload");
  browser("find", "role", "button", "click", "--name", "Shopping mode", "--exact");
  browser("check", '[aria-label="Picked up Long-grain rice"]');
  browser("wait", "--fn", "!document.querySelector('[aria-label=\"Picked up Long-grain rice\"]').disabled");
  browser("find", "role", "button", "click", "--name", "Hide checked items", "--exact");
  check("!document.querySelector('[aria-label=\"Picked up Long-grain rice\"]') && document.querySelector('.shopping-summary').textContent.includes('4 items left')", "checked products hide and remaining count updates");
  browser("find", "role", "button", "click", "--name", "Show checked items", "--exact");
  browser("uncheck", '[aria-label="Picked up Long-grain rice"]');
  browser("wait", "--fn", "!document.querySelector('[aria-label=\"Picked up Long-grain rice\"]').disabled");
  check("document.documentElement.scrollWidth <= innerWidth", "390px shopping mode has no horizontal overflow");
  browser("eval", "scrollTo(0,0)");
  screenshot("shopping-mode-mobile");
  browser("eval", "document.querySelector('.purchase-group').scrollIntoView(); scrollBy(0, -285)");
  check("document.querySelector('.shopping-summary').getBoundingClientRect().top >= document.querySelector('.topbar').getBoundingClientRect().bottom", "sticky shopping controls remain below the app header");
  screenshot("shopping-mode-in-store");
  browser("set", "viewport", "1280", "1000", "2");
  browser("eval", "scrollTo(0,0)");
  screenshot("shopping-mode-desktop");
  browser("eval", "(() => { const original = URL.createObjectURL; URL.createObjectURL = function(blob) { blob.text().then(text => window.exportedList = text); return original.call(this, blob); }; })()");
  browser("find", "role", "button", "click", "--name", "Export list", "--exact");
  browser("wait", "--fn", "!!window.exportedList");
  check("window.exportedList.includes('Buy 1 × 500 g; need 450 g') && window.exportedList.includes('WARNING: Cannot convert') && window.exportedList.indexOf('[Aisle Bakery]') < window.exportedList.indexOf('[Aisle 2]')", "export preserves purchase counts, warnings, and route order");
  console.log("Grocery browser smoke passed.");
} catch (error) {
  console.error(browser("eval", "({form: document.querySelector('.grocery-form')?.innerText, fields: [...document.querySelectorAll('.grocery-form input')].map(input => ({type:input.type,value:input.value,valid:input.validity.valid,message:input.validationMessage}))})"));
  throw error;
} finally {
  browser("close");
  const current = await household();
  for (const item of current.checks.filter((item) => item.key.includes(prefix))) await request("checks", "PUT", { key: item.key, checked: 0 });
  for (const item of current.meals.filter((item) => item.id.startsWith(prefix))) await request(`meals/${item.id}`, "DELETE");
  for (const item of current.recipes.filter((item) => item.id.startsWith(prefix))) await request(`recipes/${item.id}`, "DELETE");
  for (const item of (await household()).groceries.filter((item) => item.id.startsWith(prefix) || item.name === "Flat-leaf parsley")) await request(`groceries/${item.id}`, "DELETE");
  await request("shopping-order", "PUT", original.shoppingOrder);
}
