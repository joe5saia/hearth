import { Schema } from "effect";
import { GroceryItemSchema, ShoppingOrderSchema, type GroceryItem, type Ingredient } from "./domain";

const normalize = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

// Browser-safe: importing this module never accesses a database or Worker binding.
export function matchGrocery(name: string, groceries: readonly GroceryItem[]): GroceryItem | undefined {
  const key = normalize(name);

  if (!key) return undefined;

  const matches = groceries.filter((item) =>
    [item.name, ...item.aliases].some((alias) => normalize(alias) === key),
  );

  return matches.length === 1 ? matches[0] : undefined;
}

export class GroceryInputError extends Error {}

export const validateGrocery = Schema.is(GroceryItemSchema);

export const validateShoppingOrder = Schema.is(ShoppingOrderSchema);

export type GroceryRow = Omit<GroceryItem, "aliases"> & { aliases: string };

export const parseGrocery = (row: GroceryRow): GroceryItem =>
  Schema.decodeUnknownSync(GroceryItemSchema)({ ...row, aliases: JSON.parse(row.aliases) });

export async function getGroceries(db: D1Database): Promise<GroceryItem[]> {
  const rows = await db.prepare("SELECT * FROM groceries ORDER BY name,id").all<GroceryRow>();

  return rows.results.map(parseGrocery);
}

export function linkIngredients(
  ingredients: readonly Ingredient[],
  groceries: readonly GroceryItem[],
): Ingredient[] {
  return ingredients.map((ingredient) => {
    if (ingredient.groceryItemId !== undefined) {
      if (
        ingredient.groceryItemId !== null &&
        !groceries.some((item) => item.id === ingredient.groceryItemId)
      )
        throw new GroceryInputError("That grocery item no longer exists. No recipes were changed.");

      return { ...ingredient, grocerySuggestions: undefined };
    }

    const match = matchGrocery(ingredient.name, groceries);

    const suggestions = ingredient.grocerySuggestions?.filter((id) =>
      groceries.some((item) => item.id === id),
    );

    return match
      ? { ...ingredient, groceryItemId: match.id, grocerySuggestions: undefined }
      : { ...ingredient, grocerySuggestions: suggestions?.length ? suggestions : undefined };
  });
}
