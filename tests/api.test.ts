import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { rolldown } from "rolldown";
import { readFile, readdir } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet, type JWTPayload } from "jose";
import { sampleRecipes } from "../src/seed";
import { Schema } from "effect";
import {
  HouseholdSchema,
  RecipeSchema,
  MealSchema,
  GroceryItemSchema,
  shoppingList,
  type MealDraft,
  type Ingredient,
  type IngredientDraft,
  RecipeId,
  type GroceryId,
} from "../src/domain";
import server from "../src/server";
import { recipeStatement } from "../src/recipes";
import type { WebsiteEnv } from "../alchemy.run";

let worker: Miniflare;

let script = "";

let signingKey: CryptoKey;

let publicKeys: JSONWebKeySet;

const uploadedPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S0AAAAASUVORK5CYII=";

const uploadedWebp = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";

const feedbackDeliveries: { body: string; id: string | null; signature: string | null }[] = [];

let feedbackStatus = 200;

const feedbackContext = {
  app: { name: "Hearth", build: "client-build-42" },
  page: {
    name: "shopping",
    detail: "Shopping list · Build list",
    url: "https://user:disposable-password@hearth.example.test/?source=text&access_token=disposable-query-secret&return_to=https%3A%2F%2Fidentity.example.test%2Fcallback%3Fstate%3Ddisposable-oauth-state#shopping?mode=builder&search=rice&api_key=disposable-fragment-secret",
    view: {
      week: "2026-10-12",
      mode: "builder",
      hideChecked: true,
      collection: "all",
      search: "rice",
      selected: [],
      checklist: false,
    },
  },
  browser: {
    userAgent: "Disposable browser",
    language: "en-US",
    timeZone: "America/New_York",
    display: "standalone",
    viewport: { width: 390, height: 664, pixelRatio: 3 },
    touchPoints: 5,
    pointer: "coarse",
    online: true,
  },
};

const defaultCollections = [
  { id: "comfort", name: "Comfort food" },
  { id: "special", name: "Something special" },
  { id: "vegetarian", name: "Vegetarian" },
  { id: "weeknight", name: "Weeknight favorites" },
].map((collection) => ({ ...collection, revision: expect.any(String) }));

expectTypeOf<RecipeId>().not.toExtend<GroceryId>();

expectTypeOf<GroceryId>().not.toExtend<RecipeId>();

expectTypeOf<IngredientDraft["quantity"]>().not.toExtend<Ingredient["quantity"]>();

const meal = Schema.decodeUnknownSync(MealSchema)({
  id: "test-meal",
  recipeId: sampleRecipes[0].id,
  date: "2026-09-21",
  slot: "Dinner",
  scale: 1.5,
  note: "Leftovers for lunch",
});

function options(
  local: string,
  audience = "test-hearth",
  smokeClientId = "smoke-test.access",
  previewClientId = "",
  jwksResponse = () => Response.json(publicKeys),
  feedbackConnected = true,
) {
  return convertV4MiniflareOptions({
    workers: [
      {
        name: "hearth",
        modules: true,
        script,
        compatibilityDate: "2026-09-08",
        compatibilityFlags: ["global_fetch_strictly_public"],
        d1Databases: ["DB"],
        bindings: {
          LOCAL_DEV: local,
          ACCESS_AUD: audience,
          SMOKE_CLIENT_ID: smokeClientId,
          PREVIEW_CLIENT_ID: previewClientId,
          FEEDBACK_WEBHOOK_URL: feedbackConnected ? "https://intake.example.test/tickets" : "",
          FEEDBACK_SIGNING_KEY: "disposable-feedback-signing-key-for-smoke",
          TELEMETRY_ENVIRONMENT: "integration",
          TELEMETRY_VERSION: "server-build-43",
        },
        outboundService: async (request) => {
          const url = new URL(request.url);

          if (url.hostname === "intake.example.test") {
            feedbackDeliveries.push({
              body: await request.text(),
              id: request.headers.get("Idempotency-Key"),
              signature: request.headers.get("X-Hearth-Signature"),
            });

            return new Response(null, { status: feedbackStatus });
          }

          // A missing URL/DNS guard must produce a successful import here, not a
          // swallowed outbound assertion that could masquerade as safe rejection.
          if (
            [
              "localhost",
              "127.0.0.1",
              "[::ffff:7f00:1]",
              "private.example.com",
              "mixed.example.com",
              "no-dns.example.com",
            ].includes(url.hostname)
          )
            return new Response(await readFile("tests/fixtures/nyt-coq-au-vin.html", "utf8"));

          if (url.hostname === "cloudflare-dns.com") {
            const name = url.searchParams.get("name");
            const ipv6 = url.searchParams.get("type") === "AAAA";

            if (name === "no-dns.example.com") return Response.json({ Status: 3 });

            return Response.json({
              Status: 0,
              Answer: [
                {
                  type: ipv6 ? 28 : 1,
                  data:
                    name === "private.example.com"
                      ? ipv6
                        ? "fd00::1"
                        : "10.0.0.1"
                      : name === "mixed.example.com" && ipv6
                        ? "::ffff:127.0.0.1"
                        : ipv6
                          ? "2606:4700:4700::1111"
                          : "1.1.1.1",
                },
              ],
            });
          }

          if (url.hostname === "recipes.example.com") {
            if (url.pathname === "/redirect")
              return new Response(null, {
                status: 302,
                headers: { Location: "https://private.example.com/recipe" },
              });

            if (url.pathname === "/canonical")
              return new Response(null, { status: 301, headers: { Location: "/jsonld" } });

            if (url.pathname === "/html")
              return new Response(
                `<div itemscope itemtype="https://schema.org/Recipe" class="h-recipe"><h2 itemprop="name" class="p-name">Structured soup</h2><span itemprop="recipeYield">Serves 6</span><time itemprop="totalTime" datetime="About an hour">About an hour</time><ul><li itemprop="recipeIngredient" class="p-ingredient">1/2 cup lentils</li><li itemprop="recipeIngredient">Salt to taste</li></ul><div class="e-instructions"><p>Rinse the lentils.</p><p>Simmer until tender.</p></div></div><div class="h-recipe"><span class="p-name">Unrelated recipe</span><span class="p-ingredient">9 cups sugar</span></div>`,
              );

            if (url.pathname === "/nested-microdata")
              return new Response(
                `<article itemscope itemtype="https://schema.org/Recipe"><div itemprop="author" itemscope itemtype="https://schema.org/Person"><span itemprop="name">Alice</span></div><h2 itemprop="name">Scoped soup</h2><span itemprop="recipeIngredient">2 cups lentils</span><div itemprop="recipeInstructions" itemscope itemtype="https://schema.org/HowToSection"><div itemprop="itemListElement" itemscope itemtype="https://schema.org/HowToStep"><p itemprop="text">Simmer until tender.</p></div><aside itemscope itemtype="https://schema.org/Review"><p>Unrelated review.</p></aside></div><aside itemscope itemtype="https://schema.org/Recipe"><h3 itemprop="name">Unrelated cake</h3><span itemprop="recipeIngredient">9 cups sugar</span><p itemprop="recipeInstructions">Bake the cake.</p></aside></article>`,
              );

            if (url.pathname === "/nested-microformat")
              return new Response(
                `<article class="h-recipe"><div class="p-author h-card"><span class="p-name">Alice</span></div><h2 class="p-name">Scoped soup</h2><span class="p-ingredient">2 cups lentils</span><div class="e-instructions"><p>Simmer until tender.</p><aside class="h-review"><p>Unrelated review.</p></aside></div><aside class="hrecipe"><h3 class="fn">Unrelated cake</h3><span class="ingredient">9 cups sugar</span><p class="instructions">Bake the cake.</p></aside></article>`,
              );

            if (/^\/(?:instructions|metadata)-/.test(url.pathname)) {
              const recipe = {
                "@type": "Recipe",
                name: "Metadata soup",
                recipeIngredient: ["2 cups lentils"],
                recipeInstructions: [{ text: "Simmer until tender." }],
              };

              const variants = {
                "/instructions-mixed": {
                  recipeInstructions: [{ text: "Rinse." }, { name: "Bake until done." }],
                },
                "/instructions-fallback": {
                  recipeInstructions: [{ text: "Rinse." }, { name: "Bake until done." }],
                },
                "/instructions-empty-children": {
                  recipeInstructions: [{ text: "Simmer until tender.", itemListElement: [] }],
                },
                "/metadata-absent": {},
                "/metadata-null": {
                  description: null,
                  recipeYield: null,
                  totalTime: null,
                  prepTime: null,
                  cookTime: null,
                  image: null,
                },
                "/metadata-malformed": {
                  description: {},
                  recipeYield: { value: 4 },
                  totalTime: 45,
                  prepTime: [],
                  cookTime: {},
                  image: { contentUrl: "/photo.jpg" },
                },
                "/metadata-fallback": {
                  recipeYield: 3,
                  totalTime: null,
                  prepTime: "PT8M",
                  cookTime: "PT21M",
                  image: "/soup.jpg",
                },
              };

              return new Response(
                `<script type="application/ld+json">${JSON.stringify({ ...recipe, ...Object.entries(variants).find(([path]) => path === url.pathname)?.[1] })}</script>${url.pathname === "/instructions-fallback" ? `<script type="application/ld+json">${JSON.stringify(recipe)}</script>` : ""}`,
              );
            }

            if (url.pathname === "/empty")
              return new Response(
                `<script type="application/ld+json">{"@type":"Recipe","name":"Collection","recipeIngredient":[],"recipeInstructions":[]}</script>`,
              );

            return new Response(
              `<script type="application/ld+json">not json</script><script type="application/ld+json">${JSON.stringify(
                {
                  "@graph": [
                    { "@type": "Recipe", name: "Incomplete" },
                    {
                      "@type": ["Recipe"],
                      name: "Weeknight beans",
                      prepTime: "PT7M",
                      cookTime: "PT23M",
                      image: "/beans.jpg",
                      recipeIngredient: ["1 1/2 cups beans", "2 tablespoons olive oil"],
                      recipeInstructions: [
                        {
                          "@type": "HowToSection",
                          itemListElement: [
                            { "@type": "HowToSection", itemListElement: [{ text: "Rinse &amp; drain." }] },
                            { text: "Cook for\n23 minutes." },
                          ],
                        },
                      ],
                    },
                  ],
                },
              )}</script>`,
            );
          }

          if (url.hostname === "cooking.nytimes.com") {
            if (url.pathname === "/recipes/2") return new Response("Denied", { status: 403 });

            if (url.pathname === "/recipes/3")
              return new Response("", { status: 302, headers: { Location: "http://localhost/secret" } });

            if (url.pathname === "/recipes/4") return new Response("<html>Sign in</html>");

            if (url.pathname === "/recipes/5") return new Response("x".repeat(5_000_001));

            if (url.pathname === "/recipes/6") throw new Error("private upstream fetch detail");

            if (url.pathname === "/recipes/7") {
              if (url.searchParams.get("unlocked_article_code") !== "test")
                return new Response("Denied", { status: 403 });
              const hop = Number(url.searchParams.get("hop") ?? 0);

              if (hop < 3) {
                url.searchParams.set("hop", String(hop + 1));

                return new Response(null, {
                  status: hop === 0 ? 301 : hop === 1 ? 307 : 308,
                  headers: { Location: hop === 0 ? url.href : `${url.pathname}${url.search}` },
                });
              }
            }

            if (url.pathname === "/recipes/8")
              return new Response(null, { status: 302, headers: { Location: "/recipes/8" } });

            if (url.pathname === "/recipes/9")
              return new Response(null, {
                status: 303,
                headers: { Location: url.searchParams.get("to") ?? "/recipes/3" },
              });

            if (url.pathname === "/recipes/10") return new Response(null, { status: 302 });

            return new Response(await readFile("tests/fixtures/nyt-coq-au-vin.html", "utf8"));
          }

          expect(request.url).toBe("https://saiaai.cloudflareaccess.com/cdn-cgi/access/certs");

          return jwksResponse();
        },
      },
    ],
  });
}

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  signingKey = keys.privateKey;
  publicKeys = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: "test-key", alg: "RS256" }] };
  const bundle = await rolldown({ input: "src/server.ts", platform: "browser" });
  const result = await bundle.generate({ format: "esm" });
  await bundle.close();
  const entry = result.output.find((output) => output.type === "chunk" && output.isEntry);

  if (!entry || entry.type !== "chunk") throw new Error("Worker bundle missing.");
  script = entry.code;
  worker = new Miniflare(options("true"));
  const db = await worker.getD1Database("DB");
  const sql = await readFile("migrations/0001_initial.sql", "utf8");
  const statements = sql.split(";").flatMap((statement) => (statement.trim() ? [db.prepare(statement)] : []));
  await db.batch(statements);
  await db.prepare(await readFile("migrations/0002_recipe_rating.sql", "utf8")).run();
  const collectionsSql = await readFile("migrations/0003_collections.sql", "utf8");
  await db.batch(
    collectionsSql
      .split(/;\n(?=CREATE|INSERT)|;\s*$/)
      .filter((s) => s.trim())
      .map((s) => db.prepare(s)),
  );
  const groceriesSql = await readFile("migrations/0004_groceries.sql", "utf8");
  await db.batch(
    groceriesSql
      .split(/;\n(?=CREATE|INSERT)|;\s*$/)
      .filter((s) => s.trim())
      .map((s) => db.prepare(s)),
  );
  // Upgrade a populated plan, not just an empty schema.
  await db.batch(
    (await readFile("migrations/0005_ingredient_matching.sql", "utf8"))
      .split(/;\s*(?=CREATE|INSERT|DROP|ALTER|UPDATE)|;\s*$/)
      .filter((s) => s.trim())
      .map((s) => db.prepare(s)),
  );
  await legacyRecipeStatement(db, sampleRecipes[0]).run();
  await db
    .prepare("INSERT INTO meals(id,recipeId,date,slot,scale,note) VALUES(?,?,?,?,?,?)")
    .bind(meal.id, meal.recipeId, meal.date, meal.slot, meal.scale, meal.note)
    .run();
  const notesSql = await readFile("migrations/0006_meal_notes.sql", "utf8");
  await db.batch(
    notesSql
      .split(";")
      .filter((s) => s.trim())
      .map((s) => db.prepare(s)),
  );
  await db.prepare(await readFile("migrations/0007_shopping_membership.sql", "utf8")).run();
  const unlinkSql = await readFile("migrations/0008_grocery_delete_unlink.sql", "utf8");
  await db.batch(
    unlinkSql
      .split(/;\n(?=CREATE)|;\s*$/)
      .filter((s) => s.trim())
      .map((s) => db.prepare(s)),
  );
  const feedbackSql = await readFile("migrations/0009_feedback.sql", "utf8");
  await db.batch(
    feedbackSql
      .split(";")
      .filter((s) => s.trim())
      .map((s) => db.prepare(s)),
  );
  await db.prepare(await readFile("migrations/0010_shopping_packages.sql", "utf8")).run();
  expect(await db.prepare("SELECT * FROM meals").first()).toEqual(meal);
  await expect(db.prepare("DELETE FROM recipes WHERE id=?").bind(meal.recipeId).run()).rejects.toThrow();

  const historicalRecipe = Schema.decodeUnknownSync(RecipeSchema)({
    ...sampleRecipes[0],
    description: 'Historical description with Unicode: café and "quotes".',
    rating: "down",
    servings: 2.5,
    minutes: 137,
    ingredients: [
      { name: "Rice", quantity: 1.25, unit: "cup", originalText: "1¼ cups rice, rinsed" },
      { name: "Salt", quantity: 2, unit: "pinch", groceryItemId: null },
      { name: "Oil", quantity: 3, unit: "tbsp", grocerySuggestions: ["historical-suggestion"] },
      { name: "Beans", quantity: 1, unit: "can", groceryItemId: "historical-product" },
    ],
    instructions: ["First step.\nKeep this newline.", "Second step — simmer."],
  });

  await db
    .prepare(
      "INSERT INTO groceries(id,name,url,aisle,quantity,unit,aliases) VALUES('historical-product','Beans','','5',1,'can','[]')",
    )
    .run();
  await legacyRecipeStatement(db, historicalRecipe).run();
  await db
    .prepare("UPDATE recipes SET rating=? WHERE id=?")
    .bind(historicalRecipe.rating, historicalRecipe.id)
    .run();

  const historicalMeals = [
    meal,
    {
      ...meal,
      id: "historical-second",
      date: "2024-02-29",
      slot: "Breakfast",
      scale: 0.25,
      note: "Older meal",
    },
    { ...meal, id: "historical-note", recipeId: null, note: "Same date, separate note" },
    { ...meal, id: "historical-note-other", recipeId: null, date: "2023-01-01", note: "No recipe" },
  ];

  await db.batch(
    historicalMeals
      .slice(1)
      .map((entry) =>
        db
          .prepare("INSERT INTO meals(id,recipeId,date,slot,scale,note) VALUES(?,?,?,?,?,?)")
          .bind(entry.id, entry.recipeId, entry.date, entry.slot, entry.scale, entry.note),
      ),
  );
  const snapshotsSql = await readFile("migrations/0011_meal_recipes.sql", "utf8");
  await db.batch(
    snapshotsSql
      .replace(/^--.*$/gm, "")
      .split(/;\s*(?=CREATE|INSERT|DROP|ALTER|UPDATE)|;\s*$/)
      .filter((s) => s.trim())
      .map((s) => db.prepare(s)),
  );
  await db.batch(
    (await readFile("migrations/0012_entity_revisions.sql", "utf8"))
      .replace(/^--.*$/gm, "")
      .split(/;\s*(?=CREATE|INSERT|DROP|ALTER|UPDATE)|;\s*$/)
      .filter((s) => s.trim())
      .map((s) => db.prepare(s)),
  );
  await db.batch(
    (await readFile("migrations/0013_photos.sql", "utf8"))
      .replace(/^--.*$/gm, "")
      .split(/;\s*\n(?=CREATE|INSERT|DROP|ALTER|UPDATE)|;\s*$/)
      .filter((s) => s.trim())
      .map((s) => db.prepare(s)),
  );

  // The household snapshot reads dated lists, so apply them before the first API read.
  await db.batch(
    (await readFile("migrations/0015_shopping_lists.sql", "utf8"))
      .replace(/^--.*$/gm, "")
      .split(/;\s*\n(?=CREATE|INSERT|DROP|ALTER|UPDATE)|;\s*$/)
      .filter((s) => s.trim())
      .map((s) => db.prepare(s)),
  );

  const migrated = Schema.decodeUnknownSync(HouseholdSchema)(
    await (await worker.dispatchFetch("http://localhost/api/household")).json(),
  );

  expect(migrated.meals).toHaveLength(historicalMeals.length);

  for (const entry of historicalMeals)
    expect(migrated.meals.find((saved) => saved.id === entry.id)).toEqual({
      ...entry,
      revision: expect.any(String),
      recipe: entry.recipeId === null ? null : historicalRecipe,
    });
  await expect(db.prepare("DELETE FROM recipes WHERE id=?").bind(meal.recipeId).run()).rejects.toThrow();
  await db.batch(
    (await readFile("migrations/0014_detached_meals.sql", "utf8"))
      .replace(/^--.*$/gm, "")
      .split(/;\s*\n(?=CREATE|INSERT|DROP|ALTER|UPDATE)|;\s*$/)
      .filter((s) => s.trim())
      .map((s) => db.prepare(s)),
  );
  expect(await (await worker.dispatchFetch("http://localhost/api/household")).json()).toEqual(migrated);
}, 30000);

beforeEach(async () => {
  await worker.setOptions(options("true"));
  feedbackDeliveries.length = 0;
  feedbackStatus = 200;
  const db = await worker.getD1Database("DB");
  await db.batch([
    db.prepare("DELETE FROM feedback"),
    db.prepare("DELETE FROM meals"),
    db.prepare("DELETE FROM recipes"),
    db.prepare("DELETE FROM photos"),
    db.prepare("DELETE FROM groceries"),
    db.prepare("DELETE FROM shopping_order"),
    db.prepare("INSERT INTO shopping_order(id,aisles,items) VALUES(1,'[]','[]')"),
    db.prepare("DELETE FROM shopping_list_items"),
    db.prepare("DELETE FROM shopping_lists"),
    // Legacy single-list tables stay in the schema for Workers still running the previous release.
    db.prepare("DELETE FROM extras"),
    db.prepare("DELETE FROM checks"),
    db.prepare("DELETE FROM collections"),
    ...defaultCollections.map((collection) =>
      db.prepare("INSERT INTO collections(id,name) VALUES(?,?)").bind(collection.id, collection.name),
    ),
  ]);
});

afterAll(async () => {
  await worker?.dispose();
});

// Ordinary legacy scenarios deliberately read fresh state; regression scenarios use raw requests.
const send = async (path: string, method: string, body: string) => {
  const dispatch = () =>
    worker.dispatchFetch(`http://localhost/api/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body,
    });

  const resource = path.split("/")[0];

  if (
    ((method === "PUT" && !path.includes("/")) ||
      (method === "DELETE" && (resource !== "shopping-lists" || path.split("/").length === 2))) &&
    [
      "recipes",
      "meals",
      "groceries",
      "shopping-items",
      "collections",
      "shopping-lists",
      "shopping-order",
    ].includes(resource)
  ) {
    let input: Record<string, typeof Schema.Json.Type>;

    try {
      input = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(JSON.parse(body || "{}"));
    } catch {
      return dispatch();
    }

    if (!("expectedRevision" in input)) {
      const db = await worker.getD1Database("DB");

      const table =
        resource === "shopping-items"
          ? "groceries"
          : resource === "shopping-order" || resource === "shopping-lists"
            ? resource.replace("-", "_")
            : resource;

      let id: typeof Schema.Json.Type | undefined;

      try {
        id =
          resource === "shopping-order"
            ? 1
            : method === "DELETE"
              ? decodeURIComponent(path.slice(resource.length + 1))
              : input.id;
      } catch {
        body = JSON.stringify({ ...input, expectedRevision: "invalid-id" });

        return dispatch();
      }

      const row =
        id === undefined
          ? null
          : await db.prepare(`SELECT revision FROM ${table} WHERE id=?`).bind(id).first();

      const revision = row
        ? Schema.decodeUnknownSync(Schema.Struct({ revision: Schema.String }))(row).revision
        : null;

      body = JSON.stringify({ ...input, expectedRevision: revision });
    }
  }

  return worker.dispatchFetch(`http://localhost/api/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body,
  });
};

