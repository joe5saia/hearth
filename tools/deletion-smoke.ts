import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { HouseholdSchema, DateSchema, type RecipeDraft, type MealDraft } from "../src/domain.ts";

// Real UI -> Worker -> D1. Never run against a shared or production household.
const url = process.argv[2] ?? "http://localhost:5173";
assert(["localhost", "127.0.0.1"].includes(new URL(url).hostname), "Use local development only.");
const label = process.argv[3] ?? "after";
assert(["before", "after"].includes(label));
const session = `deletion-${process.pid}`;
const browser = (...args: string[]) => execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8", timeout: 90_000 }).trim();
const request = async (path: string, method = "GET", body?: RecipeDraft | MealDraft) => {
  // Fixture resets intentionally use current tokens; browser deletion remains under test.
  let payload = body ? JSON.stringify(body) : undefined;
  const resource = path.split("/")[0];
  if ((method === "PUT" || method === "DELETE") && (resource === "recipes" || resource === "meals")) {
    const current = await household();
    const id = method === "DELETE" ? decodeURIComponent(path.slice(resource.length + 1)) : body?.id;
    const saved = current[resource].find(item => item.id === id);
    if (method === "DELETE" && !saved) return new Response(null, { status: 200 });
    payload = JSON.stringify({ ...body, expectedRevision: saved?.revision ?? null });
  }
  const response = await fetch(`${url}/api/${path}`, { method, headers: { "Content-Type": "application/json", Connection: "close" }, body: payload });
  assert(response.ok, `${method} ${path}: ${response.status}`);
  return response;
};
const household = async () => {
  const value: unknown = await (await request("household")).json();
  assert.ok(Schema.is(HouseholdSchema)(value), "Household response must match its contract.");
  return value;
};
const original = await household();
assert(!original.recipes.length && !original.meals.length, "Use an empty disposable local household.");
const results: { resource: string; id: string; requested: string[]; remaining: string[]; passed: boolean }[] = [];
const recipe = (id: string, title: string): RecipeDraft => ({ id, title, ingredients: [{ name: "Water", quantity: 1, unit: "cup", groceryItemId: null }], description: "Disposable deletion regression", servings: 2, minutes: 20, category: "", photo: "", source: "", rating: "neutral", instructions: ["Serve."] });
const deleteRecipe = () => {
  browser("find", "role", "button", "click", "--name", "Edit recipe", "--exact");
  browser("find", "role", "button", "click", "--name", "Delete recipe", "--exact");
  browser("find", "role", "button", "click", "--name", "Yes, delete recipe", "--exact");
};
const cleanup = async () => {
  const current = await household();
  for (const resource of ["meals", "recipes"] as const) {
    for (const item of current[resource].filter(item => item.id.startsWith("delete-related-base"))) await request(`${resource}/${encodeURIComponent(item.id)}`, "DELETE");
  }
};

