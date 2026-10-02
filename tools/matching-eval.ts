import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { HouseholdSchema, MatchReportSchema, type GroceryItem, type Recipe } from "../src/domain.ts";
import { GrocerySearch, matchIngredients, normalizeIngredient, normalizationModel } from "../src/ingredient-matching.ts";
import { Cloudflare, previewFetch, previewName } from "./preview.ts";

const product = (id: string, name: string, aliases: string[] = []): GroceryItem => ({ id: `matching-eval-${id}`, name, aliases, quantity: 1, unit: "each", aisle: "Produce", url: "" });
const groceries = [
  product("white-onion", "White onion"),
  ...Array.from({ length: 60 }, (_, i) => product(`yellow-onion-${i}`, `Brand ${i} yellow onion bag`)),
  product("red-onion", "Red onion"), product("onion-powder", "Onion powder"),
  product("coconut", "Unsweetened canned coconut milk"), product("milk", "Whole dairy milk"),
  product("coconut-water", "Coconut water"), product("butter", "Unsalted butter"), product("salted", "Salted butter"),
  product("green-onion", "Green onions", ["scallion"]), product("fresh-tomato", "Fresh tomato"),
  product("canned-tomato", "Canned crushed tomatoes"), product("olive-oil", "Extra virgin olive oil"),
];
const cases = [
  { name: "Chopped White Onions", originalText: "2 white onions, finely chopped", expected: "white-onion", core: /^white onion$/i },
  { name: "Finely diced white onoin", expected: "white-onion", core: /^white onion$/i },
  { name: "Unsweetened coconut milk, stirred", expected: "coconut", core: /^unsweetened coconut milk$/i },
  { name: "Softened unsalted butter", expected: "butter", core: /^unsalted butter$/i },
  { name: "Sliced scallions for garnish", expected: "green-onion", core: /^(?:scallion|green onion)$/i },
  { name: "Crushed canned tomatoes, with juices", expected: "canned-tomato", core: /^(?:crushed canned|canned crushed) tomato$/i },
  { name: "Tomatoes, chopped", originalText: "2 tomatoes, chopped", expected: "fresh-tomato", core: /^tomato$/i },
  { name: "Toasted sesame oil for finishing", expected: undefined, core: /^toasted sesame oil$/i },
  { name: "Dragon fruit, peeled", expected: undefined, core: /^dragon fruit$/i },
];
const recipes: Recipe[] = cases.map((item, i) => ({
  id: `matching-eval-recipe-${i}`, title: `Matching evaluation ${i + 1}`, description: "Disposable evaluation recipe.",
  servings: 2, minutes: 20, category: "", photo: "", source: "", rating: "neutral",
  ingredients: [{ name: item.name, originalText: item.originalText ?? item.name, quantity: 2, unit: "each" }],
  instructions: [i === 6 ? "Use raw fresh tomatoes in this uncooked salad. Do not use canned tomatoes." : i === 7 ? "Finish with toasted sesame oil for its sesame aroma; olive oil is not a substitute." : `Prepare ${item.name} as described and cook the recipe.`],
}));
// Explicit links and opt-outs must survive the AI pass.
recipes[0] = { ...recipes[0], ingredients: [...recipes[0].ingredients,
  { name: "Chopped White Onions", quantity: 1, unit: "each", groceryItemId: null },
  { name: "Chopped White Onions", quantity: 1, unit: "each", groceryItemId: groceries[1].id },
] };

function validate(actual: readonly Recipe[]) {
  const results = cases.map((item, index) => {
    const ingredient = actual.find((recipe) => recipe.id === recipes[index].id)?.ingredients[0];
    const expected = item.expected ? `matching-eval-${item.expected}` : undefined;
    return { ingredient: item.name, expected: expected ?? null, actual: ingredient?.groceryItemId ?? null, correct: !!ingredient && ingredient.groceryItemId === expected };
  });
  const first = actual.find((recipe) => recipe.id === recipes[0].id)!;
  assert.equal(first.ingredients[1].groceryItemId, null);
  assert.equal(first.ingredients[2].groceryItemId, groceries[1].id);
  for (const [index, recipe] of recipes.entries()) {
    const saved = actual.find((r) => r.id === recipe.id)!;
    assert.equal(saved.ingredients[0].originalText, recipe.ingredients[0].originalText);
    assert.equal(saved.ingredients[0].quantity, 2);
    assert.equal(saved.ingredients[0].unit, "each");
    assert.deepEqual(saved.instructions, recipe.instructions);
  }
  return results;
}

const [mode = "models", output, normalizer = normalizationModel] = process.argv.slice(2);
assert(["normalization", "models", "history", "preview", "preview-ui"].includes(mode), "Use normalization, models, history, preview, or preview-ui [report.json] [normalizer-model].");
const trace: { model: string; ingredient: string; ms: number; response: object }[] = [];
let reports: object[] = [];
let results: ReturnType<typeof validate> = [];
let normalizationCorrect = 0;

