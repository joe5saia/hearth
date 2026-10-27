import { Effect, Schema } from "effect";
import {
  RecipeSchema,
  RecipeWriteSchema,
  RecipeId,
  type Recipe,
  type RecipeDraft,
  type Rating,
  type GroceryItem,
} from "./domain";
import { getGroceries, linkIngredients } from "./groceries";
import {
  Conflict,
  MissingReference,
  NotFound,
  ValidationError,
  database,
  stored,
  requireRevision,
  staleWrite,
  checkRevision,
} from "./storage";
import { importRecipe, RecipeImportError } from "./recipe-import";
import { record } from "./observability";
import { preparePhoto } from "./photos";

/** SQL representation with JSON-encoded ingredient and instruction columns. */
export type RecipeRow = Omit<RecipeDraft, "ingredients" | "instructions"> & {
  ingredients: string;
  instructions: string;
};

const decodeRecipeRow = Schema.decodeUnknownSync(
  Schema.Struct({
    ...RecipeSchema.fields,
    revision: Schema.NonEmptyString,
    ingredients: Schema.fromJsonString(RecipeSchema.fields.ingredients),
    instructions: Schema.fromJsonString(RecipeSchema.fields.instructions),
  }),
);

/** Decodes an untrusted SQL row, including JSON columns, without write-only size limits. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the SQL decoding boundary, not an inner operation.
export function parseRecipe(row: unknown): Recipe {
  return decodeRecipeRow(row);
}

/** Builds a conditional write; null permits creation only, never replacement. */
export function recipeStatement(db: D1Database, recipe: Recipe, expectedRevision: string | null = null) {
  return db
    .prepare(`INSERT INTO recipes (id,title,description,servings,minutes,category,photo,source,ingredients,instructions)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10 WHERE ?11 IS NULL OR EXISTS (SELECT 1 FROM recipes WHERE id=?1 AND revision=?11)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,
    servings=excluded.servings,minutes=excluded.minutes,category=excluded.category,photo=excluded.photo,
    source=excluded.source,ingredients=excluded.ingredients,instructions=excluded.instructions
    WHERE recipes.revision=?11`)
    .bind(
      recipe.id,
      recipe.title.trim(),
      recipe.description,
      recipe.servings,
      recipe.minutes,
      recipe.category,
      recipe.photo,
      recipe.source,
      JSON.stringify(recipe.ingredients),
      JSON.stringify(recipe.instructions),
      expectedRevision,
    );
}

/** Reads recipes in requested ID order, reporting absent IDs separately. */
export function getRecipes(db: D1Database, ids: readonly RecipeId[]) {
  return Effect.gen(function* () {
    if (!ids.length) return { recipes: [], missingIds: [] };

    const rows = yield* database(() =>
      db
        .prepare(`SELECT * FROM recipes WHERE id IN (${ids.map(() => "?").join(",")})`)
        .bind(...ids)
        .all(),
    );

    const recipes = yield* stored(() => rows.results.map(parseRecipe));
    const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));

    return {
      recipes: ids.flatMap((id) => {
        const recipe = byId.get(id);

        return recipe === undefined ? [] : [recipe];
      }),
      missingIds: ids.filter((id) => !byId.has(id)),
    };
  });
}

/** Links omitted ingredient identities; explicit null keeps an ingredient unlinked. */
export function matchRecipeIngredients(
  db: D1Database,
  recipes: readonly Recipe[],
  groceries?: readonly GroceryItem[],
) {
  return Effect.gen(function* () {
    const catalog = groceries ?? (yield* getGroceries(db));

    return yield* Effect.forEach(recipes, (recipe) =>
      Effect.gen(function* () {
        return {
          ...recipe,
          ingredients: yield* linkIngredients(recipe.ingredients, catalog),
        };
      }),
    );
  });
}

function validateCollections(db: D1Database, names: readonly string[]) {
  return Effect.gen(function* () {
    if (!names.some((name) => name !== "")) return;

    const collections = yield* database(() => db.prepare("SELECT name FROM collections").all());

    const namesInStorage = yield* stored(() =>
      Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))(collections.results),
    );

    const existing = new Set(namesInStorage.map((collection) => collection.name));

    if (names.some((name) => name !== "" && !existing.has(name)))
      return yield* new MissingReference({
        message:
          "A collection no longer exists. Choose an existing collection name or use an empty string for Uncollected. No recipes were changed.",
      });
  });
}

const decodeRecipe = (recipe: RecipeDraft, message: string) =>
  Schema.decodeEffect(RecipeWriteSchema)(recipe).pipe(
    Effect.mapError(() => new ValidationError({ message })),
  );