try {
  await mkdir(".amp/in/artifacts", { recursive: true });
  browser("open", `${url}/#recipes`);
  browser("set", "viewport", "1280", "900", "2");
  const date = Schema.decodeUnknownSync(DateSchema)(JSON.parse(browser("eval", "(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })()")));
  for (const resource of ["recipes", "meals"] as const) {
    for (const suffix of ["?variant", "#variant", "/%20 space 食", "-ordinary"]) {
      const base = "delete-related-base";
      const id = base + suffix;
      if (resource === "recipes") {
        await request(resource, "PUT", recipe(base, "Deletion base control"));
        await request(resource, "PUT", recipe(id, "Deletion variant target"));
      } else {
        for (const [mealId, note] of [[base, "Deletion base control"], [id, "Deletion variant target"]]) {
          await request(resource, "PUT", { id: mealId, recipeId: null, date, slot: "Dinner", scale: 1, note });
        }
      }
      browser("open", `${url}/#${resource === "recipes" ? "recipes" : "plan"}`);
      browser("reload");
      browser("wait", "--text", "Deletion variant target");
      // Observe requests without replacing fetch or mocking any boundary.
      browser("network", "requests", "--clear");
      browser("find", "role", "button", "click", "--name", "Deletion variant target");
      if (resource === "recipes") {
        deleteRecipe();
      } else {
        browser("find", "role", "button", "click", "--name", "Remove meal", "--exact");
      }
      browser("wait", "--fn", "!document.querySelector('dialog[open]') || !!document.querySelector('[role=alert]')");
      const requested = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Struct({ requests: Schema.Array(Schema.Struct({ url: Schema.String })) }) }))(JSON.parse(browser("network", "requests", "--method", "DELETE", "--json"))).data.requests.map(request => request.url);
      const remaining = (await household())[resource].map(item => item.id);
      const passed = remaining.length === 1 && remaining[0] === base && requested.length === 1 && requested[0] === `${url}/api/${resource}/${encodeURIComponent(id)}`;
      results.push({ resource, id, requested, remaining, passed });
      console.log(`${passed ? "PASS" : "FAIL"} ${resource} ${JSON.stringify(id)}: ${JSON.stringify({ requested, remaining })}`);
      if (passed) assert.equal(JSON.parse(browser("eval", "!document.querySelector('dialog[open]') && !document.querySelector('[role=alert]') && document.body.textContent.includes('Deletion base control') && !document.body.textContent.includes('Deletion variant target')")), true, "Deletion closes the dialog and refreshes the selected card, preserving its control.");
      browser("reload");
      browser("wait", "--text", passed ? "Deletion base control" : "Deletion variant target");
      if (suffix === "?variant") browser("screenshot", "--full", resolve(`.amp/in/artifacts/deletion-${resource}-${label}.png`));
      await cleanup();
    }
  }
  assert(results.length === 8 && results.every(result => result.passed), "Deletion must remove only the selected ID, preserving its base control.");

  // Deleting a source preserves its independently editable meal, including its share URL.
  const base = "delete-related-base";
  const id = `${base}?variant`;
  await request("recipes", "PUT", recipe(base, "Deletion base control"));
  await request("recipes", "PUT", { ...recipe(id, "Deletion variant target"), photo: "/photos/chicken.jpg" });
  await request("meals", "PUT", { id: base, recipeId: null, date, slot: "Dinner", scale: 1, note: "Deletion base meal" });
  await request("meals", "PUT", { id, recipeId: id, date, slot: "Dinner", scale: 1.5, note: "Add cauliflower" });
  const before = await household();
  const planned = before.meals.find(item => item.id === id);
  assert(planned?.recipe);
  const detailUrl = `${url}/#plan?view=recipe&id=${encodeURIComponent(id)}&meal=${encodeURIComponent(id)}`;
  browser("open", `${url}/#recipes`);
  browser("reload");
  browser("wait", "--text", "Deletion variant target");
  browser("find", "role", "button", "click", "--name", "Deletion variant target");
  deleteRecipe();
  browser("wait", "--fn", "!document.querySelector('dialog[open]')");
  const detached = (await household()).meals.find(item => item.id === id);
  assert(detached?.revision);
  assert.notEqual(detached.revision, planned.revision);
  assert.deepEqual(detached, { ...planned, recipeId: null, revision: detached.revision });
  assert.deepEqual((await household()).recipes.map(item => item.id), [base]);
  console.log("PASS source deleted; special-ID meal snapshot, photo, scale and note preserved");
  browser("open", detailUrl);
  browser("reload");
  browser("wait", "--text", "Meal details");
  assert.equal(JSON.parse(browser("eval", "Array.from(document.querySelectorAll('dialog button')).some(button => button.textContent.includes('View recipe'))")), false, "Deleted source has no View recipe link");
  browser("wait", "--fn", "document.querySelector('dialog img')?.naturalWidth > 0");
  browser("screenshot", resolve(`.amp/in/artifacts/deletion-detached-meal-${label}.png`));
  browser("find", "role", "button", "click", "--name", "Edit meal", "--exact");
  browser("find", "label", "Meal name", "fill", "Dinner after source deletion");
  browser("find", "label", "Meal note", "fill", "Roast cauliflower");
  browser("find", "role", "button", "click", "--name", "Save meal", "--exact");
  browser("wait", "--fn", "!document.querySelector('dialog[open]')");
  browser("open", detailUrl);
  browser("reload");
  browser("wait", "--text", "Meal details");
  assert.match(browser("get", "text", "dialog"), /Dinner after source deletion/);
  assert.match(browser("get", "text", "dialog"), /Roast cauliflower/);
  const edited = (await household()).meals.find(item => item.id === id);
  assert.deepEqual(edited, { ...detached, revision: edited?.revision, note: "Roast cauliflower", recipe: { ...planned.recipe, title: "Dinner after source deletion" } });
  browser("open", `${url}/#recipe-checklist?selectedMeal=${encodeURIComponent(id)}&checklist=1`);
  browser("reload");
  browser("wait", "--text", "1 of 1 items left");
  assert.match(browser("get", "text", '[aria-label="Ingredients needed"]'), /1\.5 cup/);
  assert.match(browser("get", "text", '[aria-label="Ingredients needed"]'), /Dinner after source deletion/);
  console.log("PASS detached meal deep link, editing, reload and scaled ingredient checklist");
  browser("open", `${url}/#plan?view=meal&id=${encodeURIComponent(id)}`);
  browser("reload");
  browser("wait", ".meal-form");
  assert.equal(browser("get", "value", ".meal-form-fields > label:first-child select"), "recipe");
  browser("click", ".selected-recipe");
  browser("wait", "--text", "Back to meal");
  browser("back");
  browser("wait", ".meal-form");
  browser("forward");
  browser("wait", "--text", "Back to meal");
  browser("find", "role", "button", "click", "--name", "Back to meal", "--exact");
  browser("wait", ".meal-form");
  browser("find", "role", "button", "click", "--name", "Save", "--exact");
  browser("wait", "--fn", "!document.querySelector('dialog[open]')");
  assert.deepEqual((await household()).meals.find(item => item.id === id)?.recipe, edited?.recipe);
  browser("open", detailUrl);
  browser("reload");
  browser("wait", "--text", "Meal details");
  browser("find", "role", "button", "click", "--name", "Edit meal", "--exact");
  browser("find", "role", "button", "click", "--name", "Remove meal", "--exact");
  browser("wait", "--fn", "!document.querySelector('dialog[open]')");
  assert.deepEqual((await household()).meals.map(item => item.id), [base]);
  assert.deepEqual((await household()).recipes.map(item => item.id), [base]);
  console.log("PASS detached meal removed independently; base meal and recipe preserved");
} finally {
  try {
    browser("close");
  } finally {
    await cleanup();
    assert.deepEqual(await household(), original, "Fixture cleanup must restore the disposable household.");
    await writeFile(`.amp/in/artifacts/deletion-${label}.json`, JSON.stringify(results, null, 2));
  }
}
console.log("Deletion browser smoke passed; eight exact-ID cases and planned/linked recipe flow; household restored.");
