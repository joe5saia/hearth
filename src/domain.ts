import { Schema } from "effect";

export const IngredientSchema = Schema.Struct({
  name: Schema.String,
  originalText: Schema.optional(Schema.String),
  quantity: Schema.Number,
  unit: Schema.String,
  groceryItemId: Schema.optional(Schema.NullOr(Schema.String)),
});

export const RecipeSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  servings: Schema.Number,
  minutes: Schema.Number,
  category: Schema.String,
  photo: Schema.String,
  source: Schema.String,
  rating: Schema.Literals(["up", "down", "neutral"]),
  ingredients: Schema.Array(IngredientSchema),
  instructions: Schema.Array(Schema.String),
});

export const MealSchema = Schema.Struct({
  id: Schema.String,
  recipeId: Schema.NullOr(Schema.String),
  date: Schema.String,
  slot: Schema.Literals(["Breakfast", "Lunch", "Dinner"]),
  scale: Schema.Number,
  note: Schema.String,
});

export type Ingredient = typeof IngredientSchema.Type;

export type Recipe = typeof RecipeSchema.Type;

export type Rating = Recipe["rating"];

export type Meal = typeof MealSchema.Type;

export const ExtraSchema = Schema.Struct({ id: Schema.String, name: Schema.String, checked: Schema.Number });

export const CheckSchema = Schema.Struct({ key: Schema.String, checked: Schema.Number });

export const CollectionSchema = Schema.Struct({ id: Schema.String, name: Schema.String });

export type Collection = typeof CollectionSchema.Type;

export const GroceryItemSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  aisle: Schema.String,
  quantity: Schema.Number,
  unit: Schema.String,
  aliases: Schema.Array(Schema.String),
});

export type GroceryItem = typeof GroceryItemSchema.Type;

export const MatchReportSchema = Schema.Struct({
  attempted: Schema.Number,
  matched: Schema.Number,
  unmatched: Schema.Number,
  failed: Schema.Number,
  conflicts: Schema.Number,
  normalizationCalls: Schema.Number,
  selectionCalls: Schema.Number,
  normalizationCacheHits: Schema.Number,
  selectionCacheHits: Schema.Number,
  candidates: Schema.Number,
  normalizationMs: Schema.Number,
  retrievalMs: Schema.Number,
  selectionMs: Schema.Number,
  totalMs: Schema.Number,
});

export type MatchReport = {
  -readonly [Key in keyof typeof MatchReportSchema.Type]: (typeof MatchReportSchema.Type)[Key];
};

export const ShoppingOrderSchema = Schema.Struct({
  aisles: Schema.Array(Schema.String),
  items: Schema.Array(Schema.String),
});

export type ShoppingOrder = typeof ShoppingOrderSchema.Type;

export const HouseholdSchema = Schema.Struct({
  collections: Schema.Array(CollectionSchema),
  recipes: Schema.Array(RecipeSchema),
  meals: Schema.Array(MealSchema),
  extras: Schema.Array(ExtraSchema),
  checks: Schema.Array(CheckSchema),
  groceries: Schema.Array(GroceryItemSchema),
  shoppingOrder: ShoppingOrderSchema,
});

export type Extra = typeof ExtraSchema.Type;

export type Household = typeof HouseholdSchema.Type;

export const units = [
  "g",
  "kg",
  "ml",
  "l",
  "tsp",
  "tbsp",
  "cup",
  "oz",
  "lb",
  "each",
  "clove",
  "bunch",
  "can",
  "pinch",
  "slice",
];

export function matchesRecipeSearch(recipe: Pick<Recipe, "title" | "ingredients">, search: string): boolean {
  return `${recipe.title} ${recipe.ingredients.map((item) => item.name).join(" ")}`
    .toLowerCase()
    .includes(search.toLowerCase());
}

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function addDays(key: string, days: number): string {
  const date = new Date(`${key}T12:00:00`);
  date.setDate(date.getDate() + days);

  return dateKey(date);
}

export function weekStart(key = dateKey(new Date())): string {
  const day = new Date(`${key}T12:00:00`).getDay();

  return addDays(key, -((day + 6) % 7));
}

export function nextDinnerDate(meals: readonly Meal[], week: string, today = dateKey(new Date())): string {
  const end = addDays(week, 6);
  const first = today >= week && today <= end ? today : week;

  for (let day = first; day <= end; day = addDays(day, 1)) {
    if (!meals.some((meal) => meal.date === day && meal.slot === "Dinner")) return day;
  }

  return first;
}

export function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

const quantityFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function quantity(value: number): string {
  return quantityFormatter.format(value);
}

// Exact mass and US-volume conversions. Counts never imply weight or volume.
const conversions = new Map([
  ["kg", { unit: "g", factor: 1000 }],
  ["l", { unit: "ml", factor: 1000 }],
  ["oz", { unit: "g", factor: 28.349523125 }],
  ["lb", { unit: "g", factor: 453.59237 }],
  ["tsp", { unit: "ml", factor: 4.92892159375 }],
  ["tbsp", { unit: "ml", factor: 14.78676478125 }],
  ["cup", { unit: "ml", factor: 236.5882365 }],
]);

export type ShoppingItem = {
  key: string;
  name: string;
  grocery?: GroceryItem;
  needs: Ingredient[];
  packages: number | null;
  warnings: string[];
  recipes: string[];
};

