import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { rolldown } from "rolldown";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet, type JWTPayload } from "jose";
import { sampleRecipes } from "../src/seed";
import { Schema } from "effect";
import {
  HouseholdSchema,
  RecipeSchema,
  MealSchema,
  GroceryItemSchema,
  shoppingList,
  checkKey,
  type MealDraft,
  type Ingredient,
  type IngredientDraft,
  type RecipeId,
  type GroceryId,
} from "../src/domain";
import server from "../src/server";
import { recipeStatement } from "../src/recipes";
import type { WebsiteEnv } from "../alchemy.run";

let worker: Miniflare;

let script = "";

let signingKey: CryptoKey;

let publicKeys: JSONWebKeySet;

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
];

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

          if (url.hostname === "cooking.nytimes.com") {
            if (url.pathname === "/recipes/2") return new Response("Denied", { status: 403 });

            if (url.pathname === "/recipes/3")
              return new Response("", { status: 302, headers: { Location: "http://localhost/secret" } });

            if (url.pathname === "/recipes/4") return new Response("<html>Sign in</html>");

            if (url.pathname === "/recipes/5") return new Response("x".repeat(5_000_001));

            if (url.pathname === "/recipes/6") throw new Error("private upstream fetch detail");

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
  await recipeStatement(db, sampleRecipes[0]).run();
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
    db.prepare("DELETE FROM groceries"),
    db.prepare("DELETE FROM shopping_order"),
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

const send = (path: string, method: string, body: string) =>
  worker.dispatchFetch(`http://localhost/api/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body,
  });

describe("real Worker with disposable SQLite D1", () => {
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
    expect(await household.json()).toMatchObject({ recipes: [], meals: [], groceries: [], extras: [] });
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
      ["extras", "PUT", "The item is missing required fields."],
      ["checks", "PUT", "Invalid shopping item."],
    ];

    for (const [path, method, message] of routes) {
      for (const [body, error] of [
        ["{", "Please send valid JSON."],
        ["null", message],
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
      expect(Schema.decodeUnknownSync(HouseholdSchema)(await recovered.json())).toEqual(before);
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
    let household = await state();

    const list = () => shoppingList(household.groceries, household.shoppingOrder);

    let items = list();

    const byId = (id: string) => {
      const item = items.find((item) => item.grocery?.id === id);

      if (!item) throw new Error(`Expected grocery ${id} in the shopping list.`);

      return item;
    };

    expect(items).toHaveLength(products.length);
    expect(
      items.every(
        (item) => item.needs.length === 0 && item.recipes.length === 0 && item.warnings.length === 0,
      ),
    ).toBe(true);
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

    const checkedKey = checkKey(byId("rice"));
    // Unchecking adds a catalog item; checked=0 must survive household refreshes.
    await put("checks", { key: checkedKey, checked: 0 });

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
    expect(checkKey(byId("rice"))).toBe(checkedKey);
    expect(household.checks).toContainEqual({ key: checkedKey, checked: 0, packages: 1 });
    await put("meals", { ...meal, id: "second-meal", recipeId: "second", date: "2026-09-27", scale: 1.1 });
    household = await state();
    items = list();
    expect(checkKey(byId("rice"))).toBe(checkedKey);
    expect(household.checks).toContainEqual({ key: checkedKey, checked: 0, packages: 1 });
    await put("groceries", { ...products[0], quantity: 750, name: "Renamed rice" });
    household = await state();
    items = list();
    expect(checkKey(byId("rice"))).toBe(checkedKey);
    expect(household.checks).toContainEqual({ key: checkedKey, checked: 0, packages: 1 });
    await put("checks", { key: checkedKey, checked: 1 });
    expect((await state()).checks.some((entry) => entry.key === checkedKey)).toBe(false);
    expect(household.shoppingOrder).toEqual(order);
  });

  it("does not revive membership after a late check write and same-ID product recreation", async () => {
    const put = (path: string, value: typeof Schema.Json.Type) => send(path, "PUT", JSON.stringify(value));

    const product = {
      id: 'late-"rice\\雪',
      name: "Rice",
      url: "",
      aisle: "Pantry",
      quantity: 500,
      unit: "g",
      aliases: [],
    };

    const key = JSON.stringify(["shopping-list", product.id]);
    const db = await worker.getD1Database("DB");
    const membership = () => db.prepare("SELECT * FROM checks WHERE key=?").bind(key).first();

    expect((await put("groceries", product)).status).toBe(200);
    expect((await put("checks", { key, checked: 0, packages: 3, onlyIfAbsent: true })).status).toBe(200);
    // Another client updates the amount after a recipe review was opened.
    expect((await put("checks", { key, checked: 0, packages: 5 })).status).toBe(200);
    expect((await put("checks", { key, checked: 0, packages: 2, onlyIfAbsent: true })).status).toBe(200);

    const household = Schema.decodeUnknownSync(HouseholdSchema)(
      await (await worker.dispatchFetch("http://localhost/api/household")).json(),
    );

    expect(household.checks).toContainEqual({ key, checked: 0, packages: 5 });
    expect((await put("checks", { key, checked: 1, onlyIfAbsent: true })).status).toBe(400);
    expect((await put("checks", { key: "legacy", checked: 0, onlyIfAbsent: true })).status).toBe(400);
    expect((await put("checks", { key, checked: 0, packages: 3 })).status).toBe(200);
    expect((await put("checks", { key, checked: 0 })).status).toBe(200);
    expect(await membership()).toEqual({ key, checked: 0, packages: 3 });

    for (const packages of [0, -1, 1.5, 1_000_001]) {
      expect((await put("checks", { key, checked: 0, packages })).status).toBe(400);
    }

    expect(await membership()).toEqual({ key, checked: 0, packages: 3 });
    expect((await put("groceries", { ...product, name: "Renamed rice", quantity: 750 })).status).toBe(200);
    expect(await membership()).toEqual({ key, checked: 0, packages: 3 });

    // Force the harmful ordering: deletion commits before the delayed list-add reaches D1.
    expect((await send(`groceries/${encodeURIComponent(product.id)}`, "DELETE", "")).status).toBe(200);
    expect(await membership()).toBeNull();
    const late = await put("checks", { key, checked: 0 });
    expect((await put("checks", { key, checked: 0, packages: 2, onlyIfAbsent: true })).status).toBe(400);
    const orphan = await membership();
    expect((await put("groceries", product)).status).toBe(200);
    const revived = await membership();
    expect(orphan).toBeNull();
    expect(revived).toBeNull();
    expect(late.status).toBe(400);
    expect(await late.json()).toEqual({ error: "That grocery item no longer exists." });

    // A genuine addition to the recreated product must still work; removal is idempotent.
    expect((await put("checks", { key, checked: 0 })).status).toBe(200);
    expect(await membership()).toEqual({ key, checked: 0, packages: 1 });
    expect((await put("checks", { key, checked: 1 })).status).toBe(200);
    expect((await put("checks", { key, checked: 1 })).status).toBe(200);
    expect(await membership()).toBeNull();

    // Either database ordering of overlapping DELETE/add requests must leave no orphan.
    for (let attempt = 0; attempt < 12; attempt++) {
      expect((await put("groceries", product)).status).toBe(200);
      const remove = () => send(`groceries/${encodeURIComponent(product.id)}`, "DELETE", "");
      const add = () => put("checks", { key, checked: 0 });

      const [deleted, added] =
        attempt % 2
          ? await Promise.all([add(), remove()]).then(([a, d]) => [d, a])
          : await Promise.all([remove(), add()]);

      expect(deleted.status).toBe(200);
      expect([200, 400]).toContain(added.status);
      expect(await db.prepare("SELECT id FROM groceries WHERE id=?").bind(product.id).first()).toBeNull();
      expect(await membership()).toBeNull();
    }

    expect((await put("checks", { key, checked: 1 })).status).toBe(200);

    // SQL canonical key construction must agree with returned keys for valid Unicode/control IDs.
    for (const id of ["line\nfeed\t\u0000", "emoji-🛒/rice"]) {
      const key = JSON.stringify(["shopping-list", id]);
      expect((await put("groceries", { ...product, id })).status).toBe(200);
      expect((await put("checks", { key, checked: 0 })).status).toBe(200);
      expect(await db.prepare("SELECT * FROM checks WHERE key=?").bind(key).first()).toEqual({
        key,
        checked: 0,
        packages: 1,
      });
      expect((await send(`groceries/${encodeURIComponent(id)}`, "DELETE", "")).status).toBe(200);
      expect((await put("checks", { key, checked: 0 })).status).toBe(400);
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

    expect((await state()).shoppingOrder).toEqual({ aisles: [], items: [] });

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
    await recipeStatement(
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
    expect((await state()).shoppingOrder).toEqual(order);
    expect((await put("shopping-order", { ...order, items: ["rice", "rice"] })).status).toBe(400);
    expect((await send("groceries/other", "DELETE", "")).status).toBe(200);
    expect((await state()).groceries).toHaveLength(1);
  });
  it("deletes linked products atomically without losing recipe data or unrelated list membership", async () => {
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

    for (const product of [removed, keep])
      expect(
        (await put("checks", { key: JSON.stringify(["shopping-list", product.id]), checked: 0 })).status,
      ).toBe(200);
    const before = await state();

    const expectedRecipes = before.recipes.map((recipe) => ({
      ...recipe,
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
      checks: before.checks.filter((check) => check.key !== JSON.stringify(["shopping-list", removed.id])),
    });
    expect((await send(`groceries/${encodeURIComponent(removed.id)}`, "DELETE", "")).status).toBe(409);
    expect(await state()).toEqual(after);
    // A stale editor cannot resurrect dangling links or overwrite the unlinked recipe.
    expect((await put("recipes", before.recipes[0])).status).toBe(400);
    expect(await state()).toEqual(after);
    expect(
      (await put("checks", { key: JSON.stringify(["shopping-list", removed.id]), checked: 0 })).status,
    ).toBe(400);
    expect(await state()).toEqual(after);
    // Recreating an identical name/ID does not silently re-match explicitly unlinked ingredients.
    expect((await put("groceries", removed)).status).toBe(200);

    for (const recipe of expectedRecipes) expect((await put("recipes", recipe)).status).toBe(200);
    expect((await state()).recipes).toEqual(expectedRecipes);
    // Failure of the second batch statement rolls back the product deletion and recipe unlinking.
    const db = await worker.getD1Database("DB");
    await db
      .prepare(
        "CREATE TRIGGER reject_product_delete BEFORE DELETE ON checks BEGIN SELECT RAISE(ABORT, 'Delete rejected'); END",
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
    await put("checks", { key: '["shopping-list","chicken"]', checked: 0 });
    const before = await state();

    for (const to of ["   ", "x".repeat(151)])
      expect((await put("shopping-aisles", { from: "Meat", to })).status).toBe(400);
    expect((await put("shopping-aisles", { from: "Meat", to: "Produce" })).status).toBe(409);
    expect((await put("shopping-aisles", { from: "Missing", to: "Butcher" })).status).toBe(409);
    expect(await state()).toEqual(before);
    expect((await put("shopping-aisles", { from: "Meat", to: "  Butcher  " })).status).toBe(200);
    const after = await state();
    expect(after.groceries).toEqual(
      before.groceries.map((item) => (item.aisle === "Meat" ? { ...item, aisle: "Butcher" } : item)),
    );
    expect(after.shoppingOrder).toEqual({ ...order, aisles: ["Produce", "Butcher", ""] });
    expect(after.checks).toEqual(before.checks);
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
    expect(state.recipes).toEqual([recipe]);
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

    expect(state.recipes).toEqual([recipe]);
    expect(state.collections).toContainEqual({ id: "double", name: "Sunday  suppers" });
    expect(state.collections).toContainEqual({ id: "single", name: "Sunday suppers" });
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

      await recipeStatement(db, { ...sampleRecipes[0], category: "" }).run();
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

      const state = Schema.decodeUnknownSync(HouseholdSchema)(
        await (await legacy.dispatchFetch("http://localhost/api/household")).json(),
      );

      expect(state.collections).toEqual(defaultCollections);
      expect(state.recipes).toEqual([sampleRecipes[0]]);
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
    expect(renamed.collections).toContainEqual({ id: collection.id, name: "Weekend dinners" });
    expect(renamed.recipes.find((item) => item.id === recipe.id)).toEqual({
      ...recipe,
      category: "Weekend dinners",
    });
    expect(renamed.recipes.find((item) => item.id === sampleRecipes[1].id)).toEqual(sampleRecipes[1]);
    expect((await send(`collections/${encodeURIComponent(collection.id)}`, "DELETE", "{}")).status).toBe(200);
    const deleted = await read();
    expect(deleted.collections).toEqual(defaultCollections);
    expect(deleted.recipes.find((item) => item.id === recipe.id)).toEqual({ ...recipe, category: "" });
    expect(deleted.meals).toEqual([meal]);
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
    expect(state.recipes).toEqual([sampleRecipes[0]]);
    expect((await send("collections/missing", "DELETE", "{}")).status).toBe(404);
  });
  it("starts empty and saves recipe JSON, decimal quantities, source, and photo", async () => {
    const initial = await worker.dispatchFetch("http://localhost/api/household");
    expect(await initial.json()).toEqual({
      collections: defaultCollections,
      groceries: [],
      shoppingOrder: { aisles: [], items: [] },
      recipes: [],
      meals: [],
      extras: [],
      checks: [],
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
  it("updates rather than duplicates and protects planned recipes from deletion", async () => {
    expect((await send("recipes", "PUT", JSON.stringify(sampleRecipes[0]))).status).toBe(200);
    expect((await send("meals", "PUT", JSON.stringify(meal))).status).toBe(200);
    expect((await send(`recipes/${sampleRecipes[0].id}`, "DELETE", "{}")).status).toBe(409);
    expect(
      (await send("recipes", "PUT", JSON.stringify({ ...sampleRecipes[0], title: "Updated chicken" })))
        .status,
    ).toBe(200);
    const db = await worker.getD1Database("DB");
    expect(await db.prepare("SELECT count(*) AS count,title FROM recipes").first()).toEqual({
      count: 1,
      title: "Updated chicken",
    });
    expect((await send("meals/test-meal", "DELETE", "{}")).status).toBe(200);
    expect((await send(`recipes/${sampleRecipes[0].id}`, "DELETE", "{}")).status).toBe(200);
    expect(await db.prepare("SELECT count(*) AS count FROM recipes").first()).toEqual({ count: 0 });
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
    expect((await household()).meals).toEqual([note]);
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
    expect((await household()).meals).toEqual([note]);

    expect((await send("recipes", "PUT", JSON.stringify(sampleRecipes[0]))).status).toBe(200);
    expect((await put(meal)).status).toBe(200);
    let state = await household();
    const ingredients = shoppingList(state.groceries);
    expect(ingredients).toEqual([]);
    const edited = { ...note, date: "2026-09-23", slot: "Lunch" as const, note: "Leftovers" };
    expect((await put(edited)).status).toBe(200);
    expect((await household()).meals).toEqual([meal, edited]);
    // Both conversions replace the same row; no phantom ingredients or lost recipe links.
    expect((await put({ ...meal, id: note.id })).status).toBe(200);
    expect((await household()).meals).toHaveLength(2);
    expect((await put(edited)).status).toBe(200);
    state = await household();
    expect(shoppingList(state.groceries)).toEqual(ingredients);
    expect((await send(`meals/${note.id}`, "DELETE", "{}")).status).toBe(200);
    expect((await household()).meals).toEqual([meal]);
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
  it("persists independent extras and ingredient checks, and deletes only the requested extra", async () => {
    expect(
      (await send("extras", "PUT", JSON.stringify({ id: "snack", name: "Apples", checked: 0 }))).status,
    ).toBe(200);
    expect(
      (
        await send(
          "extras",
          "PUT",
          JSON.stringify({ id: "snack", name: "Apples & peanut butter", checked: 1 }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await send("checks", "PUT", JSON.stringify({ key: "range-ingredient-total", checked: 1 }))).status,
    ).toBe(200);
    const state = await worker.dispatchFetch("http://localhost/api/household");
    expect(Schema.decodeUnknownSync(HouseholdSchema)(await state.json())).toEqual({
      collections: defaultCollections,
      groceries: [],
      shoppingOrder: { aisles: [], items: [] },
      recipes: [],
      meals: [],
      extras: [{ id: "snack", name: "Apples & peanut butter", checked: 1 }],
      checks: [{ key: "range-ingredient-total", checked: 1, packages: 1 }],
    });
    expect((await send("extras/snack", "DELETE", "{}")).status).toBe(200);
    const db = await worker.getD1Database("DB");
    expect(await db.prepare("SELECT count(*) AS count FROM extras").first()).toEqual({ count: 0 });
  });
  it("removes legacy unchecked identities without changing other checked items", async () => {
    expect(
      (await send("checks", "PUT", JSON.stringify({ key: "range-ingredient-total", checked: 1 }))).status,
    ).toBe(200);
    expect((await send("checks", "PUT", JSON.stringify({ key: "keep-checked", checked: 1 }))).status).toBe(
      200,
    );

    for (const key of ["range-ingredient-total", "never-checked"]) {
      expect((await send("checks", "PUT", JSON.stringify({ key, checked: 0 }))).status).toBe(200);
    }

    const db = await worker.getD1Database("DB");
    expect((await db.prepare("SELECT * FROM checks").all()).results).toEqual([
      { key: "keep-checked", checked: 1, packages: 1 },
    ]);
    expect(
      (await send("checks", "PUT", JSON.stringify({ key: "range-ingredient-total", checked: 1 }))).status,
    ).toBe(200);
    expect(await db.prepare("SELECT count(*) AS count FROM checks").first()).toEqual({ count: 2 });
  });
  it("rejects malformed encoded IDs as client errors and decodes valid IDs once", async () => {
    const db = await worker.getD1Database("DB");

    for (const resource of ["recipes", "meals", "extras", "groceries", "collections"]) {
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
                : resource === "extras"
                  ? { id: itemId, name: "Milk", checked: 0 }
                  : resource === "groceries"
                    ? { id: itemId, name: "Milk", aliases: [], quantity: 1, unit: "l", aisle: "", url: "" }
                    : { id: itemId, name: itemId };

          expect((await send(resource, "PUT", JSON.stringify(item))).status).toBe(200);
        }

        expect((await send(`${resource}/${encodeURIComponent(id)}`, "DELETE", "{}")).status).toBe(200);
        expect(await db.prepare(`SELECT id FROM ${resource} WHERE id=?`).bind(id).first()).toBeNull();
        expect(await db.prepare(`SELECT id FROM ${resource} WHERE id=?`).bind(base).first()).toEqual({
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

    expect(
      household.recipes.find((recipe) => recipe.id === sampleRecipes[0].id)?.ingredients[0].groceryItemId,
    ).toBe("demo-link");
    expect(household.groceries).toHaveLength(8);
    expect(household.groceries.find((item) => item.id === "demo-link")).toEqual(grocery);
    expect(household.groceries.some((item) => item.id === "sample-chicken")).toBe(false);

    const items = shoppingList(household.groceries);
    expect(items).toHaveLength(8);
    expect(items.every((item) => item.needs.length === 0)).toBe(true);
    expect(household.checks).toEqual([]);
    expect((await send("demo?today=2026-09-27", "POST", "{}")).status).toBe(409);
    expect(await (await worker.dispatchFetch("http://localhost/api/household")).json()).toEqual(household);
  });
  it("rolls back sample groceries and recipes when the demo batch cannot finish", async () => {
    expect(
      (await send("extras", "PUT", JSON.stringify({ id: "sample-extra", name: "Keep this", checked: 0 })))
        .status,
    ).toBe(200);
    const before = await (await worker.dispatchFetch("http://localhost/api/household")).json();
    expect((await send("demo?today=2026-09-27", "POST", "{}")).status).toBe(500);
    expect(await (await worker.dispatchFetch("http://localhost/api/household")).json()).toEqual(before);
  });
  it("imports a draft without writing, then persists reviewed fields and the exact source URL", async () => {
    const source =
      "https://cooking.nytimes.com/recipes/1018529-coq-au-vin?unlocked_article_code=test&smid=share";

    const response = await send("recipes/import", "POST", JSON.stringify({ url: source }));

    expect(response.status).toBe(200);

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
  it("rejects unsupported URLs, blocked pages, redirects, missing recipe data, and oversized pages", async () => {
    for (const url of [
      "http://localhost/",
      "https://cooking.nytimes.com.evil.test/recipes/1",
      "https://cooking.nytimes.com/recipes/2",
      "https://cooking.nytimes.com/recipes/3",
      "https://cooking.nytimes.com/recipes/4",
      "https://cooking.nytimes.com/recipes/5",
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
      error: "NYT couldn’t be read. Try an unlocked share link or add the recipe manually.",
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
        shoppingOrder: { aisles: [], items: [] },
        recipes: [],
        meals: [],
        extras: [],
        checks: [],
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
    expect(await read.json()).toHaveProperty("extras.length", 0);

    for (const method of ["PUT", "POST", "PATCH", "DELETE"]) {
      const denied = await worker.dispatchFetch("http://localhost/api/extras", {
        method,
        headers,
        body: JSON.stringify({ id: "smoke-item", name: "Must not be saved", checked: 0 }),
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

    const human = await worker.dispatchFetch("http://localhost/api/extras", {
      method: "PUT",
      headers: {
        ...headers,
        "Cf-Access-Jwt-Assertion": await sign({ sub: "household-user", common_name: undefined }),
      },
      body: JSON.stringify({ id: "human-item", name: "Human shopping item", checked: 0 }),
    });

    expect(human.status).toBe(200);
    const household = await worker.dispatchFetch("http://localhost/api/household", { headers });
    expect(await household.json()).toHaveProperty("extras.length", 1);

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
      worker.dispatchFetch("http://localhost/api/extras", {
        method: "PUT",
        headers: {
          "Cf-Access-Jwt-Assertion": await sign(clientId, audience),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: "preview-item", name: "Preview shopping item", checked: 0 }),
      });

    await worker.setOptions(options("false", "test-hearth", "smoke-test.access", "preview-test.access"));
    expect((await put("preview-test.access")).status).toBe(200);

    const read = await worker.dispatchFetch("http://localhost/api/household", {
      headers: { "Cf-Access-Jwt-Assertion": await sign("preview-test.access") },
    });

    expect(await read.json()).toHaveProperty("extras", [
      { id: "preview-item", name: "Preview shopping item", checked: 0 },
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
