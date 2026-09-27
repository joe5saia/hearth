import { Schema } from "effect";

export const IngredientSchema = Schema.Struct({
  name: Schema.String,
  quantity: Schema.Number,
  unit: Schema.String,
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
  ingredients: Schema.Array(IngredientSchema),
  instructions: Schema.Array(Schema.String),
});

export const MealSchema = Schema.Struct({
  id: Schema.String,
  recipeId: Schema.String,
  date: Schema.String,
  slot: Schema.Literals(["Breakfast", "Lunch", "Dinner"]),
  scale: Schema.Number,
  note: Schema.String,
});

export type Ingredient = typeof IngredientSchema.Type;

export type Recipe = typeof RecipeSchema.Type;

export type Meal = typeof MealSchema.Type;

export const ExtraSchema = Schema.Struct({ id: Schema.String, name: Schema.String, checked: Schema.Number });

export const CheckSchema = Schema.Struct({ key: Schema.String, checked: Schema.Number });

export const HouseholdSchema = Schema.Struct({
  recipes: Schema.Array(RecipeSchema),
  meals: Schema.Array(MealSchema),
  extras: Schema.Array(ExtraSchema),
  checks: Schema.Array(CheckSchema),
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

export const categories = ["Weeknight favorites", "Vegetarian", "Comfort food", "Something special"];

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

export function quantity(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

// Convert only compatible units; a can or a clove cannot be inferred as grams.
const conversions = new Map([
  ["kg", { unit: "g", factor: 1000 }],
  ["l", { unit: "ml", factor: 1000 }],
  ["lb", { unit: "oz", factor: 16 }],
  ["tbsp", { unit: "tsp", factor: 3 }],
  ["cup", { unit: "tsp", factor: 48 }],
]);

export type ShoppingItem = Ingredient & { key: string; recipes: string[] };

export function shoppingList(
  recipes: readonly Recipe[],
  meals: readonly Meal[],
  start: string,
  end: string,
): ShoppingItem[] {
  const items = new Map<string, ShoppingItem>();

  for (const meal of meals) {
    if (meal.date < start || meal.date > end) continue;
    const recipe = recipes.find((entry) => entry.id === meal.recipeId);

    if (!recipe) continue;

    for (const ingredient of recipe.ingredients) {
      const name = ingredient.name.trim().replace(/\s+/g, " ").toLowerCase();
      const conversion = conversions.get(ingredient.unit);
      const unit = conversion?.unit ?? ingredient.unit;
      const amount = ingredient.quantity * meal.scale * (conversion?.factor ?? 1);
      const key = JSON.stringify([name, unit]);
      const existing = items.get(key);

      if (existing) {
        items.set(key, {
          ...existing,
          quantity: existing.quantity + amount,
          recipes: [...new Set([...existing.recipes, recipe.title])],
        });
      } else {
        items.set(key, { key, name, unit, quantity: amount, recipes: [recipe.title] });
      }
    }
  }

  return [...items.values()].sort((a, b) => a.name.localeCompare(b.name));
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
  return JSON.stringify([start, end, item.key, Number(item.quantity.toFixed(6))]);
}
