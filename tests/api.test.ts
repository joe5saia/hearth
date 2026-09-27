import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { rolldown } from "rolldown";
import { readFile } from "node:fs/promises";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet, type JWTPayload } from "jose";
import { sampleRecipes } from "../src/seed";
import { Schema } from "effect";
import { RecipeSchema } from "../src/domain";

let worker: Miniflare;

let script = "";

let signingKey: CryptoKey;

let publicKeys: JSONWebKeySet;

function options(local: string, audience = "test-hearth") {
  return convertV4MiniflareOptions({
    workers: [
      {
        name: "hearth",
        modules: true,
        script,
        compatibilityDate: "2026-09-08",
        d1Databases: ["DB"],
        bindings: { LOCAL_DEV: local, ACCESS_AUD: audience },
        outboundService: async (request) => {
          const url = new URL(request.url);

          if (url.hostname === "cooking.nytimes.com") {
            if (url.pathname === "/recipes/2") return new Response("Denied", { status: 403 });

            if (url.pathname === "/recipes/3")
              return new Response("", { status: 302, headers: { Location: "http://localhost/secret" } });

            if (url.pathname === "/recipes/4") return new Response("<html>Sign in</html>");

            if (url.pathname === "/recipes/5") return new Response("x".repeat(5_000_001));

            return new Response(await readFile("tests/fixtures/nyt-coq-au-vin.html", "utf8"));
          }

          expect(request.url).toBe("https://saiaai.cloudflareaccess.com/cdn-cgi/access/certs");

          return Response.json(publicKeys);
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
}, 30000);

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
  it("starts empty and saves recipe JSON, decimal quantities, source, and photo", async () => {
    const initial = await worker.dispatchFetch("http://localhost/api/household");
    expect(await initial.json()).toEqual({ recipes: [], meals: [], extras: [], checks: [] });
    expect((await send("recipes", "PUT", JSON.stringify(sampleRecipes[0]))).status).toBe(200);
    const db = await worker.getD1Database("DB");

    const stored = await db
      .prepare("SELECT source,photo,ingredients FROM recipes WHERE id=?")
      .bind(sampleRecipes[0].id)
      .first<{ source: string; photo: string; ingredients: string }>();

    expect(stored?.photo).toBe("/photos/chicken.jpg");
    expect(stored?.source).toBe(sampleRecipes[0].source);
    expect(JSON.parse(stored?.ingredients ?? "[]")).toEqual(sampleRecipes[0].ingredients);
  });
  it("rejects malformed JSON, invalid URLs, quantities, empty ingredients, and invalid dates", async () => {
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

    const meal = {
      id: "test-meal",
      recipeId: sampleRecipes[0].id,
      date: "2026-09-21",
      slot: "Dinner",
      scale: 1.5,
      note: "Leftovers for lunch",
    };

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
    expect(await state.json()).toEqual({
      recipes: [],
      meals: [],
      extras: [{ id: "snack", name: "Apples & peanut butter", checked: 1 }],
      checks: [{ key: "range-ingredient-total", checked: 1 }],
    });
    expect((await send("extras/snack", "DELETE", "{}")).status).toBe(200);
    const db = await worker.getD1Database("DB");
    expect(await db.prepare("SELECT count(*) AS count FROM extras").first()).toEqual({ count: 0 });
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
    expect((await send("demo?today=2026-09-27", "POST", "{}")).status).toBe(200);
    expect((await send("demo?today=2026-09-27", "POST", "{}")).status).toBe(409);
    const db = await worker.getD1Database("DB");
    expect(await db.prepare("SELECT count(*) AS count FROM recipes").first()).toEqual({ count: 6 });
    expect(await db.prepare("SELECT count(*) AS count FROM meals").first()).toEqual({ count: 5 });
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

    expect(await db.prepare("SELECT count(*) AS count FROM recipes").first()).toEqual({ count: 6 });
    expect(result.recipe).toMatchObject({ title: "Coq au Vin", source, minutes: 120, servings: 4 });
    expect(result.recipe.ingredients).toHaveLength(20);
    expect(result.recipe.instructions).toHaveLength(9);
    expect((await send("recipes", "PUT", JSON.stringify(result.recipe))).status).toBe(200);

    const stored = await db
      .prepare("SELECT source,ingredients,instructions FROM recipes WHERE id=?")
      .bind(result.recipe.id)
      .first<{ source: string; ingredients: string; instructions: string }>();

    expect(stored?.source).toBe(source);
    expect(JSON.parse(stored?.ingredients ?? "[]")).toEqual(result.recipe.ingredients);
    expect(JSON.parse(stored?.instructions ?? "[]")).toEqual(result.recipe.instructions);
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
  });
  it("requires a signed Access token even when the assets router omits runtime context", async () => {
    await worker.setOptions(options("false"));

    for (const path of ["/", "/api/household"]) {
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
      const household = await authorized.json();
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
});