// Historical writer intentionally predates revision and snapshot columns.
function legacyRecipeStatement(db: D1Database, recipe: typeof RecipeSchema.Type) {
  return db
    .prepare(`INSERT INTO recipes(id,title,description,servings,minutes,category,photo,source,ingredients,instructions)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,
    servings=excluded.servings,minutes=excluded.minutes,category=excluded.category,photo=excluded.photo,source=excluded.source,
    ingredients=excluded.ingredients,instructions=excluded.instructions`)
    .bind(
      recipe.id,
      recipe.title,
      recipe.description,
      recipe.servings,
      recipe.minutes,
      recipe.category,
      recipe.photo,
      recipe.source,
      JSON.stringify(recipe.ingredients),
      JSON.stringify(recipe.instructions),
    );
}

describe("real Worker with disposable SQLite D1", () => {
  it("extracts legacy uploads once, keeps customized snapshots, supports old SQL writers and safely reapplies the photo migration", async () => {
    const legacy = new Miniflare(options("true"));

    try {
      const db = await legacy.getD1Database("DB");

      const migrate = async (name: string) => {
        const sql = await readFile(`migrations/${name}`, "utf8");
        await db.batch(
          sql
            .replace(/^--.*$/gm, "")
            .split(/;\s*\n(?=CREATE|INSERT|DROP|ALTER|UPDATE)|;\s*$/)
            .filter((s) => s.trim())
            .map((s) => db.prepare(s)),
        );
      };

      for (const name of (await readdir("migrations"))
        .filter((name) => name.endsWith(".sql") && name < "0013_photos.sql")
        .sort())
        await migrate(name);
      const source = { ...sampleRecipes[0], photo: uploadedPng };
      const custom = { ...source, title: "Customized meal photo", photo: uploadedWebp };
      const external = { ...source, photo: "https://example.com/private-dinner.png" };
      await legacyRecipeStatement(db, source).run();
      await legacyRecipeStatement(db, { ...sampleRecipes[1], photo: uploadedPng }).run();

      for (const [id, recipe] of [
        ["shared", source],
        ["custom", custom],
        ["external", external],
      ] as const)
        await db
          .prepare(
            "INSERT INTO meals(id,recipeId,date,slot,scale,note,recipe) VALUES(?,?,'2026-09-21','Dinner',1,'',?)",
          )
          .bind(id, source.id, JSON.stringify(recipe))
          .run();
      await db
        .prepare(
          "INSERT INTO meals(id,recipeId,date,slot,scale,note) VALUES('note',NULL,'2026-09-21','Lunch',1,'Picnic')",
        )
        .run();

      await migrate("0013_photos.sql");
      await migrate("0015_shopping_lists.sql");

      const read = async () =>
        Schema.decodeUnknownSync(HouseholdSchema)(
          await (await legacy.dispatchFetch("http://localhost/api/household")).json(),
        );

      const photos = async () =>
        Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ path: Schema.String, data: Schema.String })))(
          (await db.prepare("SELECT path,data FROM photos ORDER BY path").all()).results,
        );

      const assets = await photos();
      expect(assets).toHaveLength(2);
      const sharedPath = assets.find((asset) => asset.data === uploadedPng)?.path;
      const customPath = assets.find((asset) => asset.data === uploadedWebp)?.path;
      expect(sharedPath).toMatch(/^\/photos\/upload-[a-p]{64}\.jpg$/);
      expect(customPath).toMatch(/^\/photos\/upload-[a-p]{64}\.jpg$/);
      const migrated = await read();
      expect(migrated.recipes.map((recipe) => recipe.photo)).toEqual([sharedPath, sharedPath]);
      expect(migrated.meals.find((entry) => entry.id === "shared")?.recipe).toEqual({
        ...source,
        photo: sharedPath,
      });
      expect(migrated.meals.find((entry) => entry.id === "custom")?.recipe).toEqual({
        ...custom,
        photo: customPath,
      });
      expect(migrated.meals.find((entry) => entry.id === "external")?.recipe).toEqual(external);
      expect(migrated.meals.find((entry) => entry.id === "note")?.recipe).toBeNull();

      // A current upload must reuse a migrated random ID, not create a second hash-addressed asset.
      const saved = await legacy.dispatchFetch("http://localhost/api/recipes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...source, id: "current-upload", expectedRevision: null }),
      });

      expect(saved.status).toBe(200);
      expect((await read()).recipes.find((recipe) => recipe.id === "current-upload")?.photo).toBe(sharedPath);
      expect(await photos()).toEqual(assets);

      // Both INSERT and UPDATE from pre-photo Workers still extract inline values.
      await legacyRecipeStatement(db, { ...source, id: RecipeId.make("old-writer") }).run();
      expect((await read()).recipes.find((recipe) => recipe.id === "old-writer")?.photo).toBe(sharedPath);
      await legacyRecipeStatement(db, {
        ...source,
        id: RecipeId.make("old-writer"),
        photo: uploadedWebp,
      }).run();
      await db
        .prepare(
          "INSERT INTO meals(id,recipeId,date,slot,scale,note) VALUES('old-capture','old-writer','2026-09-21','Dinner',1,'')",
        )
        .run();
      expect((await read()).meals.find((entry) => entry.id === "old-capture")?.recipe?.photo).toBe(
        customPath,
      );
      await db
        .prepare(
          "INSERT INTO meals(id,recipeId,date,slot,scale,note,recipe) VALUES('old-explicit',?,'2026-09-21','Dinner',1,'',?)",
        )
        .bind(source.id, JSON.stringify(custom))
        .run();
      expect((await read()).meals.find((entry) => entry.id === "old-explicit")?.recipe?.photo).toBe(
        customPath,
      );
      await db
        .prepare("UPDATE meals SET recipe=? WHERE id='old-explicit'")
        .bind(JSON.stringify(source))
        .run();
      expect((await read()).meals.find((entry) => entry.id === "old-explicit")?.recipe?.photo).toBe(
        sharedPath,
      );
      expect((await read()).meals.find((entry) => entry.id === "custom")?.recipe?.photo).toBe(customPath);
      expect(await photos()).toEqual(assets);

      // Old INSERT and UPDATE triggers must also create previously unseen assets.
      for (const [index, file] of ["chicken", "pasta", "bowl", "soup"].entries()) {
        const data = `data:image/jpeg;base64,${Buffer.from(await readFile(`public/photos/${file}.jpg`)).toString("base64")}`;

        if (index < 2) {
          await legacyRecipeStatement(db, {
            ...source,
            id: RecipeId.make("old-new-upload"),
            photo: data,
          }).run();
        } else if (index === 2) {
          await db
            .prepare(
              "INSERT INTO meals(id,recipeId,date,slot,scale,note,recipe) VALUES('old-new-meal',?,'2026-09-21','Dinner',1,'',?)",
            )
            .bind(source.id, JSON.stringify({ ...source, photo: data }))
            .run();
        } else {
          await db
            .prepare("UPDATE meals SET recipe=? WHERE id='old-new-meal'")
            .bind(JSON.stringify({ ...source, photo: data }))
            .run();
        }

        const asset = (await photos()).find((asset) => asset.data === data);
        expect(asset?.path).toMatch(/^\/photos\/upload-[a-p]{64}\.jpg$/);
        const state = await read();
        expect(
          index < 2
            ? state.recipes.find((recipe) => recipe.id === "old-new-upload")?.photo
            : state.meals.find((entry) => entry.id === "old-new-meal")?.recipe?.photo,
        ).toBe(asset?.path);
        expect(await photos()).toHaveLength(3 + index);
      }

      const orphanPath = `/photos/upload-${"d".repeat(64)}.jpg`;
      await db
        .prepare("INSERT INTO photos(path,data) VALUES(?,?)")
        .bind(orphanPath, "data:image/jpeg;base64,/9j/2Q==")
        .run();
      const beforeReapply = await read();
      const retained = await photos();
      await migrate("0013_photos.sql");
      expect(await photos()).toEqual(retained);
      expect(await read()).toEqual(beforeReapply);
      await expect(
        db.prepare("UPDATE photos SET data=? WHERE path=?").bind(uploadedPng, orphanPath).run(),
      ).rejects.toThrow();
      expect(await photos()).toEqual(retained);
    } finally {
      await legacy.dispose();
    }
  }, 30_000);

  it("upgrades an already-applied snapshot-only 0011 without losing customized meals", async () => {
    const legacy = new Miniflare(options("true"));

    try {
      const db = await legacy.getD1Database("DB");

      const migrate = async (file: string, originalSnapshot = false) => {
        let sql = await readFile(`migrations/${file}`, "utf8");

        if (originalSnapshot) sql = sql.split("-- Overlapping Workers")[0];
        await db.batch(
          sql
            .replace(/^--.*$/gm, "")
            .split(/;\s*\n(?=CREATE|INSERT|DROP|ALTER|UPDATE)|;\s*$/)
            .filter((s) => s.trim())
            .map((s) => db.prepare(s)),
        );
      };

      for (const file of [
        "0001_initial.sql",
        "0002_recipe_rating.sql",
        "0003_collections.sql",
        "0004_groceries.sql",
        "0005_ingredient_matching.sql",
        "0006_meal_notes.sql",
        "0010_shopping_packages.sql",
      ])
        await migrate(file);
      await legacyRecipeStatement(db, sampleRecipes[0]).run();
      await legacyRecipeStatement(db, sampleRecipes[1]).run();
      await migrate("0011_meal_recipes.sql", true);
      const custom = { ...sampleRecipes[0], title: "Keep this customized dinner" };
      await db.batch([
        db
          .prepare(
            "INSERT INTO meals(id,recipeId,date,slot,scale,note) VALUES('null-snapshot',?,'2026-09-21','Dinner',1,'')",
          )
          .bind(sampleRecipes[0].id),
        db
          .prepare(
            "INSERT INTO meals(id,recipeId,date,slot,scale,note,recipe) VALUES('wrong-source',?,'2026-09-21','Dinner',1,'',?)",
          )
          .bind(sampleRecipes[1].id, JSON.stringify(sampleRecipes[0])),
        db
          .prepare(
            "INSERT INTO meals(id,recipeId,date,slot,scale,note,recipe) VALUES('custom',?,'2026-09-21','Dinner',1,'',?)",
          )
          .bind(sampleRecipes[0].id, JSON.stringify(custom)),
        db
          .prepare(
            "INSERT INTO meals(id,recipeId,date,slot,scale,note,recipe) VALUES('note',NULL,'2026-09-21','Dinner',1,'Takeout',?)",
          )
          .bind(JSON.stringify(sampleRecipes[0])),
      ]);
      await migrate("0012_entity_revisions.sql");
      await migrate("0013_photos.sql");
      await migrate("0015_shopping_lists.sql");

      const read = async () =>
        Schema.decodeUnknownSync(HouseholdSchema)(
          await (await legacy.dispatchFetch("http://localhost/api/household")).json(),
        );

      const upgraded = await read();
      expect(upgraded.meals.find((row) => row.id === "custom")?.recipe).toEqual(custom);
      expect(upgraded.meals.find((row) => row.id === "null-snapshot")?.recipe).toEqual(sampleRecipes[0]);
      expect(upgraded.meals.find((row) => row.id === "wrong-source")?.recipe).toEqual(sampleRecipes[1]);
      expect(upgraded.meals.find((row) => row.id === "note")?.recipe).toBeNull();
      expect(upgraded.meals.every((row) => row.revision?.length === 32)).toBe(true);
      // The old writer still omits both new columns after the additive migration.
      await db
        .prepare(
          "INSERT INTO meals(id,recipeId,date,slot,scale,note) VALUES('after-upgrade',?,'2026-09-21','Dinner',1,'')",
        )
        .bind(sampleRecipes[0].id)
        .run();
      expect((await read()).meals.find((row) => row.id === "after-upgrade")?.recipe).toEqual(
        sampleRecipes[0],
      );
      await db
        .prepare("UPDATE meals SET recipeId=? WHERE id='after-upgrade'")
        .bind(sampleRecipes[1].id)
        .run();
      expect((await read()).meals.find((row) => row.id === "after-upgrade")?.recipe).toEqual(
        sampleRecipes[1],
      );
    } finally {
      await legacy.dispose();
    }
  });

  it("rejects stale, missing, creation-conflicting and deleted-version writes for every structural resource", async () => {
    const raw = (path: string, method: string, input: typeof Schema.Json.Type) =>
      worker.dispatchFetch(`http://localhost/api/${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });

    const read = async () =>
      Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

    const fixtures = [
      ["recipes", { ...sampleRecipes[0], id: "guard-recipe", category: "" }],
      ["meals", { ...meal, id: "guard-meal", recipeId: null, note: "Original note" }],
      [
        "groceries",
        { id: "guard-grocery", name: "Beans", url: "", aisle: "1", quantity: 1, unit: "can", aliases: [] },
      ],
      [
        "shopping-items",
        {
          id: "guard-shopping",
          name: "Rice",
          url: "",
          aisle: "2",
          quantity: 1,
          unit: "kg",
          aliases: [],
          listId: "guard-quick-list",
        },
      ],
      ["collections", { id: "guard-collection", name: "Guard collection" }],
      ["shopping-lists", { id: "guard-list", date: "2026-09-26", label: "Top-up" }],
    ] as const;

    expect(
      (
        await raw("shopping-lists", "PUT", {
          id: "guard-quick-list",
          date: "2026-09-26",
          label: "",
          expectedRevision: null,
        })
      ).status,
    ).toBe(200);

    for (const [path, fixture] of fixtures) {
      const resource = path === "shopping-items" ? "groceries" : path;
      const key = resource === "shopping-lists" ? "shoppingLists" : resource;
      const oldClient = await raw(path, "PUT", fixture);
      expect(oldClient.status).toBe(409);
      expect(await oldClient.json()).toEqual({
        error: "Reload the app to get the latest version before saving or deleting; no changes were applied.",
      });
      expect((await raw(path, "PUT", { ...fixture, expectedRevision: null })).status).toBe(200);
      const first = (await read())[key].find((row) => row.id === fixture.id);

      if (!first?.revision) throw new Error("Persisted revision missing");
      expect(first.revision).toMatch(/^[a-f0-9]{32}$/);
      expect((await raw(path, "PUT", { ...fixture, expectedRevision: null })).status).toBe(409);
      expect((await raw(path, "PUT", { ...fixture, expectedRevision: first.revision })).status).toBe(200);
      const second = (await read())[key].find((row) => row.id === fixture.id);

      if (!second?.revision) throw new Error("Updated revision missing");
      expect(second.revision).not.toBe(first.revision);
      const beforeRejected = await read();
      const staleClient = await raw(path, "PUT", { ...fixture, expectedRevision: first.revision });
      expect(staleClient.status).toBe(409);
      expect(await staleClient.json()).toEqual({
        error:
          path === "collections"
            ? "This collection changed, no longer exists, or its name is already in use. Reload before saving."
            : "This item changed or no longer exists. Reload the latest household before saving or deleting; your changes were not applied.",
      });
      expect((await raw(path, "PUT", fixture)).status).toBe(409);

      for (const body of [undefined, "{}", JSON.stringify({ revision: second.revision })]) {
        const unguardedDelete = await worker.dispatchFetch(`http://localhost/api/${resource}/${fixture.id}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body,
        });

        expect(unguardedDelete.status).toBe(409);
        expect(await unguardedDelete.json()).toEqual({
          error:
            "Reload the app to get the latest version before saving or deleting; no changes were applied.",
        });
      }

      expect(
        (await raw(`${resource}/${fixture.id}`, "DELETE", { expectedRevision: first.revision })).status,
      ).toBe(409);
      expect(await read()).toEqual(beforeRejected);
      expect(
        (await raw(`${resource}/${fixture.id}`, "DELETE", { expectedRevision: second.revision })).status,
      ).toBe(200);
      expect((await raw(path, "PUT", { ...fixture, expectedRevision: second.revision })).status).toBe(409);
      expect(
        (await raw(`${resource}/${fixture.id}`, "DELETE", { expectedRevision: second.revision })).status,
      ).toBe(409);
      expect((await raw(path, "PUT", { ...fixture, expectedRevision: null })).status).toBe(200);
      const recreated = (await read())[key].find((row) => row.id === fixture.id);
      expect(recreated?.revision).not.toBe(second.revision);
      expect(
        (await raw(`${resource}/${fixture.id}`, "DELETE", { expectedRevision: second.revision })).status,
      ).toBe(409);
    }

    const order = { aisles: ["1"], items: [] };
    expect((await raw("shopping-order", "PUT", order)).status).toBe(409);
    expect((await raw("shopping-order", "PUT", { ...order, expectedRevision: null })).status).toBe(409);
    const first = (await read()).shoppingOrder;

    if (!first.revision) throw new Error("Order revision missing");
    expect((await raw("shopping-order", "PUT", { ...order, expectedRevision: null })).status).toBe(409);
    expect(
      (await raw("shopping-order", "PUT", { ...order, aisles: ["2"], expectedRevision: first.revision }))
        .status,
    ).toBe(200);
    expect((await raw("shopping-order", "PUT", { ...order, expectedRevision: first.revision })).status).toBe(
      409,
    );
    expect((await read()).shoppingOrder.aisles).toEqual(["2"]);
  });

  it("merges note-only intent with newer meal structure and never resurrects deleted meals or shopping lists", async () => {
    const raw = (path: string, method: string, input: typeof Schema.Json.Type) =>
      worker.dispatchFetch(`http://localhost/api/${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });

    const read = async () =>
      Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

    await send("recipes", "PUT", JSON.stringify(sampleRecipes[0]));
    await send("meals", "PUT", JSON.stringify(meal));
    const stale = (await read()).meals[0];

    if (!stale.revision || !stale.recipe) throw new Error("Missing meal");

    const latest = {
      ...stale,
      date: "2026-09-22",
      recipe: { ...stale.recipe, title: "Meal-only edit" },
      expectedRevision: stale.revision,
    };

    expect((await raw("meals", "PUT", latest)).status).toBe(200);
    expect(
      (await raw("meals", "PUT", { ...stale, note: "Lost update", expectedRevision: stale.revision })).status,
    ).toBe(409);
    expect(
      (await raw(`meals/${stale.id}`, "PATCH", { note: "New note", expectedNote: stale.note })).status,
    ).toBe(200);
    expect((await read()).meals[0]).toMatchObject({
      date: latest.date,
      note: "New note",
      recipe: { title: "Meal-only edit" },
    });
    expect(
      (await raw(`meals/${stale.id}`, "PATCH", { note: "Other note", expectedNote: stale.note })).status,
    ).toBe(409);
    const current = (await read()).meals[0];
    expect(
      (await raw(`meals/${stale.id}`, "DELETE", { expectedRevision: current.revision ?? "missing" })).status,
    ).toBe(200);
    expect(
      (await raw(`meals/${stale.id}`, "PATCH", { note: "Recreate", expectedNote: "New note" })).status,
    ).toBe(409);
    await send(
      "groceries",
      "PUT",
      JSON.stringify({
        id: "soap",
        name: "Soap",
        url: "",
        aisle: "",
        quantity: 1,
        unit: "each",
        aliases: [],
      }),
    );
    await send(
      "shopping-lists",
      "PUT",
      JSON.stringify({ id: "patch-list", date: "2026-09-26", label: "Original" }),
    );
    expect(
      (await raw("shopping-lists/patch-list/items", "POST", { items: [{ groceryId: "soap" }] })).status,
    ).toBe(200);
    await send(
      "shopping-lists",
      "PUT",
      JSON.stringify({ id: "patch-list", date: "2026-09-26", label: "Renamed" }),
    );
    // A field-scoped check applies to the renamed list without needing its new revision.
    expect((await raw("shopping-lists/patch-list/items/soap", "PATCH", { checked: 1 })).status).toBe(200);
    expect((await read()).shoppingLists[0]).toMatchObject({ label: "Renamed" });
    expect((await read()).shoppingItems[0]).toMatchObject({
      listId: "patch-list",
      groceryId: "soap",
      checked: 1,
    });
    await send("shopping-lists/patch-list", "DELETE", "{}");
    expect((await raw("shopping-lists/patch-list/items/soap", "PATCH", { checked: 0 })).status).toBe(400);
    expect(
      (await raw("shopping-lists/patch-list/items", "POST", { items: [{ groceryId: "soap" }] })).status,
    ).toBe(400);
    const db = await worker.getD1Database("DB");
    expect(await db.prepare("SELECT count(*) AS count FROM shopping_list_items").first()).toEqual({
      count: 0,
    });
    expect((await read()).shoppingLists).toEqual([]);
  });

  it("captures snapshots and rotates tokens for overlapping old SQL writers and indirect cleanup", async () => {
    const db = await worker.getD1Database("DB");

    const read = async () =>
      Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

    await legacyRecipeStatement(db, sampleRecipes[0]).run();
    await legacyRecipeStatement(db, sampleRecipes[1]).run();

    const oldMeal = (recipeId: string | null, note = "Old writer") =>
      db
        .prepare(
          `INSERT INTO meals(id,recipeId,date,slot,scale,note) VALUES('rolling',?,'2026-09-21','Dinner',1,?) ON CONFLICT(id) DO UPDATE SET recipeId=excluded.recipeId,note=excluded.note`,
        )
        .bind(recipeId, note)
        .run();

    await oldMeal(sampleRecipes[0].id);
    const initial = (await read()).meals[0];
    expect(initial.recipe).toEqual(sampleRecipes[0]);
    await db
      .prepare("UPDATE recipes SET title='New source title' WHERE id=?")
      .bind(sampleRecipes[0].id)
      .run();
    await oldMeal(sampleRecipes[0].id, "Same source");
    const preserved = (await read()).meals[0];
    expect(preserved.recipe).toEqual(initial.recipe);
    expect(preserved.revision).not.toBe(initial.revision);
    await oldMeal(sampleRecipes[1].id);
    expect((await read()).meals[0].recipe).toEqual(sampleRecipes[1]);
    await oldMeal(null, "Now a note");
    expect((await read()).meals[0].recipe).toBeNull();
    await oldMeal(sampleRecipes[0].id);
    expect((await read()).meals[0].recipe?.title).toBe("New source title");
    const beforeRename = (await read()).recipes.find((row) => row.id === sampleRecipes[0].id);
    await db
      .prepare("UPDATE collections SET name='Renamed category' WHERE name=?")
      .bind(sampleRecipes[0].category)
      .run();
    const renamed = (await read()).recipes.find((row) => row.id === sampleRecipes[0].id);
    expect(renamed?.revision).not.toBe(beforeRename?.revision);
    await send(
      "groceries",
      "PUT",
      JSON.stringify({
        id: "indirect",
        name: "Oil",
        url: "",
        aisle: "1",
        quantity: 1,
        unit: "l",
        aliases: [],
      }),
    );
    await db
      .prepare("UPDATE recipes SET ingredients=? WHERE id=?")
      .bind(
        JSON.stringify([{ name: "Oil", quantity: 1, unit: "l", groceryItemId: "indirect" }]),
        sampleRecipes[0].id,
      )
      .run();
    const linked = (await read()).recipes.find((row) => row.id === sampleRecipes[0].id);
    await send("groceries/indirect", "DELETE", "{}");
    const unlinked = (await read()).recipes.find((row) => row.id === sampleRecipes[0].id);
    expect(unlinked?.revision).not.toBe(linked?.revision);
    expect(unlinked?.ingredients[0].groceryItemId).toBeNull();
    await send(
      "shopping-lists",
      "PUT",
      JSON.stringify({ id: "indirect-list", date: "2026-09-26", label: "" }),
    );
    expect(
      (
        await send(
          "shopping-lists/indirect-list/items",
          "POST",
          JSON.stringify({ items: [{ groceryId: "indirect", packages: 5 }] }),
        )
      ).status,
    ).toBe(400);
    expect((await read()).groceries).toEqual([]);
    expect((await read()).shoppingItems).toEqual([]);
  });

  it("authenticates feedback, signs its preserved context and deduplicates safe retries without household writes", async () => {
    const ticket = {
      schemaVersion: 2,
      id: crypto.randomUUID(),
      clientSubmittedAt: "2026-10-01T12:34:56.789Z",
      request: "Add a clearer shopping empty state",
      context: feedbackContext,
    };

    const body = JSON.stringify(ticket);

    const sign = (common_name?: string) =>
      new SignJWT({
        iss: "https://saiaai.cloudflareaccess.com",
        aud: ["test-hearth"],
        sub: common_name ? "" : "household-user",
        email: "disposable.user@example.test",
        name: "Disposable User",
        common_name,
        exp: Math.floor(Date.now() / 1000) + 300,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .sign(signingKey);

    await worker.setOptions(options("false"));
    expect((await send("feedback", "POST", body)).status).toBe(403);

    const smoke = await worker.dispatchFetch("http://localhost/api/feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cf-Access-Jwt-Assertion": await sign("smoke-test.access"),
      },
      body,
    });

    expect(smoke.status).toBe(403);

    const headers = {
      "Content-Type": "application/json",
      "Cf-Access-Jwt-Assertion": await sign(),
      "Cf-Access-Authenticated-User-Email": "spoofed@example.test",
      Cookie: "disposable-cookie",
      Authorization: "Bearer disposable-bearer",
      "X-Hearth-Operation-Id": ticket.id,
    };

    expect(
      (
        await worker.dispatchFetch("http://localhost/api/feedback", {
          method: "POST",
          headers: { ...headers, "Sec-Fetch-Site": "cross-site" },
          body,
        })
      ).status,
    ).toBe(403);
    expect(feedbackDeliveries).toHaveLength(0);
    feedbackStatus = 503;

    const submit = () =>
      worker.dispatchFetch("http://localhost/api/feedback", { method: "POST", headers, body });

    const beforeReceipt = Date.now();
    expect((await submit()).status).toBe(503);
    let db = await worker.getD1Database("DB");
    expect(await db.prepare("SELECT queued FROM feedback WHERE id=?").bind(ticket.id).first()).toEqual({
      queued: 0,
    });
    feedbackStatus = 200;
    await worker.setOptions(options("false"));
    db = await worker.getD1Database("DB");
    const result = await submit();
    expect(result.status).toBe(202);
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(await result.json()).toEqual({ id: ticket.id, status: "queued" });
    expect((await submit()).status).toBe(202);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM feedback").first()).toEqual({ count: 1 });
    expect(await db.prepare("SELECT queued FROM feedback WHERE id=?").bind(ticket.id).first()).toEqual({
      queued: 1,
    });
    expect(feedbackDeliveries).toHaveLength(2);
    expect(feedbackDeliveries[0].body).toBe(feedbackDeliveries[1].body);

    for (const delivery of feedbackDeliveries) {
      const envelope = JSON.parse(delivery.body);
      expect(envelope).toMatchObject({
        ...ticket,
        context: {
          ...ticket.context,
          page: {
            ...ticket.context.page,
            url: "https://hearth.example.test/?source=text&access_token=%5Bredacted%5D&return_to=%5Bredacted%5D#shopping?mode=builder&search=rice&api_key=%5Bredacted%5D",
          },
        },
      });
      expect(envelope.delivery).toMatchObject({
        environment: "integration",
        build: "server-build-43",
        identity: {
          source: "cloudflare-access",
          subject: "household-user",
          email: "disposable.user@example.test",
          name: "Disposable User",
        },
        correlation: { operationId: ticket.id },
      });
      expect(Date.parse(envelope.delivery.receivedAt)).toBeGreaterThanOrEqual(beforeReceipt);
      expect(Date.parse(envelope.delivery.receivedAt)).toBeLessThanOrEqual(Date.now());
      expect(envelope.delivery.receivedAt).not.toBe(ticket.clientSubmittedAt);
      expect(envelope.delivery.correlation.requestId).toMatch(/^[a-f0-9-]{36}$/);
      expect(envelope.delivery.correlation.traceId).toMatch(/^[a-f0-9]{32}$/);

      for (const privateValue of [
        "disposable-password",
        "disposable-query-secret",
        "disposable-fragment-secret",
        "disposable-oauth-state",
        "disposable-cookie",
        "disposable-bearer",
        "spoofed@example.test",
        headers["Cf-Access-Jwt-Assertion"],
      ])
        expect(delivery.body).not.toContain(privateValue);
      expect(delivery.id).toBe(ticket.id);
      expect(delivery.signature).toBe(
        createHmac("sha256", "disposable-feedback-signing-key-for-smoke").update(delivery.body).digest("hex"),
      );
    }

    expect(
      (
        await worker.dispatchFetch("http://localhost/api/feedback", {
          method: "POST",
          headers,
          body: JSON.stringify({ ...ticket, request: "A different ask" }),
        })
      ).status,
    ).toBe(409);
    const household = await worker.dispatchFetch("http://localhost/api/household", { headers });
    expect(await household.json()).toMatchObject({
      recipes: [],
      meals: [],
      groceries: [],
      shoppingLists: [],
      shoppingItems: [],
    });
    await worker.setOptions(options("false", "test-hearth", "smoke-test.access", "preview-test.access"));

    const preview = await worker.dispatchFetch("http://localhost/api/feedback", {
      method: "POST",
      headers: { ...headers, "Cf-Access-Jwt-Assertion": await sign("preview-test.access") },
      body: JSON.stringify({ ...ticket, id: crypto.randomUUID() }),
    });

    expect(preview.status).toBe(202);
    expect(JSON.parse(feedbackDeliveries.at(-1)!.body).delivery.identity).toBeNull();
  });

  it("bounds feedback input and quota, rejects extra authority fields, and fails honestly when disconnected", async () => {
    const ticket = {
      schemaVersion: 2,
      id: crypto.randomUUID(),
      clientSubmittedAt: "2026-10-01T12:34:56.789Z",
      request: "Keep context",
      context: feedbackContext,
    };

    for (const invalid of [
      { ...ticket, request: " " },
      { ...ticket, request: "x".repeat(4001) },
      { ...ticket, project: "another/repo" },
      { ...ticket, schemaVersion: 1 },
      { ...ticket, clientSubmittedAt: "2026-02-31T12:34:56.789Z" },
      { ...ticket, clientSubmittedAt: undefined },
      { ...ticket, delivery: { identity: { email: "spoof@example.test" } } },
      { ...ticket, context: { ...ticket.context, browser: { ...ticket.context.browser, user: "spoof" } } },
      {
        ...ticket,
        context: {
          ...ticket.context,
          page: {
            ...ticket.context.page,
            view: { ...ticket.context.page.view, search: "Bearer disposable-search-credential" },
          },
        },
      },
      {
        ...ticket,
        context: { ...ticket.context, browser: { ...ticket.context.browser, userAgent: "x".repeat(1001) } },
      },
      {
        ...ticket,
        context: { ...ticket.context, page: { ...ticket.context.page, url: "javascript:alert(1)" } },
      },
    ])
      expect((await send("feedback", "POST", JSON.stringify(invalid))).status).toBe(400);
    expect((await send("feedback", "POST", "x".repeat(32001))).status).toBe(413);
    expect((await send("feedback", "PUT", JSON.stringify(ticket))).status).toBe(405);
    expect(feedbackDeliveries).toHaveLength(0);

    for (let i = 0; i < 10; i++)
      expect(
        (await send("feedback", "POST", JSON.stringify({ ...ticket, id: crypto.randomUUID() }))).status,
      ).toBe(202);
    expect((await send("feedback", "POST", JSON.stringify(ticket))).status).toBe(429);
    expect(JSON.parse(feedbackDeliveries[0].body).delivery.identity).toBeNull();
    const db = await worker.getD1Database("DB");
    expect(await db.prepare("SELECT COUNT(*) AS count FROM feedback").first()).toEqual({ count: 10 });

    const disconnected = options(
      "true",
      "test-hearth",
      "smoke-test.access",
      "",
      () => Response.json(publicKeys),
      false,
    );

    await worker.setOptions(disconnected);
    expect((await send("feedback", "POST", JSON.stringify(ticket))).status).toBe(503);
  });

  it("distinguishes malformed JSON from schema failures and never caches API responses", async () => {
    const routes = [
      ["groceries", "PUT", "Invalid grocery item."],
      ["shopping-order", "PUT", "Invalid shopping order."],
      ["collections", "PUT", "Add a collection name."],
      ["recipes/import", "POST", "Paste a NYT Cooking recipe URL."],
      ["recipes", "PUT", "The recipe is missing required fields."],
      ["recipes/rating/missing", "PUT", "Choose a valid recipe rating."],
      ["meals", "PUT", "The meal is missing required fields."],
      ["shopping-lists", "PUT", "Choose a list date and a label of 100 characters or less."],
      [
        "shopping-lists/missing/items",
        "POST",
        "Add between 1 and 500 groceries, each once, with whole package counts.",
      ],
      [
        "shopping-lists/missing/items/missing",
        "PATCH",
        "Choose checked or unchecked and a whole package count.",
      ],
      ["shopping-lists/missing/items", "DELETE", "Choose between 1 and 500 groceries to remove."],
    ];

    for (const [path, method, message] of routes) {
      for (const [body, error] of [
        ["{", "Please send valid JSON."],
        ["null", method === "PUT" && !path.includes("/") ? "Reload before saving." : message],
      ]) {
        const response = await send(path, method, body);
        expect(response.status).toBe(400);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(await response.json()).toEqual({ error });
      }
    }

    const missing = await worker.dispatchFetch("http://localhost/api/missing");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
    expect(await missing.json()).toEqual({ error: "That page couldn’t be found." });

    // The single global list's routes are gone rather than silently accepted.
    for (const [path, method] of [
      ["extras", "PUT"],
      ["extras/legacy", "PATCH"],
      ["extras/legacy", "DELETE"],
      ["checks", "PUT"],
      ["shopping-lists/missing/other", "POST"],
    ]) {
      const response = await worker.dispatchFetch(`http://localhost/api/${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "legacy", name: "Soap", checked: 0, key: '["shopping-list","x"]' }),
      });

      expect(response.status).toBe(404);
    }

    const success = await worker.dispatchFetch("http://localhost/api/household");
    expect(success.status).toBe(200);
    expect(success.headers.get("Cache-Control")).toBe("no-store");
  });
  it("maps D1 write failures and stored-data defects to distinct uncached server errors", async () => {
    const db = await worker.getD1Database("DB");
    await db
      .prepare(
        "CREATE TRIGGER reject_recipe BEFORE INSERT ON recipes BEGIN SELECT RAISE(ABORT, 'test write failure'); END",
      )
      .run();

    try {
      const failed = await send("recipes", "PUT", JSON.stringify(sampleRecipes[0]));
      expect(failed.status).toBe(500);
      expect(failed.headers.get("Cache-Control")).toBe("no-store");
      expect(await failed.json()).toEqual({
        error:
          "Household data is unavailable. Refresh to check the current state before retrying any changes.",
      });
      expect(await db.prepare("SELECT count(*) AS count FROM recipes").first()).toEqual({ count: 0 });
    } finally {
      await db.prepare("DROP TRIGGER reject_recipe").run();
    }

    expect((await send("recipes", "PUT", JSON.stringify(sampleRecipes[0]))).status).toBe(200);

    const grocery = {
      id: "corruption-check",
      name: "Rice",
      aliases: [],
      quantity: 1,
      unit: "g",
      aisle: "",
      url: "",
    };

    expect((await send("groceries", "PUT", JSON.stringify(grocery))).status).toBe(200);
    expect((await send("shopping-order", "PUT", JSON.stringify({ aisles: [], items: [] }))).status).toBe(200);

    const before = Schema.decodeUnknownSync(HouseholdSchema)(
      await (await worker.dispatchFetch("http://localhost/api/household")).json(),
    );

    for (const [corrupt, restore] of [
      [
        db.prepare("UPDATE recipes SET instructions='[1]'"),
        db.prepare("UPDATE recipes SET instructions=?").bind(JSON.stringify(sampleRecipes[0].instructions)),
      ],
      [db.prepare("UPDATE groceries SET aliases='[1]'"), db.prepare("UPDATE groceries SET aliases='[]'")],
      ...["aisles", "items"].flatMap((column) =>
        ["[1]", '["duplicate","duplicate"]', JSON.stringify(["x".repeat(1001)]), "{}", "{"].map((value) => [
          db.prepare(`UPDATE shopping_order SET ${column}=?`).bind(value),
          db.prepare(`UPDATE shopping_order SET ${column}='[]'`),
        ]),
      ),
    ]) {
      try {
        await corrupt.run();
        const defect = await worker.dispatchFetch("http://localhost/api/household");
        expect(defect.status).toBe(500);
        expect(defect.headers.get("Cache-Control")).toBe("no-store");
        expect(await defect.json()).toEqual({
          error:
            "Some saved household data couldn’t be read. Refresh to check the current state before retrying any changes. If this continues, report it with the request ID.",
        });
      } finally {
        await restore.run();
      }

      const recovered = await worker.dispatchFetch("http://localhost/api/household");
      expect(recovered.status).toBe(200);
      expect(Schema.decodeUnknownSync(HouseholdSchema)(await recovered.json())).toEqual({
        ...before,
        recipes: before.recipes.map((row) => ({ ...row, revision: expect.any(String) })),
        groceries: before.groceries.map((row) => ({ ...row, revision: expect.any(String) })),
        shoppingOrder: { ...before.shoppingOrder, revision: expect.any(String) },
      });
    }
  });
  it("builds a persistent manual grocery list independently of recipes and meal scales", async () => {
    const put = async (path: string, value: typeof Schema.Json.Type) => {
      expect((await send(path, "PUT", JSON.stringify(value))).status).toBe(200);
    };

    const state = async () =>
      Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

    const products = Schema.decodeUnknownSync(Schema.Array(GroceryItemSchema))([
      {
        id: "rice",
        name: "Rice bag",
        aliases: ["rice", "white rice"],
        quantity: 500,
        unit: "g",
        aisle: "10",
        url: "",
      },
      { id: "beef", name: "Beef", aliases: [], quantity: 1, unit: "lb", aisle: "2", url: "" },
      {
        id: "limes",
        name: "Fresh limes",
        aliases: ["lime"],
        quantity: 2,
        unit: "lb",
        aisle: "Produce",
        url: "https://www.shoprite.com/sm/pickup/rsid/3000/product/fresh-limes-2-lb-bag-id-00000000096867",
      },
      { id: "oil", name: "Oil", aliases: [], quantity: 500, unit: "ml", aisle: "10", url: "" },
      { id: "bread", name: "Bread", aliases: [], quantity: 20, unit: "slice", aisle: "Bakery", url: "" },
      { id: "boundary", name: "Boundary", aliases: [], quantity: 0.3, unit: "g", aisle: "", url: "" },
      { id: "above", name: "Above boundary", aliases: [], quantity: 300, unit: "g", aisle: "2", url: "" },
      { id: "half", name: "Half pack", aliases: [], quantity: 500, unit: "g", aisle: "2", url: "" },
    ]);

    for (const item of products) await put("groceries", item);

    const first = Schema.decodeUnknownSync(RecipeSchema)({
      ...sampleRecipes[0],
      id: "first",
      title: "First dinner",
      ingredients: [
        { name: "rice", quantity: 200, unit: "g" },
        { name: "Beef", quantity: 8, unit: "oz" },
        { name: "lime", quantity: 2, unit: "each" },
        { name: "Oil", quantity: 16, unit: "tbsp" },
        { name: "Bread", quantity: 1, unit: "slice" },
        { name: "Boundary", quantity: 0.1, unit: "g" },
      ],
    });

    const second = Schema.decodeUnknownSync(RecipeSchema)({
      ...sampleRecipes[0],
      id: "second",
      title: "Second dinner",
      ingredients: [
        { name: "white rice", quantity: 0.1, unit: "kg" },
        { name: "Beef", quantity: 4, unit: "oz" },
        { name: "lime", quantity: 1, unit: "lb" },
        { name: "Oil", quantity: 0.5, unit: "cup" },
        { name: "Bread", quantity: 0.5, unit: "slice" },
        { name: "Boundary", quantity: 0.15, unit: "g" },
        { name: "Above boundary", quantity: 300.00001, unit: "g" },
        { name: "Half pack", quantity: 250, unit: "g" },
        { name: "Unknown garnish", quantity: 1, unit: "bunch" },
      ],
    });

    await put("recipes", first);
    await put("recipes", second);
    await put("meals", { ...meal, id: "first-meal", recipeId: "first", date: "2026-09-21", scale: 1.5 });
    await put("meals", { ...meal, id: "second-meal", recipeId: "second", date: "2026-09-27", scale: 1 });
    await put("meals", { ...meal, id: "outside", recipeId: "second", date: "2026-09-28", scale: 100 });
    await put("shopping-lists", { id: "week", date: "2026-09-26", label: "" });
    await put("shopping-lists", { id: "top-up", date: "2026-09-30", label: "Top-up" });
    let household = await state();

    const list = (listId = "week") =>
      shoppingList(
        household.groceries,
        household.shoppingOrder,
        household.shoppingItems.filter((entry) => entry.listId === listId),
      );

    let items = list();

    const byId = (id: string) => {
      const item = items.find((item) => item.grocery?.id === id);

      if (!item) throw new Error(`Expected grocery ${id} in the shopping list.`);

      return item;
    };

    expect(items).toHaveLength(products.length);
    // Planned meals alone never put catalog groceries on a list.
    expect(items.every((item) => item.entry === undefined)).toBe(true);
    expect([...new Set(items.filter((item) => item.grocery).map((item) => item.grocery?.aisle))]).toEqual([
      "2",
      "10",
      "Bakery",
      "Produce",
      "",
    ]);
    expect(items.filter((item) => item.grocery?.aisle === "10").map((item) => item.name)).toEqual([
      "Oil",
      "Rice bag",
    ]);

    const add = async (listId: string, groceryId: string, packages?: number) => {
      const response = await send(
        `shopping-lists/${listId}/items`,
        "POST",
        JSON.stringify({ items: [{ groceryId, packages }] }),
      );

      expect(response.status).toBe(200);
    };

    const onList = { listId: "week", groceryId: "rice", checked: 0, packages: 1, sources: [] };
    // Adding puts the catalog grocery on one list; the row must survive household refreshes.
    await add("week", "rice");
    await add("top-up", "rice", 4);

    const order = {
      aisles: ["Produce", "Bakery", "10", "2", ""],
      items: [byId("rice").key, byId("oil").key],
    };

    await put("shopping-order", order);
    household = await state();
    items = list();
    expect(items[0].grocery?.id).toBe("limes");
    expect(items.filter((item) => item.grocery?.aisle === "10").map((item) => item.name)).toEqual([
      "Rice bag",
      "Oil",
    ]);
    expect(byId("rice").entry).toMatchObject(onList);
    expect(items.filter((item) => item.entry).map((item) => item.grocery.id)).toEqual(["rice"]);
    await put("meals", { ...meal, id: "second-meal", recipeId: "second", date: "2026-09-27", scale: 1.1 });
    household = await state();
    items = list();
    expect(byId("rice").entry).toMatchObject(onList);
    await put("groceries", { ...products[0], quantity: 750, name: "Renamed rice" });
    household = await state();
    items = list();
    // Catalog edits change neither membership nor the package count chosen on each list.
    expect(byId("rice").entry).toMatchObject(onList);
    expect(list("top-up").find((item) => item.grocery.id === "rice")?.entry).toMatchObject({
      ...onList,
      listId: "top-up",
      packages: 4,
    });

    const removed = await send(
      "shopping-lists/week/items",
      "DELETE",
      JSON.stringify({ groceryIds: ["rice"] }),
    );

    expect(await removed.json()).toEqual({ removed: 1 });
    expect(household.shoppingOrder).toEqual({ ...order, revision: expect.any(String) });
    household = await state();
    items = list();
    expect(byId("rice").entry).toBeUndefined();
    expect(list("top-up").find((item) => item.grocery.id === "rice")?.entry?.packages).toBe(4);
  });

  it("does not revive list membership after a late list write and same-ID product recreation", async () => {
    const put = (path: string, value: typeof Schema.Json.Type) => send(path, "PUT", JSON.stringify(value));

    const post = (path: string, value: typeof Schema.Json.Type) => send(path, "POST", JSON.stringify(value));

    const product = {
      id: 'late-"rice\\雪',
      name: "Rice",
      url: "",
      aisle: "Pantry",
      quantity: 500,
      unit: "g",
      aliases: [],
    };

    const db = await worker.getD1Database("DB");

    const membership = (groceryId = product.id) =>
      db
        .prepare("SELECT checked,packages FROM shopping_list_items WHERE list_id='late' AND grocery_id=?")
        .bind(groceryId)
        .first();

    const add = (items: typeof Schema.Json.Type) => post("shopping-lists/late/items", { items });

    const patch = (value: typeof Schema.Json.Type, groceryId = product.id) =>
      send(`shopping-lists/late/items/${encodeURIComponent(groceryId)}`, "PATCH", JSON.stringify(value));

    expect((await put("shopping-lists", { id: "late", date: "2026-09-26", label: "" })).status).toBe(200);
    expect((await put("groceries", product)).status).toBe(200);
    expect(await (await add([{ groceryId: product.id, packages: 3 }])).json()).toMatchObject({
      added: [product.id],
    });
    // Another client updates the amount after a recipe review was opened.
    expect((await patch({ packages: 5 })).status).toBe(200);
    expect(await (await add([{ groceryId: product.id, packages: 2 }])).json()).toEqual({
      added: [],
      updated: [],
      unchanged: [],
      conflicts: [{ groceryId: product.id, checked: 0, packages: 5 }],
    });
    expect(await membership()).toEqual({ checked: 0, packages: 5 });

    for (const packages of [0, -1, 1.5, 1_000_001]) {
      expect((await add([{ groceryId: product.id, packages, replace: true }])).status).toBe(400);
      expect((await patch({ packages })).status).toBe(400);
    }

    expect(await membership()).toEqual({ checked: 0, packages: 5 });
    expect((await put("groceries", { ...product, name: "Renamed rice", quantity: 750 })).status).toBe(200);
    expect(await membership()).toEqual({ checked: 0, packages: 5 });

    // Force the harmful ordering: deletion commits before the delayed list-add reaches D1.
    expect((await send(`groceries/${encodeURIComponent(product.id)}`, "DELETE", "")).status).toBe(200);
    expect(await membership()).toBeNull();
    const late = await add([{ groceryId: product.id }]);
    expect((await patch({ checked: 1 })).status).toBe(400);
    const orphan = await membership();
    expect((await put("groceries", product)).status).toBe(200);
    const revived = await membership();
    expect(orphan).toBeNull();
    expect(revived).toBeNull();
    expect(late.status).toBe(400);
    expect(await late.json()).toEqual({
      error:
        "Some of those groceries no longer exist. Refresh the groceries before adding them; no items were added.",
    });

    // A genuine addition to the recreated product starts fresh; removal is idempotent.
    expect((await add([{ groceryId: product.id }])).status).toBe(200);
    expect(await membership()).toEqual({ checked: 0, packages: 1 });

    for (const removed of [1, 0]) {
      const response = await send(
        "shopping-lists/late/items",
        "DELETE",
        JSON.stringify({ groceryIds: [product.id] }),
      );

      expect(await response.json()).toEqual({ removed });
    }

    expect(await membership()).toBeNull();

    // Either database ordering of overlapping DELETE/add requests must leave no orphan.
    for (let attempt = 0; attempt < 12; attempt++) {
      expect((await put("groceries", product)).status).toBe(200);
      const remove = () => send(`groceries/${encodeURIComponent(product.id)}`, "DELETE", "");
      const addOne = () => add([{ groceryId: product.id }]);

      const [deleted, added] =
        attempt % 2
          ? await Promise.all([addOne(), remove()]).then(([a, d]) => [d, a])
          : await Promise.all([remove(), addOne()]);

      expect(deleted.status).toBe(200);
      expect([200, 400]).toContain(added.status);
      expect(await db.prepare("SELECT id FROM groceries WHERE id=?").bind(product.id).first()).toBeNull();
      expect(await membership()).toBeNull();
    }

    // Unicode and control-character IDs round-trip through the body and the encoded item path.
    for (const id of ["line\nfeed\t\u0000", "emoji-🛒/rice"]) {
      expect((await put("groceries", { ...product, id })).status).toBe(200);
      expect((await add([{ groceryId: id }])).status).toBe(200);
      expect((await patch({ checked: 1 }, id)).status).toBe(200);
      expect(await membership(id)).toEqual({ checked: 1, packages: 1 });
      expect((await send(`groceries/${encodeURIComponent(id)}`, "DELETE", "")).status).toBe(200);
      expect(await membership(id)).toBeNull();
      expect((await add([{ groceryId: id }])).status).toBe(400);
    }
  });

  it("cleans historical orphan memberships without changing live memberships or legacy checks", async () => {
    const db = await worker.getD1Database("DB");
    expect((await send("demo?today=2026-09-21", "POST", "{}")).status).toBe(200);

    const state = Schema.decodeUnknownSync(HouseholdSchema)(
      await (await worker.dispatchFetch("http://localhost/api/household")).json(),
    );

    const live = { key: JSON.stringify(["shopping-list", state.groceries[0].id]), checked: 0 };
    const orphan = { key: '["shopping-list","deleted-product"]', checked: 0 };
    const legacy = { key: "range-ingredient-total", checked: 1 };
    const legacyCatalog = { key: '["Shopping-list","deleted-product"]', checked: 1 };

    for (const check of [live, orphan, legacy, legacyCatalog])
      await db.prepare("INSERT INTO checks(key,checked) VALUES(?,?)").bind(check.key, check.checked).run();

    const sql = await readFile("migrations/0007_shopping_membership.sql", "utf8");

    for (let attempt = 0; attempt < 2; attempt++) {
      await db.prepare(sql).run();
      expect((await db.prepare("SELECT * FROM checks ORDER BY key").all()).results).toEqual([
        { ...legacyCatalog, packages: 1 },
        { ...live, packages: 1 },
        { ...legacy, packages: 1 },
      ]);
    }
  });

  it("persists groceries, exact links, backfill, ordering and deletion guards", async () => {
    const put = (path: string, value: typeof Schema.Json.Type) => send(path, "PUT", JSON.stringify(value));

    const state = async () =>
      Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

    expect((await state()).shoppingOrder).toEqual({ aisles: [], items: [], revision: expect.any(String) });

    const item = Schema.decodeUnknownSync(GroceryItemSchema)({
      id: "rice",
      name: "Rice",
      url: "",
      aisle: "",
      quantity: 500,
      unit: "g",
      aliases: ["White rice"],
    });

    for (const changes of [
      { url: "ftp://example.com" },
      { url: "https://user:pass@example.com" },
      { quantity: 0 },
      { quantity: 1_000_001 },
      { id: "" },
      { unit: "bag" },
    ])
      expect((await put("groceries", { ...item, ...changes })).status).toBe(400);
    expect((await put("groceries", item)).status).toBe(200);
    expect((await put("groceries", { ...item, aisle: "Dry goods" })).status).toBe(200);

    const recipe = Schema.decodeUnknownSync(RecipeSchema)({
      ...sampleRecipes[0],
      ingredients: [{ name: " WHITE   rice ", quantity: 100, unit: "g" }],
    });

    expect((await put("recipes", recipe)).status).toBe(200);
    expect((await state()).recipes[0].ingredients[0].groceryItemId).toBe("rice");
    expect(
      (
        await put("recipes", {
          ...recipe,
          ingredients: [{ ...recipe.ingredients[0], groceryItemId: "missing" }],
        })
      ).status,
    ).toBe(400);
    expect((await send("groceries/rice", "DELETE", "")).status).toBe(200);
    expect((await state()).recipes[0].ingredients[0].groceryItemId).toBeNull();
    await put("groceries", item);
    await put("recipes", recipe);
    const db = await worker.getD1Database("DB");
    await db.prepare("DELETE FROM groceries WHERE id='rice'").run();
    expect((await state()).recipes[0].ingredients[0].groceryItemId).toBeNull();
    await put("groceries", item);
    await expect(
      recipeStatement(
        db,
        Schema.decodeUnknownSync(RecipeSchema)({
          ...recipe,
          id: "bad",
          ingredients: [{ ...recipe.ingredients[0], groceryItemId: "missing" }],
        }),
      ).run(),
    ).rejects.toThrow();
    await legacyRecipeStatement(
      db,
      Schema.decodeUnknownSync(RecipeSchema)({
        ...recipe,
        ingredients: [
          { name: "White rice", quantity: 1, unit: "g" },
          { name: "White rice", quantity: 1, unit: "g", groceryItemId: null },
          { name: "Nothing", quantity: 1, unit: "g" },
          { name: "Ambiguous", quantity: 1, unit: "g" },
        ],
      }),
    ).run();
    await put("groceries", { ...item, aliases: ["White rice", "Ambiguous"] });
    await put("groceries", { ...item, id: "other", name: "Other", aliases: ["Ambiguous"] });
    const unavailable = await send("groceries/match", "POST", "");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toHaveProperty(
      "error",
      expect.stringContaining("Cloudflare deployment"),
    );
    expect((await state()).recipes[0].ingredients.map((i) => i.groceryItemId)).toEqual([
      undefined,
      null,
      undefined,
      undefined,
    ]);
    const order = { aisles: ["Dry goods", ""], items: ["rice", "unresolved:test"] };
    expect((await put("shopping-order", order)).status).toBe(200);
    expect((await state()).shoppingOrder).toEqual({ ...order, revision: expect.any(String) });
    expect((await put("shopping-order", { ...order, items: ["rice", "rice"] })).status).toBe(400);
    expect((await send("groceries/other", "DELETE", "")).status).toBe(200);
    expect((await state()).groceries).toHaveLength(1);
  });
  it("deletes linked products atomically from every list without losing recipe data or unrelated list membership", async () => {
    const put = (path: string, value: typeof Schema.Json.Type) => send(path, "PUT", JSON.stringify(value));

    const state = async () =>
      Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

    const removed = {
      id: "rice/?#%20",
      name: "Rice",
      aliases: [],
      quantity: 500,
      unit: "g",
      aisle: "Dry",
      url: "",
    };

    const keep = { ...removed, id: "keep", name: "Oil" };

    for (const product of [removed, keep]) expect((await put("groceries", product)).status).toBe(200);

    const ingredients = Schema.decodeUnknownSync(RecipeSchema.fields.ingredients)([
      {
        name: "Rice",
        originalText: "1½ cups rice, rinsed\nthen drained",
        quantity: 1.5,
        unit: "cup",
        groceryItemId: removed.id,
      },
      { name: "Oil", quantity: 2, unit: "tbsp", groceryItemId: keep.id },
      { name: "Rice", quantity: 75, unit: "g", groceryItemId: removed.id },
      { name: "Unmatched herb", quantity: 1, unit: "bunch", groceryItemId: null },
      ...Array.from({ length: 9 }, (_, index) => ({
        name: `Unmatched seed ${index}`,
        quantity: index + 1,
        unit: "g",
        grocerySuggestions: [keep.id],
      })),
    ]);

    for (const [index, recipe] of sampleRecipes.slice(0, 2).entries())
      expect(
        (await put("recipes", { ...recipe, ingredients: index ? ingredients.slice(2) : ingredients })).status,
      ).toBe(200);
    expect((await put("meals", { ...meal, recipeId: sampleRecipes[0].id })).status).toBe(200);

    for (const [id, date] of [
      ["this-week", "2026-09-26"],
      ["same-day", "2026-09-26"],
      ["next-week", "2026-10-03"],
    ]) {
      expect((await put("shopping-lists", { id, date, label: "" })).status).toBe(200);
      expect(
        (
          await send(
            `shopping-lists/${id}/items`,
            "POST",
            JSON.stringify({
              items: [removed, keep].map((product) => ({ groceryId: product.id, packages: 2 })),
            }),
          )
        ).status,
      ).toBe(200);
    }

    const before = await state();
    expect(before.shoppingItems.filter((entry) => entry.groceryId === removed.id)).toHaveLength(3);

    const expectedRecipes = before.recipes.map((recipe) => ({
      ...recipe,
      revision: expect.any(String),
      ingredients: recipe.ingredients.map((ingredient) =>
        ingredient.groceryItemId === removed.id ? { ...ingredient, groceryItemId: null } : ingredient,
      ),
    }));

    expect((await send(`groceries/${encodeURIComponent(removed.id)}`, "DELETE", "")).status).toBe(200);
    const after = await state();
    expect(after).toEqual({
      ...before,
      recipes: expectedRecipes,
      groceries: before.groceries.filter((product) => product.id !== removed.id),
      shoppingItems: before.shoppingItems.filter((entry) => entry.groceryId !== removed.id),
    });
    expect(after.shoppingItems.filter((entry) => entry.groceryId === keep.id)).toHaveLength(3);
    expect((await send(`groceries/${encodeURIComponent(removed.id)}`, "DELETE", "")).status).toBe(409);
    expect(await state()).toEqual(after);
    // A stale editor cannot resurrect dangling links or overwrite the unlinked recipe.
    expect(
      (
        await put("recipes", {
          ...before.recipes[0],
          expectedRevision: before.recipes[0].revision ?? "missing",
        })
      ).status,
    ).toBe(409);
    expect(await state()).toEqual(after);
    expect(
      (
        await send(
          "shopping-lists/this-week/items",
          "POST",
          JSON.stringify({ items: [{ groceryId: removed.id }] }),
        )
      ).status,
    ).toBe(400);
    expect(await state()).toEqual(after);
    // Recreating an identical name/ID does not silently re-match explicitly unlinked ingredients.
    expect((await put("groceries", removed)).status).toBe(200);

    for (const recipe of after.recipes) expect((await put("recipes", recipe)).status).toBe(200);
    expect((await state()).recipes).toEqual(expectedRecipes);
    // A recreated product is not silently put back on any list.
    expect((await state()).shoppingItems).toEqual(after.shoppingItems);
    // Failure of the list cascade rolls back the product deletion and recipe unlinking.
    const db = await worker.getD1Database("DB");
    await db
      .prepare(
        "CREATE TRIGGER reject_product_delete BEFORE DELETE ON shopping_list_items BEGIN SELECT RAISE(ABORT, 'Delete rejected'); END",
      )
      .run();
    const beforeFailure = await state();

    try {
      expect((await send("groceries/keep", "DELETE", "")).status).toBe(500);
      expect(await state()).toEqual(beforeFailure);
    } finally {
      await db.prepare("DROP TRIGGER reject_product_delete").run();
    }
  });
  it("renames whole aisles atomically while preserving route and list membership", async () => {
    const put = (path: string, value: typeof Schema.Json.Type) => send(path, "PUT", JSON.stringify(value));

    const state = async () =>
      Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

    const grocery = {
      id: "steak",
      name: "Steak",
      url: "",
      aisle: "Meat",
      quantity: 500,
      unit: "g",
      aliases: [],
    };

    await put("groceries", grocery);
    await put("groceries", { ...grocery, id: "chicken", name: "Chicken" });
    await put("groceries", { ...grocery, id: "apples", name: "Apples", aisle: "Produce" });

    const order = {
      aisles: ["Produce", "Meat", "Butcher", ""],
      items: ['["grocery","chicken"]', '["grocery","steak"]'],
    };

    await put("shopping-order", order);
    await put("shopping-lists", { id: "aisle-list", date: "2026-09-26", label: "" });
    await send(
      "shopping-lists/aisle-list/items",
      "POST",
      JSON.stringify({ items: [{ groceryId: "chicken", packages: 3 }] }),
    );
    const before = await state();
    expect(before.shoppingItems).toHaveLength(1);

    for (const to of ["   ", "x".repeat(151)])
      expect((await put("shopping-aisles", { from: "Meat", to })).status).toBe(400);
    expect((await put("shopping-aisles", { from: "Meat", to: "Produce" })).status).toBe(409);
    expect((await put("shopping-aisles", { from: "Missing", to: "Butcher" })).status).toBe(409);
    expect(await state()).toEqual(before);
    expect((await put("shopping-aisles", { from: "Meat", to: "  Butcher  " })).status).toBe(200);
    const after = await state();
    expect(after.groceries).toEqual(
      before.groceries.map((item) =>
        item.aisle === "Meat" ? { ...item, aisle: "Butcher", revision: expect.any(String) } : item,
      ),
    );
    expect(after.shoppingOrder).toEqual({
      ...order,
      aisles: ["Produce", "Butcher", ""],
      revision: expect.any(String),
    });
    expect(after.shoppingLists).toEqual(before.shoppingLists);
    expect(after.shoppingItems).toEqual(before.shoppingItems);
    expect((await put("shopping-aisles", { from: "Butcher", to: "Butcher" })).status).toBe(200);
    expect(await state()).toEqual(after);
  });
  it("returns one household snapshot when a collection is renamed during a read", async () => {
    const recipe = { ...sampleRecipes[0], category: "Vegetarian" };
    expect((await send("recipes", "PUT", JSON.stringify(recipe))).status).toBe(200);
    const db = await worker.getD1Database("DB");
    let resolveRename: (() => void) | undefined;

    const renamed = new Promise<void>((resolve) => {
      resolveRename = resolve;
    });

    const rename = async () => {
      await db.prepare("UPDATE collections SET name='Plant-based' WHERE id='vegetarian'").run();

      if (!resolveRename) throw new Error("Rename signal was not initialized.");
      resolveRename();
    };

    // Separate reads force the rename between recipes and collections; a batch
    // returns its complete snapshot before the competing rename is applied.
    const racingDb: D1Database = {
      exec: db.exec.bind(db),
      dump: db.dump.bind(db),
      withSession: db.withSession.bind(db),
      prepare(sql: string) {
        const statement = db.prepare(sql);
        const read = statement.all.bind(statement);
        statement.all = async <T>() => {
          if (sql.includes("FROM collections")) await renamed;
          const result = await read<T>();

          if (sql.includes("FROM recipes")) await rename();

          return result;
        };

        return statement;
      },
      async batch<T>(statements: D1PreparedStatement[]) {
        const results = await db.batch<T>(statements);
        await rename();

        return results;
      },
    };

    // SAFETY: WebsiteEnv requires deployment-only bindings that this local API read
    // never uses; this real-D1 snapshot smoke exercises DB with LOCAL_DEV enabled.
    const env = { DB: racingDb, LOCAL_DEV: "true" } as WebsiteEnv;
    const response = await server.fetch(new Request("http://localhost/api/household"), env);
    expect(response.status).toBe(200);
    const state = Schema.decodeUnknownSync(HouseholdSchema)(await response.json());
    expect(state.collections).toEqual(defaultCollections);
    expect(state.recipes).toEqual([{ ...recipe, revision: expect.any(String) }]);
    expect(await db.prepare("SELECT category FROM recipes WHERE id=?").bind(recipe.id).first()).toEqual({
      category: "Plant-based",
    });
  });
  it("keeps collection names with consecutive spaces distinct when saving recipes", async () => {
    for (const collection of [
      { id: "single", name: "Sunday suppers" },
      { id: "double", name: "Sunday  suppers" },
    ]) {
      expect((await send("collections", "PUT", JSON.stringify(collection))).status).toBe(200);
    }

    const recipe = { ...sampleRecipes[0], category: "Sunday  suppers" };
    expect((await send("recipes", "PUT", JSON.stringify(recipe))).status).toBe(200);

    const state = Schema.decodeUnknownSync(HouseholdSchema)(
      await (await worker.dispatchFetch("http://localhost/api/household")).json(),
    );

    expect(state.recipes).toEqual([{ ...recipe, revision: expect.any(String) }]);
    expect(state.collections).toContainEqual({
      id: "double",
      name: "Sunday  suppers",
      revision: expect.any(String),
    });
    expect(state.collections).toContainEqual({
      id: "single",
      name: "Sunday suppers",
      revision: expect.any(String),
    });
  });
  it("migrates existing collection assignments without changing saved recipes", async () => {
    const legacy = new Miniflare(options("true"));

    try {
      const db = await legacy.getD1Database("DB");

      for (const file of ["0001_initial.sql", "0002_recipe_rating.sql"]) {
        const sql = await readFile(`migrations/${file}`, "utf8");
        await db.batch(
          sql
            .split(";")
            .filter((s) => s.trim())
            .map((s) => db.prepare(s)),
        );
      }

      await legacyRecipeStatement(db, { ...sampleRecipes[0], category: "" }).run();
      await db
        .prepare("UPDATE recipes SET category=? WHERE id=?")
        .bind("Weeknight favorites", sampleRecipes[0].id)
        .run();
      const grocerySql = await readFile("migrations/0004_groceries.sql", "utf8");
      await db.batch(
        grocerySql
          .split(/;\n(?=CREATE|INSERT)|;\s*$/)
          .filter((s) => s.trim())
          .map((s) => db.prepare(s)),
      );
      const sql = await readFile("migrations/0003_collections.sql", "utf8");
      await db.batch(
        sql
          .split(/;\n(?=CREATE|INSERT)|;\s*$/)
          .filter((s) => s.trim())
          .map((s) => db.prepare(s)),
      );

      for (const file of [
        "0005_ingredient_matching.sql",
        "0006_meal_notes.sql",
        "0010_shopping_packages.sql",
        "0011_meal_recipes.sql",
        "0012_entity_revisions.sql",
        "0013_photos.sql",
        "0014_detached_meals.sql",
        "0015_shopping_lists.sql",
      ]) {
        const migration = await readFile(`migrations/${file}`, "utf8");
        await db.batch(
          migration
            .replace(/^--.*$/gm, "")
            .split(/;\s*\n(?=CREATE|INSERT|DROP|ALTER|UPDATE)|;\s*$/)
            .filter((s) => s.trim())
            .map((s) => db.prepare(s)),
        );
      }

      const state = Schema.decodeUnknownSync(HouseholdSchema)(
        await (await legacy.dispatchFetch("http://localhost/api/household")).json(),
      );

      expect(state.collections).toEqual(defaultCollections);
      expect(state.recipes).toEqual([{ ...sampleRecipes[0], revision: expect.any(String) }]);
    } finally {
      await legacy.dispose();
    }
  });
  it("allows adding recipes and sample content after every collection is deleted", async () => {
    for (const collection of defaultCollections) {
      expect((await send(`collections/${collection.id}`, "DELETE", "{}")).status).toBe(200);
    }

    expect((await send("demo?today=2026-09-21", "POST", "{}")).status).toBe(200);

    const state = Schema.decodeUnknownSync(HouseholdSchema)(
      await (await worker.dispatchFetch("http://localhost/api/household")).json(),
    );

    expect(state.collections).toEqual([]);
    expect(state.recipes).toHaveLength(6);
    expect(state.recipes.every((recipe) => recipe.category === "")).toBe(true);
    expect(
      (await send("recipes", "PUT", JSON.stringify({ ...sampleRecipes[0], id: "uncollected", category: "" })))
        .status,
    ).toBe(200);
  });
  it("creates, renames, and deletes collections without losing recipes or planned meals", async () => {
    const collection = { id: "custom/collection", name: "  Sunday suppers  " };
    expect((await send("collections", "PUT", JSON.stringify(collection))).status).toBe(200);
    const recipe = { ...sampleRecipes[0], category: "Sunday suppers" };
    expect((await send("recipes", "PUT", JSON.stringify(recipe))).status).toBe(200);
    expect((await send("recipes", "PUT", JSON.stringify(sampleRecipes[1]))).status).toBe(200);
    expect((await send("meals", "PUT", JSON.stringify(meal))).status).toBe(200);
    expect(
      (await send("collections", "PUT", JSON.stringify({ ...collection, name: "Weekend dinners" }))).status,
    ).toBe(200);

    const read = async () =>
      Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

    const renamed = await read();
    expect(renamed.collections).toContainEqual({
      id: collection.id,
      name: "Weekend dinners",
      revision: expect.any(String),
    });
    expect(renamed.recipes.find((item) => item.id === recipe.id)).toEqual({
      ...recipe,
      category: "Weekend dinners",
      revision: expect.any(String),
    });
    expect(renamed.recipes.find((item) => item.id === sampleRecipes[1].id)).toEqual({
      ...sampleRecipes[1],
      revision: expect.any(String),
    });
    expect((await send(`collections/${encodeURIComponent(collection.id)}`, "DELETE", "{}")).status).toBe(200);
    const deleted = await read();
    expect(deleted.collections).toEqual(defaultCollections);
    expect(deleted.recipes.find((item) => item.id === recipe.id)).toEqual({
      ...recipe,
      category: "",
      revision: expect.any(String),
    });
    expect(deleted.meals).toEqual([{ ...meal, recipe, revision: expect.any(String) }]);
    expect((await send("recipes", "PUT", JSON.stringify(recipe))).status).toBe(400);
    expect((await send("recipes", "PUT", JSON.stringify({ ...recipe, category: "" }))).status).toBe(200);
  });
  it("rejects blank, oversized, duplicate, and missing collections without changing assignments", async () => {
    for (const name of ["   ", "x".repeat(101)]) {
      expect((await send("collections", "PUT", JSON.stringify({ id: "invalid", name }))).status).toBe(400);
    }

    expect((await send("recipes", "PUT", JSON.stringify(sampleRecipes[0]))).status).toBe(200);

    for (const id of ["duplicate", "weeknight"]) {
      expect((await send("collections", "PUT", JSON.stringify({ id, name: " vegetarian " }))).status).toBe(
        409,
      );
    }

    const state = Schema.decodeUnknownSync(HouseholdSchema)(
      await (await worker.dispatchFetch("http://localhost/api/household")).json(),
    );

    expect(state.collections).toEqual(defaultCollections);
    expect(state.recipes).toEqual([{ ...sampleRecipes[0], revision: expect.any(String) }]);
    expect((await send("collections/missing", "DELETE", "{}")).status).toBe(409);
  });
  it("starts empty and saves recipe JSON, decimal quantities, source, and photo", async () => {
    const initial = await worker.dispatchFetch("http://localhost/api/household");
    expect(await initial.json()).toEqual({
      collections: defaultCollections,
      groceries: [],
      shoppingOrder: { aisles: [], items: [], revision: expect.any(String) },
      recipes: [],
      recipesAdded: [],
      meals: [],
      shoppingLists: [],
      shoppingItems: [],
    });
    expect((await send("recipes", "PUT", JSON.stringify(sampleRecipes[0]))).status).toBe(200);
    const db = await worker.getD1Database("DB");

    const stored = Schema.decodeUnknownSync(
      Schema.Struct({
        source: RecipeSchema.fields.source,
        photo: RecipeSchema.fields.photo,
        ingredients: Schema.fromJsonString(RecipeSchema.fields.ingredients),
      }),
      { onExcessProperty: "error" },
    )(
      await db
        .prepare("SELECT source,photo,ingredients FROM recipes WHERE id=?")
        .bind(sampleRecipes[0].id)
        .first(),
    );

    expect(stored.photo).toBe("/photos/chicken.jpg");
    expect(stored.source).toBe(sampleRecipes[0].source);
    expect(stored.ingredients).toEqual(sampleRecipes[0].ingredients);
  });

  it("shares immutable uploaded assets across recipes and meals without repeating bytes in household responses", async () => {
    const upload = `data:image/jpeg;base64,${Buffer.from(await readFile("public/photos/chicken.jpg")).toString("base64")}`;

    const hash = createHash("sha256")
      .update(Buffer.from(upload.split(",")[1], "base64"))
      .digest("hex")
      .replace(/[0-9]/g, (digit) => String.fromCharCode(103 + Number(digit)));

    const path = `/photos/upload-${hash}.jpg`;
    const source = { ...sampleRecipes[0], photo: upload };

    const read = async () =>
      Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

    expect((await send("recipes", "PUT", JSON.stringify(source))).status).toBe(200);
    expect(
      (await send("recipes", "PUT", JSON.stringify({ ...sampleRecipes[1], photo: upload }))).status,
    ).toBe(200);

    for (let index = 0; index < 32; index++)
      expect(
        (await send("meals", "PUT", JSON.stringify({ ...meal, id: `photo-meal-${index}` }))).status,
      ).toBe(200);
    const response = await worker.dispatchFetch("http://localhost/api/household");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(body)).toBeLessThan(upload.length);
    expect(body).not.toContain("data:image/");
    const state = Schema.decodeUnknownSync(HouseholdSchema)(JSON.parse(body));
    expect(state.meals).toHaveLength(32);
    expect(state.meals.every((entry) => entry.recipe?.photo === path)).toBe(true);
    expect(state.recipes.every((recipe) => recipe.photo === path)).toBe(true);
    // This intentionally restates the OLD reader's path constraint, not the new schema.
    expect(path).toMatch(/^\/photos\/[a-z-]+\.jpg$/);
    const db = await worker.getD1Database("DB");
    expect((await db.prepare("SELECT path,data FROM photos").all()).results).toEqual([
      { path, data: upload },
    ]);
    expect(
      await db.prepare("SELECT count(*) AS count FROM meals WHERE recipe LIKE '%data:image/%'").first(),
    ).toEqual({ count: 0 });

    expect((await send("recipes", "PUT", JSON.stringify({ ...source, photo: uploadedPng }))).status).toBe(
      200,
    );
    const replacement = (await read()).recipes.find((recipe) => recipe.id === source.id)?.photo;
    expect(replacement).toMatch(/^\/photos\/upload-[a-p]{64}\.jpg$/);
    expect(replacement).not.toBe(path);
    expect((await read()).meals.every((entry) => entry.recipe?.photo === path)).toBe(true);
    expect(
      (
        await send(
          "meals",
          "PUT",
          JSON.stringify({ ...meal, id: "photo-meal-0", recipe: { ...source, photo: uploadedWebp } }),
        )
      ).status,
    ).toBe(200);
    const edited = await read();
    expect(edited.meals.find((entry) => entry.id === "photo-meal-0")?.recipe?.photo).not.toBe(path);
    expect(
      edited.meals
        .filter((entry) => entry.id !== "photo-meal-0")
        .every((entry) => entry.recipe?.photo === path),
    ).toBe(true);
    expect(edited.recipes.find((recipe) => recipe.id === sampleRecipes[1].id)?.photo).toBe(path);
    expect(edited.recipes.find((recipe) => recipe.id === source.id)?.photo).toBe(replacement);
    // Explicit snapshots may share an existing pointer without uploading again.
    expect(
      (
        await send(
          "meals",
          "PUT",
          JSON.stringify({ ...meal, id: "photo-meal-1", recipe: { ...source, photo: replacement } }),
        )
      ).status,
    ).toBe(200);
    expect((await send("recipes", "PUT", JSON.stringify({ ...source, photo: "" }))).status).toBe(200);
    expect((await read()).meals.find((entry) => entry.id === "photo-meal-1")?.recipe?.photo).toBe(
      replacement,
    );

    const beforeRace = (await read()).recipes.find((recipe) => recipe.id === source.id);

    if (!beforeRace) throw new Error("Photo source missing");

    const candidates = await Promise.all(
      ["bowl", "soup"].map(
        async (name) =>
          `data:image/jpeg;base64,${Buffer.from(await readFile(`public/photos/${name}.jpg`)).toString("base64")}`,
      ),
    );

    const raced = await Promise.all(
      candidates.map((photo) =>
        worker.dispatchFetch("http://localhost/api/recipes", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...beforeRace, photo, expectedRevision: beforeRace.revision }),
        }),
      ),
    );

    expect(raced.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = candidates[raced.findIndex((response) => response.status === 200)];
    const winnerPath = (await read()).recipes.find((recipe) => recipe.id === source.id)?.photo;
    expect(
      await db
        .prepare("SELECT data FROM photos WHERE path=?")
        .bind(winnerPath ?? "")
        .first(),
    ).toEqual({ data: winner });
    // Rejecting a concurrent upload must not leave its unreferenced bytes behind.
    const assets = (await db.prepare("SELECT path,data FROM photos ORDER BY path").all()).results;
    expect(assets).toHaveLength(4);

    for (const entry of (await read()).meals)
      expect((await send(`meals/${entry.id}`, "DELETE", "{}")).status).toBe(200);

    for (const recipe of (await read()).recipes)
      expect((await send(`recipes/${recipe.id}`, "DELETE", "{}")).status).toBe(200);
    expect((await db.prepare("SELECT path,data FROM photos ORDER BY path").all()).results).toEqual(assets);
    const retained = await worker.dispatchFetch(`http://localhost${path}`);
    expect(retained.status).toBe(200);
    expect(Buffer.from(await retained.arrayBuffer())).toEqual(Buffer.from(upload.split(",")[1], "base64"));
  }, 30_000);

  it("serves exact PNG/JPEG/WebP bytes only behind normal Access, with private headers and GET/HEAD semantics", async () => {
    const uploads = [
      uploadedPng,
      uploadedWebp,
      `data:image/jpeg;base64,${Buffer.from(await readFile("public/photos/chicken.jpg")).toString("base64")}`,
    ];

    const paths: string[] = [];

    for (const [index, photo] of uploads.entries()) {
      expect(
        (await send("recipes", "PUT", JSON.stringify({ ...sampleRecipes[0], id: `asset-${index}`, photo })))
          .status,
      ).toBe(200);

      const household = Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

      const path = household.recipes.find((recipe) => recipe.id === `asset-${index}`)?.photo;

      if (!path) throw new Error("Uploaded asset reference missing");
      paths.push(path);
    }

    await worker.setOptions(options("false"));

    const token = await new SignJWT({ email: "joe5saia@gmail.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://saiaai.cloudflareaccess.com")
      .setAudience("test-hearth")
      .setSubject("photo-reader")
      .setExpirationTime("5m")
      .sign(signingKey);

    const headers = { "Cf-Access-Jwt-Assertion": token };

    for (const [index, path] of paths.entries()) {
      for (const method of ["GET", "HEAD"]) {
        expect((await worker.dispatchFetch(`http://localhost${path}`, { method })).status).toBe(403);
        expect(
          (
            await worker.dispatchFetch(`http://localhost${path}`, {
              method,
              headers: {
                "Cf-Access-Jwt-Assertion": "forged",
                "Cf-Access-Authenticated-User-Email": "joe5saia@gmail.com",
              },
            })
          ).status,
        ).toBe(403);
        const asset = await worker.dispatchFetch(`http://localhost${path}`, { method, headers });
        expect(asset.status).toBe(200);
        expect(asset.headers.get("Content-Type")).toBe(uploads[index].slice(5, uploads[index].indexOf(";")));
        expect(asset.headers.get("Cache-Control")).toContain("private");
        expect(asset.headers.get("Cache-Control")).toContain("no-store");
        expect(asset.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(Buffer.from(await asset.arrayBuffer())).toEqual(
          method === "HEAD" ? Buffer.alloc(0) : Buffer.from(uploads[index].split(",")[1], "base64"),
        );
      }

      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
        expect((await worker.dispatchFetch(`http://localhost${path}`, { method, headers })).status).toBe(405);
    }

    for (const method of ["GET", "HEAD"])
      expect(
        (
          await worker.dispatchFetch(`http://localhost/photos/upload-${"a".repeat(64)}.jpg`, {
            method,
            headers,
          })
        ).status,
      ).toBe(404);
    expect((await worker.dispatchFetch(`http://localhost${paths[0]}`, { headers })).status).toBe(200);
  });

  it("rejects missing upload references and malformed base64 before recipe or explicit meal writes", async () => {
    expect((await send("recipes", "PUT", JSON.stringify(sampleRecipes[0]))).status).toBe(200);
    expect((await send("meals", "PUT", JSON.stringify(meal))).status).toBe(200);
    const before = await (await worker.dispatchFetch("http://localhost/api/household")).json();
    const db = await worker.getD1Database("DB");

    for (const photo of [
      `/photos/upload-${"a".repeat(64)}.jpg`,
      "/photos/upload-not-an-asset.jpg",
      "data:image/png;base64,A",
      "data:image/png;base64,AA=A",
      "data:image/png;base64,====",
      "data:image/png;base64,not base64!",
    ]) {
      expect((await send("recipes", "PUT", JSON.stringify({ ...sampleRecipes[0], photo }))).status).toBe(400);
      expect(
        (await send("recipes", "PUT", JSON.stringify({ ...sampleRecipes[0], id: "invalid-photo", photo })))
          .status,
      ).toBe(400);
      expect(
        (await send("meals", "PUT", JSON.stringify({ ...meal, recipe: { ...sampleRecipes[0], photo } })))
          .status,
      ).toBe(400);
      expect(
        (
          await send(
            "meals",
            "PUT",
            JSON.stringify({ ...meal, id: "invalid-photo-meal", recipe: { ...sampleRecipes[0], photo } }),
          )
        ).status,
      ).toBe(400);
      expect(await (await worker.dispatchFetch("http://localhost/api/household")).json()).toEqual(before);
      expect(await db.prepare("SELECT count(*) AS count FROM photos").first()).toEqual({ count: 0 });
    }
  });

  it("rejects malformed JSON, invalid URLs, quantities, empty ingredients, and invalid dates", async () => {
    expect((await send("recipes", "PUT", JSON.stringify(sampleRecipes[0]))).status).toBe(200);
    expect((await send("recipes", "PUT", "{")).status).toBe(400);

    for (const patch of [
      { source: "javascript:alert(1)" },
      { photo: "javascript:alert(1)" },
      { ingredients: [] },
      { servings: -1 },
      { ingredients: [{ name: "Flour", quantity: 0, unit: "g" }] },
    ]) {
      expect((await send("recipes", "PUT", JSON.stringify({ ...sampleRecipes[0], ...patch }))).status).toBe(
        400,
      );
    }

    for (const patch of [{ date: "2026-02-30" }, { scale: 0 }, { scale: 101 }, { recipeId: "missing" }]) {
      expect((await send("meals", "PUT", JSON.stringify({ ...meal, ...patch }))).status).toBe(400);
    }

    expect((await send("meals", "PUT", JSON.stringify(meal))).status).toBe(200);
    const db = await worker.getD1Database("DB");
    expect(await db.prepare("SELECT scale,note,date FROM meals WHERE id='test-meal'").first()).toEqual({
      scale: 1.5,
      note: "Leftovers for lunch",
      date: "2026-09-21",
    });
  });
  it("updates rather than duplicates and detaches meals when deleting their source recipe", async () => {
    expect((await send("recipes", "PUT", JSON.stringify(sampleRecipes[0]))).status).toBe(200);
    expect((await send("meals", "PUT", JSON.stringify(meal))).status).toBe(200);
    expect(
      (await send("recipes", "PUT", JSON.stringify({ ...sampleRecipes[0], title: "Updated chicken" })))
        .status,
    ).toBe(200);
    const db = await worker.getD1Database("DB");
    expect(await db.prepare("SELECT count(*) AS count,title FROM recipes").first()).toEqual({
      count: 1,
      title: "Updated chicken",
    });
    expect((await send(`recipes/${sampleRecipes[0].id}`, "DELETE", "{}")).status).toBe(200);
    expect(await db.prepare("SELECT count(*) AS count FROM recipes").first()).toEqual({ count: 0 });

    const state = Schema.decodeUnknownSync(HouseholdSchema)(
      await (await worker.dispatchFetch("http://localhost/api/household")).json(),
    );

    expect(state.meals).toEqual([
      { ...meal, recipeId: null, recipe: sampleRecipes[0], revision: expect.any(String) },
    ]);
    expect((await send("meals/test-meal", "DELETE", "{}")).status).toBe(200);
  });

  it("preserves detached snapshots and photos, rejects stale and old-Worker saves, and keeps meals editable", async () => {
    const read = async () =>
      Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

    const put = (entry: MealDraft) => send("meals", "PUT", JSON.stringify(entry));
    const source = { ...sampleRecipes[0], photo: uploadedPng };
    expect((await send("recipes", "PUT", JSON.stringify(source))).status).toBe(200);
    const first = { ...meal, date: "2020-01-02", note: "", scale: 2.25 };
    const second = { ...meal, id: "future-meal", date: "2037-04-05" };
    const note = { ...meal, id: "note", recipeId: null, note: "Takeout" };
    expect((await put(first)).status).toBe(200);
    expect(
      (await put({ ...second, recipe: { ...source, title: "Customized dinner", photo: uploadedWebp } }))
        .status,
    ).toBe(200);
    expect((await put(note)).status).toBe(200);
    const before = await read();
    const original = before.meals.find((entry) => entry.id === first.id);

    if (!original?.recipe) throw new Error("Missing original meal");
    const endpoint = `recipes/${encodeURIComponent(source.id)}`;
    expect((await send(endpoint, "DELETE", JSON.stringify({ expectedRevision: "stale" }))).status).toBe(409);
    expect(await read()).toEqual(before);
    expect((await send(endpoint, "DELETE", "{}")).status).toBe(200);
    const detached = await read();
    expect(detached).toEqual({
      ...before,
      recipes: [],
      recipesAdded: [],
      meals: before.meals.map((entry) =>
        entry.recipe ? { ...entry, recipeId: null, revision: expect.any(String) } : entry,
      ),
    });

    for (const entry of detached.meals.filter((entry) => entry.recipe)) {
      expect(entry.revision).not.toBe(before.meals.find((old) => old.id === entry.id)?.revision);
      const response = await worker.dispatchFetch(`http://localhost${entry.recipe?.photo}`);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(
        (entry.id === first.id ? uploadedPng : uploadedWebp).split(",")[1],
      );
    }

    expect(
      (await send("meals", "PUT", JSON.stringify({ ...original, expectedRevision: original.revision })))
        .status,
    ).toBe(409);
    expect(
      (await send(`meals/${first.id}`, "DELETE", JSON.stringify({ expectedRevision: original.revision })))
        .status,
    ).toBe(409);
    expect(await read()).toEqual(detached);

    const db = await worker.getD1Database("DB");
    // The previous Worker clears snapshots for every null source, even on scheduling-only saves.
    const saved = detached.meals.find((entry) => entry.id === second.id);

    if (!saved?.revision) throw new Error("Missing detached meal revision");
    await expect(
      db
        .prepare(`INSERT INTO meals (id,recipeId,date,slot,scale,note,recipe)
      SELECT ?1,?2,?3,?4,?5,?6,COALESCE(?7,(
        SELECT json_object('id',id,'title',title,'description',description,'servings',servings,
          'minutes',minutes,'category',category,'photo',photo,'source',source,'rating',rating,
          'ingredients',json(ingredients),'instructions',json(instructions)) FROM recipes WHERE id=?2
      )) WHERE (?2 IS NULL OR EXISTS (SELECT 1 FROM recipes WHERE id=?2))
        AND (?8 IS NULL OR EXISTS (SELECT 1 FROM meals WHERE id=?1 AND revision=?8))
      ON CONFLICT(id) DO UPDATE SET recipeId=excluded.recipeId,date=excluded.date,slot=excluded.slot,
        scale=excluded.scale,note=excluded.note,
        recipe=CASE WHEN excluded.recipeId IS NULL THEN NULL
          WHEN ?7 IS NULL AND meals.recipeId=excluded.recipeId THEN meals.recipe
          ELSE excluded.recipe END
      WHERE meals.revision=?8`)
        .bind(saved.id, null, saved.date, saved.slot, 3, saved.note, null, saved.revision)
        .run(),
    ).rejects.toThrow();
    expect(await read()).toEqual(detached);

    // Reusing the deleted recipe ID must not relink or rewrite historical meals.
    expect((await send("recipes", "PUT", JSON.stringify({ ...source, title: "New source" }))).status).toBe(
      200,
    );
    expect((await read()).meals).toEqual(detached.meals);
    expect((await send(endpoint, "DELETE", "{}")).status).toBe(200);
    expect((await read()).meals).toEqual(detached.meals);
    expect((await put({ ...first, recipeId: null, date: "2028-03-04", scale: 0.5 })).status).toBe(200);
    let current = (await read()).meals.find((entry) => entry.id === first.id);
    expect(current).toEqual({
      ...original,
      recipeId: null,
      date: "2028-03-04",
      scale: 0.5,
      revision: expect.any(String),
    });

    if (!current?.recipe) throw new Error("Missing editable snapshot");

    const edited = {
      ...current.recipe,
      title: "After deletion",
      instructions: ["New meal step"],
      photo: uploadedWebp,
    };

    expect((await put({ ...current, recipe: edited, note: "Cauliflower" })).status).toBe(200);
    expect(
      (await send(`meals/${first.id}`, "PATCH", JSON.stringify({ note: "", expectedNote: "Cauliflower" })))
        .status,
    ).toBe(200);
    current = (await read()).meals.find((entry) => entry.id === first.id);
    expect(current?.recipe).toEqual({ ...edited, photo: saved.recipe?.photo });
    expect(current?.note).toBe("");
    expect((await read()).meals.find((entry) => entry.id === second.id)).toEqual(saved);

    if (!current) throw new Error("Missing meal");
    // Explicit conversion remains available; omission alone never discards the snapshot.
    expect((await put({ ...current, recipe: null, note: "Pizza instead" })).status).toBe(200);
    expect((await read()).meals.find((entry) => entry.id === first.id)?.recipe).toBeNull();
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("keeps complete meal snapshots independent from their source and each other across old-style and concurrent saves", async () => {
    const put = (entry: MealDraft) => send("meals", "PUT", JSON.stringify(entry));

    const read = async () =>
      Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

    const source = sampleRecipes[0];
    const otherSource = sampleRecipes[1];

    for (const recipe of [source, otherSource])
      expect((await send("recipes", "PUT", JSON.stringify(recipe))).status).toBe(200);
    expect((await send(`recipes/rating/${source.id}`, "PUT", JSON.stringify({ rating: "up" }))).status).toBe(
      200,
    );
    const original = { ...source, rating: "up" as const };
    const secondMeal = { ...meal, id: "second-meal" };

    for (const entry of [meal, secondMeal]) expect((await put(entry)).status).toBe(200);
    expect((await read()).meals).toEqual([
      { ...secondMeal, recipe: original, revision: expect.any(String) },
      { ...meal, recipe: original, revision: expect.any(String) },
    ]);

    const editedRecipe = {
      ...original,
      title: "Only tonight's chicken",
      description: "Independent description",
      servings: 2,
      minutes: 21,
      category: "A meal-only collection label",
      photo: "https://example.com/meal.png",
      source: "https://example.com/meal",
      rating: "down" as const,
      ingredients: [
        {
          name: "Salt",
          originalText: "a pinch of salt",
          quantity: 2,
          unit: "pinch" as const,
          groceryItemId: null,
          grocerySuggestions: ["remembered-product"],
        },
      ],
      instructions: ["A completely different meal step."],
    };

    expect((await put({ ...meal, recipe: editedRecipe })).status).toBe(200);
    let state = await read();
    expect(state.recipes.find((recipe) => recipe.id === source.id)).toEqual({
      ...original,
      revision: expect.any(String),
    });
    expect(state.meals.find((entry) => entry.id === meal.id)?.recipe).toEqual(editedRecipe);
    expect(state.meals.find((entry) => entry.id === secondMeal.id)?.recipe).toEqual(original);

    const changedSource = {
      ...source,
      title: "Source changed after planning",
      instructions: ["Source-only step."],
    };

    expect((await send("recipes", "PUT", JSON.stringify(changedSource))).status).toBe(200);
    expect(
      (await send(`recipes/rating/${source.id}`, "PUT", JSON.stringify({ rating: "neutral" }))).status,
    ).toBe(200);

    const rescheduled = {
      ...meal,
      date: "2027-02-12",
      slot: "Lunch" as const,
      scale: 2.25,
      note: "Keep my independent recipe",
    };

    expect((await put(rescheduled)).status).toBe(200);
    state = await read();
    expect(state.meals.find((entry) => entry.id === meal.id)).toEqual({
      ...rescheduled,
      recipe: editedRecipe,
      revision: expect.any(String),
    });
    expect(state.meals.find((entry) => entry.id === secondMeal.id)?.recipe).toEqual(original);
    expect(state.recipes.find((recipe) => recipe.id === source.id)).toEqual({
      ...changedSource,
      revision: expect.any(String),
    });

    // Concurrent whole saves share a captured revision: exactly one wins, the other conflicts.
    for (let round = 0; round < 4; round++) {
      const concurrentRecipe = { ...editedRecipe, title: `Concurrent snapshot ${round}` };
      const current = (await read()).meals.find((entry) => entry.id === meal.id);

      if (!current?.revision) throw new Error("Missing meal revision");

      const responses = await Promise.all([
        send(
          "meals",
          "PUT",
          JSON.stringify({ ...rescheduled, recipe: concurrentRecipe, expectedRevision: current.revision }),
        ),
        send(
          "meals",
          "PUT",
          JSON.stringify({
            ...rescheduled,
            note: `Concurrent note ${round}`,
            expectedRevision: current.revision,
          }),
        ),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      expect((await read()).meals.find((entry) => entry.id === meal.id)?.recipe).toEqual(
        responses[0].status === 200 ? concurrentRecipe : current.recipe,
      );
    }

    const changedMeal = { ...rescheduled, recipeId: otherSource.id };
    expect((await put(changedMeal)).status).toBe(200);
    expect((await read()).meals.find((entry) => entry.id === meal.id)).toEqual({
      ...changedMeal,
      recipe: otherSource,
      revision: expect.any(String),
    });
    const note = { ...changedMeal, recipeId: null, note: "Takeout", recipe: null };
    expect((await put(note)).status).toBe(200);
    expect((await read()).meals.find((entry) => entry.id === meal.id)).toEqual({
      ...note,
      revision: expect.any(String),
    });
    expect((await put({ ...rescheduled })).status).toBe(200);
    expect((await read()).meals.find((entry) => entry.id === meal.id)?.recipe).toEqual(changedSource);
    // A supplied snapshot also wins on creation; it is not silently replaced with the source.
    expect((await put({ ...meal, id: "explicit-new", recipe: editedRecipe })).status).toBe(200);
    expect((await read()).meals.find((entry) => entry.id === "explicit-new")?.recipe).toEqual(editedRecipe);
  });

  it("links substituted meal ingredients without changing source recipes, other meals or explicit choices", async () => {
    const read = async () =>
      Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

    const pork = { id: "pork", name: "Pork", aliases: [], quantity: 500, unit: "g", aisle: "Meat", url: "" };
    const chicken = { ...pork, id: "chicken", name: "Chicken", aliases: ["chicken breast"] };

    for (const grocery of [pork, chicken])
      expect((await send("groceries", "PUT", JSON.stringify(grocery))).status).toBe(200);
    expect(
      (
        await send(
          "recipes",
          "PUT",
          JSON.stringify({
            ...sampleRecipes[0],
            ingredients: [{ name: "Pork", quantity: 400, unit: "g", groceryItemId: "pork" }],
          }),
        )
      ).status,
    ).toBe(200);

    for (const id of ["substitution", "unchanged"])
      expect((await send("meals", "PUT", JSON.stringify({ ...meal, id }))).status).toBe(200);
    const before = await read();
    const first = before.meals.find((entry) => entry.id === "substitution");

    if (!first?.recipe) throw new Error("Missing meal snapshot");

    const ingredients = [
      { name: " CHICKEN   breast ", quantity: 350, unit: "g" },
      { name: "Chicken", quantity: 100, unit: "g", groceryItemId: null },
      { name: "Cook's choice", quantity: 50, unit: "g", groceryItemId: "pork" },
      { name: "Unknown substitute", quantity: 1, unit: "each" },
    ];

    expect(
      (
        await send(
          "meals",
          "PUT",
          JSON.stringify({
            ...first,
            recipe: { ...first.recipe, ingredients },
          }),
        )
      ).status,
    ).toBe(200);
    const after = await read();
    expect(after.meals.find((entry) => entry.id === first.id)?.recipe?.ingredients).toEqual([
      { ...ingredients[0], groceryItemId: "chicken" },
      ...ingredients.slice(1),
    ]);
    expect(after.recipes).toEqual(before.recipes);
    expect(after.meals.find((entry) => entry.id === "unchanged")).toEqual(
      before.meals.find((entry) => entry.id === "unchanged"),
    );
    expect(after.groceries).toEqual(before.groceries);
    expect(after.shoppingItems).toEqual(before.shoppingItems);
  });

  it("rejects invalid meal snapshots before writes and validates stored snapshot JSON at the read boundary", async () => {
    const source = sampleRecipes[0];
    expect((await send("recipes", "PUT", JSON.stringify(source))).status).toBe(200);
    expect((await send("meals", "PUT", JSON.stringify(meal))).status).toBe(200);

    const read = async () =>
      Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

    const before = await read();

    for (const patch of [
      { recipe: null },
      { recipe: { ...source, id: "wrong-provenance" } },
      { recipe: { ...source, ingredients: [] } },
      { recipe: { ...source, servings: 0 } },
      { recipe: { ...source, source: "javascript:alert(1)" } },
      { recipe: { ...source, ingredients: [{ name: "Salt", quantity: 0, unit: "g" }] } },
      { recipe: { ...source, instructions: [""] } },
      { recipe: { ...source, photo: `data:image/png;base64,${"a".repeat(1_900_000)}` } },
      { recipeId: null, recipe: { ...source, ingredients: [] }, note: "Detached invalid recipe" },
      { recipeId: "missing", recipe: { ...source, id: "missing" } },
    ]) {
      expect((await send("meals", "PUT", JSON.stringify({ ...meal, ...patch }))).status).toBe(400);
      expect(await read()).toEqual(before);
    }

    const db = await worker.getD1Database("DB");
    await db.prepare("UPDATE meals SET recipe=? WHERE id=?").bind('{"id":"incomplete"}', meal.id).run();
    const response = await worker.dispatchFetch("http://localhost/api/household");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("incomplete");
  });

  it("reports recipe addition order independently of titles, edits, ratings and deletions", async () => {
    const [lemon, pasta, bowl, salmon] = sampleRecipes;

    const snapshot = async () =>
      Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

    for (const recipe of [pasta, lemon, bowl])
      expect((await send("recipes", "PUT", JSON.stringify(recipe))).status).toBe(200);
    let household = await snapshot();
    expect(household.recipes.map((recipe) => recipe.id)).toEqual([bowl.id, lemon.id, pasta.id]);
    expect(household.recipesAdded).toEqual([pasta.id, lemon.id, bowl.id]);

    expect((await send("recipes", "PUT", JSON.stringify({ ...pasta, title: "Aardvark pasta" }))).status).toBe(
      200,
    );
    expect((await send(`recipes/rating/${lemon.id}`, "PUT", JSON.stringify({ rating: "up" }))).status).toBe(
      200,
    );
    expect((await send(`recipes/${bowl.id}`, "DELETE", "{}")).status).toBe(200);
    expect((await send("recipes", "PUT", JSON.stringify(salmon))).status).toBe(200);
    household = await snapshot();
    expect(household.recipes.map((recipe) => recipe.id)).toEqual([pasta.id, salmon.id, lemon.id]);
    expect(household.recipesAdded).toEqual([pasta.id, lemon.id, salmon.id]);
  });

  it("persists recipe-free notes, validates them, and converts entries without affecting other meals", async () => {
    const note = Schema.decodeUnknownSync(MealSchema)({
      ...meal,
      id: "note-only",
      recipeId: null,
      scale: 1,
      note: "Pizza",
    });

    const put = (entry: MealDraft) => send("meals", "PUT", JSON.stringify(entry));

    const household = async () =>
      Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

    expect((await put(note)).status).toBe(200);
    expect((await household()).meals).toEqual([{ ...note, recipe: null, revision: expect.any(String) }]);
    expect((await household()).recipes).toEqual([]);

    for (const patch of [
      { note: "" },
      { note: " \n\t" },
      { note: "x".repeat(2001) },
      { recipeId: "" },
      { recipeId: "missing" },
      { date: "2026-02-30" },
    ])
      expect((await put({ ...note, ...patch })).status).toBe(400);
    expect((await household()).meals).toEqual([{ ...note, recipe: null, revision: expect.any(String) }]);

    expect((await send("recipes", "PUT", JSON.stringify(sampleRecipes[0]))).status).toBe(200);
    expect((await put(meal)).status).toBe(200);
    let state = await household();
    const ingredients = shoppingList(state.groceries);
    expect(ingredients).toEqual([]);
    const edited = { ...note, date: "2026-09-23", slot: "Lunch" as const, note: "Leftovers" };
    expect((await put(edited)).status).toBe(200);
    expect((await household()).meals).toEqual([
      { ...meal, recipe: sampleRecipes[0], revision: expect.any(String) },
      { ...edited, recipe: null, revision: expect.any(String) },
    ]);
    // Both conversions replace the same row; no phantom ingredients or lost recipe links.
    expect((await put({ ...meal, id: note.id })).status).toBe(200);
    expect((await household()).meals).toHaveLength(2);
    expect((await put(edited)).status).toBe(200);
    state = await household();
    expect(shoppingList(state.groceries)).toEqual(ingredients);
    expect((await send(`meals/${note.id}`, "DELETE", "{}")).status).toBe(200);
    expect((await household()).meals).toEqual([
      { ...meal, recipe: sampleRecipes[0], revision: expect.any(String) },
    ]);
  });
  it("defaults recipes to neutral and persists each rating without rewriting recipe fields", async () => {
    const recipe = sampleRecipes[0];
    expect((await send("recipes", "PUT", JSON.stringify(recipe))).status).toBe(200);
    const db = await worker.getD1Database("DB");
    expect(await db.prepare("SELECT rating FROM recipes WHERE id=?").bind(recipe.id).first()).toEqual({
      rating: "neutral",
    });

    for (const rating of ["up", "down", "neutral"] as const) {
      expect((await send(`recipes/rating/${recipe.id}`, "PUT", JSON.stringify({ rating }))).status).toBe(200);
      const response = await worker.dispatchFetch("http://localhost/api/household");
      const household = Schema.decodeUnknownSync(HouseholdSchema)(await response.json());
      expect(household.recipes[0]).toMatchObject({ id: recipe.id, title: recipe.title, rating });
    }

    expect((await send(`recipes/rating/${recipe.id}`, "PUT", '{"rating":"up"}')).status).toBe(200);
    expect((await send("recipes", "PUT", JSON.stringify({ ...recipe, title: "New title" }))).status).toBe(
      200,
    );
    expect(await db.prepare("SELECT title,rating FROM recipes WHERE id=?").bind(recipe.id).first()).toEqual({
      title: "New title",
      rating: "up",
    });

    for (const rating of ["liked", 1, null]) {
      expect((await send(`recipes/rating/${recipe.id}`, "PUT", JSON.stringify({ rating }))).status).toBe(400);
    }

    expect((await send("recipes/rating/missing", "PUT", '{"rating":"down"}')).status).toBe(404);
    expect(await db.prepare("SELECT rating FROM recipes WHERE id=?").bind(recipe.id).first()).toEqual({
      rating: "up",
    });
  });
  it("quick-adds a minimal grocery to one list atomically and keeps saved package counts on retry", async () => {
    const coffee = {
      id: "coffee",
      name: "  Coffee ",
      url: "",
      aisle: " 4 ",
      quantity: 1,
      unit: "each",
      aliases: ["Coffee"],
    };

    const state = async () =>
      Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

    const quickAdd = (value: typeof Schema.Json.Type) => send("shopping-items", "PUT", JSON.stringify(value));

    for (const id of ["quick", "other"])
      expect(
        (await send("shopping-lists", "PUT", JSON.stringify({ id, date: "2026-09-26", label: id }))).status,
      ).toBe(200);

    // The list is part of the contract; a missing list writes neither the product nor membership.
    expect((await quickAdd(coffee)).status).toBe(400);
    const missing = await quickAdd({ ...coffee, listId: "deleted-list" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: "That shopping list no longer exists. Refresh to see the current lists; nothing was saved.",
    });
    expect((await state()).groceries).toEqual([]);
    expect((await state()).shoppingItems).toEqual([]);

    expect((await quickAdd({ ...coffee, listId: "quick" })).status).toBe(200);
    expect((await state()).groceries).toEqual([
      { ...coffee, name: "Coffee", aisle: "4", revision: expect.any(String) },
    ]);
    expect((await state()).shoppingItems).toEqual([
      {
        listId: "quick",
        groceryId: "coffee",
        checked: 0,
        packages: 1,
        sources: [],
        addedAt: expect.any(String),
        checkedAt: null,
      },
    ]);

    expect(
      (await send("shopping-lists/quick/items/coffee", "PATCH", JSON.stringify({ checked: 1, packages: 3 })))
        .status,
    ).toBe(200);
    expect((await state()).shoppingItems[0]).toMatchObject({
      checked: 1,
      packages: 3,
      checkedAt: expect.any(String),
    });
    // Quick-adding something already picked up puts it back as needed, keeping the chosen count.
    expect((await quickAdd({ ...coffee, listId: "quick" })).status).toBe(200);
    expect((await state()).shoppingItems).toEqual([
      expect.objectContaining({
        listId: "quick",
        groceryId: "coffee",
        checked: 0,
        packages: 3,
        checkedAt: null,
      }),
    ]);
    // Another list on the same date gets its own fresh row.
    expect((await quickAdd({ ...coffee, listId: "other" })).status).toBe(200);
    expect(
      (await state()).shoppingItems.map(({ listId, checked, packages }) => ({ listId, checked, packages })),
    ).toEqual(
      expect.arrayContaining([
        { listId: "quick", checked: 0, packages: 3 },
        { listId: "other", checked: 0, packages: 1 },
      ]),
    );

    // A rejected item writes neither the product nor its list membership.
    expect((await quickAdd({ ...coffee, id: "blank", name: " ", listId: "quick" })).status).toBe(400);
    expect((await state()).groceries.map((item) => item.id)).toEqual(["coffee"]);
    expect((await state()).shoppingItems).toHaveLength(2);
  });
  it("returns every list and its rows in the household snapshot with decoded sources", async () => {
    const db = await worker.getD1Database("DB");

    for (const id of ["milk", "eggs"])
      expect(
        (
          await send(
            "groceries",
            "PUT",
            JSON.stringify({ id, name: id, url: "", aisle: "", quantity: 1, unit: "each", aliases: [] }),
          )
        ).status,
      ).toBe(200);
    expect(
      (
        await send(
          "shopping-lists",
          "PUT",
          JSON.stringify({ id: "later", date: "2026-10-03", label: "  Party  " }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await send("shopping-lists", "PUT", JSON.stringify({ id: "sooner", date: "2026-09-26", label: "" })))
        .status,
    ).toBe(200);

    const sources = [{ title: "Pancakes", mealId: "meal-1", date: "2026-09-27" }, { title: "Custard" }];

    const added = await send(
      "shopping-lists/later/items",
      "POST",
      JSON.stringify({
        items: [
          { groceryId: "milk", packages: 2, sources },
          { groceryId: "eggs", checked: 1 },
        ],
      }),
    );

    expect(await added.json()).toEqual({
      added: ["milk", "eggs"],
      updated: [],
      unchanged: [],
      conflicts: [],
    });
    // Sources are stored as JSON text but must reach callers as structured values.
    expect(
      await db
        .prepare("SELECT typeof(sources) AS type FROM shopping_list_items WHERE grocery_id='milk'")
        .first(),
    ).toEqual({ type: "text" });

    const household = await (await worker.dispatchFetch("http://localhost/api/household")).json();
    expect(Schema.decodeUnknownSync(HouseholdSchema)(household)).toEqual(household);
    expect(household).toMatchObject({
      shoppingLists: [
        { id: "sooner", date: "2026-09-26", label: "", revision: expect.stringMatching(/^[a-f0-9]{32}$/) },
        {
          id: "later",
          date: "2026-10-03",
          label: "Party",
          revision: expect.stringMatching(/^[a-f0-9]{32}$/),
        },
      ],
    });
    expect(Schema.decodeUnknownSync(HouseholdSchema)(household).shoppingItems).toEqual(
      expect.arrayContaining([
        {
          listId: "later",
          groceryId: "milk",
          checked: 0,
          packages: 2,
          sources,
          addedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
          checkedAt: null,
        },
        {
          listId: "later",
          groceryId: "eggs",
          checked: 1,
          packages: 1,
          sources: [],
          addedAt: expect.any(String),
          checkedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
        },
      ]),
    );
    expect(Schema.decodeUnknownSync(HouseholdSchema)(household).shoppingItems).toHaveLength(2);
  });
  it("keeps lists on the same date independent for the same grocery", async () => {
    const db = await worker.getD1Database("DB");

    for (const id of ["milk", "bread"])
      expect(
        (
          await send(
            "groceries",
            "PUT",
            JSON.stringify({ id, name: id, url: "", aisle: "", quantity: 1, unit: "each", aliases: [] }),
          )
        ).status,
      ).toBe(200);

    for (const id of ["weekly", "top-up"])
      expect(
        (await send("shopping-lists", "PUT", JSON.stringify({ id, date: "2026-09-26", label: id }))).status,
      ).toBe(200);

    const rows = async () =>
      (
        await db
          .prepare(
            "SELECT list_id,grocery_id,checked,packages FROM shopping_list_items ORDER BY list_id,grocery_id",
          )
          .all()
      ).results;

    expect(
      (
        await send(
          "shopping-lists/weekly/items",
          "POST",
          JSON.stringify({ items: [{ groceryId: "milk", packages: 2 }, { groceryId: "bread" }] }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await send(
          "shopping-lists/top-up/items",
          "POST",
          JSON.stringify({ items: [{ groceryId: "milk", packages: 5, checked: 1 }] }),
        )
      ).status,
    ).toBe(200);
    expect(await rows()).toEqual([
      { list_id: "top-up", grocery_id: "milk", checked: 1, packages: 5 },
      { list_id: "weekly", grocery_id: "bread", checked: 0, packages: 1 },
      { list_id: "weekly", grocery_id: "milk", checked: 0, packages: 2 },
    ]);

    // Checking or recounting a row on one list never touches the same grocery on another list.
    expect(
      (await send("shopping-lists/weekly/items/milk", "PATCH", JSON.stringify({ checked: 1 }))).status,
    ).toBe(200);
    expect(
      (await send("shopping-lists/top-up/items/milk", "PATCH", JSON.stringify({ checked: 0, packages: 7 })))
        .status,
    ).toBe(200);
    expect(await rows()).toEqual([
      { list_id: "top-up", grocery_id: "milk", checked: 0, packages: 7 },
      { list_id: "weekly", grocery_id: "bread", checked: 0, packages: 1 },
      { list_id: "weekly", grocery_id: "milk", checked: 1, packages: 2 },
    ]);

    // Grocery not on this list: a field-scoped patch must not add it, even though another list has it.
    expect(
      (await send("shopping-lists/top-up/items/bread", "PATCH", JSON.stringify({ checked: 1 }))).status,
    ).toBe(400);
    expect(
      await (
        await send("shopping-lists/top-up/items", "DELETE", JSON.stringify({ groceryIds: ["milk", "bread"] }))
      ).json(),
    ).toEqual({ removed: 1 });
    expect(await rows()).toEqual([
      { list_id: "weekly", grocery_id: "bread", checked: 0, packages: 1 },
      { list_id: "weekly", grocery_id: "milk", checked: 1, packages: 2 },
    ]);

    // Editing one list's date and label leaves both lists' rows and the other list's version alone.
    const before = Schema.decodeUnknownSync(HouseholdSchema)(
      await (await worker.dispatchFetch("http://localhost/api/household")).json(),
    );

    expect(
      (await send("shopping-lists", "PUT", JSON.stringify({ id: "top-up", date: "2026-09-27", label: "" })))
        .status,
    ).toBe(200);

    const after = Schema.decodeUnknownSync(HouseholdSchema)(
      await (await worker.dispatchFetch("http://localhost/api/household")).json(),
    );

    expect(after.shoppingItems).toEqual(before.shoppingItems);
    expect(after.shoppingLists.find((list) => list.id === "weekly")).toEqual(
      before.shoppingLists.find((list) => list.id === "weekly"),
    );
    expect(after.shoppingLists.find((list) => list.id === "top-up")).toMatchObject({
      date: "2026-09-27",
      label: "",
    });
  });

  it("classifies list additions and writes nothing for rejected batches", async () => {
    const db = await worker.getD1Database("DB");

    for (const id of ["a", "b", "c", "d", "e", "f"])
      expect(
        (
          await send(
            "groceries",
            "PUT",
            JSON.stringify({
              id,
              name: `Item ${id}`,
              url: "",
              aisle: "",
              quantity: 1,
              unit: "each",
              aliases: [],
            }),
          )
        ).status,
      ).toBe(200);
    expect(
      (await send("shopping-lists", "PUT", JSON.stringify({ id: "list", date: "2026-09-26", label: "" })))
        .status,
    ).toBe(200);

    const add = (items: typeof Schema.Json.Type, listId = "list") =>
      send(`shopping-lists/${listId}/items`, "POST", JSON.stringify({ items }));

    const rows = async () =>
      Object.fromEntries(
        (
          await db
            .prepare(
              "SELECT grocery_id,checked,packages,sources,checked_at FROM shopping_list_items WHERE list_id='list'",
            )
            .all<{
              grocery_id: string;
              checked: number;
              packages: number;
              sources: string;
              checked_at: string | null;
            }>()
        ).results.map((row) => [
          row.grocery_id,
          {
            checked: row.checked,
            packages: row.packages,
            sources: JSON.parse(row.sources),
            checkedAt: row.checked_at,
          },
        ]),
      );

    const soup = { title: "Soup", mealId: "meal-soup", date: "2026-09-28" };
    const stew = { title: "Stew" };

    const first = await add([
      { groceryId: "a", sources: [soup] },
      { groceryId: "b", packages: 2, sources: [soup] },
      { groceryId: "c", checked: 1 },
      { groceryId: "d", packages: 3 },
      { groceryId: "e", packages: 4, sources: [soup] },
    ]);

    expect(await first.json()).toEqual({
      added: ["a", "b", "c", "d", "e"],
      updated: [],
      unchanged: [],
      conflicts: [],
    });
    const initial = await rows();
    expect(initial).toEqual({
      a: { checked: 0, packages: 1, sources: [soup], checkedAt: null },
      b: { checked: 0, packages: 2, sources: [soup], checkedAt: null },
      c: { checked: 1, packages: 1, sources: [], checkedAt: expect.any(String) },
      d: { checked: 0, packages: 3, sources: [], checkedAt: null },
      e: { checked: 0, packages: 4, sources: [soup], checkedAt: null },
    });

    const second = await add([
      // Omitted count on an unchecked row: unchanged, the repeated source is not duplicated, the new one merges.
      { groceryId: "a", sources: [soup, stew] },
      // Same count on an unchecked row: unchanged.
      { groceryId: "b", packages: 2, sources: [stew] },
      // Already picked up: conflict even without a count.
      { groceryId: "c", sources: [stew] },
      // Different count: conflict, existing count and sources stay.
      { groceryId: "d", packages: 1, sources: [stew] },
      // Replace applies the count and checked state and merges sources.
      { groceryId: "e", packages: 6, checked: 1, sources: [soup, stew], replace: true },
      { groceryId: "f", packages: 2 },
    ]);

    expect(await second.json()).toEqual({
      added: ["f"],
      updated: ["e"],
      unchanged: ["a", "b"],
      conflicts: [
        { groceryId: "c", checked: 1, packages: 1 },
        { groceryId: "d", checked: 0, packages: 3 },
      ],
    });
    const merged = await rows();
    expect(merged.a).toEqual({ ...initial.a, sources: expect.arrayContaining([soup, stew]) });
    expect(merged.a.sources).toHaveLength(2);
    expect(merged.b).toEqual({ ...initial.b, sources: expect.arrayContaining([soup, stew]) });
    expect(merged.b.sources).toHaveLength(2);
    expect(merged.c).toEqual(initial.c);
    expect(merged.d).toEqual(initial.d);
    expect(merged.e).toEqual({
      checked: 1,
      packages: 6,
      sources: expect.arrayContaining([soup, stew]),
      checkedAt: expect.any(String),
    });
    expect(merged.e.sources).toHaveLength(2);
    expect(merged.f).toEqual({ checked: 0, packages: 2, sources: [], checkedAt: null });

    // Replace without a count keeps the count; unchecking clears the picked-up time.
    expect(
      await (
        await add([
          { groceryId: "e", replace: true },
          { groceryId: "c", replace: true, packages: 2 },
        ])
      ).json(),
    ).toEqual({
      added: [],
      updated: ["e", "c"],
      unchanged: [],
      conflicts: [],
    });
    const replaced = await rows();
    expect(replaced.e).toEqual({ ...merged.e, checked: 0, checkedAt: null });
    expect(replaced.c).toEqual({ checked: 0, packages: 2, sources: [], checkedAt: null });
    // Replacing with the same checked state keeps the original picked-up time.
    expect((await add([{ groceryId: "a", replace: true, checked: 1 }])).status).toBe(200);
    const pickedUp = (await rows()).a.checkedAt;
    expect(pickedUp).toEqual(expect.any(String));
    expect((await add([{ groceryId: "a", replace: true, checked: 1, packages: 9 }])).status).toBe(200);
    expect((await rows()).a).toMatchObject({ checked: 1, packages: 9, checkedAt: pickedUp });

    const settled = await rows();

    // A missing list, an unknown grocery, duplicates, or invalid counts reject the whole batch.
    const missingList = await add([{ groceryId: "a" }], "missing");
    expect(missingList.status).toBe(400);
    expect(await missingList.json()).toEqual({
      error: "That shopping list no longer exists. Refresh to see the current lists.",
    });
    expect(
      await db.prepare("SELECT count(*) AS count FROM shopping_list_items WHERE list_id='missing'").first(),
    ).toEqual({ count: 0 });
    expect(await db.prepare("SELECT count(*) AS count FROM shopping_lists").first()).toEqual({ count: 1 });

    const rejected: (typeof Schema.Json.Type)[] = [
      [{ groceryId: "f", packages: 8, replace: true }, { groceryId: "unknown" }],
      [
        { groceryId: "f", packages: 8, replace: true },
        { groceryId: "f", packages: 9, replace: true },
      ],
      [{ groceryId: "f", packages: 0, replace: true }],
      [{ groceryId: "f", packages: 2.5, replace: true }],
      [{ groceryId: "f", checked: 2, replace: true }],
      [],
    ];

    for (const items of rejected) {
      const response = await add(items);
      expect(response.status).toBe(400);
    }

    const unknown = await add([{ groceryId: "f", packages: 8, replace: true }, { groceryId: "unknown" }]);
    expect(await unknown.json()).toEqual({
      error:
        "Some of those groceries no longer exist. Refresh the groceries before adding them; no items were added.",
    });
    expect(await rows()).toEqual(settled);
    expect(await db.prepare("SELECT count(*) AS count FROM groceries").first()).toEqual({ count: 6 });

    // Each request allows 50 sources; merging across requests keeps the oldest 50 so the row stays readable.
    const meals = (from: number) =>
      Array.from({ length: 30 }, (_, index) => ({ title: `Meal ${from + index}` }));

    expect((await add([{ groceryId: "f", sources: meals(0), replace: true }])).status).toBe(200);
    expect((await add([{ groceryId: "f", sources: meals(30), replace: true }])).status).toBe(200);
    expect((await rows()).f?.sources).toEqual([...meals(0), ...meals(30).slice(0, 20)]);
    expect((await worker.dispatchFetch("http://localhost/api/household")).status).toBe(200);
  });

  it("patches checked state and package counts only for groceries already on the list", async () => {
    const db = await worker.getD1Database("DB");

    expect(
      (
        await send(
          "groceries",
          "PUT",
          JSON.stringify({
            id: "milk",
            name: "Milk",
            url: "",
            aisle: "",
            quantity: 1,
            unit: "l",
            aliases: [],
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await send("shopping-lists", "PUT", JSON.stringify({ id: "list", date: "2026-09-26", label: "" })))
        .status,
    ).toBe(200);
    expect(
      (
        await send(
          "shopping-lists/list/items",
          "POST",
          JSON.stringify({ items: [{ groceryId: "milk", packages: 2 }] }),
        )
      ).status,
    ).toBe(200);

    const row = () =>
      db
        .prepare(
          "SELECT checked,packages,checked_at AS checkedAt,added_at AS addedAt FROM shopping_list_items WHERE list_id='list' AND grocery_id='milk'",
        )
        .first<{ checked: number; packages: number; checkedAt: string | null; addedAt: string }>();

    const patch = (value: typeof Schema.Json.Type) =>
      send("shopping-lists/list/items/milk", "PATCH", JSON.stringify(value));

    const added = await row();
    expect(added).toMatchObject({ checked: 0, packages: 2, checkedAt: null });
    expect(await (await patch({ checked: 1 })).json()).toEqual({ ok: true });
    const checked = await row();
    expect(checked).toMatchObject({
      checked: 1,
      packages: 2,
      checkedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
    // Count-only and repeated check patches keep the state and its original time.
    expect((await patch({ packages: 4 })).status).toBe(200);
    expect((await patch({ checked: 1 })).status).toBe(200);
    expect(await row()).toEqual({ ...checked, packages: 4 });
    expect((await patch({})).status).toBe(200);
    expect(await row()).toEqual({ ...checked, packages: 4 });
    expect((await patch({ checked: 0 })).status).toBe(200);
    expect(await row()).toEqual({ checked: 0, packages: 4, checkedAt: null, addedAt: added?.addedAt });
    expect((await patch({ packages: 3 })).status).toBe(200);
    expect(await row()).toMatchObject({ checked: 0, packages: 3, checkedAt: null });

    const invalid: (typeof Schema.Json.Type)[] = [
      { checked: 2 },
      { packages: 0 },
      { packages: 1.5 },
      { packages: 1_000_001 },
    ];

    for (const value of invalid) expect((await patch(value)).status).toBe(400);
    expect(await row()).toMatchObject({ checked: 0, packages: 3 });

    // Removing deletes the row; patching it afterwards fails instead of re-adding it.
    expect(
      await (
        await send("shopping-lists/list/items", "DELETE", JSON.stringify({ groceryIds: ["milk"] }))
      ).json(),
    ).toEqual({ removed: 1 });
    expect(
      await (
        await send("shopping-lists/list/items", "DELETE", JSON.stringify({ groceryIds: ["milk"] }))
      ).json(),
    ).toEqual({ removed: 0 });
    const gone = await patch({ checked: 1 });
    expect(gone.status).toBe(400);
    expect(await gone.json()).toEqual({
      error: "That grocery is no longer on this list. Refresh the list before changing it.",
    });
    expect(await row()).toBeNull();
    expect(
      (await send("shopping-lists/list/items", "DELETE", JSON.stringify({ groceryIds: [] }))).status,
    ).toBe(400);

    // Re-adding later is a fresh row: one package, unchecked, unless a count is given.
    expect(
      await (
        await send("shopping-lists/list/items", "POST", JSON.stringify({ items: [{ groceryId: "milk" }] }))
      ).json(),
    ).toMatchObject({ added: ["milk"] });
    expect(await row()).toMatchObject({ checked: 0, packages: 1, checkedAt: null });
    await send("shopping-lists/list/items", "DELETE", JSON.stringify({ groceryIds: ["milk"] }));
    expect(
      (
        await send(
          "shopping-lists/list/items",
          "POST",
          JSON.stringify({ items: [{ groceryId: "milk", packages: 6 }] }),
        )
      ).status,
    ).toBe(200);
    expect(await row()).toMatchObject({ checked: 0, packages: 6, checkedAt: null });
  });

  it("deletes a list with all of its rows only at the observed revision", async () => {
    const db = await worker.getD1Database("DB");

    const read = async () =>
      Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

    expect(
      (
        await send(
          "groceries",
          "PUT",
          JSON.stringify({
            id: "milk",
            name: "Milk",
            url: "",
            aisle: "",
            quantity: 1,
            unit: "l",
            aliases: [],
          }),
        )
      ).status,
    ).toBe(200);

    for (const id of ["doomed", "kept"]) {
      expect(
        (await send("shopping-lists", "PUT", JSON.stringify({ id, date: "2026-09-26", label: "" }))).status,
      ).toBe(200);
      expect(
        (await send(`shopping-lists/${id}/items`, "POST", JSON.stringify({ items: [{ groceryId: "milk" }] })))
          .status,
      ).toBe(200);
    }

    const stale = (await read()).shoppingLists.find((list) => list.id === "doomed")?.revision;

    if (!stale) throw new Error("List revision missing");
    expect(
      (
        await send(
          "shopping-lists",
          "PUT",
          JSON.stringify({ id: "doomed", date: "2026-09-26", label: "Renamed" }),
        )
      ).status,
    ).toBe(200);
    const before = await read();

    const rejected = await send(
      "shopping-lists/doomed",
      "DELETE",
      JSON.stringify({ expectedRevision: stale }),
    );

    expect(rejected.status).toBe(409);
    expect(await read()).toEqual(before);

    expect((await send("shopping-lists/doomed", "DELETE", "{}")).status).toBe(200);
    const after = await read();
    expect(after.shoppingLists.map((list) => list.id)).toEqual(["kept"]);
    expect(after.shoppingItems).toEqual(before.shoppingItems.filter((entry) => entry.listId === "kept"));
    expect(
      await db.prepare("SELECT count(*) AS count FROM shopping_list_items WHERE list_id='doomed'").first(),
    ).toEqual({ count: 0 });
    // The catalog grocery itself survives list deletion.
    expect(after.groceries.map((item) => item.id)).toEqual(["milk"]);
    // The deleted list cannot be revived by item writes.
    expect(
      (await send("shopping-lists/doomed/items", "POST", JSON.stringify({ items: [{ groceryId: "milk" }] })))
        .status,
    ).toBe(400);
    expect(
      (await send("shopping-lists/doomed", "DELETE", JSON.stringify({ expectedRevision: stale }))).status,
    ).toBe(409);
    expect(await read()).toEqual(after);
  });

  it("migrates the single legacy list into one dated list with catalog groceries for open extras", async () => {
    const migrateTo = async (db: D1Database, last: string, first = "") => {
      for (const name of (await readdir("migrations"))
        .filter((name) => name.endsWith(".sql") && name >= first && name <= last)
        .sort()) {
        const sql = await readFile(`migrations/${name}`, "utf8");
        await db.batch(
          sql
            .replace(/^--.*$/gm, "")
            .split(/;\s*\n(?=CREATE|INSERT|DROP|ALTER|UPDATE)|;\s*$/)
            .filter((s) => s.trim())
            .map((s) => db.prepare(s)),
        );
      }
    };

    for (const legacyState of ["empty", "off-list only", "populated"] as const) {
      const legacy = new Miniflare(options("true"));

      try {
        const db = await legacy.getD1Database("DB");
        await migrateTo(db, "0014_detached_meals.sql");

        const grocery = (id: string, name: string) =>
          db
            .prepare(
              "INSERT INTO groceries(id,name,url,aisle,quantity,unit,aliases) VALUES(?,?,'','2',1,'can','[]')",
            )
            .bind(id, name);

        const check = (key: string, checked: number, packages = 1) =>
          db.prepare("INSERT INTO checks(key,checked,packages) VALUES(?,?,?)").bind(key, checked, packages);

        const extra = (id: string, name: string, checked: number) =>
          db.prepare("INSERT INTO extras(id,name,checked) VALUES(?,?,?)").bind(id, name, checked);

        await db.batch([grocery("beans", "Black Beans"), grocery("rice", "Rice"), grocery("oil", "Oil")]);

        if (legacyState !== "empty")
          await db.batch([
            // Picked up / off the legacy list.
            check(JSON.stringify(["shopping-list", "rice"]), 1, 4),
            // Legacy recipe-total and other non-catalog keys.
            check("range-ingredient-total", 0),
            check('["Shopping-list","oil"]', 0),
            check('["shopping-list","deleted-product"]', 0),
            extra("done", "Paper towels", 1),
            extra("blank", "   ", 0),
          ]);

        if (legacyState === "populated")
          await db.batch([
            check(JSON.stringify(["shopping-list", "beans"]), 0, 3),
            check(JSON.stringify(["shopping-list", "oil"]), 0),
            // Matches the picked-up Rice product case-insensitively, putting it back on the list.
            extra("same", "  rICE ", 0),
            extra("new", "  Greek yogurt  ", 0),
            // Legacy extra IDs could be 100 characters; the prefixed grocery ID must still fit.
            extra("x".repeat(98), "Long note", 0),
          ]);

        const before = (await db.prepare("SELECT * FROM checks ORDER BY key").all()).results;
        await migrateTo(db, "0015_shopping_lists.sql", "0015_shopping_lists.sql");

        const household = Schema.decodeUnknownSync(HouseholdSchema)(
          await (await legacy.dispatchFetch("http://localhost/api/household")).json(),
        );

        // Legacy tables stay readable and unchanged for Workers still running the previous release.
        expect((await db.prepare("SELECT * FROM checks ORDER BY key").all()).results).toEqual(before);

        if (legacyState !== "populated") {
          expect(household.shoppingLists).toEqual([]);
          expect(household.shoppingItems).toEqual([]);
          expect(household.groceries.map((item) => item.id)).toEqual(["beans", "oil", "rice"]);
          continue;
        }

        const long = household.groceries.find((item) => item.name === "Long note");
        expect(long?.id).toMatch(/^extra-[a-f0-9]{32}$/);
        expect(household.shoppingItems.some((item) => item.groceryId === long?.id)).toBe(true);

        const now = new Date();
        const saturday = new Date(now.getTime() - ((now.getUTCDay() + 1) % 7) * 86_400_000);
        const listId = household.shoppingLists[0]?.id;
        const addedAt = `${saturday.toISOString().slice(0, 10)}T00:00:00.000Z`;

        // A fixed ID keeps the carried-over list identical wherever the migration runs.
        expect(household.shoppingLists).toEqual([
          {
            id: "legacy-list",
            date: saturday.toISOString().slice(0, 10),
            label: "",
            revision: expect.stringMatching(/^[a-f0-9]{32}$/),
          },
        ]);
        expect(
          household.shoppingItems
            .filter((item) => item.groceryId !== long?.id)
            .map(({ groceryId, checked, packages, sources, checkedAt, addedAt, listId: owner }) => ({
              groceryId,
              checked,
              packages,
              sources,
              checkedAt,
              owner,
              addedAt,
            }))
            .sort((a, b) => a.groceryId.localeCompare(b.groceryId)),
        ).toEqual([
          {
            groceryId: "beans",
            checked: 0,
            packages: 3,
            sources: [],
            checkedAt: null,
            owner: listId,
            addedAt,
          },
          {
            groceryId: "extra-new",
            checked: 0,
            packages: 1,
            sources: [],
            checkedAt: null,
            owner: listId,
            addedAt,
          },
          { groceryId: "oil", checked: 0, packages: 1, sources: [], checkedAt: null, owner: listId, addedAt },
          // The open extra reuses the existing grocery instead of creating a duplicate product.
          {
            groceryId: "rice",
            checked: 0,
            packages: 1,
            sources: [],
            checkedAt: null,
            owner: listId,
            addedAt,
          },
        ]);
        expect(
          household.groceries
            .filter((item) => item !== long)
            .map((item) => item.id)
            .sort(),
        ).toEqual(["beans", "extra-new", "oil", "rice"]);
        expect(household.groceries.find((item) => item.id === "extra-new")).toEqual({
          id: "extra-new",
          name: "Greek yogurt",
          url: "",
          aisle: "",
          quantity: 1,
          unit: "each",
          aliases: ["Greek yogurt"],
          revision: expect.stringMatching(/^[a-f0-9]{32}$/),
        });
        expect(household.groceries.find((item) => item.id === "beans")?.name).toBe("Black Beans");
      } finally {
        await legacy.dispose();
      }
    }
  });

  it("rejects malformed encoded IDs as client errors and decodes valid IDs once", async () => {
    const db = await worker.getD1Database("DB");

    for (const resource of ["recipes", "meals", "shopping-lists", "groceries", "collections"]) {
      const table = resource.replace("-", "_");

      for (const id of ["%", "%E0%A4%A"]) {
        const response = await send(`${resource}/${id}`, "DELETE", "{}");
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "Invalid item ID." });
      }

      const base = `delete-${resource}-base`;

      for (const suffix of ["?variant", "#variant", "/%20 space 食"]) {
        const id = base + suffix;

        for (const itemId of [base, id]) {
          const item =
            resource === "recipes"
              ? { ...sampleRecipes[0], id: itemId }
              : resource === "meals"
                ? { ...meal, id: itemId, recipeId: null, note: "Disposable note" }
                : resource === "shopping-lists"
                  ? { id: itemId, date: "2026-09-26", label: "" }
                  : resource === "groceries"
                    ? { id: itemId, name: "Milk", aliases: [], quantity: 1, unit: "l", aisle: "", url: "" }
                    : { id: itemId, name: itemId };

          expect((await send(resource, "PUT", JSON.stringify(item))).status).toBe(200);
        }

        expect((await send(`${resource}/${encodeURIComponent(id)}`, "DELETE", "{}")).status).toBe(200);
        expect(await db.prepare(`SELECT id FROM ${table} WHERE id=?`).bind(id).first()).toBeNull();
        expect(await db.prepare(`SELECT id FROM ${table} WHERE id=?`).bind(base).first()).toEqual({
          id: base,
        });
      }
    }
  });
  it("rejects cross-site writes and non-JSON requests", async () => {
    expect(
      (
        await worker.dispatchFetch("http://localhost/api/recipes", {
          method: "PUT",
          headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (await worker.dispatchFetch("http://localhost/api/recipes", { method: "PUT", body: "{}" })).status,
    ).toBe(415);
  });
  it("seeds only an empty household and refuses overwriting an existing collection", async () => {
    const grocery = {
      id: "demo-link",
      name: sampleRecipes[0].ingredients[0].name,
      url: "",
      aisle: "",
      quantity: 1,
      unit: "each",
      aliases: [],
    };

    expect((await send("groceries", "PUT", JSON.stringify(grocery))).status).toBe(200);
    expect((await send("demo?today=2026-09-27", "POST", "{}")).status).toBe(200);
    expect((await send("demo?today=2026-09-27", "POST", "{}")).status).toBe(409);
    const db = await worker.getD1Database("DB");
    expect(await db.prepare("SELECT count(*) AS count FROM recipes").first()).toEqual({ count: 6 });
    expect(await db.prepare("SELECT count(*) AS count FROM meals").first()).toEqual({ count: 5 });

    const household = Schema.decodeUnknownSync(HouseholdSchema)(
      await (await worker.dispatchFetch("http://localhost/api/household")).json(),
    );

    for (const entry of household.meals) {
      const recipe = household.recipes.find((recipe) => recipe.id === entry.recipeId);

      if (!recipe) throw new Error("Missing demo recipe");
      const { revision: _revision, ...snapshot } = recipe;
      expect(entry.recipe).toEqual(snapshot);
    }

    expect(
      household.recipes.find((recipe) => recipe.id === sampleRecipes[0].id)?.ingredients[0].groceryItemId,
    ).toBe("demo-link");
    expect(household.groceries).toHaveLength(8);
    expect(household.groceries.find((item) => item.id === "demo-link")).toEqual({
      ...grocery,
      revision: expect.any(String),
    });
    expect(household.groceries.some((item) => item.id === "sample-chicken")).toBe(false);

    expect(household.shoppingLists).toEqual([
      { id: "sample-list", date: "2026-09-26", label: "", revision: expect.any(String) },
    ]);
    const items = shoppingList(household.groceries, household.shoppingOrder, household.shoppingItems);
    expect(items).toHaveLength(8);
    expect(
      items
        .filter((item) => item.entry)
        .map((item) => [item.grocery.id, item.entry?.checked, item.entry?.packages])
        .sort(),
    ).toEqual([
      ["sample-beans", 0, 1],
      ["sample-spinach", 0, 1],
    ]);
    expect((await send("demo?today=2026-09-27", "POST", "{}")).status).toBe(409);
    expect(await (await worker.dispatchFetch("http://localhost/api/household")).json()).toEqual(household);
  });
  it("rolls back sample groceries and recipes when the demo batch cannot finish", async () => {
    expect(
      (
        await send(
          "shopping-lists",
          "PUT",
          JSON.stringify({ id: "sample-list", date: "2026-09-01", label: "Keep" }),
        )
      ).status,
    ).toBe(200);
    const before = await (await worker.dispatchFetch("http://localhost/api/household")).json();
    expect((await send("demo?today=2026-09-27", "POST", "{}")).status).toBe(500);
    expect(await (await worker.dispatchFetch("http://localhost/api/household")).json()).toEqual(before);
  });
  it("imports a draft without writing, then persists reviewed fields and the exact source URL", async () => {
    const source =
      "https://cooking.nytimes.com/recipes/1018529-coq-au-vin?unlocked_article_code=test&smid=share";

    const response = await send("recipes/import", "POST", JSON.stringify({ url: source }));

    expect(response.status, await response.clone().text()).toBe(200);

    const result = Schema.decodeUnknownSync(
      Schema.Struct({ recipe: RecipeSchema, warnings: Schema.Array(Schema.String) }),
    )(await response.json());

    const db = await worker.getD1Database("DB");

    expect(await db.prepare("SELECT count(*) AS count FROM recipes").first()).toEqual({ count: 0 });
    expect(result.recipe).toMatchObject({ title: "Coq au Vin", source, minutes: 120, servings: 4 });
    expect(result.recipe.ingredients).toHaveLength(20);
    expect(result.recipe.ingredients[0].originalText).toBe("3 pounds chicken legs and thighs");
    expect(result.recipe.instructions).toHaveLength(9);
    expect((await send("recipes", "PUT", JSON.stringify(result.recipe))).status).toBe(200);

    const stored = Schema.decodeUnknownSync(
      Schema.Struct({
        source: RecipeSchema.fields.source,
        ingredients: Schema.fromJsonString(RecipeSchema.fields.ingredients),
        instructions: Schema.fromJsonString(RecipeSchema.fields.instructions),
      }),
      { onExcessProperty: "error" },
    )(
      await db
        .prepare("SELECT source,ingredients,instructions FROM recipes WHERE id=?")
        .bind(result.recipe.id)
        .first(),
    );

    expect(stored.source).toBe(source);
    expect(stored.ingredients).toEqual(result.recipe.ingredients);
    expect(stored.instructions).toEqual(result.recipe.instructions);
    expect((await send(`recipes/${result.recipe.id}`, "DELETE", "{}")).status).toBe(200);
  });
  it("imports through three same-site redirects while preserving gift access and the original source", async () => {
    const source = "https://cooking.nytimes.com/recipes/7?unlocked_article_code=test&smid=share";
    const response = await send("recipes/import", "POST", JSON.stringify({ url: source }));

    expect(response.status).toBe(200);

    const result = Schema.decodeUnknownSync(
      Schema.Struct({ recipe: RecipeSchema, warnings: Schema.Array(Schema.String) }),
    )(await response.json());

    expect(result.recipe).toMatchObject({ title: "Coq au Vin", source, minutes: 120, servings: 4 });
    expect(result.recipe.ingredients).toHaveLength(20);
    const db = await worker.getD1Database("DB");
    expect(await db.prepare("SELECT count(*) AS count FROM recipes").first()).toEqual({ count: 0 });
  });
  it("imports non-NYT structured drafts and follows safe redirects without saving until reviewed", async () => {
    const db = await worker.getD1Database("DB");

    for (const path of ["jsonld", "canonical", "html"]) {
      const source = `https://recipes.example.com/${path}`;
      const response = await send("recipes/import", "POST", JSON.stringify({ url: source }));
      expect(response.status).toBe(200);

      const result = Schema.decodeUnknownSync(
        Schema.Struct({ recipe: RecipeSchema, warnings: Schema.Array(Schema.String) }),
      )(await response.json());

      expect(await db.prepare("SELECT count(*) AS count FROM recipes").first()).toEqual({ count: 0 });
      expect(result.recipe.source).toBe(source);

      if (path === "html") {
        expect(result.recipe).toMatchObject({ title: "Structured soup", servings: 6, minutes: 1 });
        expect(result.recipe.ingredients).toHaveLength(2);
        expect(result.recipe.ingredients[0]).toMatchObject({
          quantity: 0.5,
          unit: "cup",
          name: "lentils",
          originalText: "1/2 cup lentils",
        });
        expect(result.recipe.instructions).toEqual(["Rinse the lentils.", "Simmer until tender."]);
        expect(result.warnings.join(" ")).toContain("placeholder");
      } else {
        expect(result.recipe).toMatchObject({
          title: "Weeknight beans",
          minutes: 30,
          servings: 1,
          photo: "https://recipes.example.com/beans.jpg",
        });
        expect(result.recipe.instructions).toEqual(["Rinse & drain.", "Cook for 23 minutes."]);
        expect(result.recipe.ingredients[0]).toMatchObject({ quantity: 1.5, unit: "cup", name: "beans" });
        expect(result.warnings.join(" ")).toContain("Servings are set to 1 as a placeholder");
      }

      expect((await send("recipes", "PUT", JSON.stringify(result.recipe))).status).toBe(200);

      const household = Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

      expect(household.recipes.find((recipe) => recipe.id === result.recipe.id)).toMatchObject(result.recipe);
      expect((await send(`recipes/${result.recipe.id}`, "DELETE", "{}")).status).toBe(200);
    }
  });
  it("keeps recipe entity ownership and complete instructions while recovering optional metadata", async () => {
    const db = await worker.getD1Database("DB");

    for (const path of [
      "nested-microdata",
      "nested-microformat",
      "instructions-fallback",
      "instructions-empty-children",
      "metadata-absent",
      "metadata-null",
      "metadata-malformed",
      "metadata-fallback",
    ]) {
      const source = `https://recipes.example.com/${path}`;
      const response = await send("recipes/import", "POST", JSON.stringify({ url: source }));
      expect(response.status, path).toBe(200);

      const result = Schema.decodeUnknownSync(
        Schema.Struct({ recipe: RecipeSchema, warnings: Schema.Array(Schema.String) }),
      )(await response.json());

      expect(result.recipe).toMatchObject({
        title: path.startsWith("nested-") ? "Scoped soup" : "Metadata soup",
        source,
        description: "",
        servings: path === "metadata-fallback" ? 3 : 1,
        minutes: path === "metadata-fallback" ? 29 : 1,
        photo: path === "metadata-fallback" ? "https://recipes.example.com/soup.jpg" : "",
        ingredients: [{ quantity: 2, unit: "cup", name: "lentils", originalText: "2 cups lentils" }],
        instructions: ["Simmer until tender."],
      });
      expect(result.warnings.filter((warning) => warning.includes("placeholder"))).toHaveLength(
        path === "metadata-fallback" ? 0 : 2,
      );
      expect(await db.prepare("SELECT count(*) AS count FROM recipes").first()).toEqual({ count: 0 });
      expect((await send("recipes", "PUT", JSON.stringify(result.recipe))).status).toBe(200);

      const household = Schema.decodeUnknownSync(HouseholdSchema)(
        await (await worker.dispatchFetch("http://localhost/api/household")).json(),
      );

      expect(household.recipes.find((recipe) => recipe.id === result.recipe.id)).toMatchObject(result.recipe);
      expect((await send(`recipes/${result.recipe.id}`, "DELETE", "{}")).status).toBe(200);
    }
  });
  it("rejects unsafe DNS destinations and URLs, excessive redirects, blocked or incomplete pages, and oversized pages", async () => {
    for (const url of [
      "http://localhost/",
      "https://localhost/",
      "https://127.0.0.1/",
      "https://2130706433/",
      "https://[::ffff:127.0.0.1]/",
      "https://user:password@recipes.example.com/recipe",
      "https://recipes.example.com:8443/recipe",
      "https://private.example.com/recipe",
      "https://mixed.example.com/recipe",
      "https://no-dns.example.com/recipe",
      "https://recipes.example.com/redirect",
      "https://recipes.example.com/empty",
      "https://recipes.example.com/instructions-mixed",
      "https://cooking.nytimes.com.evil.test/recipes/1",
      "https://cooking.nytimes.com/recipes/2",
      "https://cooking.nytimes.com/recipes/3",
      "https://cooking.nytimes.com/recipes/4",
      "https://cooking.nytimes.com/recipes/5",
      "https://cooking.nytimes.com/recipes/7?unlocked_article_code=test&hop=-1",
      "https://cooking.nytimes.com/recipes/8",
      "https://cooking.nytimes.com/recipes/9",
      "https://cooking.nytimes.com/recipes/10",
      ...[
        "https://cooking.nytimes.com.evil.test/recipes/1",
        "http://cooking.nytimes.com/recipes/1",
        "https://cooking.nytimes.com:8443/recipes/1",
        "https://user:password@cooking.nytimes.com/recipes/1",
        "https://private.example.com/recipe",
      ].map((target) => `https://cooking.nytimes.com/recipes/9?to=${encodeURIComponent(target)}`),
    ]) {
      const response = await send("recipes/import", "POST", JSON.stringify({ url }));

      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty("error");
    }

    expect((await send("recipes/import", "POST", "{}")).status).toBe(400);

    const rejected = await send(
      "recipes/import",
      "POST",
      JSON.stringify({ url: "https://cooking.nytimes.com/recipes/6" }),
    );

    expect(rejected.status).toBe(400);
    expect(rejected.headers.get("Cache-Control")).toBe("no-store");
    expect(await rejected.json()).toEqual({
      error: "The recipe page couldn’t be read. Try an unlocked share link or add the recipe manually.",
    });
    const db = await worker.getD1Database("DB");
    expect(await db.prepare("SELECT count(*) AS count FROM recipes").first()).toEqual({ count: 0 });
  });
  it("requires a signed Access token even when the assets router omits runtime context", async () => {
    expect((await send("demo?today=2026-09-27", "POST", "{}")).status).toBe(200);
    await worker.setOptions(options("false"));

    expect(
      (
        await worker.dispatchFetch("http://localhost/api/telemetry", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "http://localhost" },
          body: "[]",
        })
      ).status,
    ).toBe(403);

    for (const path of ["/", "/api/household", "/api/telemetry"]) {
      const denied = await worker.dispatchFetch(`http://localhost${path}`);
      expect(denied.status).toBe(403);
      expect(denied.headers.get("WWW-Authenticate")).toBeNull();

      const forged = await worker.dispatchFetch(`http://localhost${path}`, {
        headers: {
          "Cf-Access-Authenticated-User-Email": "joe5saia@gmail.com",
          "Cf-Access-Jwt-Assertion": "forged-token",
          Authorization: "Basic " + btoa("hearth:old-password"),
        },
      });

      expect(forged.status).toBe(403);
    }

    const sign = (claims: JWTPayload, key = signingKey) =>
      new SignJWT({
        iss: "https://saiaai.cloudflareaccess.com",
        aud: ["test-hearth"],
        sub: "test-user",
        exp: Math.floor(Date.now() / 1000) + 300,
        ...claims,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .sign(key);

    // No ctx.access stub: reproduce the production Static Assets router.
    for (const email of ["joe5saia@gmail.com", "shannonnitroy@gmail.com"]) {
      const authorized = await worker.dispatchFetch("http://localhost/api/household", {
        headers: { "Cf-Access-Jwt-Assertion": await sign({ email }) },
      });

      expect(authorized.status).toBe(200);
      expect(authorized.headers.get("WWW-Authenticate")).toBeNull();
      const household = Schema.decodeUnknownSync(HouseholdSchema)(await authorized.json());
      expect(household).toHaveProperty("recipes.length", 6);
      expect(household).toHaveProperty("meals.length", 5);
    }

    const wrongKey = (await generateKeyPair("RS256")).privateKey;

    const invalidTokens = [
      await sign({ aud: ["another-application"] }),
      await sign({ iss: "https://another-team.cloudflareaccess.com" }),
      await sign({ exp: Math.floor(Date.now() / 1000) - 60 }),
      await sign({ exp: undefined }),
      await sign({ nbf: Math.floor(Date.now() / 1000) + 300 }),
      await sign({}, wrongKey),
    ];

    for (const token of invalidTokens) {
      const denied = await worker.dispatchFetch("http://localhost/api/household", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      });

      expect(denied.status).toBe(403);
    }

    await worker.setOptions(options("false", ""));

    const unconfigured = await worker.dispatchFetch("http://localhost/api/household", {
      headers: { "Cf-Access-Jwt-Assertion": await sign({}) },
    });

    expect(unconfigured.status).toBe(403);
  });

  it("recovers in the Worker runtime after a cold JWKS fetch fails without changing the assertion", async () => {
    let fetches = 0;
    await worker.setOptions(
      options("false", "test-hearth", "smoke-test.access", "", () => {
        fetches++;

        return fetches === 1 ? new Response("Unavailable", { status: 503 }) : Response.json(publicKeys);
      }),
    );

    const token = await new SignJWT({
      iss: "https://saiaai.cloudflareaccess.com",
      aud: ["test-hearth"],
      sub: "",
      common_name: "smoke-test.access",
      exp: Math.floor(Date.now() / 1000) + 300,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .sign(signingKey);

    const read = () =>
      worker.dispatchFetch("http://localhost/api/household", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      });

    const failed = await read();
    expect(failed.status).toBe(403);
    expect(await failed.text()).toBe("Cloudflare Access sign-in is required.");
    expect(failed.headers.get("Cache-Control")).toBe("no-store");

    for (let i = 0; i < 2; i++) {
      const response = await read();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        collections: defaultCollections,
        groceries: [],
        shoppingOrder: { aisles: [], items: [], revision: expect.any(String) },
        recipes: [],
        recipesAdded: [],
        meals: [],
        shoppingLists: [],
        shoppingItems: [],
      });
    }

    expect(fetches).toBe(2);
  });

  it("limits the configured service identity to reads without changing household access", async () => {
    await worker.setOptions(options("false"));

    const sign = (claims: JWTPayload) =>
      new SignJWT({
        iss: "https://saiaai.cloudflareaccess.com",
        aud: ["test-hearth"],
        sub: "",
        common_name: "smoke-test.access",
        exp: Math.floor(Date.now() / 1000) + 300,
        ...claims,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .sign(signingKey);

    const token = await sign({});
    const headers = { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json" };
    const read = await worker.dispatchFetch("http://localhost/api/household", { headers });
    expect(read.status).toBe(200);
    expect(await read.json()).toHaveProperty("shoppingLists.length", 0);

    for (const method of ["PUT", "POST", "PATCH", "DELETE"]) {
      const denied = await worker.dispatchFetch("http://localhost/api/shopping-lists", {
        method,
        headers,
        body: JSON.stringify({ id: "smoke-list", date: "2026-09-26", label: "Must not be saved" }),
      });

      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "Smoke-test access is read-only." });
    }

    for (const claims of [
      { common_name: "other-service.access" },
      { common_name: undefined },
      { aud: ["other-app"] },
      { exp: Math.floor(Date.now() / 1000) - 1 },
    ]) {
      const denied = await worker.dispatchFetch("http://localhost/api/household", {
        headers: { "Cf-Access-Jwt-Assertion": await sign(claims) },
      });

      expect(denied.status).toBe(403);
    }

    const human = await worker.dispatchFetch("http://localhost/api/shopping-lists", {
      method: "PUT",
      headers: {
        ...headers,
        "Cf-Access-Jwt-Assertion": await sign({ sub: "household-user", common_name: undefined }),
      },
      body: JSON.stringify({
        id: "human-list",
        date: "2026-09-26",
        label: "Human shopping list",
        expectedRevision: null,
      }),
    });

    expect(human.status).toBe(200);
    const household = await worker.dispatchFetch("http://localhost/api/household", { headers });
    expect(await household.json()).toHaveProperty("shoppingLists.length", 1);

    await worker.setOptions(options("false", "test-hearth", ""));
    expect((await worker.dispatchFetch("http://localhost/api/household", { headers })).status).toBe(403);
  });

  it("allows writes only for the explicitly bound preview identity and keeps smoke access read-only", async () => {
    const sign = (clientId: string, audience = "test-hearth") =>
      new SignJWT({
        iss: "https://saiaai.cloudflareaccess.com",
        aud: [audience],
        sub: "",
        common_name: clientId,
        exp: Math.floor(Date.now() / 1000) + 300,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .sign(signingKey);

    const put = async (clientId: string, audience = "test-hearth") =>
      worker.dispatchFetch("http://localhost/api/shopping-lists", {
        method: "PUT",
        headers: {
          "Cf-Access-Jwt-Assertion": await sign(clientId, audience),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "preview-list",
          date: "2026-09-26",
          label: "Preview shopping list",
          expectedRevision: null,
        }),
      });

    await worker.setOptions(options("false", "test-hearth", "smoke-test.access", "preview-test.access"));
    expect((await put("preview-test.access")).status).toBe(200);

    const read = await worker.dispatchFetch("http://localhost/api/household", {
      headers: { "Cf-Access-Jwt-Assertion": await sign("preview-test.access") },
    });

    expect(await read.json()).toHaveProperty("shoppingLists", [
      {
        id: "preview-list",
        date: "2026-09-26",
        label: "Preview shopping list",
        revision: expect.any(String),
      },
    ]);
    expect((await put("unknown.access")).status).toBe(403);
    expect((await put("preview-test.access", "production-audience")).status).toBe(403);
    expect(await (await put("smoke-test.access")).json()).toEqual({
      error: "Smoke-test access is read-only.",
    });
    await worker.setOptions(options("false"));
    expect((await put("preview-test.access")).status).toBe(403);
    await worker.setOptions(options("false", "test-hearth", "smoke-test.access", "smoke-test.access"));
    expect(await (await put("smoke-test.access")).json()).toEqual({
      error: "Smoke-test access is read-only.",
    });
  });
});
