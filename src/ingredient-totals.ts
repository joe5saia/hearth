import { type GroceryItem, type Household, type ShoppingNeed, type Unit } from "./domain";
import { matchGrocery } from "./groceries";

// US customary volume; oz is weight, not fluid ounces. Counts combine only with the same unit.
const conversions: Partial<Record<Unit, { base: Unit; factor: number }>> = {
  g: { base: "g", factor: 1 },
  kg: { base: "g", factor: 1000 },
  oz: { base: "g", factor: 28.349523125 },
  lb: { base: "g", factor: 453.59237 },
  ml: { base: "ml", factor: 1 },
  l: { base: "ml", factor: 1000 },
  tsp: { base: "ml", factor: 4.92892159375 },
  tbsp: { base: "ml", factor: 14.78676478125 },
  cup: { base: "ml", factor: 236.5882365 },
};

function conversion(unit: Unit) {
  return conversions[unit] ?? { base: unit, factor: 1 };
}

/** Totals one batch per recipe; incompatible dimensions stay separate and cannot suggest packages. */
export function ingredientTotals({ recipes, groceries }: Pick<Household, "recipes" | "groceries">) {
  const rows = new Map<
    string,
    {
      key: string;
      name: string;
      unit: Unit;
      grocery: GroceryItem | undefined;
      amounts: Map<Unit, number>;
      recipes: Set<string>;
    }
  >();

  for (const recipe of recipes) {
    for (const ingredient of recipe.ingredients) {
      const grocery = ingredient.groceryItemId
        ? groceries.find((item) => item.id === ingredient.groceryItemId)
        : ingredient.groceryItemId === undefined
          ? matchGrocery(ingredient.name, groceries)
          : undefined;

      const name = grocery?.name ?? ingredient.name.trim();

      const key = JSON.stringify(
        grocery ? ["grocery", grocery.id] : ["ingredient", name.replace(/\s+/g, " ").toLowerCase()],
      );

      const row = rows.get(key) ?? {
        key,
        name,
        unit: grocery?.unit ?? ingredient.unit,
        grocery,
        amounts: new Map<Unit, number>(),
        recipes: new Set<string>(),
      };

      const { base, factor } = conversion(ingredient.unit);
      row.amounts.set(base, (row.amounts.get(base) ?? 0) + ingredient.quantity * factor);
      row.recipes.add(recipe.title);
      rows.set(key, row);
    }
  }

  return [...rows.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((row) => {
      const preferred = conversion(row.unit);

      const amounts: ShoppingNeed[] = [...row.amounts].map(([base, total]) => ({
        name: row.name,
        quantity: base === preferred.base ? total / preferred.factor : total,
        unit: base === preferred.base ? row.unit : base,
      }));

      const ratio =
        row.grocery && amounts.length === 1 && amounts[0].unit === row.grocery.unit
          ? amounts[0].quantity / row.grocery.quantity
          : null;

      // Conversion roundoff at an exact package boundary must not suggest an extra package.
      const packages =
        ratio === null ? null : Math.max(1, Math.ceil(ratio - Number.EPSILON * Math.max(1, ratio) * 8));

      return { ...row, amounts, packages };
    });
}