/** Validates and links all recipes before atomically creating them with fresh IDs. */
export function createRecipes(db: D1Database, inputs: readonly Omit<Recipe, "id">[]) {
  return Effect.gen(function* () {
    if (!inputs.length) return { recipes: [] };

    const linked = yield* matchRecipeIngredients(
      db,
      inputs.map((input) => ({
        ...input,
        id: RecipeId.make(crypto.randomUUID()),
        title: input.title.trim(),
      })),
    );

    const recipes = yield* Effect.forEach(linked, (recipe) =>
      decodeRecipe(
        recipe,
        "Invalid recipe: check title, quantities, instructions, category, and URLs. No recipes were created.",
      ),
    );

    yield* validateCollections(
      db,
      recipes.map((recipe) => recipe.category),
    );
    const photos = yield* Effect.forEach(recipes, (recipe) => preparePhoto(db, recipe.photo));
    yield* database(() =>
      db.batch(
        recipes.flatMap((recipe, index) => [
          recipeStatement(db, { ...recipe, photo: photos[index].photo }),
          db.prepare("UPDATE recipes SET rating=? WHERE id=?").bind(recipe.rating, recipe.id),
          ...photos[index].statements,
        ]),
      ),
    );

    const saved = yield* getRecipes(
      db,
      recipes.map((recipe) => recipe.id),
    );

    return { recipes: saved.recipes };
  });
}

/** Patches supplied columns in one guarded statement; any stale version rejects the entire batch. */
export function updateRecipes(
  db: D1Database,
  updates: readonly {
    id: RecipeId;
    expectedRevision?: string | null;
    changes: Partial<Omit<Recipe, "id" | "revision">>;
  }[],
) {
  return Effect.gen(function* () {
    if (!updates.length) return { recipes: [], missingIds: [] };

    for (const update of updates) {
      const revision = yield* requireRevision(update.expectedRevision);

      if (revision === null) return yield* staleWrite();
    }

    const current = yield* getRecipes(
      db,
      updates.map((update) => update.id),
    );

    if (current.missingIds.length)
      return yield* new NotFound({
        message: `Recipes not found: ${current.missingIds.join(", ")}. No recipes were updated.`,
      });

    if (updates.some((update, index) => update.expectedRevision !== current.recipes[index].revision))
      return yield* staleWrite();
    const groceries = yield* getGroceries(db);

    const linkedUpdates = yield* Effect.forEach(updates, (update) =>
      Effect.gen(function* () {
        return {
          ...update,
          changes:
            update.changes.ingredients === undefined
              ? update.changes
              : {
                  ...update.changes,
                  ingredients: yield* linkIngredients(update.changes.ingredients, groceries),
                },
        };
      }),
    );

    const recipes = linkedUpdates.map((update, index) => ({ ...current.recipes[index], ...update.changes }));

    yield* Effect.forEach(recipes, (recipe) =>
      decodeRecipe(
        recipe,
        "Invalid changes: check title, quantities, instructions, category, and URLs. No recipes were updated.",
      ),
    );
    yield* validateCollections(
      db,
      updates.flatMap(({ changes }) => (changes.category === undefined ? [] : [changes.category])),
    );

    const photos = yield* Effect.forEach(linkedUpdates, (update) =>
      update.changes.photo === undefined ? Effect.succeed(undefined) : preparePhoto(db, update.changes.photo),
    );

    // MATERIALIZED freezes the complete version check before the first row's trigger rotates its token.
    // A single UPDATE avoids later batch statements observing earlier token rotations.
    const columns = [
      "title",
      "description",
      "servings",
      "minutes",
      "category",
      "photo",
      "source",
      "rating",
      "ingredients",
      "instructions",
    ];

    const [result] = yield* database(() =>
      db.batch([
        db
          .prepare(`
      WITH patches(value) AS MATERIALIZED (VALUES ${linkedUpdates.map((_, index) => `(?${index + 1})`).join(",")}),
      guard AS MATERIALIZED (SELECT NOT EXISTS (
        SELECT 1 FROM patches LEFT JOIN recipes ON recipes.id=json_extract(value,'$.id')
        WHERE recipes.id IS NULL OR recipes.revision IS NOT json_extract(value,'$.expectedRevision')
      ) AS valid)
      UPDATE recipes SET ${columns
        .map(
          (column) => `${column}=CASE
        WHEN json_type((SELECT value FROM patches WHERE json_extract(value,'$.id')=recipes.id),'$.changes.${column}') IS NOT NULL
        THEN (SELECT json_extract(value,'$.changes.${column}') FROM patches WHERE json_extract(value,'$.id')=recipes.id)
        ELSE ${column} END`,
        )
        .join(",")}
      WHERE (SELECT valid FROM guard) AND id IN (SELECT json_extract(value,'$.id') FROM patches)
    `)
          .bind(
            // D1 limits each string to 2 MB; keep individually validated patches in separate bindings.
            ...linkedUpdates.map((update, index) =>
              JSON.stringify({
                ...update,
                changes: {
                  ...update.changes,
                  title: update.changes.title?.trim(),
                  photo: photos[index]?.photo,
                },
              }),
            ),
          ),
        ...photos.flatMap((photo) => photo?.statements ?? []),
      ]),
    );

    if (!result.meta.changes) return yield* staleWrite();

    return yield* getRecipes(
      db,
      updates.map((update) => update.id),
    );
  });
}

