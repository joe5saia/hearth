import { Effect, Schema } from "effect";
import { RecipeSchema, RecipeId, type Recipe, type RecipeDraft, type Rating } from "./domain";
import { getGroceries, linkIngredients } from "./groceries";
import { Conflict, MissingReference, NotFound, ValidationError, database, stored } from "./storage";
import { importRecipe } from "./recipe-import";

export type RecipeRow = Omit<RecipeDraft, "ingredients" | "instructions"> & {
  ingredients: string;
  instructions: string;
};

export function parseRecipe(row: RecipeRow): Recipe {
  return Schema.decodeUnknownSync(RecipeSchema)({
    ...row,
    ingredients: JSON.parse(row.ingredients),
    instructions: JSON.parse(row.instructions),
  });
}

export function recipeStatement(db: D1Database, recipe: Recipe) {
  return db
    .prepare(`INSERT INTO recipes (id,title,description,servings,minutes,category,photo,source,ingredients,instructions)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,
    servings=excluded.servings,minutes=excluded.minutes,category=excluded.category,photo=excluded.photo,
    source=excluded.source,ingredients=excluded.ingredients,instructions=excluded.instructions`)
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
    );
}

export function getRecipes(db: D1Database, ids: readonly RecipeId[]) {
  return Effect.gen(function* () {
    if (!ids.length) return { recipes: [], missingIds: [] };

    const rows = yield* database(() =>
      db
        .prepare(`SELECT * FROM recipes WHERE id IN (${ids.map(() => "?").join(",")})`)
        .bind(...ids)
        .all<RecipeRow>(),
    );

    const recipes = yield* stored(() => rows.results.map(parseRecipe));
    const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));

    return {
      recipes: ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
      missingIds: ids.filter((id) => !byId.has(id)),
    };
  });
}

export function matchRecipeIngredients(db: D1Database, recipes: readonly Recipe[]) {
  return Effect.gen(function* () {
    const groceries = yield* getGroceries(db);

    return yield* Effect.forEach(recipes, (recipe) =>
      Effect.gen(function* () {
        return {
          ...recipe,
          ingredients: yield* linkIngredients(recipe.ingredients, groceries),
        };
      }),
    );
  });
}

function validateCollections(db: D1Database, names: readonly string[]) {
  return Effect.gen(function* () {
    if (!names.some((name) => name !== "")) return;

    const collections = yield* database(() =>
      db.prepare("SELECT name FROM collections").all<{ name: string }>(),
    );

    const existing = new Set(collections.results.map((collection) => collection.name));

    if (names.some((name) => name !== "" && !existing.has(name)))
      return yield* new MissingReference({
        message:
          "A collection no longer exists. Choose an existing collection name or use an empty string for Uncollected. No recipes were changed.",
      });
  });
}

const decodeRecipe = (recipe: RecipeDraft, message: string) =>
  Schema.decodeUnknownEffect(RecipeSchema)(recipe).pipe(
    Effect.mapError(() => new ValidationError({ message })),
  );

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
    yield* database(() =>
      db.batch(
        recipes.flatMap((recipe) => [
          recipeStatement(db, recipe),
          db.prepare("UPDATE recipes SET rating=? WHERE id=?").bind(recipe.rating, recipe.id),
        ]),
      ),
    );

    return { recipes };
  });
}

export function updateRecipes(
  db: D1Database,
  updates: readonly { id: RecipeId; changes: Partial<Omit<Recipe, "id">> }[],
) {
  return Effect.gen(function* () {
    if (!updates.length) return { recipes: [], missingIds: [] };

    const current = yield* getRecipes(
      db,
      updates.map((update) => update.id),
    );

    if (current.missingIds.length)
      return yield* new NotFound({
        message: `Recipes not found: ${current.missingIds.join(", ")}. No recipes were updated.`,
      });
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
    const ids = updates.map((update) => update.id);
    const existenceGuard = `(SELECT COUNT(*) FROM recipes WHERE id IN (${ids.map(() => "?").join(",")}))=?`;

    // Every statement checks the whole ID set inside D1's batch transaction. A deletion
    // after the validation read makes every update a no-op, never a partially applied batch.
    // Update only supplied columns: unrelated concurrent edits and ratings are preserved.
    const results = yield* database(() =>
      db.batch(
        linkedUpdates.map(({ id, changes }) => {
          const entries = Object.entries(changes);

          return db
            .prepare(
              `UPDATE recipes SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE id=? AND ${existenceGuard}`,
            )
            .bind(
              ...entries.map(([key, value]) =>
                key === "ingredients" || key === "instructions"
                  ? JSON.stringify(value)
                  : key === "title"
                    ? String(value).trim()
                    : value,
              ),
              id,
              ...ids,
              ids.length,
            );
        }),
      ),
    );

    if (results.some((result) => result.meta.changes === 0))
      return yield* new NotFound({
        message: "A recipe was deleted before the update. No recipes were updated.",
      });

    return yield* getRecipes(
      db,
      updates.map((update) => update.id),
    );
  });
}

export function saveRecipe(db: D1Database, recipe: Recipe) {
  return Effect.gen(function* () {
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
    yield* database(() => recipeStatement(db, linked).run());

    return { ok: true as const };
  });
}

export function rateRecipe(db: D1Database, id: RecipeId, rating: Rating) {
  return Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(RecipeSchema.fields.rating)(rating).pipe(
      Effect.mapError(() => new ValidationError({ message: "Choose a valid recipe rating." })),
    );

    const result = yield* database(() =>
      db.prepare("UPDATE recipes SET rating=? WHERE id=?").bind(decoded, id).run(),
    );

    if (!result.meta.changes) return yield* new NotFound({ message: "That recipe no longer exists." });

    return { ok: true as const };
  });
}

export function deleteRecipe(db: D1Database, id: RecipeId) {
  return Effect.gen(function* () {
    // The conditional delete and FK restriction both protect planned recipes.
    const result = yield* database(() =>
      db
        .prepare("DELETE FROM recipes WHERE id=? AND NOT EXISTS (SELECT 1 FROM meals WHERE recipeId=?)")
        .bind(id, id)
        .run(),
    );

    if (!result.meta.changes)
      return yield* new Conflict({ message: "Remove this recipe from your meal plan before deleting it." });

    return { ok: true as const };
  });
}

export function importRecipeDraft(url: string) {
  return Effect.gen(function* () {
    if (url.length > 4000) return yield* new ValidationError({ message: "That URL is too long." });

    const result = yield* Effect.tryPromise({
      try: () => importRecipe(url.trim()),
      catch: (error) =>
        new ValidationError({
          message:
            error instanceof Error ? error.message : "The recipe couldn’t be imported. Please try again.",
        }),
    });

    const recipe = yield* Schema.decodeUnknownEffect(RecipeSchema)(result.recipe).pipe(
      Effect.mapError(
        () =>
          new ValidationError({
            message: "This recipe contains missing or unsupported fields. Please add it manually.",
          }),
      ),
    );

    return { recipe, warnings: result.warnings };
  });
}