if (mode === "models" || mode === "normalization" || mode === "history") {
  assert(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN, "Cloudflare credentials are required for real-model evaluation.");
  const api = new Cloudflare(process.env.CLOUDFLARE_ACCOUNT_ID ?? "", process.env.CLOUDFLARE_API_TOKEN ?? "");
  // The adapter calls real Cloudflare model inference, not a mock; only run() is consumed.
  const contextualInputs: Record<string, unknown>[] = [];
  const ai = { run: async (model: string, input: Record<string, unknown>) => {
    if ((input.state as { linkedRecipeExamples?: unknown } | undefined)?.linkedRecipeExamples) contextualInputs.push(input);
    const actualModel = model === normalizationModel ? normalizer : model;
    const messages = input.messages as { content: string }[] | undefined;
    const ingredient = messages ? JSON.parse(messages[1].content).ingredient : (input.state as { ingredient: { name: string } }).ingredient.name;
    const started = performance.now();
    const response = await api.request<Record<string, unknown>>(model === "typesafe/jev" ? "/ai/run" : `/ai/run/${actualModel}`, "POST", model === "typesafe/jev" ? { model, input } : input).catch((error) => {
      console.error(error.message);
      throw error;
    });
    trace.push({ model: actualModel, ingredient, ms: performance.now() - started, response });
    return response;
  } } as Pick<Ai, "run">;
  if (mode === "normalization") {
    for (const item of cases) await normalizeIngredient(ai, item.name);
  } else if (mode === "history") {
    const catalog = [product("fresh-parm", "BelGioioso Vegetarian Parmesan Cheese, 8 oz"), product("kraft-parm", "Kraft Finely Shredded Parmesan Natural Cheese, 6 oz")];
    const targets = ["Adult pasta dinner", "Baby broccoli cheese bites"].map((title, index): Recipe => ({
      ...recipes[0], id: `context-target-${index}`, title, description: index ? "A baby recipe." : "A weekday dinner for adults.",
      ingredients: [{ name: "Parmesan, for serving", quantity: 1, unit: "tbsp" }], instructions: ["Sprinkle Parmesan over the cooked dish."],
    }));
    const history = catalog.flatMap((item, group) => Array.from({ length: 12 }, (_, index): Recipe => ({
      ...targets[group], id: `history-${group}-${index}`, title: `${group ? "Baby vegetable bites" : "Adult pasta dinner"} ${index}`,
      ingredients: [{ name: "Parmesan", quantity: 2, unit: "tbsp", groceryItemId: item.id }],
    })));
    const baseline = await matchIngredients(ai, targets, catalog);
    const contextual = await matchIngredients(ai, [...targets, ...history], catalog);
    assert.equal(baseline.report.failed + contextual.report.failed, 0);
    assert(contextualInputs.length > 0, "Live Jev must exercise the ambiguous shortlist/history pass.");
    for (const input of contextualInputs) {
      const state = input.state as { linkedRecipeExamples: Record<string, { recipeTitle: string; ingredientName: string }[]> };
      assert(Object.values(state.linkedRecipeExamples).every((examples) => examples.length === 10));
      assert(Object.values(state.linkedRecipeExamples).flat().every((example) => example.ingredientName === "Parmesan"));
    }
    results = targets.map((target, index) => {
      const ingredient = contextual.recipes.find((recipe) => recipe.id === target.id)!.ingredients[0];
      const expected = catalog[index].id;
      // Unresolved choices are surfaced for review, never silently linked to the wrong preference.
      return { ingredient: target.title, expected, actual: ingredient.groceryItemId ?? null,
        correct: ingredient.groceryItemId === expected || (!ingredient.groceryItemId && !!ingredient.grocerySuggestions?.includes(expected)) };
    });
    reports = [{ baseline: baseline.report, contextual: contextual.report, contextualInputs,
      outcomes: contextual.recipes.slice(0, targets.length).map((recipe) => ({ title: recipe.title, ingredient: recipe.ingredients[0] })) }];
    console.log("PASS live Jev: shortlist, bounded reverse-lookup examples, and preference-aware results or explicit review.");
  } else {
    const result = await matchIngredients(ai, recipes, groceries);
    reports = [result.report];
    results = validate(result.recipes);
  }
  const normalized = trace.filter((item) => item.model === normalizer);
  for (const item of normalized) {
    const response = item.response as { response?: string | { core: string }; core?: string };
    const core = response.core ?? (typeof response.response === "string" ? JSON.parse(response.response).core : response.response?.core ?? "");
    if (cases.find((entry) => entry.name === item.ingredient)?.core.test(core)) normalizationCorrect++;
  }
} else {
  const name = previewName(process.env.AMP_THREAD_ID ?? "");
  const send = async (path: string, method = "GET", body?: object) => {
    const response = await previewFetch(name, path, method, body ? JSON.stringify(body) : undefined);
    assert(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
    return response;
  };
  const state = async () => Schema.decodeUnknownSync(HouseholdSchema)(await (await send("/api/household")).json());
  const initial = await state();
  assert(!initial.recipes.length && !initial.groceries.length, "Use an empty owning thread Preview, never a household with existing data.");
  const session = "matching-eval";
  const browser = (...args: string[]) => {
    const result = spawnSync("agent-browser", ["--session", session, ...args], { encoding: "utf8", timeout: 90_000 });
    // Do not propagate child-process errors containing credential-bearing arguments.
    if (result.status !== 0) throw new Error(`Browser ${args[0]} failed; inspect the session without printing credentials.`);
    return result.stdout.trim();
  };
  const started = performance.now();
  try {
    for (const item of groceries) await send("/api/groceries", "PUT", item);
    for (const recipe of recipes) await send("/api/recipes", "PUT", recipe);
    for (let run = 0; run < 2; run++) {
      if (run) for (const recipe of recipes) await send("/api/recipes", "PUT", recipe);
      let payload: object;
      if (mode === "preview-ui" && !run) {
        const directory = resolve(".wrangler/hearth-previews", name);
        const { url } = JSON.parse(await readFile(resolve(directory, "preview.json"), "utf8"));
        const token = JSON.parse(await readFile(resolve(directory, "credentials.json"), "utf8"));
        browser("open", `${url}/#groceries`, "--headers", JSON.stringify({ "CF-Access-Client-Id": token.client_id, "CF-Access-Client-Secret": token.client_secret }));
        browser("set", "viewport", "1280", "900", "2");
        browser("wait", ".grocery-manager");
        browser("fill", '.grocery-search input', "White");
        browser("eval", `(() => { const original = window.fetch; window.__matchingReport = null; window.fetch = async (...args) => { const response = await original(...args); if (args[0] === '/api/groceries/match') window.__matchingReport = await response.clone().json(); return response; }; })()`);
        browser("find", "role", "button", "click", "--name", "Match ingredients", "--exact");
        assert.equal(browser("eval", "[...document.querySelectorAll('button')].some(b => b.textContent.includes('Matching…') && b.disabled)"), "true");
        await mkdir(resolve(".amp/in/artifacts"), { recursive: true });
        browser("screenshot", resolve(".amp/in/artifacts/matching-loading.png"));
        browser("wait", "--fn", "!!window.__matchingReport && [...document.querySelectorAll('.grocery-manager > p')].some(p => p.textContent.includes('Matching completed'))");
        payload = JSON.parse(browser("eval", "JSON.stringify(window.__matchingReport)"));
        if (typeof payload === "string") payload = JSON.parse(payload);
        assert.equal(browser("eval", "document.querySelector('.grocery-coverage').textContent.includes('8 / 11 ingredients linked')"), "true");
        browser("screenshot", resolve(".amp/in/artifacts/matching-completed.png"));
        browser("set", "viewport", "390", "844", "2");
        browser("eval", "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
        assert.equal(browser("eval", "document.documentElement.scrollWidth <= innerWidth + 1"), "true");
        browser("screenshot", resolve(".amp/in/artifacts/matching-narrow.png"));
        console.log("PASS browser: real button, disabled loading state, saved links/coverage refresh, and narrow layout without horizontal overflow.");
      } else {
        payload = await (await send("/api/groceries/match", "POST", {})).json();
      }
      const result = Schema.decodeUnknownSync(Schema.Struct({ report: MatchReportSchema }))(payload);
      reports.push(result.report);
      results = validate((await state()).recipes);
      if (!results.every((item) => item.correct)) break;
    }
    reports.push({ endToEndMs: performance.now() - started, includes: "Access, fixture writes, two matching passes, and persisted readback" });
  } finally {
    const failures: unknown[] = [];
    if (mode === "preview-ui") {
      try { browser("close"); } catch (error) { failures.push(error); }
    }
    // Recipes must be removed before their linked products; attempt every cleanup even on failure.
    for (const recipe of recipes) {
      try { await send(`/api/recipes/${recipe.id}`, "DELETE", {}); } catch (error) { failures.push(error); }
    }
    for (const item of groceries) {
      try { await send(`/api/groceries/${item.id}`, "DELETE", {}); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Matching evaluation cleanup failed.");
  }
}

const broadCandidates = new GrocerySearch(groceries).candidates(cases[0].name, "White Onion").length;
assert(broadCandidates > 50, "Candidate retrieval must not truncate the broad onion set.");
const report = { mode, cases: mode === "history" ? results.length : cases.length, correct: results.filter((item) => item.correct).length,
  normalizer, normalizationCorrect: ["models", "normalization"].includes(mode) ? normalizationCorrect : undefined, broadCandidates,
  results, reports, trace };
console.log(JSON.stringify({ ...report, trace: trace.map((item) => ({ model: item.model, ingredient: item.ingredient, ms: item.ms })) }, null, 2));
if (output) {
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
}
assert(results.every((item) => item.correct), "Matching evaluation failed; inspect per-case results.");
if (mode === "normalization") assert.equal(normalizationCorrect, cases.length, "Core normalization did not produce the expected singular ingredient phrase.");
