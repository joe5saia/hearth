import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { HouseholdSchema, type GroceryItem, type Recipe } from "../src/domain.ts";

// Real browser, Worker and SQLite; fault injection only at the browser HTTP boundary.
const url = process.argv[2] ?? "http://localhost:5173";
const selected = process.argv[3] ?? "all";
assert(["localhost", "127.0.0.1"].includes(new URL(url).hostname), "Use local development only.");
assert(["all", "extras", "catalog", "busy", "refresh", "rejection"].includes(selected));
const session = `deletion-${process.pid}`;
const browser = (...args: string[]) => execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8", timeout: 30_000 }).trim();
const check = (expression: string, message: string) => {
  browser("eval", `(() => { if (!(${expression})) throw new Error(${JSON.stringify(message)}); return true; })()`);
  console.log(`PASS ${message}`);
};
const request = async (path: string, method = "GET", value?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { "Content-Type": "application/json" }, body: value === undefined ? undefined : JSON.stringify(value) });
  assert(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
  return response;
};
const household = async () => Schema.decodeUnknownSync(HouseholdSchema)(await (await request("household")).json());
const prefix = `delete-smoke-${crypto.randomUUID()}`;
const products = ["rice", "oats", "oil"].map((name): GroceryItem => ({ id: `${prefix}-${name}`, name: `Deletion ${name}`, aliases: [], quantity: 500, unit: "g", aisle: "Deletion smoke", url: "" }));
const recipe: Recipe = { id: `${prefix}-recipe`, title: "Deletion rice bowl", description: "Keep this description", servings: 2, minutes: 20, category: "", photo: "", source: "", rating: "neutral", instructions: ["Cook rice; keep these instructions."], ingredients: [
  { name: "Rice", originalText: "1½ cups rice, rinsed", quantity: 1.5, unit: "cup", groceryItemId: products[0].id },
  { name: "Oil", quantity: 2, unit: "tbsp", groceryItemId: products[2].id },
] };
const openCatalog = () => {
  browser("open", `${url}/#groceries`);
  browser("reload");
  browser("wait", ".grocery-manager");
};
const edit = (product: GroceryItem) => {
  browser("click", `[aria-label="Edit grocery item ${product.name}"]`);
  browser("wait", ".grocery-form");
};
const remove = () => {
  browser("eval", "document.querySelector('.grocery-form .danger').scrollIntoView({block:'center'})");
  browser("find", "role", "button", "click", "--name", "Delete item", "--exact");
};
const finished = () => browser("wait", "--fn", "!document.querySelector('.grocery-form')");
const runs = (name: string) => selected === "all" || selected === name;
const screenshot = (name: string) => browser("screenshot", resolve(`.amp/in/artifacts/${name}.png`));

