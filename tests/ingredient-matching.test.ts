import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { rolldown } from "rolldown";
import { readFile, readdir } from "node:fs/promises";
import { Schema } from "effect";
import { HouseholdSchema, MatchReportSchema, type GroceryItem, type Recipe } from "../src/domain";

let worker: Miniflare;
let mode = "success";
let calls = 0;
let activeCalls = 0;
let peakCalls = 0;
let beforeSelect: (() => Promise<void>) | undefined;
const seen = new Set<string>();
const recipe: Recipe = {
  id: "matching",
  title: "Onion salad",
  description: "A raw salad.",
  servings: 3,
  minutes: 20,
  category: "",
  photo: "",
  source: "",
  rating: "neutral",
  ingredients: [
    {
      name: "Chopped white oninos",
      originalText: "2 white onions, finely chopped",
      quantity: 2,
      unit: "each",
    },
    { name: "Chopped white oninos", quantity: 1, unit: "each", groceryItemId: null },
    { name: "Chopped white oninos", quantity: 1, unit: "each", groceryItemId: "yellow-0" },
  ],
  instructions: ["Use raw white onions in this salad, finely chopping them at home."],
};
const product = (id: string, name: string): GroceryItem => ({
  id,
  name,
  aliases: [],
  quantity: 3,
  unit: "each",
  aisle: "2",
  url: "",
});
const catalog = [
  ...Array.from({ length: 60 }, (_, i) => product(`yellow-${i}`, `Brand ${i} yellow onion`)),
  product("white", "White onion"),
  product("powder", "Onion powder"),
];
const send = (path: string, method = "GET", body?: GroceryItem | Recipe) =>
  worker.dispatchFetch(`http://localhost/api/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
const state = async () => Schema.decodeUnknownSync(HouseholdSchema)(await (await send("household")).json());
const match = async () => {
  const response = await send("groceries/match", "POST");
  expect(response.status, await response.clone().text()).toBe(200);
  return Schema.decodeUnknownSync(Schema.Struct({ report: MatchReportSchema }))(await response.json()).report;
};

beforeAll(async () => {
  const bundle = await rolldown({ input: "tests/fixtures/matching-worker.ts", platform: "browser" });
  const result = await bundle.generate({ format: "esm" });
  await bundle.close();
  const entry = result.output.find((output) => output.type === "chunk" && output.isEntry);
  if (!entry || entry.type !== "chunk") throw new Error("Integration Worker bundle missing.");
  worker = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "matching",
          modules: true,
          script: entry.code,
          compatibilityDate: "2026-09-08",
          d1Databases: ["DB"],
          bindings: { LOCAL_DEV: "true" },
          outboundService: async (request) => {
            calls++;
            if (mode === "concurrency") {
              peakCalls = Math.max(peakCalls, ++activeCalls);
              await new Promise((resolve) => setTimeout(resolve, 20));
              activeCalls--;
            }
            if (mode === "outage") return new Response("Unavailable", { status: 503 });
            if (request.url.endsWith("llama-3.2-3b-instruct"))
              return Response.json({
                response: mode === "bad-normalization" ? { core: "" } : { core: "White Onion" },
              });
            const input = Schema.decodeUnknownSync(
              Schema.Struct({
                state: Schema.Struct({
                  ingredient: Schema.Struct({ originalText: Schema.String }),
                  recipe: Schema.Struct({ instructions: Schema.Array(Schema.String) }),
                }),
                questions: Schema.Struct({
                  product: Schema.Struct({ criteria: Schema.Record(Schema.String, Schema.String) }),
                }),
              }),
            )(await request.json());
            expect(input.state.ingredient.originalText).toBe(recipe.ingredients[0].originalText);
            expect(input.state.recipe.instructions).toEqual(recipe.instructions);
            for (const value of Object.values(input.questions.product.criteria)) seen.add(value);
            await beforeSelect?.();
            beforeSelect = undefined;
            if (mode === "bad-selection")
              return Response.json({ state: "Completed", result: { answers: {} } });
            const choice =
              mode === "unknown-id"
                ? "p9999"
                : mode === "none"
                  ? "none"
                  : (Object.entries(input.questions.product.criteria).find(([, value]) =>
                      value.startsWith("White onion;"),
                    )?.[0] ?? "none");
            return Response.json({
              state: "Completed",
              result: {
                answers: {
                  product: { type: "choice", choice, confidence: mode === "uncertain" ? 0.69 : 0.99 },
                },
              },
            });
          },
        },
      ],
    }),
  );
  const db = await worker.getD1Database("DB");
  for (const file of (await readdir("migrations")).filter((file) => file.endsWith(".sql")).sort()) {
    const sql = await readFile(`migrations/${file}`, "utf8");
    await db.batch(
      sql.split(/;\n(?=CREATE|INSERT)|;\s*$/).flatMap((value) => (value.trim() ? [db.prepare(value)] : [])),
    );
  }
}, 30_000);

beforeEach(async () => {
  mode = "success";
  calls = 0;
  activeCalls = 0;
  peakCalls = 0;
  beforeSelect = undefined;
  seen.clear();
  const db = await worker.getD1Database("DB");
  await db.batch([
    db.prepare("DELETE FROM recipes"),
    db.prepare("DELETE FROM groceries"),
    db.prepare("DELETE FROM ingredient_match_cache"),
  ]);
  for (const item of catalog) expect((await send("groceries", "PUT", item)).status).toBe(200);
  expect((await send("recipes", "PUT", recipe)).status).toBe(200);
});

afterAll(async () => {
  await worker?.dispose();
});

it("persists a non-first selection from 60+ candidates with original context, while preserving explicit decisions and amounts", async () => {
  const report = await match();
  expect(report).toMatchObject({
    attempted: 1,
    matched: 1,
    failed: 0,
    conflicts: 0,
    normalizationCalls: 1,
    selectionCalls: 1,
  });
  expect(report.candidates).toBeGreaterThan(60);
  const actual = (await state()).recipes[0];
  expect(actual.ingredients).toEqual([
    { ...recipe.ingredients[0], groceryItemId: "white" },
    ...recipe.ingredients.slice(1),
  ]);
  expect(actual.instructions).toEqual(recipe.instructions);
});

it("deduplicates identical in-flight model work across recipes", async () => {
  for (const id of ["duplicate-1", "duplicate-2"])
    expect((await send("recipes", "PUT", { ...recipe, id })).status).toBe(200);
  expect(await match()).toMatchObject({
    attempted: 3,
    matched: 3,
    normalizationCalls: 1,
    selectionCalls: 1,
    normalizationCacheHits: 2,
    selectionCacheHits: 2,
  });
  expect(calls).toBe(2);
  for (const actual of (await state()).recipes)
    expect(actual.ingredients).toEqual([
      { ...recipe.ingredients[0], groceryItemId: "white" },
      ...recipe.ingredients.slice(1),
    ]);
});

it("runs independent ingredients concurrently without exceeding three upstream requests", async () => {
  mode = "concurrency";
  const db = await worker.getD1Database("DB");
  await db.prepare("DELETE FROM recipes").run();
  for (let index = 0; index < 6; index++)
    expect(
      (
        await send("recipes", "PUT", {
          ...recipe,
          id: `parallel-${index}`,
          ingredients: [{ ...recipe.ingredients[0], name: `${recipe.ingredients[0].name} ${index}` }],
        })
      ).status,
    ).toBe(200);
  expect(await match()).toMatchObject({ attempted: 6, matched: 6, normalizationCalls: 6, selectionCalls: 6 });
  expect(peakCalls).toBeGreaterThan(1);
  expect(peakCalls).toBeLessThanOrEqual(3);
  for (const actual of (await state()).recipes) expect(actual.ingredients[0].groceryItemId).toBe("white");
});

it("reuses both persistent caches, but invalidates selection when recipe context or catalog changes", async () => {
  await match();
  expect((await send("recipes", "PUT", recipe)).status).toBe(200);
  expect(await match()).toMatchObject({
    matched: 1,
    normalizationCalls: 0,
    selectionCalls: 0,
    normalizationCacheHits: 1,
    selectionCacheHits: 1,
  });
  expect((await send("recipes", "PUT", { ...recipe, title: "A different salad" })).status).toBe(200);
  expect(await match()).toMatchObject({ normalizationCalls: 0, selectionCalls: 1 });
  expect((await send("groceries", "PUT", { ...catalog[60], aliases: ["white onions"] })).status).toBe(200);
  expect((await send("recipes", "PUT", recipe)).status).toBe(200);
  expect(await match()).toMatchObject({ normalizationCalls: 0, selectionCalls: 1 });
  const db = await worker.getD1Database("DB");
  await db.prepare("UPDATE ingredient_match_cache SET created_at=unixepoch()-604801").run();
  expect((await send("recipes", "PUT", recipe)).status).toBe(200);
  expect(await match()).toMatchObject({ normalizationCalls: 1, selectionCalls: 1 });
});

it("leaves uncertain, absent, malformed and unavailable model results unlinked without caching failures", async () => {
  const db = await worker.getD1Database("DB");
  for (const failure of ["uncertain", "none", "bad-normalization", "bad-selection", "unknown-id", "outage"]) {
    await db.prepare("DELETE FROM ingredient_match_cache").run();
    mode = failure;
    const report = await match();
    expect(report.matched).toBe(0);
    expect(report.failed).toBe(["uncertain", "none"].includes(failure) ? 0 : 1);
    expect((await state()).recipes[0].ingredients).toEqual(recipe.ingredients);
  }
  mode = "success";
  expect(await match()).toMatchObject({ matched: 1, normalizationCalls: 1, selectionCalls: 1 });
});

it("skips stale selections when another writer changes recipe instructions", async () => {
  const db = await worker.getD1Database("DB");
  beforeSelect = async () => {
    await db
      .prepare("UPDATE recipes SET instructions=? WHERE id=?")
      .bind(JSON.stringify(["Use different ingredients."]), recipe.id)
      .run();
  };
  expect(await match()).toMatchObject({ matched: 0, conflicts: 1 });
  const actual = (await state()).recipes[0];
  expect(actual.ingredients).toEqual(recipe.ingredients);
  expect(actual.instructions).toEqual(["Use different ingredients."]);
});

it("skips stale selections when another writer deletes or edits a product", async () => {
  const db = await worker.getD1Database("DB");
  beforeSelect = async () => {
    await db.prepare("DELETE FROM groceries WHERE id='white'").run();
  };
  expect(await match()).toMatchObject({ matched: 0, conflicts: 1 });
  expect((await state()).recipes[0].ingredients).toEqual(recipe.ingredients);
  expect((await send("groceries", "PUT", catalog[60])).status).toBe(200);
  await db.prepare("DELETE FROM ingredient_match_cache").run();
  beforeSelect = async () => {
    await db.prepare("UPDATE groceries SET name='Red onion' WHERE id='white'").run();
  };
  expect(await match()).toMatchObject({ matched: 0, conflicts: 1 });
});

it("batches oversized candidate sets and compares finalists without truncating candidates", async () => {
  for (const item of catalog) {
    const aliases = Array.from({ length: 8 }, (_, i) => `${i} ${"onion ".repeat(20)}`.trim());
    expect((await send("groceries", "PUT", { ...item, aliases })).status).toBe(200);
  }
  expect(await match()).toMatchObject({ matched: 1, failed: 0 });
  expect(calls).toBeGreaterThan(2);
  for (const item of catalog) expect([...seen].some((value) => value.startsWith(`${item.name};`))).toBe(true);
});

it("fails oversized recipe context safely instead of truncating instructions or recursing indefinitely", async () => {
  const instructions = Array.from({ length: 4 }, () => "Follow this instruction. ".repeat(400));
  expect((await send("recipes", "PUT", { ...recipe, instructions })).status).toBe(200);
  expect(await match()).toMatchObject({
    attempted: 1,
    matched: 0,
    failed: 1,
    normalizationCalls: 1,
    selectionCalls: 0,
  });
  const actual = (await state()).recipes[0];
  expect(actual.ingredients).toEqual(recipe.ingredients);
  expect(actual.instructions).toEqual(instructions);
});
