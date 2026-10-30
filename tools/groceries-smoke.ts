import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { HouseholdSchema, type GroceryDraft, type RecipeDraft, type MealDraft, type ShoppingOrder } from "../src/domain.ts";

// Exercises the real browser, Worker and local SQLite. Never writes a remote household.
const url = process.argv[2] ?? "http://localhost:5173";
assert(["localhost", "127.0.0.1"].includes(new URL(url).hostname), "Use local development only.");
const session = `groceries-${process.pid}`;
const browser = (...args: string[]) => execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8", timeout: 90_000 }).trim();
const check = (expression: string, message: string) => {
  browser("eval", `(() => { if (!(${expression})) throw new Error(${JSON.stringify(message)}); return true; })()`);
  console.log(`PASS ${message}`);
};
const checkRowAlignment = () => check(`
  [...document.querySelectorAll('.purchase-row')].every(row => {
    const label = row.querySelector('.shopping-item').getBoundingClientRect();
    const center = label.top + label.height / 2;
    return [...row.querySelectorAll('.custom-check, .membership-button, .item-info, .route-drag, summary')].every(element => {
      const box = element.getBoundingClientRect();
      return Math.abs(box.top + box.height / 2 - center) < 1;
    }) && [...row.querySelectorAll('.route-drag, summary')].every(element => element.getBoundingClientRect().height >= 44)
      && (row.querySelector('.item-info').getBoundingClientRect().height > 32 || label.height <= 48);
  })`, "shopping text, checkbox or list button and 44px controls stay centered in compact and wrapped rows");
