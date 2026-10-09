import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions, type V4WorkerdStructuredLog } from "miniflare";
import { rolldown } from "rolldown";
import { readFile, readdir } from "node:fs/promises";
import { Schema } from "effect";
import { HouseholdSchema, MatchReportSchema, GroceryItemSchema, RecipeSchema } from "../src/domain";

let worker: Miniflare;

let mode = "success";

let calls = 0;

let activeCalls = 0;

let peakCalls = 0;

let beforeSelect: (() => Promise<void>) | undefined;

let modelGate: Promise<void> | undefined;

const seen = new Set<string>();

const histories: Record<string, readonly { recipeTitle: string; ingredientName: string }[]>[] = [];

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

const recipe = Schema.decodeUnknownSync(RecipeSchema)({
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
});

const product = (id: string, name: string) =>
  Schema.decodeUnknownSync(GroceryItemSchema)({
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

function send(
  path: string,
  method = "GET",
  body?: typeof Schema.Json.Type,
  background = false,
  cancel = false,
) {
  const headers = new Headers({ "Content-Type": "application/json" });

  if (background) headers.set("X-Test-Background", "true");

  if (cancel) headers.set("X-Test-Cancel", "true");

  return worker.dispatchFetch(`http://localhost/api/${path}`, {
    method,
    headers: Object.fromEntries(headers),
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
}

const state = async () => Schema.decodeUnknownSync(HouseholdSchema)(await (await send("household")).json());

function mcpRequest(name: string, args: typeof Schema.Json.Type, cancel = false, background = false) {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": "tools/call",
    "Mcp-Name": name,
  });

  if (cancel) headers.set("X-Test-Cancel", "true");

  if (background) headers.set("X-Test-Background", "true");

  return worker.dispatchFetch("http://localhost/mcp", {
    method: "POST",
    headers: Object.fromEntries(headers),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "matching-test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

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
            await modelGate;

            if (mode === "deadline" && (await request.clone().text()).includes("Slow onion"))
              await new Promise((resolve) => setTimeout(resolve, 12_000));

            if (mode === "cancel") await new Promise((resolve) => setTimeout(resolve, 200));

            if (mode === "concurrency") {
              peakCalls = Math.max(peakCalls, ++activeCalls);
              await new Promise((resolve) => setTimeout(resolve, 20));
              activeCalls--;
            }

            if (mode === "outage") return new Response("Unavailable", { status: 503 });

            if (mode === "private-invalid-json") return new Response("private-model-response-secret");

            if (request.url.endsWith("llama-3.2-3b-instruct")) {
              if (mode === "timeout") await new Promise((resolve) => setTimeout(resolve, 16_000));

              if (mode === "partial") {
                const input = Schema.decodeUnknownSync(
                  Schema.Struct({ messages: Schema.Array(Schema.Struct({ content: Schema.String })) }),
                )(await request.json());

                const { ingredient } = Schema.decodeUnknownSync(Schema.Struct({ ingredient: Schema.String }))(
                  JSON.parse(input.messages[1].content),
                );

                if (ingredient === recipe.ingredients[0].name) return Response.json({ core: "" });
              }

              return Response.json({
                response: mode === "bad-normalization" ? { core: "" } : { core: "White Onion" },
              });
            }

            const input = Schema.decodeUnknownSync(
              Schema.Struct({
                state: Schema.Struct({
                  ingredient: Schema.Struct({ originalText: Schema.String }),
                  recipe: Schema.Struct({ instructions: Schema.Array(Schema.String) }),
                  linkedRecipeExamples: Schema.optional(
                    Schema.Record(
                      Schema.String,
                      Schema.Array(
                        Schema.Struct({ recipeTitle: Schema.String, ingredientName: Schema.String }),
                      ),
                    ),
                  ),
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

            if (mode.startsWith("suggestions") || mode === "history") {
              const criteria = input.questions.product.criteria;
              const white = Object.keys(criteria).find((key) => criteria[key].startsWith("White onion;"))!;

              const yellow = Object.keys(criteria).find((key) =>
                criteria[key].startsWith("Brand 0 yellow onion;"),
              )!;

              const third = Object.keys(criteria).find((key) =>
                criteria[key].startsWith("Brand 1 yellow onion;"),
              )!;

              if (input.state.linkedRecipeExamples) {
                histories.push(input.state.linkedRecipeExamples);

                if (mode === "suggestions-outage") return new Response("Unavailable", { status: 503 });

                if (mode === "history")
                  return Response.json({
                    answers: {
                      product: {
                        choice: yellow,
                        confidence: 0.93,
                        probabilities: { [yellow]: 0.95, [white]: 0.04, none: 0.01 },
                      },
                    },
                  });
              }

              return Response.json({
                answers: {
                  product: {
                    choice: mode === "suggestions-none" ? "none" : white,
                    confidence: 0.43,
                    probabilities: {
                      [white]: 0.46,
                      [yellow]: 0.32,
                      [third]: mode === "suggestions-invalid" ? -0.1 : 0.18,
                      none: mode === "suggestions-none" ? 0.8 : 0.04,
                    },
                  },
                },
              });
            }

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
      sql
        .split(/;\n(?=CREATE|INSERT|DROP|ALTER)|;\s*$/)
        .flatMap((value) => (value.trim() ? [db.prepare(value)] : [])),
    );
  }
}, 30_000);

beforeEach(async () => {
  mode = "success";
  calls = 0;
  activeCalls = 0;
  peakCalls = 0;
  beforeSelect = undefined;
  modelGate = undefined;
  seen.clear();
  histories.length = 0;
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

it.each([
  ["http", "history"],
  ["mcp", "history"],
  ["http", "outage"],
  ["mcp", "outage"],
  ["http", "conflict"],
  ["mcp", "conflict"],
  ["http", "cancel"],
  ["mcp", "cancel"],
])("saves through %s before background matching finishes (%s)", async (transport, outcome) => {
  mode = outcome;

  // Updating an existing recipe must not start AI work, even when background execution is available.
  const updated = await (transport === "http"
    ? send("recipes", "PUT", recipe, true)
    : mcpRequest(
        "update_recipes",
        { updates: [{ id: recipe.id, changes: { title: recipe.title } }] },
        false,
        true,
      ));

  expect(updated.status).toBe(200);
  expect(logEvents()).toEqual([]);
  let release = () => {};

  modelGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { id: _id, ...input } = recipe;
  let responded = false;

  const pending = (
    transport === "http"
      ? send("recipes", "PUT", { ...input, id: "new-recipe" }, true, outcome === "cancel")
      : mcpRequest(
          "create_recipes",
          { recipes: [input, { ...input, title: "Second salad" }] },
          outcome === "cancel",
          true,
        )
  ).then((response) => {
    responded = true;

    return response;
  });

  let created: (typeof recipe)[] = [];

  try {
    // Inference cannot finish until released. A successful response here proves saves do not await it.
    await expect.poll(() => responded).toBe(true);
    const response = await pending;
    expect(response.status).toBe(200);

    if (transport === "mcp") {
      const output = Schema.decodeUnknownSync(
        Schema.Struct({
          result: Schema.Struct({
            structuredContent: Schema.Struct({ recipes: Schema.Array(RecipeSchema) }),
          }),
        }),
      )(await response.json());

      expect(output.result.structuredContent.recipes).toHaveLength(2);
    }

    created = (await state()).recipes.filter((saved) => saved.id !== recipe.id);
    expect(created).toHaveLength(transport === "http" ? 1 : 2);

    for (const saved of created) expect(saved.ingredients).toEqual(recipe.ingredients);
    await expect.poll(() => calls).toBeGreaterThan(0);

    if (outcome === "cancel")
      await expect.poll(() => logs.some((entry) => entry.message === "test_request_aborted")).toBe(true);

    if (outcome === "conflict") {
      for (const saved of created)
        expect(
          (
            await send("recipes", "PUT", {
              ...saved,
              ingredients: [{ ...saved.ingredients[0], groceryItemId: null }, ...saved.ingredients.slice(1)],
            })
          ).status,
        ).toBe(200);
    }
  } finally {
    release();
    await pending;
    await expect
      .poll(() => logEvents().some((event) => event.event === "ingredient_matching_completed"))
      .toBe(true);
  }

  const saved = await state();
  // An older unmatched recipe provides history but must not itself be matched.
  expect(saved.recipes.find((entry) => entry.id === recipe.id)).toEqual(recipe);

  for (const original of created) {
    const actual = saved.recipes.find((entry) => entry.id === original.id)!;
    expect(actual).toEqual({
      ...original,
      ingredients: [
        outcome === "history"
          ? {
              ...recipe.ingredients[0],
              groceryItemId: "yellow-0",
              grocerySuggestions: ["white", "yellow-0", "yellow-1"],
            }
          : outcome === "conflict"
            ? { ...recipe.ingredients[0], groceryItemId: null }
            : outcome === "cancel"
              ? { ...recipe.ingredients[0], groceryItemId: "white" }
              : recipe.ingredients[0],
        ...recipe.ingredients.slice(1),
      ],
    });
  }

  if (outcome === "history")
    expect(histories[0].p1).toContainEqual({
      recipeTitle: recipe.title,
      ingredientName: recipe.ingredients[2].name,
    });
  expect(logEvents().at(-1)).toMatchObject({
    attempted: created.length,
    matched: outcome === "history" || outcome === "cancel" ? created.length : 0,
    failed: outcome === "outage" ? created.length : 0,
    conflicts: outcome === "conflict" ? created.length : 0,
  });

  if (outcome === "cancel") expect(logs.some((entry) => entry.message === "test_model_aborted")).toBe(false);
});

it("rejects stale browser ingredient replacements after matching, then accepts a refreshed edit", async () => {
  const input = { ...recipe, id: "stale-edit" };
  expect((await send("recipes", "PUT", { ...input, expectedIngredients: null }, true)).status).toBe(200);
  await expect
    .poll(
      async () =>
        (await state()).recipes.find((entry) => entry.id === input.id)?.ingredients[0].groceryItemId,
    )
    .toBe("white");
  const current = (await state()).recipes.find((entry) => entry.id === input.id)!;
  expect(
    (await send("recipes", "PUT", { ...input, minutes: 45, expectedIngredients: input.ingredients }, true))
      .status,
  ).toBe(409);
  expect((await state()).recipes.find((entry) => entry.id === input.id)).toEqual(current);
  expect(
    (
      await send(
        "recipes",
        "PUT",
        { ...current, minutes: 45, expectedIngredients: current.ingredients },
        true,
      )
    ).status,
  ).toBe(200);
  expect((await state()).recipes.find((entry) => entry.id === input.id)).toEqual({ ...current, minutes: 45 });
  // An explicit Auto-match edit remains possible; omission of the new link is not treated as preservation.
  expect(
    (await send("recipes", "PUT", { ...input, expectedIngredients: current.ingredients }, true)).status,
  ).toBe(200);
  expect((await state()).recipes.find((entry) => entry.id === input.id)?.ingredients).toEqual(
    input.ingredients,
  );
  expect((await send(`recipes/${input.id}`, "DELETE")).status).toBe(200);
  expect(
    (await send("recipes", "PUT", { ...input, expectedIngredients: input.ingredients }, true)).status,
  ).toBe(409);
  expect((await state()).recipes.some((entry) => entry.id === input.id)).toBe(false);
});

it("starts only one background run for overlapping saves of the same new ID", async () => {
  let release = () => {};

  modelGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  try {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => send("recipes", "PUT", { ...recipe, id: "overlap" }, true)),
    );

    expect(responses.map((response) => response.status)).toEqual(Array(8).fill(200));
    expect(logEvents().filter((event) => event.event === "ingredient_matching_started")).toHaveLength(1);
  } finally {
    release();
    await expect
      .poll(() => logEvents().filter((event) => event.event === "ingredient_matching_completed").length)
      .toBe(1);
  }

  expect((await state()).recipes.find((entry) => entry.id === "overlap")?.ingredients[0].groceryItemId).toBe(
    "white",
  );
});

it("persists completed background decisions when slow inference exceeds the deadline", async () => {
  mode = "deadline";

  const input = {
    ...recipe,
    id: "deadline",
    ingredients: [recipe.ingredients[0], { ...recipe.ingredients[0], name: "Slow onion" }],
  };

  expect((await send("recipes", "PUT", input, true)).status).toBe(200);
  await expect
    .poll(() => logEvents().some((event) => event.event === "ingredient_matching_completed"), {
      timeout: 25_000,
    })
    .toBe(true);
  expect(logEvents().some((event) => event.event === "ingredient_matching_deadline")).toBe(true);
  expect(logEvents().at(-1)).toMatchObject({ matched: 1, failed: 1, outcome: "partial" });
  const expected = [{ ...input.ingredients[0], groceryItemId: "white" }, input.ingredients[1]];
  expect((await state()).recipes.find((entry) => entry.id === input.id)?.ingredients).toEqual(expected);
  // The late upstream response must not write after the partial result has committed.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  expect((await state()).recipes.find((entry) => entry.id === input.id)?.ingredients).toEqual(expected);
}, 30_000);

it.each(["exact", "ai"])(
  "keeps near-limit recipes readable after %s linking grows the stored value",
  async (kind) => {
    const input = {
      ...recipe,
      ingredients: [
        { ...recipe.ingredients[0], name: kind === "exact" ? "White onion" : recipe.ingredients[0].name },
      ],
      photo: "data:image/png;base64,",
    };

    input.photo += "A".repeat(1_899_999 - new TextEncoder().encode(JSON.stringify(input)).length);
    expect(new TextEncoder().encode(JSON.stringify(input)).length).toBe(1_899_999);
    expect((await send("recipes", "PUT", input)).status).toBe(200);

    if (kind === "ai") expect(await match()).toMatchObject({ matched: 1 });

    const response = await send("household");
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = Schema.decodeUnknownSync(HouseholdSchema)(await response.json()).recipes[0];
    expect(saved.ingredients[0].groceryItemId).toBe("white");
    expect(new TextEncoder().encode(JSON.stringify(saved)).length).toBeGreaterThan(1_900_000);
    const mcpResponse = await mcpRequest("get_recipes", { ids: [recipe.id] });
    expect(mcpResponse.status).toBe(200);

    const mcpResult = Schema.decodeUnknownSync(
      Schema.Struct({
        result: Schema.Struct({ structuredContent: Schema.Struct({ recipes: Schema.Array(RecipeSchema) }) }),
      }),
    )(await mcpResponse.json());

    expect(mcpResult.result.structuredContent.recipes).toEqual([saved]);
    // Oversized input still fails; separating reads must not remove the write policy.
    expect((await send("recipes", "PUT", saved)).status).toBe(400);
  },
);

it.each(["http", "mcp"])(
  "propagates %s cancellation to inference without subsequent matching writes",
  async (transport) => {
    mode = "cancel";

    const response = await (transport === "mcp"
      ? mcpRequest("match_groceries", {}, true)
      : worker.dispatchFetch("http://localhost/api/groceries/match", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Test-Cancel": "true" },
          body: "{}",
        }));

    expect(response.status).toBe(499);
    await expect.poll(() => logs.some((entry) => entry.message === "test_model_aborted")).toBe(true);
    // Wait beyond the upstream response. Cancellation must stop selection and persistence,
    // not merely stop the transport from delivering the result.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(calls).toBe(1);
    expect((await state()).recipes[0].ingredients).toEqual(recipe.ingredients);
    const db = await worker.getD1Database("DB");
    expect(await db.prepare("SELECT COUNT(*) AS count FROM ingredient_match_cache").first("count")).toBe(0);
    expect(logEvents().some((event) => event.event === "ingredient_matching_completed")).toBe(false);

    mode = "success";
    expect(await match()).toMatchObject({ matched: 1, failed: 0, normalizationCalls: 1, selectionCalls: 1 });
  },
);

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

it("shares failed in-flight work without cancelling healthy ingredients, then retries failures on the next run", async () => {
  mode = "partial";
  expect((await send("recipes", "PUT", { ...recipe, id: "duplicate" })).status).toBe(200);
  expect(
    (
      await send("recipes", "PUT", {
        ...recipe,
        id: "healthy",
        ingredients: [{ ...recipe.ingredients[0], name: "Fresh white onion, chopped" }],
      })
    ).status,
  ).toBe(200);

  expect(await match()).toMatchObject({
    attempted: 3,
    matched: 1,
    failed: 2,
    normalizationCalls: 2,
    selectionCalls: 1,
  });
  expect(calls).toBe(3);
  const after = (await state()).recipes;
  expect(after.find((entry) => entry.id === "healthy")!.ingredients[0].groceryItemId).toBe("white");

  for (const id of [recipe.id, "duplicate"])
    expect(after.find((entry) => entry.id === id)!.ingredients).toEqual(recipe.ingredients);

  mode = "success";
  expect(await match()).toMatchObject({
    attempted: 2,
    matched: 2,
    failed: 0,
    normalizationCalls: 1,
    selectionCalls: 1,
    normalizationCacheHits: 1,
    selectionCacheHits: 1,
  });
  expect(calls).toBe(5);

  for (const entry of (await state()).recipes) expect(entry.ingredients[0].groceryItemId).toBe("white");
});

it("times out inference without persisting a late response and retries the ingredient on a later run", async () => {
  mode = "timeout";
  expect(await match()).toMatchObject({ attempted: 1, matched: 0, failed: 1, selectionCalls: 0 });
  expect(logEvents().find((event) => event.event === "ingredient_matching_ingredient_failed")).toMatchObject({
    stage: "normalization",
    reason: "timeout",
  });
  // Let the deliberately slow upstream finish; its late result must not reach D1.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect((await state()).recipes[0].ingredients).toEqual(recipe.ingredients);
  const db = await worker.getD1Database("DB");
  expect(await db.prepare("SELECT COUNT(*) AS count FROM ingredient_match_cache").first("count")).toBe(0);

  mode = "success";
  expect(await match()).toMatchObject({ matched: 1, failed: 0, normalizationCalls: 1, selectionCalls: 1 });
}, 25_000);

it("persists ranked suggestions without linking, reuses them, and clears them on explicit selection", async () => {
  mode = "suggestions";
  expect(await match()).toMatchObject({ matched: 0, unmatched: 1, selectionCalls: 1 });
  let actual = (await state()).recipes[0];
  expect(actual.ingredients[0]).toEqual({
    ...recipe.ingredients[0],
    grocerySuggestions: ["white", "yellow-0", "yellow-1"],
  });
  expect(actual.ingredients.slice(1)).toEqual(recipe.ingredients.slice(1));
  expect(histories).toEqual([]); // The current recipe's own linked onion is not history.
  expect(await match()).toMatchObject({ matched: 0, unmatched: 1, selectionCalls: 0 });
  expect(
    (
      await send("recipes", "PUT", {
        ...actual,
        ingredients: actual.ingredients.map((item, index) =>
          index ? item : { ...item, groceryItemId: "yellow-1" },
        ),
      })
    ).status,
  ).toBe(200);
  actual = (await state()).recipes[0];
  expect(actual.ingredients[0]).toEqual({ ...recipe.ingredients[0], groceryItemId: "yellow-1" });
  expect(await match()).toMatchObject({ attempted: 0 });

  const db = await worker.getD1Database("DB");

  for (const value of ["suggestions-none", "suggestions-invalid"]) {
    mode = value;
    await db.prepare("DELETE FROM ingredient_match_cache").run();
    await send("recipes", "PUT", recipe);
    expect(await match()).toMatchObject({ matched: 0, failed: value === "suggestions-invalid" ? 1 : 0 });
    expect((await state()).recipes[0].ingredients).toEqual(recipe.ingredients);
  }
});

it("uses at most ten distinct other recipes per shortlisted product and invalidates contextual cache on history edits", async () => {
  mode = "history";

  for (let index = 0; index < 12; index++) {
    const ingredient = {
      name: `White onion example ${index}`,
      quantity: 1,
      unit: "each",
      groceryItemId: "white",
    };

    await send("recipes", "PUT", {
      ...recipe,
      id: `history-${index}`,
      title: `History ${String(index).padStart(2, "0")}`,
      ingredients: [ingredient, ingredient],
    });
  }

  const yellowRecipe = {
    ...recipe,
    id: "yellow-history",
    title: "Yellow dinner",
    ingredients: [{ name: "Diced yellow onion", quantity: 2, unit: "each", groceryItemId: "yellow-0" }],
  };

  await send("recipes", "PUT", yellowRecipe);
  expect(await match()).toMatchObject({ matched: 1, selectionCalls: 2 });
  expect(histories).toHaveLength(1);
  expect(histories[0]).toEqual({
    p0: Array.from({ length: 10 }, (_, index) => ({
      recipeTitle: `History ${String(index).padStart(2, "0")}`,
      ingredientName: `White onion example ${index}`,
    })),
    p1: [{ recipeTitle: "Yellow dinner", ingredientName: "Diced yellow onion" }],
    p2: [],
  });
  expect((await state()).recipes.find((r) => r.id === recipe.id)?.ingredients[0]).toEqual({
    ...recipe.ingredients[0],
    groceryItemId: "yellow-0",
    grocerySuggestions: ["white", "yellow-0", "yellow-1"],
  });
  await send("recipes", "PUT", recipe);
  expect(await match()).toMatchObject({ matched: 1, selectionCalls: 0, selectionCacheHits: 2 });
  await send("recipes", "PUT", {
    ...yellowRecipe,
    title: "Renamed dinner",
    ingredients: [{ ...yellowRecipe.ingredients[0], name: "New ingredient context" }],
  });
  await send("recipes", "PUT", recipe);
  expect(await match()).toMatchObject({ matched: 1, selectionCalls: 1 });
  expect(histories.at(-1)?.p1).toEqual([
    { recipeTitle: "Renamed dinner", ingredientName: "New ingredient context" },
  ]);
});

it("keeps suggestions when the history pass fails, retries it, and guards suggestion-only writes against concurrent edits", async () => {
  mode = "suggestions-outage";
  await send("recipes", "PUT", {
    ...recipe,
    id: "history",
    title: "Other recipe",
    ingredients: [{ ...recipe.ingredients[0], groceryItemId: "white" }],
  });
  expect(await match()).toMatchObject({ matched: 0, failed: 1, selectionCalls: 2 });
  expect((await state()).recipes.find((r) => r.id === recipe.id)?.ingredients[0].grocerySuggestions).toEqual([
    "white",
    "yellow-0",
    "yellow-1",
  ]);
  mode = "history";
  expect(await match()).toMatchObject({ matched: 1, failed: 0, selectionCalls: 1 });

  const db = await worker.getD1Database("DB");
  await db.prepare("DELETE FROM recipes WHERE id='history'").run();
  await db.prepare("DELETE FROM ingredient_match_cache").run();
  await send("recipes", "PUT", recipe);
  await db.prepare("INSERT INTO collections(id,name) VALUES('matching-category','Changed category')").run();
  mode = "suggestions";
  beforeSelect = async () => {
    await db.prepare("UPDATE recipes SET category='Changed category' WHERE id=?").bind(recipe.id).run();
  };

  expect(await match()).toMatchObject({ matched: 0, conflicts: 1 });
  expect((await state()).recipes[0].ingredients).toEqual(recipe.ingredients);
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
