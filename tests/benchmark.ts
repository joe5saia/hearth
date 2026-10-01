import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { gzipSync } from "node:zlib";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { rolldown } from "rolldown";
import { shoppingList, displayAmount, type Recipe, type Meal } from "../src/domain.ts";

// Fixed data and serial warm runs: setup, bundling, and seeding are not timed.
const measurements: { name: string; medianMs: number; p95Ms: number; samples: number }[] = [];

async function measure<A>(name: string, run: () => A, iterations = 1) {
  for (let warmup = 0; warmup < 5; warmup++) await run();
  const times: number[] = [];

  for (let sample = 0; sample < 25; sample++) {
    const start = performance.now();

    for (let iteration = 0; iteration < iterations; iteration++) await run();
    times.push((performance.now() - start) / iterations);
  }

  times.sort((a, b) => a - b);
  measurements.push({ name, medianMs: times[12], p95Ms: times[23], samples: times.length });
}

const bundle = await rolldown({ input: "src/server.ts", platform: "browser" });

const result = await bundle.generate({ format: "esm" });

await bundle.close();

const entry = result.output.find((output) => output.type === "chunk" && output.isEntry);

assert(entry?.type === "chunk");

const payloads: { name: string; bytes: number; gzipBytes: number }[] = [];

for (const [name, recipeCount, mealCount, photoBytes] of [
  ["household", 50, 100, 0],
  ["large", 500, 2000, 0],
  ["photos", 50, 100, 32_768],
] as const) {
  const recipes: Recipe[] = Array.from({ length: recipeCount }, (_, i) => ({
    id: `recipe-${i}`,
    title: `Recipe ${String(i).padStart(4, "0")}`,
    description: "Benchmark recipe",
    servings: 4,
    minutes: 30,
    category: "Vegetarian",
    source: "",
    rating: "neutral",
    // Incompressible synthetic bytes approximate encoded photo transfer, not image decoding.
    photo: photoBytes
      ? `data:image/jpeg;base64,${createHash("shake256", { outputLength: (photoBytes * 3) / 4 })
          .update(String(i))
          .digest("base64")}`
      : "/photos/pasta.jpg",
    instructions: ["Prepare ingredients.", "Cook and serve."],
    ingredients: Array.from({ length: 12 }, (_, j) => ({
      name: `Ingredient ${(i + j) % 60}`,
      quantity: j + 0.5,
      unit: "g",
    })),
  }));

  const meals: Meal[] = Array.from({ length: mealCount }, (_, i) => ({
    id: `meal-${i}`,
    recipeId: recipes[(i * 37) % recipeCount].id,
    date: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`,
    slot: "Dinner",
    scale: (i % 3) + 0.5,
    note: "",
  }));

  const items = shoppingList(recipes, meals, "2026-09-01", "2026-09-28");
  // Independently computed total: sum of 0.5, 1.5, ..., 11.5 is 72.
  assert.equal(
    items.reduce((sum, item) => sum + item.needs[0].quantity, 0),
    72 * meals.reduce((sum, meal) => sum + meal.scale, 0),
  );
  await measure(`${name}/shopping-week`, () => shoppingList(recipes, meals, "2026-09-21", "2026-09-27"), 10);
  await measure(`${name}/shopping-month`, () => shoppingList(recipes, meals, "2026-09-01", "2026-09-28"), 10);
  await measure(`${name}/format-list`, () => items.map((item) => item.needs.map(displayAmount)), 10);

  const worker = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "benchmark",
          modules: true,
          script: entry.code,
          compatibilityDate: "2026-09-08",
          d1Databases: ["DB"],
          bindings: { LOCAL_DEV: "true" },
        },
      ],
    }),
  );

  try {
    const db = await worker.getD1Database("DB");

    for (const file of (await readdir("migrations")).filter((file) => file.endsWith(".sql")).sort()) {
      const sql = await readFile(`migrations/${file}`, "utf8");
      await db.batch(
        sql
          .split(/;\n(?=CREATE|INSERT)|;\s*$/)
          .filter((statement) => statement.trim())
          .map((statement) => db.prepare(statement)),
      );
    }

    await db.batch(
      recipes.map((recipe) =>
        db
          .prepare(
            "INSERT INTO recipes (id,title,description,servings,minutes,category,photo,source,ingredients,instructions) VALUES (?,?,?,?,?,?,?,?,?,?)",
          )
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
          ),
      ),
    );
    await db.batch(
      meals.map((meal) =>
        db
          .prepare("INSERT INTO meals (id,recipeId,date,slot,scale,note) VALUES (?,?,?,?,?,?)")
          .bind(meal.id, meal.recipeId, meal.date, meal.slot, meal.scale, meal.note),
      ),
    );
    const response = await worker.dispatchFetch("http://localhost/api/household");
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), {
      collections: [
        { id: "comfort", name: "Comfort food" },
        { id: "special", name: "Something special" },
        { id: "vegetarian", name: "Vegetarian" },
        { id: "weeknight", name: "Weeknight favorites" },
      ],
      recipes,
      meals: meals.toSorted((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)),
      extras: [],
      checks: [],
    });
    payloads.push({ name, bytes: Buffer.byteLength(body), gzipBytes: gzipSync(body).length });
    await measure(`${name}/household-api`, async () => {
      const response = await worker.dispatchFetch("http://localhost/api/household");
      assert.equal(response.status, 200);
      await response.json(); // Include transfer and JSON parsing, not just response headers.
    });
  } finally {
    await worker.dispose();
  }
}

const assets = await Promise.all(
  (await readdir("dist/assets"))
    .filter((file) => /\.(js|css)$/.test(file))
    .sort()
    .map(async (file) => {
      const data = await readFile(`dist/assets/${file}`);

      return { file, bytes: data.length, gzipBytes: gzipSync(data).length };
    }),
);

const report = {
  environment: { node: process.version, cpu: cpus()[0]?.model, platform: process.platform },
  methodology:
    "25 warm samples after 5 warmups; CPU samples average 10 operations; local disposable D1; no network/auth/cold-start/browser timing",
  measurements,
  payloads,
  assets,
};

console.table(measurements);

console.table(payloads);

console.table(assets);

if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
