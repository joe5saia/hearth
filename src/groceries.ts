import { units, type GroceryItem, type Ingredient, type ShoppingOrder } from "./domain";

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

export function validateGrocery(item: GroceryItem): boolean {
  let validUrl = item.url === "";

  try {
    const url = new URL(item.url);
    validUrl = ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    /* Empty URLs are allowed. */
  }

  return (
    !!item.id.trim() &&
    item.id.length <= 100 &&
    !!item.name.trim() &&
    item.name.length <= 150 &&
    item.url.length <= 4000 &&
    validUrl &&
    item.aisle.length <= 150 &&
    Number.isFinite(item.quantity) &&
    item.quantity > 0 &&
    item.quantity <= 1_000_000 &&
    units.includes(item.unit) &&
    item.aliases.length <= 100 &&
    item.aliases.every((alias) => !!alias.trim() && alias.length <= 150)
  );
}

export function validateShoppingOrder(order: ShoppingOrder): boolean {
  return [order.aisles, order.items].every(
    (values) =>
      values.length <= 10000 &&
      new Set(values).size === values.length &&
      values.every((value) => value.length <= 1000),
  );
}

export type GroceryRow = Omit<GroceryItem, "aliases"> & { aliases: string };

export const parseGrocery = (row: GroceryRow): GroceryItem => ({ ...row, aliases: JSON.parse(row.aliases) });

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
