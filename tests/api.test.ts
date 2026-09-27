import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { rolldown } from "rolldown";
import { readFile } from "node:fs/promises";
import { sampleRecipes } from "../src/seed";

let worker: Miniflare;

let script = "";

function options(local: string, password: string) {
  return convertV4MiniflareOptions({
    workers: [
      {
        name: "hearth",
        modules: true,
        script,
        compatibilityDate: "2026-09-08",
        d1Databases: ["DB"],
        bindings: { LOCAL_DEV: local, HOUSEHOLD_PASSWORD: password },
      },
    ],
  });
}

beforeAll(async () => {
  const bundle = await rolldown({ input: "src/server.ts", platform: "browser" });
  const result = await bundle.generate({ format: "esm" });
  await bundle.close();
  const entry = result.output.find((output) => output.type === "chunk" && output.isEntry);

  if (!entry || entry.type !== "chunk") throw new Error("Worker bundle missing.");
  script = entry.code;
  worker = new Miniflare(options("true", ""));
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
  it("fails closed in production and requires the correct household credentials", async () => {
    await worker.setOptions(options("false", ""));
    expect((await worker.dispatchFetch("http://localhost/api/household")).status).toBe(503);
    await worker.setOptions(options("false", "test-only-household-password"));
    const unauthorized = await worker.dispatchFetch("http://localhost/api/household");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("WWW-Authenticate")).toContain("Basic");
    expect(
      (
        await worker.dispatchFetch("http://localhost/api/household", {
          headers: { Authorization: "Basic " + btoa("hearth:wrong") },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await worker.dispatchFetch("http://localhost/api/household", {
          headers: { Authorization: "Basic " + btoa("hearth:test-only-household-password") },
        })
      ).status,
    ).toBe(200);
  });
});
