import { Schema } from "effect";
import { RecipeSchema, units, type Recipe } from "./domain";

export type RecipeRow = Omit<Recipe, "ingredients" | "instructions"> & {
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

function safeUrl(value: string): boolean {
  if (!value) return true;

  try {
    const url = new URL(value);

    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function validateRecipe(recipe: Recipe): boolean {
  return (
    !!recipe.id &&
    recipe.id.length <= 100 &&
    !!recipe.title.trim() &&
    recipe.title.length <= 150 &&
    recipe.description.length <= 2000 &&
    recipe.servings > 0 &&
    recipe.servings <= 100 &&
    Number.isInteger(recipe.minutes) &&
    recipe.minutes > 0 &&
    recipe.minutes <= 10000 &&
    recipe.category.length <= 100 &&
    safeUrl(recipe.source) &&
    (safeUrl(recipe.photo) ||
      /^\/photos\/[a-z-]+\.jpg$/.test(recipe.photo) ||
      /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(recipe.photo)) &&
    new TextEncoder().encode(JSON.stringify(recipe)).length < 1_900_000 &&
    recipe.ingredients.length > 0 &&
    recipe.ingredients.length <= 100 &&
    recipe.ingredients.every(
      (i) =>
        !!i.name.trim() &&
        i.name.length <= 150 &&
        i.quantity > 0 &&
        i.quantity <= 1_000_000 &&
        units.includes(i.unit),
    ) &&
    recipe.instructions.length > 0 &&
    recipe.instructions.length <= 100 &&
    recipe.instructions.every((i) => !!i.trim() && i.length <= 10000)
  );
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

export async function getRecipes(db: D1Database, ids: string[]) {
  const rows = await db
    .prepare(`SELECT * FROM recipes WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<RecipeRow>();

  const byId = new Map(rows.results.map((row) => [row.id, parseRecipe(row)]));

  return {
    recipes: ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
    missingIds: ids.filter((id) => !byId.has(id)),
  };
}

export class RecipeInputError extends Error {}

async function validateCollections(db: D1Database, names: readonly string[]) {
  if (!names.some((name) => name !== "")) return;
  const collections = await db.prepare("SELECT name FROM collections").all<{ name: string }>();
  const existing = new Set(collections.results.map((collection) => collection.name));

  if (names.some((name) => name !== "" && !existing.has(name)))
    throw new RecipeInputError(
      "A collection no longer exists. Choose an existing collection name or use an empty string for Uncollected. No recipes were changed.",
    );
}

export async function createRecipes(db: D1Database, inputs: Omit<Recipe, "id">[]) {
  const recipes = inputs.map((input) => ({ ...input, id: crypto.randomUUID(), title: input.title.trim() }));

  if (recipes.some((recipe) => !validateRecipe(recipe)))
    throw new RecipeInputError(
      "Invalid recipe: check title, quantities, instructions, category, and URLs. No recipes were created.",
    );
  await validateCollections(
    db,
    recipes.map((recipe) => recipe.category),
  );
  await db.batch(
    recipes.flatMap((recipe) => [
      recipeStatement(db, recipe),
      db.prepare("UPDATE recipes SET rating=? WHERE id=?").bind(recipe.rating, recipe.id),
    ]),
  );

  return { recipes };
}

export async function updateRecipes(
  db: D1Database,
  updates: { id: string; changes: Partial<Omit<Recipe, "id">> }[],
) {
  const current = await getRecipes(
    db,
    updates.map((update) => update.id),
  );

  if (current.missingIds.length)
    throw new RecipeInputError(
      `Recipes not found: ${current.missingIds.join(", ")}. No recipes were updated.`,
    );
  const recipes = updates.map((update, index) => ({ ...current.recipes[index], ...update.changes }));

  if (recipes.some((recipe) => !validateRecipe(recipe)))
    throw new RecipeInputError(
      "Invalid changes: check title, quantities, instructions, category, and URLs. No recipes were updated.",
    );
  await validateCollections(
    db,
    updates.flatMap(({ changes }) => (changes.category === undefined ? [] : [changes.category])),
  );
  const ids = updates.map((update) => update.id);
  const existenceGuard = `(SELECT COUNT(*) FROM recipes WHERE id IN (${ids.map(() => "?").join(",")}))=?`;

  // Every statement checks the whole ID set inside D1's batch transaction. A deletion
  // after the validation read makes every update a no-op, never a partially applied batch.
  // Update only supplied columns: unrelated concurrent edits and ratings are preserved.
  const results = await db.batch(
    updates.map(({ id, changes }) => {
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
  );

  if (results.some((result) => result.meta.changes === 0))
    throw new RecipeInputError("A recipe was deleted before the update. No recipes were updated.");

  return getRecipes(
    db,
    updates.map((update) => update.id),
  );
}