const request = async (path: string, method = "GET", value?: GroceryDraft | RecipeDraft | MealDraft | ShoppingOrder | { items: { groceryId: string; packages?: number }[] } | { groceryIds: string[] } | { expectedRevision: string | null }) => {
  // Deliberate fixture writes read fresh guards; browser writes retain their original guards.
  let payload = value ? JSON.stringify(value) : undefined;
  const resource = path.split("/")[0];
  if ((method === "PUT" || method === "DELETE") && path.split("/").length <= 2 && (resource === "recipes" || resource === "groceries" || resource === "meals" || resource === "shopping-order")) {
    const current = Schema.decodeUnknownSync(HouseholdSchema)(await (await fetch(`${url}/api/household`)).json());
    const id = method === "DELETE" ? decodeURIComponent(path.slice(resource.length + 1)) : value && "id" in value ? value.id : undefined;
    const saved = resource === "shopping-order" ? current.shoppingOrder : current[resource].find(item => item.id === id);
    if (method === "DELETE" && !saved) return new Response(null, { status: 200 });
    payload = JSON.stringify({ ...value, expectedRevision: saved?.revision ?? null });
  }
  const response = await fetch(`${url}/api/${path}`, { method, headers: { "Content-Type": "application/json", Connection: "close" }, body: payload });
  assert(response.ok, `${method} ${path}: ${response.status}`);

  return response;
};
const household = async () => Schema.decodeUnknownSync(HouseholdSchema)(await (await request("household")).json());
const withoutRevision = <T extends { readonly revision?: string }>({ revision: _revision, ...value }: T) => value;
const original = await household();
assert(!original.recipes.length && !original.groceries.length && !original.meals.length && !original.shoppingLists.length, "Use an empty disposable local household for grocery browser smoke.");
// The list created through the empty state; every list write below targets it.
let listId = "";
const entries = async () => (await household()).shoppingItems.filter(entry => entry.listId === listId);
const entry = async (product: GroceryDraft) => (await entries()).find(item => item.groceryId === product.id);
const addToList = (...items: { groceryId: string; packages?: number }[]) => request(`shopping-lists/${encodeURIComponent(listId)}/items`, "POST", { items });
const removeFromList = (...items: GroceryDraft[]) => request(`shopping-lists/${encodeURIComponent(listId)}/items`, "DELETE", { groceryIds: items.map(item => item.id) });
const prefix = `grocery-smoke-${crypto.randomUUID()}`;
const products: GroceryDraft[] = [
  { id: `${prefix}-rice`, name: "Long-grain rice", aliases: ["rice", "white rice"], quantity: 500, unit: "g", aisle: "10", url: "https://example.com/rice" },
  { id: `${prefix}-oil`, name: "Olive oil", aliases: ["oil"], quantity: 500, unit: "ml", aisle: "10", url: "https://example.com/oil" },
  { id: `${prefix}-bread`, name: "Whole-wheat bread", aliases: ["bread"], quantity: 20, unit: "slice", aisle: "Bakery", url: "https://example.com/bread" },
  { id: `${prefix}-limes`, name: "Fresh limes · 2 lb bag", aliases: ["lime"], quantity: 2, unit: "lb", aisle: "Produce", url: "https://www.shoprite.com/sm/pickup/rsid/3000/product/fresh-limes-2-lb-bag-id-00000000096867" },
  { id: `${prefix}-oats`, name: "Rolled oats", aliases: [], quantity: 500, unit: "g", aisle: "10", url: "" },
];
const recipes: RecipeDraft[] = [
  { id: `${prefix}-dinner`, title: "Lime rice bowls", description: "A simple weeknight dinner.", servings: 2, minutes: 30, category: "", photo: "", source: "", rating: "neutral", instructions: ["Cook the rice and serve with lime."], ingredients: [
    { name: "rice", quantity: 200, unit: "g" }, { name: "lime", quantity: 2, unit: "each" },
    { name: "oil", quantity: 1, unit: "tbsp" }, { name: "bread", quantity: 2, unit: "slice" },
    { name: "parsley", quantity: 1, unit: "bunch" },
  ] },
  { id: `${prefix}-lunch`, title: "Rice for lunch", description: "Use the rest of the rice.", servings: 1, minutes: 20, category: "", photo: "", source: "", rating: "neutral", instructions: ["Cook and serve."], ingredients: [{ name: "white rice", quantity: 200, unit: "g" }] },
];
const start = "2099-01-05";
const shopping = () => {
  browser("open", `${url}/#shopping`);
  browser("reload");
  browser("wait", ".shopping-summary");
};
const screenshot = (name: string) => {
  browser("wait", "--fn", "!document.querySelector('.toast')");
  browser("eval", "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  browser("screenshot", resolve(`.amp/in/artifacts/${name}.png`));
};
// Meals are listed newest first and a recipe can be planned twice; act on the newest visible option for a title.
const chooseRecipe = (action: "check" | "click", title: string) => browser("eval", `(() => { const box = [...document.querySelectorAll('.shopping-recipe-option')].find(option => option.querySelector('strong')?.textContent === ${JSON.stringify(title)})?.querySelector('input'); if (!box) throw new Error(${JSON.stringify(`Missing recipe option ${title}`)}); if (${JSON.stringify(action)} === 'click' || !box.checked) box.click(); return true; })()`);
// The list choice above review items pushes them under the sticky actions on narrow screens.
const reviewItem = (action: "check" | "uncheck", selector: string) => {
  browser("eval", `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`);
  browser(action, selector);
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
  browser("open", `${url}/#groceries`);
  browser("set", "viewport", "1280", "900", "2");
  browser("wait", ".grocery-manager");
  browser("find", "role", "button", "click", "--name", "Add grocery item", "--exact");
  check("!document.querySelector('.aisle-list [role=option]') && document.querySelector('.aisle-choices').textContent.includes('No aisles assigned yet')", "empty catalog keeps text input and Create fallback available");
  formFill("Aisle (optional)", "   ");
  check("document.querySelector('.aisle-create').disabled", "whitespace-only names cannot create an aisle");
  formFill("Aisle (optional)", "Canceled aisle");
  browser("find", "role", "button", "click", "--name", "Create new aisle", "--exact");
  browser("find", "role", "button", "click", "--name", "Cancel", "--exact");
  assert.equal((await household()).groceries.length, 0, "Create followed by Cancel must not persist anything.");
  for (const item of products) await request("groceries", "PUT", item);
  for (const recipe of recipes) await request("recipes", "PUT", recipe);
  await mkdir(".amp/in/artifacts", { recursive: true });
  browser("open", `${url}/#shopping`);
  browser("reload");
  browser("wait", "--fn", "document.querySelector('.shopping-layout, .empty-state')?.textContent.includes('No shopping lists yet')");
  screenshot("shopping-no-lists");
  browser("find", "role", "button", "click", "--name", "Start a list for today", "--exact");
  browser("wait", ".shopping-summary");
  const [created] = (await household()).shoppingLists;
  assert(created, "Starting a list persists it.");
  listId = created.id;
  check(`location.hash.includes(${JSON.stringify(`list=${listId}`)}) && document.querySelector('.list-switcher > summary')?.textContent.includes('0 items')`, "empty state starts a list for today and opens it");
  shopping();
  browser("set", "viewport", "390", "844", "2");
  browser("find", "role", "button", "click", "--name", "Add from meals", "--exact");
  check("document.querySelectorAll('.shopping-recipe-option').length === 2 && document.querySelector('.shopping-recipe-form .primary').disabled", "empty meal plan still offers the entire recipe library without preselecting items");
  check("document.querySelector('.shopping-recipe-form .primary').getAttribute('aria-describedby') === 'shopping-recipe-blocked' && document.getElementById('shopping-recipe-blocked').textContent.includes('Select at least one recipe')", "disabled review explains how to proceed without requiring hover");
  browser("fill", '.shopping-recipe-form input[type=search]', "lunch");
  browser("find", "role", "button", "click", "--name", "Select all", "--exact");
  browser("fill", '.shopping-recipe-form input[type=search]', "");
  check("[...document.querySelectorAll('.shopping-recipe-option input')].every(box => box.checked)", "Select all recipes includes recipes hidden by search");
  browser("find", "role", "button", "click", "--name", "Unselect all", "--exact");
  check("[...document.querySelectorAll('.shopping-recipe-option input')].every(box => !box.checked) && document.querySelector('.shopping-recipe-form .primary').disabled", "Unselect all recipes clears the selection");
  check("document.querySelector('dialog').classList.contains('fullscreen') && document.querySelector('dialog').getBoundingClientRect().height === innerHeight && !document.querySelector('.shopping-recipe-fields > p.muted')", "mobile recipe picker fills the screen without helper copy");
  screenshot("shopping-recipes-empty-plan");
  browser("find", "role", "button", "click", "--name", "Cancel", "--exact");
  for (const [index, recipe] of recipes.entries()) await request("meals", "PUT", { id: `${prefix}-meal-${index}`, recipeId: recipe.id, date: index === 0 ? start : "2099-01-04", slot: "Dinner", scale: 1, note: "" });
  await request("recipes", "PUT", { ...recipes[1], id: `${prefix}-past`, title: "Earlier lunch", ingredients: [...recipes[1].ingredients, { name: "Rolled oats", quantity: 100, unit: "g" }] });
  await request("recipes", "PUT", { ...recipes[1], id: `${prefix}-unplanned`, title: "Unplanned recipe" });
  await request("meals", "PUT", { id: `${prefix}-meal-past`, recipeId: `${prefix}-past`, date: "2000-01-02", slot: "Lunch", scale: 1, note: "" });
  await request("meals", "PUT", { id: `${prefix}-meal-repeat`, recipeId: recipes[0].id, date: "2000-01-01", slot: "Dinner", scale: 1, note: "" });
  await request("meals", "PUT", { id: `${prefix}-meal-note`, recipeId: null, date: "2099-01-06", slot: "Dinner", scale: 1, note: "Leftovers" });
  await request("shopping-order", "PUT", { aisles: [], items: [] });
  await addToList({ groceryId: products[1].id });
  shopping();
  browser("set", "viewport", "1280", "900", "2");
  browser("find", "role", "button", "click", "--name", "Edit amount for Olive oil", "--exact");
  check("document.activeElement === document.querySelector('.purchase-amount-editor input')", "amount editor focuses the package count without checking the item");
  for (const value of ["", "0", "-1", "1.5", "1000001"]) {
    if (value) formFill("Packages to buy for Olive oil", value);
    else {
      browser("press", "Control+a");
      browser("press", "Backspace");
    }
    check("document.querySelector('.purchase-amount-editor .primary').disabled", `invalid package count ${JSON.stringify(value)} cannot save`);
  }
  formFill("Packages to buy for Olive oil", "3");
  browser("click", ".purchase-amount-editor .primary");
  browser("wait", "--fn", "!document.querySelector('.purchase-amount-editor')");
  assert.deepEqual([(await entry(products[1]))?.packages, (await entry(products[1]))?.checked], [3, 0], "Saving an amount preserves list membership.");
  assert.equal((await household()).groceries.find(item => item.id === products[1].id)?.quantity, 500, "Buying three packages must not change the catalog package size.");
  shopping();
  check("document.querySelector('.purchase-amount').textContent.includes('3 × 500 ml')", "edited amount survives a full reload");
  browser("find", "role", "button", "click", "--name", "Shopping mode", "--exact");
  browser("set", "viewport", "390", "844", "2");
  browser("find", "role", "button", "click", "--name", "Edit amount for Olive oil", "--exact");
  formFill("Packages to buy for Olive oil", "7");
  browser("click", ".purchase-amount-editor .secondary");
  check("!document.querySelector('.purchase-amount-editor') && document.activeElement.getAttribute('aria-label') === 'Edit amount for Olive oil'", "Cancel closes the amount editor and restores keyboard focus in narrow Shop Mode");
  assert.equal((await entry(products[1]))?.packages, 3, "Cancel does not write the draft amount.");
  browser("find", "role", "button", "click", "--name", "Edit amount for Olive oil", "--exact");
  formFill("Packages to buy for Olive oil", "1");
  browser("press", "Enter");
  browser("wait", "--fn", "!document.querySelector('.purchase-amount-editor')");
  assert.equal((await entry(products[1]))?.packages, 1, "Keyboard save in Shop Mode restores one package.");
  browser("find", "role", "button", "click", "--name", "Exit shopping mode", "--exact");
  browser("set", "viewport", "1280", "900", "2");
  browser("find", "role", "button", "click", "--name", "Add from meals", "--exact");
  check("document.querySelector('.shopping-recipe-form .primary').disabled && document.querySelectorAll('.shopping-recipe-option').length === 5", "recipe picker starts unselected with add disabled");
  check("[...document.querySelectorAll('.shopping-recipe-option strong')].map(el => el.textContent).join('|') === 'Lime rice bowls|Rice for lunch|Earlier lunch|Lime rice bowls|Unplanned recipe'", "each planned meal appears newest first, including future and past repeats, followed by unplanned recipes");
  screenshot("shopping-recipes-default");
  chooseRecipe("check", "Lime rice bowls");
  browser("fill", '.shopping-recipe-form input[type=search]', "lunch");
  check("[...document.querySelectorAll('.shopping-recipe-option strong')].map(el => el.textContent).join('|') === 'Rice for lunch|Earlier lunch'", "search preserves meal-plan date ordering");
  chooseRecipe("check", "Rice for lunch");
  check("document.querySelector('.shopping-recipe-preview').textContent.includes('2 selected · 4 linked groceries') && document.querySelector('.shopping-recipe-preview').textContent.includes('1 unlinked ingredient')", "selection survives search and deduplicates shared links while skipping unlinked items");
  browser("click", '.shopping-recipe-form input[type=search]');
  browser("press", "Control+a");
  browser("press", "Backspace");
  browser("wait", "--fn", "document.querySelectorAll('.shopping-recipe-option').length === 5");
  screenshot("shopping-recipes-selected-desktop");
  for (const width of [320, 390]) {
    browser("set", "viewport", String(width), "844", "2");
    check("document.documentElement.scrollWidth <= innerWidth && document.querySelector('dialog').scrollWidth <= document.querySelector('dialog').clientWidth && [...document.querySelectorAll('.shopping-recipe-option')].every(el => el.getBoundingClientRect().height >= 44 && el.querySelector('input').getBoundingClientRect().width <= 24 && el.querySelector('strong').getBoundingClientRect().width >= 150)", `${width}px recipe picker fits with readable labels and accessible selection targets`);
  }
  screenshot("shopping-recipes-selected-narrow");
  browser("click", '.shopping-recipe-form .primary');
  check("document.querySelectorAll('.shopping-review-item').length === 3 && [...document.querySelectorAll('.shopping-review-item input[type=checkbox]')].every(box => box.checked) && document.activeElement.textContent === 'Review items'", "review defaults every unique missing item to checked and focuses its heading");
  check(`document.querySelector('.shopping-recipe-preview').textContent.includes('1 already on this list with the same count') && document.querySelector('.shopping-target').textContent.includes('Adding to ')`, "review targets the open list and counts an unchanged existing item instead of offering it again");
  check("document.querySelector('[aria-label=\"Packages to buy for Fresh limes · 2 lb bag\"]').value === '' && document.querySelector('.shopping-recipe-form .primary').disabled", "incompatible count and weight require an explicit package count rather than guessing");
  check("document.querySelectorAll('.shopping-review-item.needs-quantity').length === 1 && document.querySelector('.needs-quantity strong').textContent === 'Fresh limes · 2 lb bag' && document.getElementById('shopping-recipe-blocked').textContent.includes('highlighted item')", "only the ingredient needing a quantity is highlighted and explained beside submit");
  screenshot("shopping-review-needs-quantity-narrow");
  browser("find", "role", "button", "click", "--name", "Unselect all", "--exact");
  check("[...document.querySelectorAll('.shopping-review-item input[type=checkbox]')].every(box => !box.checked) && !document.querySelector('.needs-quantity') && document.getElementById('shopping-recipe-blocked').textContent.includes('Select at least one item')", "Unselect all items removes quantity warnings and explains the empty selection");
  browser("find", "role", "button", "click", "--name", "Select all", "--exact");
  check("[...document.querySelectorAll('.shopping-review-item input[type=checkbox]')].every(box => box.checked) && document.querySelectorAll('.needs-quantity').length === 1", "Select all items restores selection and unresolved quantity feedback");
  for (const invalid of ["-1", "1.5", "1000001"]) {
    formFill("Packages to buy for Fresh limes · 2 lb bag", invalid);
    check("document.querySelectorAll('.needs-quantity').length === 1 && document.querySelector('.shopping-recipe-form .primary').disabled", `invalid package quantity ${invalid} stays highlighted and blocks adding`);
  }
  formFill("Packages to buy for Fresh limes · 2 lb bag", "0");
  check("!document.querySelector('.needs-quantity') && !document.querySelector('.shopping-recipe-form .primary').disabled && document.querySelector('.shopping-recipe-form .primary').textContent === 'Add 2 items'", "zero skips an item without highlighting or blocking other additions");
  formFill("Packages to buy for Fresh limes · 2 lb bag", "2");
  check("!document.querySelector('.needs-quantity') && !document.getElementById('shopping-recipe-blocked') && !document.querySelector('.shopping-recipe-form .primary').disabled", "valid quantity clears both the highlight and blocked-submit guidance");
  assert.equal((await entries()).length, 1, "Review must not add items before confirmation.");
  browser("set", "viewport", "1280", "900", "2");
  screenshot("shopping-review-default-desktop");
  for (const width of [320, 390]) {
    browser("set", "viewport", String(width), "844", "2");
    check("document.documentElement.scrollWidth <= innerWidth && document.querySelector('dialog').scrollWidth <= document.querySelector('dialog').clientWidth && [...document.querySelectorAll('.shopping-review-item')].every(el => el.getBoundingClientRect().height >= 44)", `${width}px review fits with accessible item targets`);
  }
  reviewItem("uncheck", '.shopping-review-item:nth-child(1) input[type=checkbox]');
  reviewItem("uncheck", '.shopping-review-item:nth-child(2) input[type=checkbox]');
  reviewItem("uncheck", '.shopping-review-item:nth-child(3) input[type=checkbox]');
  check("document.querySelector('.shopping-recipe-form .primary').disabled && document.querySelector('.shopping-recipe-preview strong').textContent.includes('0 items to add')", "unchecking everything disables adding without changing the list");
  screenshot("shopping-review-none");
  reviewItem("check", '.shopping-review-item:nth-child(1) input[type=checkbox]');
  reviewItem("check", '.shopping-review-item:nth-child(2) input[type=checkbox]');
  screenshot("shopping-review-selected-narrow");
  browser("find", "role", "button", "click", "--name", "Back", "--exact");
  check("[...document.querySelectorAll('.shopping-recipe-option input')].filter(box => box.checked).length === 2 && document.activeElement.textContent === 'Choose recipes'", "Back preserves recipe selections and moves focus to the recipe step");
  browser("click", '.shopping-recipe-form .primary');
  check("!document.querySelector('.shopping-review-item:nth-child(3) input').checked && document.querySelector('.shopping-recipe-form .primary').textContent === 'Add 2 items'", "returning to review preserves unchecked items");
  reviewItem("uncheck", '.shopping-review-item:nth-child(2) input[type=checkbox]');
  browser("find", "role", "button", "click", "--name", "Back", "--exact");
  chooseRecipe("click", "Lime rice bowls");
  chooseRecipe("click", "Rice for lunch");
  chooseRecipe("check", "Earlier lunch");
  browser("click", '.shopping-recipe-form .primary');
  check("document.querySelectorAll('.shopping-review-item').length === 2 && !document.querySelector('.shopping-review-item:nth-child(1) input').checked && document.querySelector('.shopping-review-item:nth-child(1) strong').textContent === 'Long-grain rice' && document.querySelector('.shopping-review-item:nth-child(2) input').checked && document.querySelector('.shopping-review-item:nth-child(2) strong').textContent === 'Rolled oats'", "changing recipes preserves a shared exclusion and defaults a newly introduced product to checked");
  browser("find", "role", "button", "click", "--name", "Unselect all", "--exact");
  browser("find", "role", "button", "click", "--name", "Back", "--exact");
  chooseRecipe("click", "Earlier lunch");
  chooseRecipe("check", "Lime rice bowls");
  browser("click", '.shopping-recipe-form .primary');
  check("document.querySelector('.shopping-review-item:nth-child(1) input').checked && !document.querySelector('.shopping-review-item:nth-child(2) input').checked && !document.querySelector('.shopping-review-item:nth-child(3) input').checked", "Unselect all in another recipe preserves the hidden bread exclusion and does not exclude hidden limes");
  browser("find", "role", "button", "click", "--name", "Back", "--exact");
  chooseRecipe("click", "Lime rice bowls");
  chooseRecipe("check", "Earlier lunch");
  browser("click", '.shopping-recipe-form .primary');
  browser("find", "role", "button", "click", "--name", "Select all", "--exact");
  browser("find", "role", "button", "click", "--name", "Back", "--exact");
  chooseRecipe("click", "Earlier lunch");
  chooseRecipe("check", "Lime rice bowls");
  browser("click", '.shopping-recipe-form .primary');
  check("document.querySelector('.shopping-review-item:nth-child(1) input').checked && document.querySelector('.shopping-review-item:nth-child(2) input').checked && !document.querySelector('.shopping-review-item:nth-child(3) input').checked", "Select all in another recipe selects shared rice but preserves the hidden bread exclusion");
  browser("find", "role", "button", "click", "--name", "Cancel", "--exact");
  assert.equal((await entries()).length, 1, "Cancel must not add items.");
  browser("find", "role", "button", "click", "--name", "Add from meals", "--exact");
  chooseRecipe("check", "Lime rice bowls");
  browser("click", '.shopping-recipe-form .primary');
  formFill("Packages to buy for Fresh limes · 2 lb bag", "2");
  reviewItem("uncheck", '.shopping-review-item:nth-child(3) input[type=checkbox]');
  // One atomic list write: a rejection must add nothing and keep the reviewed choices for retry or exclusion.
  const itemsPath = `/api/shopping-lists/${encodeURIComponent(listId)}/items`;
  browser("eval", `(() => { const originalFetch = window.fetch; let rejectWrite = true; window.reviewWrites = []; window.fetch = (input, init) => { if (String(input).endsWith(${JSON.stringify(itemsPath)}) && init?.method === 'POST') { window.reviewWrites.push(JSON.parse(init.body).items); if (rejectWrite) { rejectWrite = false; return Promise.resolve(new Response(JSON.stringify({error:'First review item failed'}), {status:503, headers:{'Content-Type':'application/json'}})); } } return originalFetch(input, init); }; })()`);
  browser("click", '.shopping-recipe-form .primary');
  browser("wait", "--fn", "!!document.querySelector('.shopping-recipe-form [role=alert]') && !document.querySelector('.shopping-recipe-form .primary').disabled");
  check("document.querySelector('.shopping-recipe-form [role=alert]').textContent.includes('First review item failed') && document.querySelector('.shopping-recipe-form .primary').textContent === 'Add 2 items'", "a rejected addition keeps review open with its error and the same reviewed items");
  assert.equal((await entries()).length, 1, "A rejected bulk addition adds nothing.");
  reviewItem("uncheck", '.shopping-review-item:nth-child(1) input[type=checkbox]');
  reviewItem("uncheck", '.shopping-review-item:nth-child(2) input[type=checkbox]');
  check("document.querySelector('.shopping-recipe-form .primary').disabled", "unsaved items can be excluded rather than retried");
  browser("find", "role", "button", "click", "--name", "Cancel", "--exact");
  check("!document.querySelector('[role=alert]')", "Cancel clears the review error");
  assert.equal((await entries()).length, 1, "Canceling after a rejection adds nothing.");
  shopping();
  browser("find", "role", "button", "click", "--name", "Add from meals", "--exact");
  chooseRecipe("check", "Lime rice bowls");
  chooseRecipe("check", "Rice for lunch");
  browser("click", '.shopping-recipe-form .primary');
  check("[...document.querySelectorAll('.shopping-review-item input[type=checkbox]')].every(box => box.checked)", "a fresh flow resets review items to checked");
  formFill("Packages to buy for Fresh limes · 2 lb bag", "2");
  formFill("Packages to buy for Long-grain rice", "3");
  reviewItem("uncheck", '.shopping-review-item:nth-child(3) input[type=checkbox]');
  // Reject one real browser request; other requests still exercise Worker/D1 persistence.
  browser("eval", `(() => { const originalFetch = window.fetch; let rejectWrite = true; window.reviewWrites = []; window.fetch = (input, init) => { if (String(input).endsWith(${JSON.stringify(itemsPath)}) && init?.method === 'POST') { window.reviewWrites.push(JSON.parse(init.body).items); if (rejectWrite) { rejectWrite = false; return Promise.resolve(new Response(JSON.stringify({error:'Recipe item save failed'}), {status:503, headers:{'Content-Type':'application/json'}})); } } return originalFetch(input, init); }; })()`);
  browser("click", '.shopping-recipe-form .primary');
  browser("wait", "--fn", "!!document.querySelector('.shopping-recipe-form [role=alert]') && !document.querySelector('.shopping-recipe-form .primary').disabled");
  check("document.querySelector('.shopping-recipe-preview').textContent.includes('2 items to add') && document.querySelector('.shopping-recipe-form [role=alert]').textContent.includes('Recipe item save failed')", "failed addition stays open with its reviewed counts for retry");
  screenshot("shopping-recipes-save-error");
  browser("click", '.shopping-recipe-form .primary');
  browser("wait", "--fn", "!document.querySelector('dialog[open]') && !document.querySelector('.shopping-save-status')");
  const reviewWrites = Schema.decodeUnknownSync(Schema.Array(Schema.Array(Schema.Struct({ groceryId: Schema.String, packages: Schema.optional(Schema.Number), replace: Schema.optional(Schema.Boolean) }))))(JSON.parse(browser("eval", "window.reviewWrites")));
  const summarize = (items: (typeof reviewWrites)[number]) => items.map(item => `${item.groceryId}:${item.packages ?? "keep"}`).sort();
  assert.deepEqual(reviewWrites.map(summarize), [0, 1].map(() => [`${products[0].id}:3`, `${products[1].id}:keep`, `${products[3].id}:2`].sort()), "Retry resends the same reviewed additions once; excluded bread is never sent and unchanged oil keeps its count.");
  browser("reload");
  browser("wait", ".shopping-summary");
  const selected = (await entries()).filter(item => item.checked === 0);
  assert.deepEqual(selected.map(item => item.groceryId).sort(), [products[0], products[1], products[3]].map(item => item.id).sort(), "Only checked unique groceries persist; existing oil stays, unchecked bread and unrelated oats stay off-list.");
  assert.deepEqual((await entry(products[0]))?.sources.map(source => source.title).sort(), ["Lime rice bowls", "Rice for lunch"], "Added rows record the meals that need them.");
  assert.deepEqual((await entry(products[1]))?.sources.map(source => source.title), ["Lime rice bowls"], "An unchanged existing row gains the new meal source without changing its count.");
  check("document.querySelectorAll('.purchase-row').length === 3", "only reviewed additions appear on shopping list after reload");
  check("[...document.querySelectorAll('.purchase-row')].find(el => el.textContent.includes('Long-grain rice')).textContent.includes('3 × 500 g') && [...document.querySelectorAll('.purchase-row')].find(el => el.textContent.includes('Fresh limes')).textContent.includes('2 × 2 lb') && !document.querySelector('.purchase-need')", "review additions persist adjusted package counts without altering catalog package sizes");
  browser("find", "role", "button", "click", "--name", "Add from meals", "--exact");
  chooseRecipe("check", "Lime rice bowls");
  browser("click", '.shopping-recipe-form .primary');
  check("document.querySelectorAll('[aria-label=\"Items to add\"] .shopping-review-item').length === 1 && document.querySelector('[aria-label=\"Items to add\"] .shopping-review-item strong').textContent === 'Whole-wheat bread' && document.querySelector('[aria-label=\"Items to add\"] .shopping-review-item input').checked", "later additions offer the previously excluded item without duplicating saved items");
  check("document.querySelector('[aria-label=\"Already on this list\"]').textContent.includes('Needs your decision · 1') && document.querySelector('[aria-label=\"Already on this list\"]').textContent.includes('On this list as 3') && !document.querySelector('[aria-label=\"Already on this list\"] input[type=checkbox]').checked && document.querySelector('[aria-label=\"Packages to buy for Long-grain rice\"]').disabled && document.querySelector('.shopping-recipe-form .primary').textContent === 'Add 1 item'", "an existing row with a different count needs an explicit decision and is left alone by default");
  browser("click", '.shopping-recipe-form .primary');
  browser("wait", "--fn", "!document.querySelector('dialog[open]') && !document.querySelector('.shopping-save-status')");
  assert.equal((await entries()).filter(item => item.checked === 0).length, 4);
  assert.equal((await entry(products[0]))?.packages, 3, "An unticked conflict keeps its existing count.");
  browser("find", "role", "button", "click", "--name", "Add from meals", "--exact");
  chooseRecipe("check", "Lime rice bowls");
  chooseRecipe("check", "Rice for lunch");
  browser("click", '.shopping-recipe-form .primary');
  check("document.querySelector('.shopping-recipe-form .primary').disabled && document.querySelector('[aria-label=\"Items to add\"]').textContent.includes('Everything from these meals is already on this list')", "reselecting recipes cannot duplicate or remove shopping items");
  screenshot("shopping-recipes-already-added");
  browser("find", "role", "button", "click", "--name", "Back", "--exact");
  browser("fill", '.shopping-recipe-form input[type=search]', "no such recipe");
  check("!document.querySelector('.shopping-recipe-option') && document.querySelector('.shopping-recipe-options').textContent.includes('No recipes match')", "recipe picker search has an empty state");
  browser("find", "role", "button", "click", "--name", "Cancel", "--exact");
  for (const suffix of ["past", "repeat", "note"]) await request(`meals/${prefix}-meal-${suffix}`, "DELETE");
  for (const suffix of ["past", "unplanned"]) await request(`recipes/${prefix}-${suffix}`, "DELETE");
  await removeFromList(...products.slice(0, 4));
  console.log("PASS recipe shopping flow persists unique additions, cancellation, repeat selection and partial-failure retry");
  // Include off-list aisles, blanks, duplicates and numeric boundaries; none require a new aisle API.
  const aisleFixtures = ["20", "3", "Frozen", "Wine", ""].map((aisle, index) => ({ ...products[4], id: `${prefix}-aisle-${index}`, name: `Aisle fixture ${index}`, aisle }));
  for (const item of aisleFixtures) await request("groceries", "PUT", item);
  shopping();
  browser("set", "viewport", "1280", "900", "2");
  browser("click", '[aria-label="List Builder"]');
  // Hold a real shopping write so its eventual household refresh arrives with the editor open.
  browser("eval", "window.aisleOriginalFetch = window.fetch; window.fetch = (input, init) => String(input).endsWith('/items') ? new Promise(resolve => { window.releaseAisleRefresh = () => resolve(window.aisleOriginalFetch(input, init)); }) : window.aisleOriginalFetch(input, init)");
  browser("click", '[aria-label="Add Rolled oats to this list"]');
  browser("wait", "--fn", "typeof window.releaseAisleRefresh === 'function'");
  browser("click", '[aria-label="Exit List Builder"]');
  browser("click", 'nav a[href="#groceries"]');
  browser("wait", ".grocery-manager");
  browser("find", "role", "button", "click", "--name", "Add grocery item", "--exact");
  formFill("Store product name", `${prefix}-stale`);
  browser("click", '[role=combobox]');
  browser("press", "ArrowUp");
  check("document.getElementById(document.querySelector('[role=combobox]').getAttribute('aria-activedescendant')).textContent === 'Wine'", "an option can be highlighted while a background household refresh is pending");
  await request("groceries", "PUT", { ...aisleFixtures[3], aisle: "Zzz" });
  browser("eval", "window.releaseAisleRefresh(); window.fetch = window.aisleOriginalFetch");
  browser("wait", "--fn", "[...document.querySelectorAll('.aisle-list [role=option]')].some(el => el.textContent === 'Zzz')");
  check("!document.querySelector('[role=combobox]').hasAttribute('aria-activedescendant')", "catalog refresh removes stale active-option accessibility references");
  browser("press", "Enter");
  check("!!document.querySelector('.grocery-form') && document.querySelector('[role=combobox]').value === ''", "Enter after a highlighted aisle disappears neither crashes, selects its replacement, nor submits");
  browser("find", "role", "button", "click", "--name", "Cancel", "--exact");
  await request("groceries", "PUT", aisleFixtures[3]);
  await removeFromList(products[4]);
  browser("open", `${url}/#groceries`);
  browser("reload");
  browser("set", "viewport", "1280", "900", "2");
  browser("wait", ".grocery-manager");
  browser("eval", "window.aisleFetches = 0; window.aisleOriginalFetch = window.fetch; window.fetch = (...args) => { window.aisleFetches++; return window.aisleOriginalFetch(...args); }");
  browser("find", "role", "button", "click", "--name", "Add grocery item", "--exact");
  browser("wait", ".grocery-form");
  check("[...document.querySelectorAll('.aisle-list [role=option]')].map(el => el.textContent).join('|') === '3|10|20|Bakery|Frozen|Produce|Wine' && document.querySelector('[role=combobox]').getAttribute('aria-expanded') === 'true'", "new form immediately shows every assigned aisle once, excludes blanks, and sorts numerically");
  check("document.querySelector('.aisle-list').scrollHeight > document.querySelector('.aisle-list').clientHeight && document.querySelector('.aisle-create').disabled && [...document.querySelectorAll('.aisle-list button')].every(el => el.getBoundingClientRect().height >= 44)", "aisles scroll with 44px options and a bottom fallback disabled for an empty name");
  screenshot("aisle-picker-default");
  formFill("Store product name", `${prefix}-picker`);
  browser("find", "role", "option", "click", "--name", "20", "--exact");
  check("document.querySelector('[role=combobox]').value === '20' && !document.querySelector('.aisle-list')", "existing aisle is selectable without typing");
  formFill("Aisle (optional)", "  bAk  ");
  check("document.querySelectorAll('.aisle-list [role=option]').length === 1 && document.querySelector('.aisle-list [role=option]').textContent === 'Bakery'", "typing filters by a trimmed case-insensitive substring");
  screenshot("aisle-picker-filtered");
  browser("press", "ArrowDown");
  check("document.getElementById(document.querySelector('[role=combobox]').getAttribute('aria-activedescendant')).textContent === 'Bakery'", "keyboard active option is exposed to assistive technology");
  browser("press", "Enter");
  check("document.querySelector('[role=combobox]').value === 'Bakery' && !!document.querySelector('.grocery-form')", "Enter selects the aisle without submitting the form");
  formFill("Aisle (optional)", "bakery");
  check("document.querySelectorAll('.aisle-list [role=option]').length === 1 && document.querySelector('.aisle-create').disabled", "an exact matching aisle narrows the list and cannot be recreated");
  browser("press", "Escape");
  check("!!document.querySelector('.grocery-form') && document.querySelector('[role=combobox]').getAttribute('aria-expanded') === 'false'", "Escape dismisses suggestions, not the grocery dialog");
  browser("press", "Control+a");
  browser("press", "Backspace");
  browser("press", "ArrowUp");
  browser("wait", "--fn", "document.querySelector('.aisle-list').scrollTop > 0");
  check("document.getElementById(document.querySelector('[role=combobox]').getAttribute('aria-activedescendant')).textContent === 'Wine' && document.querySelector('.aisle-list').scrollTop > 0", "ArrowUp reaches and reveals the last option in a long list");
  browser("press", "Enter");
  formFill("Aisle (optional)", "  Pantry  ");
  browser("set", "viewport", "320", "844", "2");
  check("!document.querySelector('.aisle-list [role=option]') && !document.querySelector('.aisle-create').disabled && document.querySelector('.aisle-choices').textContent.includes('No matching aisles') && document.querySelector('.grocery-form').scrollWidth <= document.querySelector('.grocery-form').clientWidth", "new-name fallback remains usable with no matches at 320px");
  screenshot("aisle-picker-new-narrow");
  browser("press", "Tab");
  check("document.activeElement === document.querySelector('.aisle-create')", "Create new aisle is reachable by Tab");
  browser("press", "Escape");
  check("!!document.querySelector('.grocery-form') && document.activeElement === document.querySelector('[role=combobox]') && document.querySelector('[role=combobox]').value === '  Pantry  ' && document.querySelector('[role=combobox]').getAttribute('aria-expanded') === 'false'", "Escape from Create restores input focus and preserves the entire draft");
  browser("click", '[role=combobox]');
  browser("press", "Tab");
  browser("press", "Enter");
  check("document.querySelector('[role=combobox]').value === 'Pantry' && document.querySelector('.aisle-picker [role=status]').textContent.includes('when you save')", "Create new aisle confirms the trimmed name without prematurely saving");
  assert.equal((await household()).groceries.length, products.length + aisleFixtures.length, "Choosing Create must not write a grocery or standalone aisle.");
  check("window.aisleFetches === 0", "opening, filtering, scrolling, selecting and creating reuse loaded aisles without any fetch");
  browser("eval", "window.fetch = window.aisleOriginalFetch");
  formFill("Store product name", `${prefix}-picker`);
  submit('.grocery-form button[type="submit"]');
  finishSave();
  const pickerProduct = (await household()).groceries.find(item => item.name === `${prefix}-picker`);
  assert(pickerProduct, "Saving the picker product must create a catalog item.");
  assert.equal(pickerProduct.aisle, "Pantry", "Confirmed new aisle persists with the product.");
  browser("find", "role", "button", "click", "--name", "Add grocery item", "--exact");
  browser("wait", ".grocery-form");
  check("[...document.querySelectorAll('.aisle-list [role=option]')].some(el => el.textContent === 'Pantry')", "saved new aisle appears on reopening without reloading the app");
  browser("find", "role", "button", "click", "--name", "Cancel", "--exact");
  browser("find", "role", "button", "click", "--name", `Edit grocery item ${prefix}-picker`, "--exact");
  formFill("Aisle (optional)", "20");
  browser("find", "role", "option", "click", "--name", "20", "--exact");
  submit('.grocery-form button[type="submit"]');
  finishSave();
  assert.equal((await household()).groceries.find(item => item.id === pickerProduct.id)?.aisle, "20", "Selected existing aisle persists with the product.");
  browser("find", "role", "button", "click", "--name", `Edit grocery item ${prefix}-picker`, "--exact");
  formFill("Aisle (optional)", "  Seasonal  ");
  submit('.grocery-form button[type="submit"]');
  finishSave();
  assert.equal((await household()).groceries.find(item => item.id === pickerProduct.id)?.aisle, "Seasonal", "Saving arbitrary text remains supported without requiring Create.");
  await request(`groceries/${pickerProduct.id}`, "DELETE");
  for (const item of aisleFixtures) await request(`groceries/${item.id}`, "DELETE");
  browser("reload");
  browser("set", "viewport", "1280", "900", "2");
  browser("wait", ".grocery-manager");
  console.log("PASS aisle picker persists new and free-text values, refreshes cached suggestions, and makes zero interaction fetches");
  check("document.querySelector('.grocery-coverage').textContent.includes('5 / 6 ingredients linked')", "automatic linking and central coverage");
  browser("click", ".grocery-coverage summary");
  submit('[aria-label="Edit recipe Lime rice bowls"]');
  browser("wait", '[aria-label="Ingredient 1 quantity"]');
  browser("fill", '[aria-label="Ingredient 1 quantity"]', "250");
  browser("eval", "document.querySelector('.ingredient-editor:has([aria-label=\"Ingredient 5 name\"]) summary').scrollIntoView({block:'center'})");
  browser("click", '.ingredient-editor:has([aria-label="Ingredient 5 name"]) summary');
  browser("fill", '[aria-label="Grocery item for ingredient 5"]', "");
  browser("click", '.ingredient-editor:has([aria-label="Ingredient 5 name"]) .ingredient-create');
  browser("wait", ".grocery-form");
  check("[...document.querySelectorAll('.aisle-list [role=option]')].map(el => el.textContent).join('|') === '10|Bakery|Produce'", "nested product creation shares the current full aisle catalog");
  formFill("Store product name", "Flat-leaf parsley");
  formFill("Aisle (optional)", "2");
  browser("find", "role", "button", "click", "--name", "Create new aisle", "--exact");
  browser("set", "viewport", "390", "844", "2");
  check("document.querySelector('.grocery-form').scrollWidth <= document.querySelector('.grocery-form').clientWidth", "narrow product form fits inside recipe dialog");
  screenshot("grocery-product-form");
  browser("click", '.quantity-input input');
  browser("find", "label", "Store product name", "click");
  check("document.querySelector('.quantity-input input').value === '1'", "entering and leaving quantity without typing preserves the existing value");
  browser("click", '.quantity-input input');
  browser("keyboard", "type", "22");
  check("document.querySelector('.quantity-input input').value === '22'", "typing immediately after clicking replaces rather than appends to the previous quantity");
  check("document.querySelectorAll('.quantity-list [role=option]').length === 1000 && document.querySelector('.quantity-list [role=option]').textContent === '1' && document.querySelector('.quantity-list [role=option]:last-child').textContent === '1000'", "quantity picker offers every integer from 1 through 1000 without filtering typed input");
  browser("press", "ArrowDown");
  browser("press", "Enter");
  check("document.querySelector('.quantity-input input').value === '23' && !document.querySelector('.quantity-list') && !!document.querySelector('.grocery-form')", "keyboard selects an adjacent quantity without submitting the grocery");
  browser("click", '.quantity-input input');
  browser("press", "End");
  browser("press", "ArrowDown");
  browser("press", "Enter");
  check("document.querySelector('.quantity-input input').value === '1000'", "keyboard navigation stops at the upper quantity boundary");
  browser("click", '.quantity-input input');
  browser("press", "Home");
  browser("press", "ArrowUp");
  browser("press", "Enter");
  check("document.querySelector('.quantity-input input').value === '1'", "keyboard navigation stops at the lower quantity boundary");
  browser("click", '.quantity-input input');
  browser("press", "Escape");
  check("!document.querySelector('.quantity-list') && !!document.querySelector('.grocery-form')", "Escape dismisses quantities without closing the grocery form");
  formFill("Package quantity", "0");
  submit('.grocery-form button[type="submit"]');
  check("document.querySelector('.grocery-form [role=alert]').textContent.includes('positive')", "invalid package quantity keeps product draft");
  formFill("Package quantity", "0.5");
  submit('.grocery-form button[type="submit"]');
  finishSave();
  assert.equal((await household()).groceries.find(item => item.name === "Flat-leaf parsley")?.quantity, 0.5, "Typed fractional package sizes persist through the real Worker/D1 boundary.");
  check("document.querySelector('[aria-label=\"Ingredient 1 quantity\"]').value === '250' && [...document.querySelectorAll('.ingredient-match-status')][4].textContent.includes('Linked: Flat-leaf parsley')", "nested product creation preserves unsaved recipe edits and selects link");
  browser("eval", "document.querySelector('.ingredient-editor').scrollIntoView()");
  check("document.querySelector('.recipe-form').scrollWidth <= document.querySelector('.recipe-form').clientWidth", "narrow ingredient-link editor has no horizontal overflow");
  screenshot("recipe-grocery-links");
  submit('.recipe-form .form-actions .primary');
  browser("wait", "--fn", "!document.querySelector('dialog[open]')");
  check("document.querySelector('.grocery-coverage').textContent.includes('6 / 6 ingredients linked')", "recipe link saved and coverage refreshed");
  browser("set", "viewport", "1280", "1050", "2");
  browser("eval", "scrollTo(0,0)");
  check("[...document.querySelectorAll('.grocery-item')].every(el => el.getBoundingClientRect().height <= 76)", "desktop catalog rows stay compact");
  check("[...document.querySelectorAll('.grocery-item')].find(el => el.textContent.includes('Long-grain rice')).textContent.includes('Linked: 2 ingredients')", "compact metadata retains ingredient counts");
  screenshot("grocery-catalog");
  const longProduct: GroceryDraft = { id: `${prefix}-long`, name: "Organic whole-grain breakfast crackers with rosemary and extra virgin olive oil", aliases: ["compact-fixture"], quantity: 1, unit: "each", aisle: "", url: "" };
  await request("groceries", "PUT", longProduct);
  browser("reload");
  browser("wait", ".grocery-item");
  browser("set", "viewport", "390", "844", "2");
  check("document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.grocery-edit')].every(el => el.getBoundingClientRect().width >= 44 && el.getBoundingClientRect().height >= 44)", "narrow compact catalog fits and retains 44px edit controls");
  check("[...document.querySelectorAll('.grocery-item')].filter(el => !el.textContent.includes('Organic')).every(el => el.getBoundingClientRect().height <= 110)", "narrow standard catalog rows stay compact");
  browser("eval", "document.querySelector('.grocery-items').scrollIntoView(); scrollBy(0, -document.querySelector('.topbar').getBoundingClientRect().height - 16)");
  screenshot("grocery-catalog-narrow");
  browser("fill", '.grocery-search input', "compact-fixture");
  check("document.querySelectorAll('.grocery-item').length === 1 && document.querySelector('.grocery-item h2').textContent === 'Organic whole-grain breakfast crackers with rosemary and extra virgin olive oil' && document.querySelector('.grocery-item').textContent.includes('Package: 1 each') && document.querySelector('.grocery-item .grocery-gap').textContent === 'Missing aisle' && document.querySelector('.grocery-item').textContent.includes('Not linked')", "alias search preserves long names, each units, unlinked state and aisle gap");
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
  browser("click", '[aria-label="List Builder"]');
  check("[...document.querySelectorAll('.purchase-group h3')].map(el => el.textContent).join('|') === 'Aisle 2|Aisle 10|Aisle Bakery|Aisle Produce'", "numeric then alphabetical aisle order");
  check("[...document.querySelectorAll('.purchase-row')].find(el => el.textContent.includes('Long-grain rice')).textContent.includes('500 g') && !document.querySelector('.purchase-need')", "catalog package sizes replace recipe-derived quantities");
  browser("click", '[aria-label="Exit List Builder"]');
  browser("click", '[aria-label="Page options"]');
  browser("find", "role", "button", "click", "--name", "Arrange route", "--exact");
  submit('[aria-label="Move Aisle Bakery up"]');
  browser("wait", "--fn", "!document.querySelector('[aria-label=\"Move Aisle Bakery up\"]').disabled");
  // Acknowledgment can precede the row's settling animation; wait before clicking its moving button.
  browser("wait", "--fn", "document.querySelectorAll('.route-aisle')[1].querySelector('h3').textContent.trim() === 'Aisle Bakery' && document.querySelector('.route-editor').getAnimations({subtree:true}).every(animation => animation.playState !== 'running')");
  submit('[aria-label="Move Aisle Bakery up"]');
  browser("wait", "--fn", "document.querySelector('.route-aisle h3').textContent.trim() === 'Aisle Bakery'");
  browser("wait", "--fn", "!document.querySelector('[aria-label=\"Move Olive oil up\"]').disabled");
  submit('[aria-label="Move Olive oil up"]');
  browser("wait", "--fn", "!document.querySelector('[aria-label=\"Move Olive oil down\"]').disabled");
  browser("set", "viewport", "390", "844", "2");
  browser("eval", "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  check("document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.route-move button')].every(el => el.getBoundingClientRect().width >= 44 && el.getBoundingClientRect().height >= 44)", "narrow route editor fits and has 44px reorder controls");
  check("[...document.querySelectorAll('.route-drag')].every(el => el.getBoundingClientRect().width >= 44 && el.getBoundingClientRect().height >= 44)", "drag handles retain 44px targets");
  const aisleOrder = () => Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(browser("eval", "[...document.querySelector('[aria-label=\"Arrange Aisle 10\"]').querySelectorAll('.route-product > span')].map(el => el.childNodes[0].textContent)")));
  const dragPoints = () => {
    browser("eval", "document.querySelector('[aria-label=\"Arrange Aisle 10\"]').scrollIntoView({block:'center'})");
    browser("eval", "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
    return Schema.decodeUnknownSync(Schema.Struct({ x: Schema.Finite, y: Schema.Finite, end: Schema.Finite }))(JSON.parse(browser("eval", "(() => { const aisle = document.querySelector('[aria-label=\"Arrange Aisle 10\"]'); const source = aisle.querySelector('[aria-label=\"Drag Olive oil within Aisle 10\"]').getBoundingClientRect(); const target = [...aisle.querySelectorAll('.route-product')].find(el => !el.textContent.includes('Olive oil') && el === aisle.querySelector('.route-product:last-child')) ?? aisle.querySelector('.route-product'); const rect = target.getBoundingClientRect(); return { x: source.left + source.width / 2, y: source.top + source.height / 2, end: rect.top + rect.height / 2 + (source.top < rect.top ? 5 : -5) }; })()")));
  };
  assert.deepEqual(aisleOrder(), ["Olive oil", "Long-grain rice", "Rolled oats"]);
  const beforeDrag = (await household()).shoppingOrder;
  let point = dragPoints();
  browser("mouse", "move", String(Math.round(point.x)), String(Math.round(point.y)));
  browser("mouse", "down", "left");
  browser("mouse", "move", String(Math.round(point.x)), String(Math.round(point.end)));
  check("!!document.querySelector('.is-dragging') && !!document.querySelector('.drop-target')", "dragging shows the moving row and drop target");
  assert.deepEqual((await household()).shoppingOrder, beforeDrag, "Drag must not save until dropped.");
  browser("mouse", "up", "left");
  browser("wait", "--fn", "document.querySelector('[aria-label=\"Arrange Aisle 10\"] .route-product:last-child > span').textContent.startsWith('Olive oil') && !document.querySelector('[aria-label=\"Drag Olive oil within Aisle 10\"]').disabled");
  assert.deepEqual(aisleOrder(), ["Long-grain rice", "Rolled oats", "Olive oil"], "Multi-position drag must insert, not swap.");
  const afterDrag = (await household()).shoppingOrder;
  assert.deepEqual(afterDrag.aisles, beforeDrag.aisles);
  assert.deepEqual(afterDrag.items.filter(key => key.includes('-bread') || key.includes('-limes')), beforeDrag.items.filter(key => key.includes('-bread') || key.includes('-limes')));
  console.log("PASS mouse drag persists insertion order without changing other aisles");

  // Native Chromium touch input, not synthetic DOM PointerEvents; no browser dependency needed.
  const socket = new WebSocket(browser("get", "cdp-url"));
  await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let sequence = 0;
  let sessionId: string | undefined;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const cdpMessage = Schema.Struct({ id: Schema.optional(Schema.Number), result: Schema.optional(Schema.Unknown), error: Schema.optional(Schema.Struct({ message: Schema.String })) });
  socket.addEventListener("message", event => {
    try {
      const message = Schema.decodeUnknownSync(cdpMessage)(JSON.parse(String(event.data)));
      if (message.id === undefined) return; // CDP events are not command responses.
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    } catch (error) {
      for (const request of pending.values()) request.reject(new Error("Invalid CDP response", { cause: error }));
      pending.clear();
    }
  });
  // Each command result is decoded by its caller; the transport cannot know its shape.
  const cdp = (method: string, params: { targetId?: string; flatten?: boolean; enabled?: boolean; maxTouchPoints?: number; type?: string; touchPoints?: { x: number; y: number }[] } = {}) => new Promise<unknown>((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, sessionId })); });
  try {
    const { targetInfos } = Schema.decodeUnknownSync(Schema.Struct({ targetInfos: Schema.Array(Schema.Struct({ type: Schema.String, url: Schema.String, targetId: Schema.String })) }))(await cdp("Target.getTargets"));
    const target = targetInfos.find(entry => entry.type === "page" && entry.url.startsWith(url));
    assert(target, "Local smoke tab must exist.");
    sessionId = Schema.decodeUnknownSync(Schema.Struct({ sessionId: Schema.String }))(await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
    await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    browser("eval", "window.lastDragPointer = ''; document.addEventListener('pointerdown', event => {window.lastDragPointer = event.pointerType;}, {once:true})");
    point = dragPoints();
    await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
    browser("wait", "--fn", "!!document.querySelector('.is-dragging')");
    await cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.end }] });
    check("window.lastDragPointer === 'touch' && !!document.querySelector('.drop-target')", "native touch activates the vertical drag handle");
    await cdp("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    check("!document.querySelector('.is-dragging')", "canceling a touch drag clears feedback");
    assert.deepEqual((await household()).shoppingOrder, afterDrag, "Canceled touch must not save.");
    // Start the independent drop check in a fresh document after Chromium's canceled gesture.
    browser("reload");
    browser("wait", ".shopping-summary");
    check("location.hash.includes('mode=arrange') && !!document.querySelector('.route-editor')", "reload preserves the route editor instead of reopening arrange mode");
    point = dragPoints();
    await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
    browser("wait", "--fn", "!!document.querySelector('.is-dragging')");
    await cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.end }] });
    check("!!document.querySelector('.drop-target')", "second touch drag selects its drop target");
    await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    browser("wait", "--fn", "document.querySelector('[aria-label=\"Arrange Aisle 10\"] .route-product > span').textContent.startsWith('Olive oil') && !document.querySelector('[aria-label=\"Drag Olive oil within Aisle 10\"]').disabled");
    assert.deepEqual(aisleOrder(), ["Olive oil", "Long-grain rice", "Rolled oats"]);
    assert.deepEqual(withoutRevision((await household()).shoppingOrder), withoutRevision(beforeDrag), "Reverse touch drag must restore the persisted order.");
    console.log("PASS touch drag up persists and touch cancellation leaves order unchanged");
  } finally { socket.close(); }
  browser("eval", "document.querySelector('.route-editor').scrollIntoView()");
  screenshot("grocery-route");
  browser("reload");
  shopping();
  check("!document.querySelector('.purchase-row') && !document.querySelector('.shopping-range')", "planned recipes do not dynamically populate the manual list");
  browser("click", '[aria-label="List Builder"]');
  check("document.querySelectorAll('.purchase-row').length === 6 && [...document.querySelectorAll('.purchase-row .membership-button')].every(button => button.getAttribute('aria-pressed') === 'false' && button.getAttribute('aria-label').startsWith('Add '))", "List Builder includes all groceries, including unused oats, each offered for adding");
  check("document.querySelector('.purchase-group h3').textContent === 'Aisle Bakery' && document.querySelector('[aria-label=\"Aisle 10\"] .item-info strong').textContent === 'Olive oil'", "aisle and within-aisle ordering survive reload");
  // Check both debounce boundaries in one browser call, without CLI latency masking an immediate filter.
  browser("eval", `(async () => {
    const input = document.querySelector('[aria-label="Search grocery items"]');
    const fill = value => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    fill('rolled');
    await new Promise(resolve => setTimeout(resolve, 100));
    if (document.querySelectorAll('.purchase-row').length !== 6) throw new Error('Search filtered before debounce');
    fill('  RAIN  ');
    await new Promise(resolve => setTimeout(resolve, 220));
    if (document.querySelectorAll('.purchase-row').length !== 6) throw new Error('Superseded search was not canceled');
  })()`);
  browser("wait", "--fn", "document.querySelectorAll('.purchase-row').length === 1 && document.querySelector('.item-info strong').textContent === 'Long-grain rice'");
  console.log("PASS builder search debounces rapid edits and matches mixed-case substrings inside product names");
  screenshot("list-builder-search-desktop");
  browser("set", "viewport", "390", "844", "2");
  check("document.documentElement.scrollWidth <= innerWidth && document.querySelector('[aria-label=\"Search grocery items\"]').getBoundingClientRect().width > 250", "narrow builder search fits with a usable input width");
  screenshot("list-builder-search-narrow");
  browser("click", '[aria-label="Add Long-grain rice to this list"]');
  browser("wait", "--fn", "!document.querySelector('.shopping-save-status')");
  browser("fill", '[aria-label="Search grocery items"]', "no such item");
  browser("wait", "--fn", "!document.querySelector('.purchase-row') && document.querySelector('.shopping-panel').textContent.includes('No grocery items found')");
  check("document.querySelector('.shopping-summary').textContent.includes('1 left') && !document.querySelector('.shopping-panel').textContent.includes('Nothing on this list')", "no-match search keeps list totals and has a dedicated empty state");
  screenshot("list-builder-search-empty");
  browser("click", '[aria-label="Search grocery items"]');
  browser("press", "Control+a");
  browser("press", "Backspace");
  browser("wait", "--fn", "document.querySelectorAll('.purchase-row').length === 6");
  check("document.querySelector('[aria-label=\"Remove Long-grain rice from this list\"]').getAttribute('aria-pressed') === 'true' && document.querySelector('[aria-label=\"Aisle 10\"] .item-info strong').textContent === 'Olive oil'", "clearing search restores catalog route order and preserves filtered selection");
  const beforeSearch = await household();
  for (const query of ["white rice", "Bakery", "[", ".", "Long  grain"]) {
    browser("fill", '[aria-label="Search grocery items"]', query);
    browser("eval", "new Promise(resolve => setTimeout(resolve, 400)).then(() => { if (document.querySelector('.purchase-row')) throw new Error('Search matched outside literal product name'); })");
  }
  browser("fill", '[aria-label="Search grocery items"]', "i");
  browser("wait", "--fn", "document.querySelectorAll('.purchase-row').length === 3");
  check("[...document.querySelectorAll('.item-info strong')].map(el => el.textContent).join('|') === 'Olive oil|Long-grain rice|Fresh limes · 2 lb bag'", "multiple name matches preserve saved order across aisles without matching aliases, aisles or regex punctuation");
  browser("fill", '[aria-label="Search grocery items"]', "   ");
  browser("wait", "--fn", "document.querySelectorAll('.purchase-row').length === 6");
  const afterSearch = await household();
  assert.deepEqual(afterSearch.shoppingItems, beforeSearch.shoppingItems, "Searching must not change hidden or visible shopping membership.");
  assert.deepEqual(afterSearch.shoppingOrder, beforeSearch.shoppingOrder, "Searching must not change route order.");
  // Change mode/page in the same turn as input so a still-pending timer is definitely exercised.
  browser("eval", `(async () => {
    const fill = () => {
      const input = document.querySelector('[aria-label="Search grocery items"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'rice');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const settle = () => new Promise(resolve => setTimeout(resolve, 400));
    for (const shop of [false, true]) {
      fill();
      document.querySelector('[aria-label="Exit List Builder"]').click();
      await settle();
      if (shop) {
        document.querySelector('[aria-label="Shopping mode"]').click();
        await settle();
        document.querySelector('[aria-label="Exit shopping mode"]').click();
        await settle();
      }
      document.querySelector('[aria-label="List Builder"]').click();
      await settle();
      if (document.querySelector('[aria-label="Search grocery items"]').value || document.querySelectorAll('.purchase-row').length !== 6) throw new Error('Pending search survived mode change');
    }
    fill();
    location.hash = '#recipes';
    await settle();
    location.hash = '#shopping';
    await settle();
    document.querySelector('[aria-label="List Builder"]').click();
    await settle();
    if (document.querySelector('[aria-label="Search grocery items"]').value || document.querySelectorAll('.purchase-row').length !== 6) throw new Error('Pending search survived navigation');
  })()`);
  console.log("PASS blank search restores all items; pending debounce is canceled on Exit, Focus and page navigation");
  browser("click", '[aria-label="Add Rolled oats to this list"]');
  browser("wait", "--fn", "!document.querySelector('.shopping-save-status')");
  assert.equal((await entry(products[0]))?.checked, 0);
  assert.equal((await entry(products[4]))?.checked, 0);
  check("document.querySelectorAll('.purchase-row').length === 6 && document.querySelector('.shopping-summary').textContent.includes('2 left')", "adding items keeps every catalog row visible");
  for (const width of [320, 390, 1280]) {
    browser("set", "viewport", String(width), "844", "2");
    check("document.documentElement.scrollWidth <= innerWidth", `${width}px List Builder has no horizontal overflow`);
    checkRowAlignment();
  }
  browser("set", "viewport", "390", "844", "2");
  screenshot("list-builder-narrow");
  browser("set", "viewport", "1280", "1000", "2");
  screenshot("list-builder-desktop");
  browser("fill", '[aria-label="Search grocery items"]', "rice");
  browser("wait", "--fn", "document.querySelectorAll('.purchase-row').length === 1");
  browser("click", '[aria-label="Exit List Builder"]');
  browser("click", '[aria-label="Shopping mode"]');
  check("!document.querySelector('[aria-label=\"Search grocery items\"]') && document.querySelectorAll('.purchase-row').length === 2 && [...document.querySelectorAll('.purchase-row input')].every(box => !box.checked)", "Focus ignores builder search and shows only the manually selected groceries");
  browser("click", '[aria-label="Picked up Long-grain rice"]');
  browser("wait", "--fn", "!document.querySelector('.shopping-save-status')");
  check("document.querySelector('[aria-label=\"In cart\"] [aria-label=\"Picked up Long-grain rice\"]').checked && !document.querySelector('[aria-label=\"Aisle 10\"]')?.textContent.includes('Long-grain rice') && [...document.querySelectorAll('.toast')].some(toast => toast.textContent.includes('Picked up Long-grain rice') && toast.querySelector('button')?.textContent === 'Undo')", "picking up an item moves it from its aisle into In cart and offers Undo");
  assert.equal((await entry(products[0]))?.checked, 1, "Picked-up state persists while the grocery stays on the list.");
  browser("click", '[aria-label="Picked up Long-grain rice"]');
  browser("wait", "--fn", "!document.querySelector('.shopping-save-status') && !document.querySelector('[aria-label=\"In cart\"]')");
  assert.equal((await entry(products[0]))?.checked, 0, "Unchecking returns the grocery to still needed.");
  browser("click", '[aria-label="Exit shopping mode"]');
  browser("click", '[aria-label="List Builder"]');
  check("document.querySelector('[aria-label=\"Search grocery items\"]').value === '' && document.querySelectorAll('.purchase-row').length === 6", "reopening builder starts with an unfiltered catalog");
  check("document.querySelector('[aria-label=\"Remove Long-grain rice from this list\"]').getAttribute('aria-pressed') === 'true'", "a grocery picked up and put back stays on the list in List Builder");
  browser("click", '[aria-label="Exit List Builder"]');
  await request("meals", "PUT", { ...(await household()).meals[0], scale: 7, date: "2099-02-01" });
  browser("reload");
  browser("wait", ".purchase-row");
  check("document.querySelectorAll('.purchase-row').length === 2 && document.querySelector('[aria-label=\"Remove Rolled oats from this list\"]')", "manual selection persists after reload and changing meal date/scale");
  browser("click", '[aria-label="Shopping mode"]');
  check("[...document.querySelectorAll('.purchase-row')].filter(el => !el.querySelector('.purchase-warning')).every(el => el.getBoundingClientRect().height <= 88) && [...document.querySelectorAll('.purchase-details summary')].every(el => el.getBoundingClientRect().height >= 44)", "compact rows retain 44px disclosure targets");
  checkRowAlignment();
  browser("click", '[aria-label="Details for Long-grain rice"]');
  check("[...document.querySelectorAll('.purchase-details[open]')].some(el => el.querySelector('a').href === 'https://example.com/rice') && !document.querySelector('.purchase-need')", "expanded row retains product URL without recipe-derived totals");
  checkRowAlignment();
  browser("click", '.purchase-details[open] button');
  browser("wait", ".grocery-form");
  check("document.querySelector('.grocery-form input').value === 'Long-grain rice'", "expanded linked row edits the correct product");
  browser("find", "role", "button", "click", "--name", "Cancel", "--exact");
  browser("click", '[aria-label="Details for Long-grain rice"]');
  browser("eval", "scrollTo(0,0)");
  browser("set", "viewport", "390", "844", "2");
  check("document.documentElement.scrollWidth <= innerWidth", "390px Focus controls fit without horizontal overflow");
  screenshot("shopping-mode-mobile");
  check("Math.abs(document.querySelector('.shopping-summary').getBoundingClientRect().top) <= 1 && !document.querySelector('.topbar').getClientRects().length", "compact shopping controls stay pinned with app headers hidden");
  browser("set", "viewport", "1280", "1000", "2");
  browser("eval", "scrollTo(0,0)");
  screenshot("shopping-mode-desktop");
  browser("find", "role", "button", "click", "--name", "Exit shopping mode", "--exact");
  check("!document.querySelector('.shopping-mode') && document.querySelector('.topbar').getClientRects().length > 0 && !document.querySelector('.shopping-range')", "exit restores normal page headers without recipe date controls");
  screenshot("shopping-list-default");
  const dragProducts = ["qa Basil", "qa Garlic", "qa qe Sage", "qe Pepper", "qe Leek"].map((name, index) => ({ ...products[0], id: `${prefix}-search-drag-${index}`, name, aliases: [], aisle: "Search drag" }));
  for (const item of dragProducts) await request("groceries", "PUT", item);
  const searchOrder = { ...(await household()).shoppingOrder, items: dragProducts.map(item => JSON.stringify(["grocery", item.id])) };
  await request("shopping-order", "PUT", searchOrder);
  const savedSearchOrder = (await household()).shoppingOrder;
  shopping();
  browser("click", '[aria-label="List Builder"]');
  browser("fill", '[aria-label="Search grocery items"]', "qa");
  browser("wait", "--fn", "document.querySelectorAll('.purchase-row').length === 3");
  const sageHandle = Schema.decodeUnknownSync(Schema.Struct({ x: Schema.Finite, y: Schema.Finite }))(JSON.parse(browser("eval", "(() => { const rect = document.querySelector('[aria-label=\"Drag qa qe Sage within Aisle Search drag\"]').getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; })()")));
  browser("mouse", "move", String(sageHandle.x), String(sageHandle.y));
  browser("mouse", "down", "left");
  check("!!document.querySelector('.is-dragging')", "search race starts with a real active drag");
  browser("eval", "(() => { const input = document.querySelector('[aria-label=\"Search grocery items\"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'qe'); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
  browser("wait", "--fn", "document.querySelectorAll('.purchase-row').length === 3 && document.querySelector('.item-info strong').textContent === 'qa qe Sage'");
  browser("mouse", "up", "left");
  browser("wait", "--fn", "!document.querySelector('.shopping-save-status')");
  assert.deepEqual((await household()).shoppingOrder, savedSearchOrder, "An equal-height search result replacement during drag must not persist an unintended reorder.");
  console.log("PASS search result changes safely cancel an active drag without changing saved route order");
  await addToList({ groceryId: products[1].id });
  shopping();
  browser("click", '[aria-label="Page options"]');
  browser("find", "role", "button", "click", "--name", "Arrange route", "--exact");
  // Hold one failed order write so a rename draft is entered before the optimistic order rolls back.
  browser("eval", "(() => { const originalFetch = window.fetch; window.fetch = (input, init) => { if (String(input).endsWith('/api/shopping-order')) { window.fetch = originalFetch; return new Promise(resolve => { window.rejectOrder = () => resolve(new Response(JSON.stringify({error:'Order rollback smoke'}), {status:503,headers:{'Content-Type':'application/json'}})); }); } return originalFetch(input, init); }; })()");
  submit('[aria-label="Move Olive oil up"]');
  browser("wait", "--fn", "!!window.rejectOrder && document.querySelector('.route-editor').getAnimations({subtree:true}).every(animation => animation.playState !== 'running')");
  submit('[aria-label="Rename Aisle 10"]');
  browser("fill", '[aria-label="Aisle name"]', "Unsaved aisle draft");
  browser("eval", "window.rejectOrder()");
  browser("wait", "--fn", "!document.querySelector('.shopping-save-status')");
  check("document.querySelector('[aria-label=\"Aisle name\"]')?.value === 'Unsaved aisle draft'", "route rollback cancels stale drag state without discarding an unrelated aisle rename draft");
  assert.deepEqual((await household()).shoppingOrder, savedSearchOrder, "Rejected order write must leave saved route unchanged.");
  console.log("Grocery browser smoke passed.");
} finally {
  try { browser("close"); } finally {
    const current = await household();
    for (const item of current.meals.filter((item) => item.id.startsWith(prefix))) await request(`meals/${encodeURIComponent(item.id)}`, "DELETE");
    for (const item of current.recipes.filter((item) => item.id.startsWith(prefix))) await request(`recipes/${encodeURIComponent(item.id)}`, "DELETE");
    for (const item of (await household()).groceries.filter((item) => item.id.startsWith(prefix) || item.name.startsWith(prefix) || item.name === "Flat-leaf parsley")) await request(`groceries/${encodeURIComponent(item.id)}`, "DELETE");
    await request("shopping-order", "PUT", original.shoppingOrder);
    for (const list of (await household()).shoppingLists) await request(`shopping-lists/${encodeURIComponent(list.id)}`, "DELETE", { expectedRevision: list.revision ?? null });
    const restored = await household();
    assert.deepEqual({ ...restored, shoppingOrder: withoutRevision(restored.shoppingOrder) }, { ...original, shoppingOrder: withoutRevision(original.shoppingOrder) }, "Fixture cleanup must restore the starting household domain content.");
  }
}
