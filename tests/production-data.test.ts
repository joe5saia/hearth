import { expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { rolldown } from "rolldown";
import { Schema } from "effect";
import { z } from "zod";
import { HouseholdSchema } from "../src/domain";
import { seedSql } from "../tools/production-data";

it.each(["legacy inline uploads", "current shared assets"])(
  "imports %s into real D1, preserves the full private copy and reinstates write constraints",
  async (generation) => {
    const source = new DatabaseSync(":memory:");
    const migrations = (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort();
    const historicalMigrations = migrations.filter((name) => name < "0011_meal_recipes.sql");

    for (const name of historicalMigrations) source.exec(await readFile(`migrations/${name}`, "utf8"));

    const schemaQuery = source.prepare(
      "SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END",
    );

    const schema = z
      .array(z.object({ sql: z.string() }))
      .parse(schemaQuery.all())
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
    INSERT INTO checks(key,checked,packages) VALUES ('["shopping-list","oil"]',0,3);
    INSERT INTO extras VALUES ('extra','Soap',1);
    INSERT INTO shopping_order VALUES (1,'["12"]','["grocery","oil"]');
    INSERT INTO ingredient_match_cache VALUES ('cache','{"model":"fixture"}',123456);
  `;

    source.exec(fixture);
    const history = `CREATE TABLE __alchemy_migrations (name TEXT PRIMARY KEY);${historicalMigrations.map((name) => `INSERT INTO __alchemy_migrations VALUES ('${name}');`).join("\n")}`;

    let dump =
      schema.join(";\n") + ";\n" + "INSERT INTO grocery_revision VALUES (1,0);\n" + fixture + history;

    for (const name of migrations.filter((name) => !historicalMigrations.includes(name)))
      source.exec(await readFile(`migrations/${name}`, "utf8"));

    const customPhoto = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";
    const orphanPath = `/photos/upload-${"e".repeat(64)}.jpg`;
    const orphanPhoto = "data:image/jpeg;base64,/9j/2Q==";

    if (generation === "current shared assets") {
      source
        .prepare("UPDATE meals SET recipe=json_set(recipe,'$.photo',?) WHERE id='planned'")
        .run(customPhoto);
      source.prepare("INSERT INTO photos(path,data) VALUES(?,?)").run(orphanPath, orphanPhoto);

      // Model a full current export: load rows before restoring triggers, preserving exact IDs and bytes.
      const definitions = z
        .array(z.object({ type: z.string(), sql: z.string() }))
        .parse(
          source
            .prepare(
              "SELECT type,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name",
            )
            .all(),
        );

      const tables = z
        .array(z.object({ name: z.string() }))
        .parse(
          source
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all(),
        );

      const rows = tables.flatMap(({ name }) =>
        source
          .prepare(`SELECT * FROM "${name}"`)
          .all()
          .map(
            (row) =>
              `INSERT INTO "${name}" VALUES (${Object.values(row)
                .map((value) =>
                  value === null
                    ? "NULL"
                    : // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Serialize the SQLite driver's native SQL value union at the export boundary.
                      typeof value === "string"
                      ? text(value)
                      : value instanceof Uint8Array
                        ? `X'${Buffer.from(value).toString("hex")}'`
                        : String(value),
                )
                .join(",")});`,
          ),
      );

      dump = [
        "PRAGMA foreign_keys=OFF;",
        ...definitions.filter((entry) => entry.type !== "trigger").map((entry) => `${entry.sql};`),
        ...rows,
        ...definitions.filter((entry) => entry.type === "trigger").map((entry) => `${entry.sql};`),
        "CREATE TABLE __alchemy_migrations (name TEXT PRIMARY KEY);",
        ...migrations.map((name) => `INSERT INTO __alchemy_migrations VALUES ('${name}');`),
        "PRAGMA foreign_keys=ON;",
      ].join("\n");
    }

    const { batches, counts } = await seedSql(dump);
    expect(counts.photos).toBe(generation === "current shared assets" ? 3 : 1);
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

      for (const { sql } of z.array(z.object({ sql: z.string() })).parse(schemaQuery.all()))
        await db.prepare(sql).run();
      await db.prepare("INSERT INTO extras(id,name,checked) VALUES ('stale','Prior fixture',0)").run();

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

      const assetSchema = z.array(z.object({ path: z.string(), data: z.string() }));

      const originalAssets = assetSchema.parse(
        source.prepare("SELECT path,data FROM photos ORDER BY data").all(),
      );

      const copiedAssets = assetSchema.parse(
        (await db.prepare("SELECT path,data FROM photos ORDER BY data").all()).results,
      );

      expect(copiedAssets.map((asset) => asset.data)).toEqual(originalAssets.map((asset) => asset.data));
      expect(copiedAssets.every((asset) => /^\/photos\/upload-[a-p]{64}\.jpg$/.test(asset.path))).toBe(true);

      if (generation === "current shared assets") expect(copiedAssets).toEqual(originalAssets);

      // Independent legacy upgrades generate random IDs. Compare their resolved content, not randomness.
      const importedPaths = new Map(
        originalAssets.map((asset, index) => [asset.path, copiedAssets[index].path]),
      );

      for (const table of tables) {
        // Legacy upgrades generate fresh tokens; current exports must preserve them exactly.
        const expected = source
          .prepare(`SELECT * FROM "${table}" ORDER BY 1`)
          .all()
          .map((row) => {
            if (table === "photos") {
              const { path } = z.object({ path: z.string() }).parse(row);

              return { ...row, path: importedPaths.get(path) };
            }

            if (table === "recipes") {
              const { photo } = z.object({ photo: z.string() }).parse(row);

              return { ...row, photo: importedPaths.get(photo) ?? photo };
            }

            if (table === "meals") {
              const { recipe } = z.object({ recipe: z.string().nullable() }).parse(row);

              if (recipe === null) return row;
              const { photo } = z.object({ photo: z.string() }).parse(JSON.parse(recipe));

              return {
                ...row,
                recipe: z
                  .object({ recipe: z.string() })
                  .parse(
                    source
                      .prepare("SELECT json_set(?, '$.photo', ?) AS recipe")
                      .get(recipe, importedPaths.get(photo) ?? photo),
                  ).recipe,
              };
            }

            return row;
          })
          .map((row) =>
            generation === "legacy inline uploads" && "revision" in row
              ? { ...row, revision: expect.stringMatching(/^[a-f0-9]{32}$/) }
              : row,
          );

        expect((await db.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all()).results, table).toEqual(
          expected,
        );
      }

      const response = await worker.dispatchFetch("http://localhost/api/household");
      expect(response.status).toBe(200);

      const household = Schema.decodeUnknownSync(HouseholdSchema)(await response.json());

      expect(household.recipes[0].photo).toBe(copiedAssets.find((asset) => asset.data === photo)?.path);
      expect(household.recipes[0].instructions).toEqual(JSON.parse(instructions));
      expect(household.meals).toHaveLength(2);
      const { revision: _revision, ...capturedRecipe } = household.recipes[0];
      expect(household.meals.find((meal) => meal.id === "planned")?.recipe).toEqual({
        ...capturedRecipe,
        photo:
          generation === "current shared assets"
            ? copiedAssets.find((asset) => asset.data === customPhoto)?.path
            : capturedRecipe.photo,
      });
      expect(household.meals.find((meal) => meal.id === "note")?.recipe).toBeNull();

      for (const asset of copiedAssets) {
        const response = await worker.dispatchFetch(`http://localhost${asset.path}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toContain("private");
        expect(Buffer.from(await response.arrayBuffer())).toEqual(
          Buffer.from(asset.data.split(",")[1], "base64"),
        );
      }

      if (generation === "current shared assets")
        expect(copiedAssets).toContainEqual({ path: orphanPath, data: orphanPhoto });
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
  },
  60_000,
);
