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

  // Calendar actions remove the planned meal without deleting its recipe.
  const base = "delete-related-base";
  const id = `${base}?variant`;
  await request("recipes", "PUT", recipe(base, "Deletion base control"));
  await request("recipes", "PUT", recipe(id, "Deletion variant target"));
  await request("meals", "PUT", { id: base, recipeId: null, date, slot: "Dinner", scale: 1, note: "Deletion base meal" });
  await request("meals", "PUT", { id, recipeId: id, date, slot: "Dinner", scale: 1, note: "" });
  browser("open", `${url}/#recipes`);
  browser("reload");
  browser("wait", "--text", "Deletion variant target");
  browser("find", "role", "button", "click", "--name", "Deletion variant target");
  deleteRecipe();
  browser("wait", "[role=alert]");
  assert.deepEqual((await household()).recipes.map(item => item.id).sort(), [base, id]);
  assert.match(browser("get", "text", "[role=alert]"), /meal plan/);
  console.log("PASS planned special-ID recipe is rejected without deleting the base control");
  browser("open", `${url}/#plan`);
  browser("reload");
  browser("wait", "--text", "Deletion variant target");
  browser("find", "role", "button", "click", "--name", "Actions for meal Deletion variant target", "--exact");
  browser("find", "role", "button", "click", "--name", "Edit meal", "--exact");
  browser("find", "role", "button", "click", "--name", "Remove meal", "--exact");
  browser("wait", "--fn", "!document.querySelector('dialog[open]')");
  assert.deepEqual((await household()).meals.map(item => item.id), [base]);
  assert.deepEqual((await household()).recipes.map(item => item.id).sort(), [base, id]);
  console.log("PASS linked special-ID meal removed; base meal and both recipes preserved");
  browser("open", `${url}/#recipes`);
  browser("reload");
  browser("wait", "--text", "Deletion variant target");
  browser("find", "role", "button", "click", "--name", "Deletion variant target");
  deleteRecipe();
  browser("wait", "--fn", "!document.querySelector('dialog[open]')");
  assert.deepEqual((await household()).recipes.map(item => item.id), [base]);
  console.log("PASS formerly planned recipe can be deleted after its meal is removed");
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