export function compareAisles(a: string, b: string): number {
  if (!a || !b) return a === b ? 0 : a ? -1 : 1;
  const numeric = /^\d+(?:\.\d+)?$/;

  if (numeric.test(a) && numeric.test(b)) return Number(a) - Number(b) || a.localeCompare(b);

  if (numeric.test(a) !== numeric.test(b)) return numeric.test(a) ? -1 : 1;

  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }) || a.localeCompare(b);
}

export function savedOrder(a: string, b: string, order: readonly string[]): number {
  const ai = order.indexOf(a);
  const bi = order.indexOf(b);

  return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || 0;
}

export function shoppingList(
  recipes: readonly Recipe[],
  meals: readonly Meal[],
  start: string,
  end: string,
  groceries: readonly GroceryItem[] = [],
  order: ShoppingOrder = { aisles: [], items: [] },
): ShoppingItem[] {
  const recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const groceriesById = new Map(groceries.map((item) => [item.id, item]));

  const items = new Map<
    string,
    { key: string; name: string; grocery?: GroceryItem; needs: Map<string, number>; recipes: Set<string> }
  >();

  for (const meal of meals) {
    if (meal.date < start || meal.date > end || meal.recipeId === null) continue;
    const recipe = recipesById.get(meal.recipeId);

    if (!recipe) continue;

    for (const ingredient of recipe.ingredients) {
      const name = ingredient.name.trim().replace(/\s+/g, " ").toLowerCase();
      const grocery = groceriesById.get(ingredient.groceryItemId ?? "");
      const conversion = conversions.get(ingredient.unit);
      const unit = conversion?.unit ?? ingredient.unit;
      const amount = ingredient.quantity * meal.scale * (conversion?.factor ?? 1);
      const key = JSON.stringify(grocery ? ["grocery", grocery.id] : ["unlinked", name]);
      const existing = items.get(key);

      if (existing) {
        existing.needs.set(unit, (existing.needs.get(unit) ?? 0) + amount);
        existing.recipes.add(recipe.title);
      } else {
        items.set(key, {
          key,
          name: grocery?.name ?? name,
          grocery,
          needs: new Map([[unit, amount]]),
          recipes: new Set([recipe.title]),
        });
      }
    }
  }

  return [...items.values()]
    .map((item): ShoppingItem => {
      const { grocery } = item;
      const packConversion = grocery ? conversions.get(grocery.unit) : undefined;
      const packUnit = packConversion?.unit ?? grocery?.unit;

      const needs = [...item.needs]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([unit, amount]) => ({
          name: item.name,
          unit: grocery && unit === packUnit ? grocery.unit : unit,
          quantity: grocery && unit === packUnit ? amount / (packConversion?.factor ?? 1) : amount,
        }));

      const warnings: string[] = [];
      let packages: number | null = null;

      if (!grocery) {
        warnings.push("No grocery item linked. Choose a product to calculate what to buy.");
      } else if (needs.length !== 1 || needs[0].unit !== grocery.unit) {
        warnings.push(`Cannot convert all recipe quantities to ${grocery.unit}. Check the amount to buy.`);
      } else {
        const ratio = needs[0].quantity / grocery.quantity;
        // Ignore only floating-point arithmetic noise at an exact package boundary.
        packages = Math.max(1, Math.ceil(ratio - Number.EPSILON * 8 * Math.max(1, ratio)));

        if (packages / ratio >= 2 - Number.EPSILON * 8)
          warnings.push(
            `Buying ${quantity(packages / ratio)}× the amount needed. Check your pantry or a smaller pack.`,
          );
      }

      return {
        key: item.key,
        name: item.name,
        grocery,
        needs,
        packages,
        warnings,
        recipes: [...item.recipes],
      };
    })
    .sort((a, b) => {
      if (!!a.grocery !== !!b.grocery) return a.grocery ? -1 : 1;
      const aa = a.grocery?.aisle ?? "";
      const ba = b.grocery?.aisle ?? "";

      return (
        savedOrder(aa, ba, order.aisles) ||
        compareAisles(aa, ba) ||
        savedOrder(a.key, b.key, order.items) ||
        a.name.localeCompare(b.name) ||
        a.key.localeCompare(b.key)
      );
    });
}

export function purchaseAmount(item: ShoppingItem): string {
  if (!item.grocery || item.packages === null) return "Check amount";

  return `Buy ${item.packages} × ${displayAmount(item.grocery)}${item.grocery.unit === "each" ? " each" : ""}`;
}

export function displayAmount(item: Ingredient): string {
  if (item.unit === "g" && item.quantity >= 1000) return `${quantity(item.quantity / 1000)} kg`;

  if (item.unit === "ml" && item.quantity >= 1000) return `${quantity(item.quantity / 1000)} l`;

  if (item.unit === "tsp" && item.quantity >= 3 && item.quantity % 3 === 0)
    return `${quantity(item.quantity / 3)} tbsp`;

  return `${quantity(item.quantity)} ${item.unit === "each" ? "" : item.unit}`.trim();
}

// Quantity is part of the check identity, so changing the plan unchecks changed totals.
export function checkKey(item: ShoppingItem, start: string, end: string): string {
  return JSON.stringify([
    start,
    end,
    item.key,
    item.needs.map((need) => [need.unit, Number(need.quantity.toPrecision(12))]),
    item.grocery ? [item.grocery.quantity, item.grocery.unit] : null,
  ]);
}
