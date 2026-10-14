import { expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { rolldown } from "rolldown";
import { Schema } from "effect";
import { z } from "zod";
import { HouseholdSchema } from "../src/domain";
import { seedSql } from "../tools/production-data";

it("imports complete household data into real D1, preserves large/NUL/Unicode values and reinstates write constraints", async () => {
  const source = new DatabaseSync(":memory:");
  const migrations = (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort();

  for (const name of migrations) source.exec(await readFile(`migrations/${name}`, "utf8"));

  const schema = z
    .array(z.object({ sql: z.string() }))
    .parse(
      source
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END",
        )
        .all(),
    )
    .map((row) => row.sql);

  const text = (value: string) => `CAST(X'${Buffer.from(value).toString("hex")}' AS TEXT)`;
  const photo = `data:image/png;base64,${"a".repeat(1_200_000)}`;

  const instructions = JSON.stringify([
    "Cook 🥘\0 carefully. " + "stir ".repeat(1500),
    "Serve. " + "mix ".repeat(2000),
  ]);

  const description = "Unicode 🧅\0 preserved";

  const ingredients = JSON.stringify([
    { name: "Olive oil", quantity: 0.12345678901234568, unit: "tbsp", groceryItemId: "oil" },
  ]);

  const fixture = `
    DELETE FROM collections;
    INSERT INTO collections VALUES ('family', 'Family’s favorites');
    INSERT INTO groceries VALUES ('oil','Olive oil','https://example.com/oil','12',0.75,'l','["oil"]');
    UPDATE grocery_revision SET version=73;
    INSERT INTO recipes VALUES ('dinner','Chef''s dinner',${text(description)},3.5,27,'Family’s favorites',${text(photo)},'https://example.com/recipe',${text(ingredients)},${text(instructions)},'up');
    INSERT INTO meals VALUES ('planned','dinner','2026-10-16','Dinner',1.3333333333333333,'Leftovers');
    INSERT INTO meals VALUES ('note',NULL,'2026-10-17','Lunch',1,'Picnic');
    INSERT INTO checks VALUES ('["shopping-list","oil"]',0);
    INSERT INTO extras VALUES ('extra','Soap',1);
    INSERT INTO shopping_order VALUES (1,'["12"]','["grocery","oil"]');
    INSERT INTO ingredient_match_cache VALUES ('cache','{"model":"fixture"}',123456);
  `;

  source.exec(fixture);
  const history = `CREATE TABLE __alchemy_migrations (name TEXT PRIMARY KEY);${migrations.map((name) => `INSERT INTO __alchemy_migrations VALUES ('${name}');`).join("\n")}`;

  const dump =
    schema.join(";\n") + ";\n" + "INSERT INTO grocery_revision VALUES (1,0);\n" + fixture + history;

  const { batches } = await seedSql(dump);
  expect(batches.length).toBeGreaterThan(10);
  expect(batches.every((batch) => Buffer.byteLength(batch) < 81_000)).toBe(true);
  const bundle = await rolldown({ input: "src/server.ts", platform: "browser" });
  const output = await bundle.generate({ format: "esm" });
  await bundle.close();
  const entry = output.output.find((item) => item.type === "chunk" && item.isEntry);

  if (!entry || entry.type !== "chunk") throw new Error("Missing Worker bundle.");

  const worker = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "seed-smoke",
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

    for (const sql of schema) await db.prepare(sql).run();
    await db.prepare("INSERT INTO extras VALUES ('stale','Prior fixture',0)").run();

    for (const batch of batches) {
      // The actual gateway runs multi-statement SQL; D1's JS binding batches individual
      // statements. Keep complete trigger bodies intact rather than splitting on every ';'.
      const statements = batch.split(/;\n(?=DROP|CREATE|INSERT|DELETE)|;\s*$/).filter((sql) => sql.trim());
      await db.batch(statements.map((sql) => db.prepare(sql)));
    }

    const tables = z
      .array(z.object({ name: z.string() }))
      .parse(
        source
          .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all(),
      )
      .map((row) => row.name);

    for (const table of tables) {
      const expected = source.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all();
      expect((await db.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all()).results, table).toEqual(
        expected,
      );
    }

    const response = await worker.dispatchFetch("http://localhost/api/household");
    expect(response.status).toBe(200);

    const household = Schema.decodeUnknownSync(HouseholdSchema)(await response.json());

    expect(household.recipes[0].photo).toBe(photo);
    expect(household.recipes[0].instructions).toEqual(JSON.parse(instructions));
    expect(household.meals).toHaveLength(2);
    await expect(db.prepare("DELETE FROM recipes WHERE id='dinner'").run()).rejects.toThrow();
    await db.prepare("DELETE FROM groceries WHERE id='oil'").run();

    const recipe = z
      .object({ ingredients: z.string() })
      .parse(await db.prepare("SELECT ingredients FROM recipes WHERE id='dinner'").first());

    const updatedIngredients = z
      .array(z.object({ groceryItemId: z.string().nullable() }))
      .parse(JSON.parse(recipe.ingredients));

    expect(updatedIngredients[0].groceryItemId).toBeNull();

    const revision = z
      .object({ version: z.number() })
      .parse(await db.prepare("SELECT version FROM grocery_revision").first());

    expect(revision.version).toBe(74);
  } finally {
    source.close();
    await worker.dispose();
  }
}, 60_000);
