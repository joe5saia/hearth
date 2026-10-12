import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// Real browser + Worker/D1; fixture records are removed even on failure.
const url = process.argv[2] ?? "http://localhost:5173";
assert(["localhost", "127.0.0.1"].includes(new URL(url).hostname), "Use local development only.");
const session = `checklist-${process.pid}`;
const browser = (...args: string[]) => execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8", timeout: 90_000 }).trim();
const check = (expression: string, message: string) => {
  browser("eval", `(() => { if (!(${expression})) throw new Error(${JSON.stringify(message)}); return true; })()`);
  console.log(`PASS ${message}`);
};
const request = async (path: string, method = "GET", body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  assert(response.ok, `${method} ${path}: ${response.status} ${response.ok ? "" : await response.text()}`);
  return response;
};
const household = async () => (await request("household")).json();
const original = await household();
assert(!original.recipes.length && !original.groceries.length, "Use an empty disposable local household.");
const prefix = `checklist-${crypto.randomUUID()}`;
const groceries = [
  { id: `${prefix}-rice`, name: "Long-grain rice", aliases: ["rice", "white rice"], quantity: 500, unit: "g", aisle: "", url: "" },
  { id: `${prefix}-oil`, name: "Olive oil", aliases: ["oil"], quantity: 500, unit: "ml", aisle: "", url: "" },
  { id: `${prefix}-butter`, name: "Butter", aliases: [], quantity: 1, unit: "lb", aisle: "", url: "" },
  { id: `${prefix}-salt`, name: "Salt", aliases: [], quantity: 100, unit: "g", aisle: "", url: "" },
];
const recipe = (id: string, title: string, ingredients: unknown[]) => ({ id: `${prefix}-${id}`, title, ingredients, description: "", servings: 2, minutes: 20, category: "", photo: "", source: "", rating: "neutral", instructions: ["Cook and serve."] });
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
  ]),
  recipe("other", "Unselected recipe", [{ name: "rice", quantity: 9, unit: "kg" }]),
];
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
  const before = await household();
  browser("open", `${url}/#shopping`);
  browser("wait", '.shopping-controls a[href="#recipe-checklist"]');
  screenshot("recipe-checklist-shopping-button");
  browser("set", "viewport", "390", "844", "2");
  check("document.documentElement.scrollWidth <= innerWidth", "new shopping button fits narrow controls");
  screenshot("recipe-checklist-shopping-button-narrow");
  browser("click", '.shopping-controls a[href="#recipe-checklist"]');
  const tabs = JSON.parse(browser("tab", "list", "--json")).data.tabs;
  assert.equal(tabs.length, 2, "The real link opens a new tab.");
  browser("tab", tabs.find((tab: { url: string }) => tab.url.endsWith("#recipe-checklist")).tabId);
  browser("set", "viewport", "1280", "900", "2");
  browser("wait", '.recipe-checklist form .recipe-checklist-row');
  check("!document.querySelector('.sidebar') && document.querySelector('.primary').disabled", "new tab has a standalone, initially unselected recipe picker");
  screenshot("recipe-checklist-picker");
  browser("find", "label", "Rice dinner", "check");
  browser("fill", 'input[type="search"]', "lunch");
  browser("find", "label", "Rice lunch", "check");
  browser("fill", 'input[type="search"]', "not a recipe");
  check("document.body.textContent.includes('No recipes match') && document.querySelector('.primary').textContent.includes('2 recipes')", "search preserves selections and has a no-match state");
  browser("click", ".primary");
  browser("wait", '[aria-label="Ingredients needed"]');
  const amounts = JSON.parse(browser("eval", "Object.fromEntries([...document.querySelectorAll('[aria-label=\"Ingredients needed\"] label')].map(row => [row.querySelector('strong').textContent, row.querySelector('strong + span').textContent]))"));
  assert.deepEqual(amounts, { Butter: "0.75 lb", Lime: "5", "Long-grain rice": "1 kg", Milk: "1.25 l", "Olive oil": "280.95 ml", Parsley: "3 bunch", Salt: "10 g + 4.93 ml", Sugar: "1.25 cup" });
  console.log("PASS combined weights, US volumes, metric volumes, counts, linked aliases and unlinked names; incompatible units retain honest subtotals; unselected recipe excluded");
  screenshot("recipe-checklist-totals");
  browser("find", "label", "Long-grain rice", "check");
  check("document.querySelector('[role=status]').textContent.includes('7 of 8') && document.querySelectorAll('[aria-label=\"Ingredients needed\"] input:checked').length === 1", "manual checkbox changes only its row and progress");
  browser("set", "viewport", "390", "844", "2");
  check("document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.recipe-checklist-row')].every(row => row.getBoundingClientRect().height >= 44)", "narrow checklist fits and has accessible row targets");
  screenshot("recipe-checklist-checked-narrow");
  browser("find", "label", "Long-grain rice", "click");
  check("document.querySelector('[role=status]').textContent.includes('8 of 8')", "manual checkbox can be unchecked");
  browser("click", ".secondary");
  browser("fill", 'input[type="search"]', "Rice");
  browser("wait", "--fn", "document.querySelectorAll('input:checked').length === 2");
  check("document.querySelectorAll('input:checked').length === 2", "changing recipes retains selections");
  browser("find", "label", "Rice lunch", "click");
  browser("click", ".primary");
  check("[...document.querySelectorAll('strong')].some(el => el.textContent === 'Long-grain rice' && el.nextElementSibling.textContent === '250 g') && !document.querySelector('input:checked')", "regeneration recalculates totals and resets checks");
  browser("reload");
  browser("wait", ".recipe-checklist form");
  check("document.querySelector('.primary').disabled && !document.querySelector('input:checked')", "tab reload resets this disposable checklist");
  assert.deepEqual(await household(), before, "All checklist operations must leave the real household unchanged.");
  console.log("Recipe checklist browser smoke passed; household unchanged.");
} finally {
  browser("close");
  const current = await household();
  for (const item of current.recipes.filter((item: { id: string }) => item.id.startsWith(prefix))) await request(`recipes/${item.id}`, "DELETE");
  for (const grocery of current.groceries.filter((item: { id: string }) => item.id.startsWith(prefix))) await request(`groceries/${grocery.id}`, "DELETE");
}
