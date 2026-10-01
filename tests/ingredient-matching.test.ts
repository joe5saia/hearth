import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions, type V4WorkerdStructuredLog } from "miniflare";
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

const logs: V4WorkerdStructuredLog[] = [];

const logEvents = () =>
  logs.flatMap(({ message }) =>
    message.startsWith('{"event":"ingredient_matching_')
      ? [
          Schema.decodeUnknownSync(
            Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Null])),
          )(JSON.parse(message)),
        ]
      : [],
  );

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
  const previous = logEvents().filter((event) => event.event === "ingredient_matching_completed").length;
  const response = await send("groceries/match", "POST");
  expect(response.status, await response.clone().text()).toBe(200);

  const report = Schema.decodeUnknownSync(Schema.Struct({ report: MatchReportSchema }))(
    await response.json(),
  ).report;

  await expect
    .poll(() => logEvents().filter((event) => event.event === "ingredient_matching_completed").length)
    .toBe(previous + 1);
  expect(logEvents().at(-1)).toMatchObject(report);

  return report;
};

beforeAll(async () => {
  const bundle = await rolldown({ input: "tests/fixtures/matching-worker.ts", platform: "browser" });
  const result = await bundle.generate({ format: "esm" });
  await bundle.close();
  const entry = result.output.find((output) => output.type === "chunk" && output.isEntry);

  if (!entry || entry.type !== "chunk") throw new Error("Integration Worker bundle missing.");
  worker = new Miniflare(
    convertV4MiniflareOptions({
      handleStructuredLogs: (log) => logs.push(log),
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

            if (mode === "private-invalid-json") return new Response("private-model-response-secret");

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
  logs.length = 0;
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
  const events = logEvents();
  expect(events.map((event) => event.event)).toEqual([
    "ingredient_matching_started",
    "ingredient_matching_batch_started",
    "ingredient_matching_progress",
    "ingredient_matching_persisting",
    "ingredient_matching_completed",
  ]);
  expect(new Set(events.map((event) => event.runId)).size).toBe(1);
  expect(events[0]).toMatchObject({
    normalizationModel: "@cf/meta/llama-3.2-3b-instruct",
    selectionModel: "typesafe/jev",
  });
  expect(events[1]).toMatchObject({ recipes: 1, groceries: 62, ingredients: 3, eligible: 1, concurrency: 1 });
  expect(events[2]).toMatchObject({ completed: 1, inFlight: 0, remaining: 0, proposedMatches: 1 });
  expect(events[3]).toMatchObject({ changedRecipes: 1, proposedMatches: 1 });
  expect(events[4]).toMatchObject({ outcome: "complete", matched: 1 });
  const text = JSON.stringify(logs);

  for (const value of [recipe.title, recipe.description, recipe.ingredients[0].name, ...recipe.instructions])
    expect(text).not.toContain(value);
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

it("logs intermediate progress while running independent ingredients with at most three upstream requests", async () => {
  mode = "concurrency";
  const db = await worker.getD1Database("DB");
  await db.prepare("DELETE FROM recipes").run();

  for (let index = 0; index < 28; index++)
    expect(
      (
        await send("recipes", "PUT", {
          ...recipe,
          id: `parallel-${index}`,
          ingredients: [{ ...recipe.ingredients[0], name: `${recipe.ingredients[0].name} ${index}` }],
        })
      ).status,
    ).toBe(200);
  expect(await match()).toMatchObject({
    attempted: 28,
    matched: 28,
    normalizationCalls: 28,
    selectionCalls: 28,
  });
  expect(peakCalls).toBeGreaterThan(1);
  expect(peakCalls).toBeLessThanOrEqual(3);
  const progress = logEvents().filter((event) => event.event === "ingredient_matching_progress");
  expect(progress).toHaveLength(2);
  expect(progress[0]).toMatchObject({ eligible: 28, completed: 25, remaining: 3, proposedMatches: 25 });
  expect(progress[1]).toMatchObject({ completed: 28, remaining: 0, inFlight: 0, proposedMatches: 28 });

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
    logs.length = 0;
    mode = failure;
    const report = await match();
    expect(report.matched).toBe(0);
    expect(report.failed).toBe(["uncertain", "none"].includes(failure) ? 0 : 1);
    expect((await state()).recipes[0].ingredients).toEqual(recipe.ingredients);
    const failures = logEvents().filter((event) => event.event === "ingredient_matching_ingredient_failed");
    expect(failures).toHaveLength(report.failed);

    if (report.failed) {
      expect(failures[0]).toMatchObject({
        stage: ["bad-normalization", "outage"].includes(failure) ? "normalization" : "selection",
        reason:
          failure === "bad-normalization"
            ? "invalid_normalization"
            : failure === "bad-selection"
              ? "invalid_response"
              : failure === "unknown-id"
                ? "invalid_selection"
                : "dependency_or_internal_error",
        recipeIndex: 0,
        ingredientIndex: 0,
      });
      expect(logEvents().at(-1)).toMatchObject({ outcome: "partial", failed: 1, matched: 0 });
    }
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
  expect(logEvents().find((event) => event.event === "ingredient_matching_persisting")).toMatchObject({
    proposedMatches: 1,
  });
  expect(logEvents().at(-1)).toMatchObject({ outcome: "partial", matched: 0, conflicts: 1 });
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
  expect(logEvents().find((event) => event.event === "ingredient_matching_ingredient_failed")).toMatchObject({
    stage: "selection",
    reason: "context_too_large",
  });
});

it("does not leak invalid model output into failure logs", async () => {
  mode = "private-invalid-json";
  expect(await match()).toMatchObject({ failed: 1, matched: 0 });
  expect(logEvents().find((event) => event.event === "ingredient_matching_ingredient_failed")).toMatchObject({
    stage: "normalization",
    reason: "invalid_response",
  });
  expect(JSON.stringify(logs)).not.toContain("private-model-response-secret");
});

it("logs no-work completion with distinct run IDs and only validated Ray IDs", async () => {
  await match();
  const runIds = new Set(logEvents().map((event) => event.runId));

  for (const ray of ["a43d8ff52b41e5d0-IAD", "private-header-secret"]) {
    logs.length = 0;

    const response = await worker.dispatchFetch("http://localhost/api/groceries/match", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cf-Ray": ray },
    });

    expect(response.status).toBe(200);
    await expect.poll(() => logEvents().at(-1)?.event).toBe("ingredient_matching_completed");
    const events = logEvents();
    expect(events[0].cfRay).toBe(ray === "private-header-secret" ? null : ray);
    expect(runIds.has(events[0].runId)).toBe(false);
    runIds.add(events[0].runId);
    expect(events.find((event) => event.event === "ingredient_matching_batch_started")).toMatchObject({
      eligible: 0,
      concurrency: 0,
    });
    expect(events.at(-1)).toMatchObject({
      attempted: 0,
      matched: 0,
      failed: 0,
      normalizationCalls: 0,
      selectionCalls: 0,
      outcome: "complete",
    });
    expect(JSON.stringify(logs)).not.toContain("private-header-secret");
  }
});

it("logs persistence failure without claiming proposed matches were saved", async () => {
  const db = await worker.getD1Database("DB");
  await db.exec(
    "CREATE TRIGGER matching_write_failure BEFORE UPDATE OF ingredients ON recipes BEGIN SELECT RAISE(ABORT, 'private-database-error-secret'); END;",
  );

  try {
    expect((await send("groceries/match", "POST")).status).toBe(500);
    await expect.poll(() => logEvents().at(-1)?.event).toBe("ingredient_matching_failed");
    expect(logEvents().at(-1)).toMatchObject({ stage: "persistence", reason: "database_error" });
    expect(logEvents().some((event) => event.event === "ingredient_matching_completed")).toBe(false);
    expect(JSON.stringify(logs)).not.toContain("private-database-error-secret");
    expect((await state()).recipes[0].ingredients).toEqual(recipe.ingredients);
  } finally {
    await db.exec("DROP TRIGGER matching_write_failure");
  }
});