try {
  await mkdir(".amp/in/artifacts", { recursive: true });
  browser("open", `${url}/#shopping`);
  browser("set", "viewport", "1280", "900", "2");
  if (runs("extras")) {
    const extras = [
      { id: `${prefix}?query`, name: "Deletion query extra", checked: 0 },
      { id: prefix, name: "Deletion plain extra", checked: 0 },
      { id: `${prefix}#fragment`, name: "Deletion fragment extra", checked: 1 },
      { id: `${prefix}/%20`, name: "Deletion percent extra", checked: 0 },
    ];
    for (const extra of extras) await request("extras", "PUT", extra);
    browser("reload");
    browser("wait", ".extra-item");
    for (const [index, extra] of extras.entries()) {
      browser("find", "role", "button", "click", "--name", `Remove ${extra.name}`, "--exact");
      browser("wait", "--fn", "![...document.querySelectorAll('.extra-item button')].some(button => button.disabled)");
      assert.deepEqual((await household()).extras.filter(item => item.id.startsWith(prefix)).map(item => item.id).sort(), extras.slice(index + 1).map(item => item.id).sort(), `Removing ${extra.name} must delete only its complete ID.`);
    }
    browser("reload");
    browser("wait", ".shopping-summary");
    check("![...document.querySelectorAll('.extra-item')].some(row => row.textContent.includes('Deletion'))", "plain, query, fragment, percent and checked extras remain deleted after reload");
  }
  for (const product of products) await request("groceries", "PUT", product);
  await request("recipes", "PUT", recipe);
  for (const product of products) await request("checks", "PUT", { key: JSON.stringify(["shopping-list", product.id]), checked: 0 });
  openCatalog();
  if (runs("busy")) {
    edit(products[1]);
    browser("eval", `(() => { const original = window.fetch; window.fetch = (input, init) => { if (init?.method === 'DELETE') return new Promise(resolve => { window.releaseDeletion = () => { window.fetch = original; resolve(original(input, init)); }; }); return original(input, init); }; })()`);
    remove();
    browser("wait", "--fn", "!!window.releaseDeletion && document.querySelector('.grocery-form .danger').disabled");
    browser("press", "Escape");
    check("!!document.querySelector('dialog[open] .grocery-form')", "Escape cannot dismiss a pending deletion");
    browser("click", '[aria-label="Close dialog"]');
    check("!!document.querySelector('dialog[open] .grocery-form')", "X cannot dismiss a pending deletion");
    browser("mouse", "move", "2", "2"); browser("mouse", "down", "left"); browser("mouse", "up", "left");
    check("!!document.querySelector('dialog[open] .grocery-form')", "backdrop cannot dismiss a pending deletion");
    browser("eval", "window.releaseDeletion()");
    finished();
    assert(!(await household()).groceries.some(item => item.id === products[1].id));
    await request("groceries", "PUT", products[1]);
    openCatalog();
  }
  if (runs("rejection")) {
    edit(products[1]);
    browser("eval", `(() => { const original = window.fetch; window.fetch = (input, init) => { if (init?.method === 'DELETE') { window.fetch = original; return Promise.resolve(new Response(JSON.stringify({error:'Delete rejected for smoke'}), {status:503, headers:{'Content-Type':'application/json'}})); } return original(input, init); }; })()`);
    remove();
    browser("wait", "--fn", "!!document.querySelector('.grocery-form [role=alert]') && !document.querySelector('.grocery-form .danger').disabled");
    check("document.querySelector('.grocery-form [role=alert]').textContent.includes('Delete rejected for smoke')", "rejected delete keeps the editor open with an actionable error");
    screenshot("delete-rejected");
    assert((await household()).groceries.some(item => item.id === products[1].id));
    remove(); finished();
    assert(!(await household()).groceries.some(item => item.id === products[1].id));
    console.log("PASS retry after rejection deletes the product with one click");
    await request("groceries", "PUT", products[1]);
    openCatalog();
  }
  if (runs("refresh")) {
    edit(products[1]);
    browser("eval", `(() => { const original = window.fetch; let deleted = false; let failed = false; window.deletionRequests = 0; window.restoreDeletionFetch = () => { window.fetch = original; }; window.fetch = async (input, init) => { if (init?.method === 'DELETE') { window.deletionRequests++; const response = await original(input, init); deleted = response.ok; return response; } if (deleted && !failed && String(input).endsWith('/api/household')) { failed = true; return new Response(JSON.stringify({error:'Refresh unavailable for smoke'}), {status:503, headers:{'Content-Type':'application/json'}}); } return original(input, init); }; })()`);
    remove();
    browser("wait", "--fn", "!!document.querySelector('[role=alert]') && !document.querySelector('.grocery-form .danger:disabled')");
    assert(!(await household()).groceries.some(item => item.id === products[1].id), "DELETE must really have committed before the failed refresh.");
    check("!document.querySelector('.grocery-form') && document.querySelector('[role=alert]').textContent.includes('saved') && document.querySelector('[role=alert]').textContent.includes('refresh')", "acknowledged delete closes editor and reports refresh failure rather than delete failure");
    screenshot("delete-refresh-warning");
    browser("find", "role", "button", "click", "--name", "Retry", "--exact");
    browser("wait", "--fn", "!document.querySelector('[aria-label=\"Edit grocery item Deletion oats\"]')");
    check("window.deletionRequests === 1", "Retry refreshes the committed deletion without sending another DELETE");
    browser("eval", "window.restoreDeletionFetch()");
    await request("groceries", "PUT", products[1]);
    openCatalog();
  }
  if (runs("catalog")) {
    const before = await household();
    edit(products[0]);
    browser("set", "viewport", "390", "844", "2");
    check("document.querySelector('.grocery-form').scrollWidth <= document.querySelector('.grocery-form').clientWidth", "narrow one-click deletion editor fits without horizontal overflow");
    browser("eval", "document.querySelector('.grocery-form .danger').scrollIntoView({block:'center'})");
    screenshot("delete-product-narrow");
    browser("set", "viewport", "1280", "900", "2");
    remove(); finished();
    const after = await household();
    assert.deepEqual(after.recipes, before.recipes.map(recipe => ({ ...recipe, ingredients: recipe.ingredients.map(ingredient => ingredient.groceryItemId === products[0].id ? { ...ingredient, groceryItemId: null } : ingredient) })));
    assert(!after.groceries.some(item => item.id === products[0].id));
    assert(!after.checks.some(item => item.key === JSON.stringify(["shopping-list", products[0].id])));
    edit(products[1]); remove(); finished();
    browser("reload"); browser("wait", ".grocery-manager");
    check("!document.querySelector('[aria-label=\"Edit grocery item Deletion rice\"]') && !document.querySelector('[aria-label=\"Edit grocery item Deletion oats\"]') && !!document.querySelector('[aria-label=\"Edit grocery item Deletion oil\"]')", "one-click linked and unused product deletion persists; unrelated product remains");
    assert((await household()).recipes.find(item => item.id === recipe.id)?.ingredients[0].groceryItemId === null);
  }
  console.log(`Grocery deletion browser smoke passed (${selected}).`);
} finally {
  try { browser("close"); } finally {
    const current = await household();
    for (const extra of current.extras.filter(item => item.id.startsWith(prefix))) await request(`extras/${encodeURIComponent(extra.id)}`, "DELETE");
    for (const recipe of current.recipes.filter(item => item.id.startsWith(prefix))) await request(`recipes/${encodeURIComponent(recipe.id)}`, "DELETE");
    for (const product of current.groceries.filter(item => item.id.startsWith(prefix))) await request(`groceries/${encodeURIComponent(product.id)}`, "DELETE");
  }
}