/** Saves exactly the observed recipe version; ratings stay unchanged. */
export function saveRecipe(db: D1Database, recipe: Recipe, expectedRevision?: string | null) {
  return Effect.gen(function* () {
    const revision = yield* checkRevision(db, "recipes", recipe.id, expectedRevision);

    const decoded = yield* decodeRecipe(
      recipe,
      "Check your recipe: add a title, positive quantities, ingredients, instructions, and valid URLs.",
    );

    if (decoded.category) {
      const collection = yield* database(() =>
        db.prepare("SELECT id FROM collections WHERE name=? COLLATE BINARY").bind(decoded.category).first(),
      );

      if (!collection)
        return yield* new MissingReference({
          message: "That collection no longer exists. Choose another collection.",
        });
    }

    const [linked] = yield* matchRecipeIngredients(db, [decoded]);
    const photo = yield* preparePhoto(db, linked.photo);

    // Existence check, guarded write and assets share one transaction; concurrent creates cannot both win.
    const [existing, saved] = yield* database(() =>
      db.batch([
        db.prepare("SELECT id FROM recipes WHERE id=?").bind(linked.id),
        recipeStatement(db, { ...linked, photo: photo.photo }, revision),
        ...photo.statements,
      ]),
    );

    if (!saved.meta.changes) return yield* staleWrite();

    return { ok: true as const, created: !existing.results.length };
  });
}

/** Changes only the rating, rejecting missing recipes. */
export function rateRecipe(db: D1Database, id: RecipeId, rating: Rating) {
  return Effect.gen(function* () {
    const decoded = yield* Schema.decodeEffect(RecipeSchema.fields.rating)(rating).pipe(
      Effect.mapError(() => new ValidationError({ message: "Choose a valid recipe rating." })),
    );

    const result = yield* database(() =>
      db.prepare("UPDATE recipes SET rating=? WHERE id=?").bind(decoded, id).run(),
    );

    if (!result.meta.changes) return yield* new NotFound({ message: "That recipe no longer exists." });

    return { ok: true as const };
  });
}

/** Deletes only unplanned recipes; missing and planned recipes both produce a conflict. */
export function deleteRecipe(db: D1Database, id: RecipeId, expectedRevision?: string | null) {
  return Effect.gen(function* () {
    const revision = yield* requireRevision(expectedRevision);

    // The conditional delete and FK restriction both protect planned recipes.
    const result = yield* database(() =>
      db
        .prepare(
          "DELETE FROM recipes WHERE id=? AND revision=? AND NOT EXISTS (SELECT 1 FROM meals WHERE recipeId=?)",
        )
        .bind(id, revision, id)
        .run(),
    );

    if (!result.meta.changes)
      return yield* new Conflict({
        message:
          "This recipe changed, no longer exists, or is still planned. Reload and remove planned meals before deleting it.",
      });

    return { ok: true as const };
  });
}

/** Downloads and validates an import draft without persisting it. */
export function importRecipeDraft(url: string) {
  return Effect.gen(function* () {
    if (url.length > 4000) return yield* new ValidationError({ message: "That URL is too long." });

    const result = yield* Effect.tryPromise({
      try: () => importRecipe(url.trim()),
      catch: (error) =>
        new ValidationError({
          message:
            error instanceof RecipeImportError
              ? error.message
              : "The recipe couldn’t be imported. Check the link or add the recipe manually.",
        }),
    }).pipe(Effect.withSpan("import.download_parse"));

    const recipe = yield* Schema.decodeEffect(RecipeSchema)(result.recipe).pipe(
      Effect.mapError(
        () =>
          new ValidationError({
            message: "This recipe contains missing or unsupported fields. Please add it manually.",
          }),
      ),
    );

    yield* record("import_completed", { ingredients: recipe.ingredients.length, outcome: "success" });

    return { recipe, warnings: result.warnings };
  }).pipe(
    Effect.tapError(() =>
      record("import_failure", { reason: "invalid_or_unavailable", outcome: "rejected" }),
    ),
    Effect.withSpan("recipe.import"),
  );
}
