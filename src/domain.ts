import { Schema } from "effect";

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
] as const;

export const IdSchema = Schema.String.check(Schema.isLengthBetween(1, 100));

export const RecipeId = IdSchema.pipe(Schema.brand("RecipeId"));

export type RecipeId = typeof RecipeId.Type;

export const UnitSchema = Schema.Literals(units);

export type Unit = typeof UnitSchema.Type;

export const PositiveQuantitySchema = Schema.Finite.check(Schema.isGreaterThan(0));

export const IngredientQuantitySchema = PositiveQuantitySchema.check(
  Schema.isLessThanOrEqualTo(1_000_000),
).pipe(Schema.brand("IngredientQuantity"));

export const nonblank = Schema.makeFilter<string>((value) => !!value.trim(), {
  expected: "a nonblank string",
  toJsonSchema: () => ({ pattern: "\\S" }),
});

export const GroceryId = IdSchema.check(nonblank).pipe(Schema.brand("GroceryId"));

export type GroceryId = typeof GroceryId.Type;

export const NameSchema = Schema.String.check(nonblank, Schema.isMaxLength(150));

const safeUrl = (value: string): boolean => {
  if (!value) return true;

  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const SourceSchema = Schema.String.check(
  Schema.makeFilter(safeUrl, { expected: "an HTTP(S) URL or empty string" }),
);

const PhotoSchema = Schema.String.check(
  Schema.makeFilter(
    (value: string) =>
      safeUrl(value) ||
      /^\/photos\/[a-z-]+\.jpg$/.test(value) ||
      /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value),
    { expected: "an image URL or uploaded image" },
  ),
);

export const DateSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter(validDate, { expected: "a real YYYY-MM-DD date" }),
).pipe(Schema.brand("CalendarDate"));

export type CalendarDate = typeof DateSchema.Type;

export const IngredientSchema = Schema.Struct({
  name: NameSchema,
  originalText: Schema.optional(Schema.String.check(nonblank, Schema.isMaxLength(4000))).annotate({
    description: "Original ingredient line, including preparation notes, when available.",
  }),
  quantity: IngredientQuantitySchema,
  unit: UnitSchema,
  groceryItemId: Schema.optional(Schema.NullOr(GroceryId)).annotate({
    description: "Existing grocery ID; omit to auto-match exact name or alias, null to stay unlinked.",
  }),
  grocerySuggestions: Schema.optional(
    Schema.Array(GroceryId).check(Schema.isMaxLength(3), Schema.isUnique()),
  ).annotate({
    description:
      "Potential grocery IDs ranked by Jev. Choose one by setting groceryItemId; suggestions are not links.",
  }),
});

export const RecipeFields = Schema.Struct({
  title: NameSchema,
  description: Schema.String.check(Schema.isMaxLength(2000)),
  servings: PositiveQuantitySchema.check(Schema.isLessThanOrEqualTo(100)),
  minutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000 })).annotate({
    description: "Total preparation and cooking time in minutes.",
  }),
  category: Schema.String.check(Schema.isMaxLength(100)).annotate({
    description:
      "Exact existing collection name from list_collections (not its ID); empty string means Uncollected.",
  }),
  photo: PhotoSchema,
  source: SourceSchema,
  rating: Schema.Literals(["up", "down", "neutral"]),
  ingredients: Schema.Array(IngredientSchema).check(Schema.isLengthBetween(1, 100)),
  instructions: Schema.Array(Schema.String.check(nonblank, Schema.isMaxLength(10000))).check(
    Schema.isLengthBetween(1, 100),
  ),
});

export const RecipeSchema = Schema.Struct({ id: RecipeId, ...RecipeFields.fields });

// A write-input limit, not a storage invariant: linking and collection renames can
// enlarge valid saved recipes. Those rows must remain readable by HTTP and MCP.
export const RecipeWriteSchema = RecipeSchema.check(
  Schema.makeFilter((recipe) => new TextEncoder().encode(JSON.stringify(recipe)).length < 1_900_000, {
    expected: "a recipe smaller than 1.9 MB",
  }),
);

export const MealSchema = Schema.Struct({
  id: IdSchema,
  recipeId: Schema.NullOr(RecipeId),
  date: DateSchema,
  slot: Schema.Literals(["Breakfast", "Lunch", "Dinner"]),
  scale: PositiveQuantitySchema.check(Schema.isLessThanOrEqualTo(100)).annotate({
    description: "Recipe multiplier, NOT servings. Desired servings / recipe.servings.",
  }),
  note: Schema.String.check(Schema.isMaxLength(2000)),
});

export type Ingredient = typeof IngredientSchema.Type;

export type Recipe = typeof RecipeSchema.Type;

// Drafts can contain unfinished numeric/text values. Decode before crossing a write boundary.
export type RecipeDraft = typeof RecipeSchema.Encoded;

export type IngredientDraft = typeof IngredientSchema.Encoded;

export type MealDraft = typeof MealSchema.Encoded;

export type Rating = Recipe["rating"];

export type Meal = typeof MealSchema.Type;

export const ExtraSchema = Schema.Struct({
  id: IdSchema,
  name: Schema.String.check(nonblank, Schema.isMaxLength(200)),
  checked: Schema.Literals([0, 1]),
});

export const CheckSchema = Schema.Struct({
  key: Schema.String.check(Schema.isMaxLength(1000)),
  checked: Schema.Literals([0, 1]),
});

// Legacy migration-generated IDs can exceed the limit for newly written IDs.
export const CollectionSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String.check(nonblank, Schema.isMaxLength(100)),
});

export type Collection = typeof CollectionSchema.Type;

export const GroceryItemSchema = Schema.Struct({
  id: GroceryId,
  name: NameSchema,
  url: Schema.String.check(
    Schema.isMaxLength(4000),
    Schema.makeFilter(
      (value) => {
        if (!safeUrl(value)) return false;

        if (!value) return true;
        const url = new URL(value);

        return !url.username && !url.password;
      },
      { expected: "an HTTP(S) product URL without credentials, or empty string" },
    ),
  ),
  aisle: Schema.String.check(Schema.isMaxLength(150)),
  quantity: IngredientQuantitySchema.annotate({
    description: "Quantity in ONE package, not the shopping total.",
  }),
  unit: UnitSchema,
  aliases: Schema.Array(NameSchema).check(Schema.isMaxLength(100)),
});

export type GroceryItem = typeof GroceryItemSchema.Type;

export type GroceryDraft = typeof GroceryItemSchema.Encoded;

export const RenameAisleSchema = Schema.Struct({
  from: GroceryItemSchema.fields.aisle,
  to: GroceryItemSchema.fields.aisle.check(
    Schema.makeFilter((value) => value.trim().length > 0, { expected: "an aisle name" }),
  ),
});

// Computed totals are not recipe inputs: scaling may legitimately exceed the input maximum.
export const ShoppingNeedSchema = Schema.Struct({
  name: Schema.String,
  quantity: PositiveQuantitySchema,
  unit: UnitSchema,
});

export type ShoppingNeed = typeof ShoppingNeedSchema.Type;

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
  aisles: Schema.Array(Schema.String.check(Schema.isMaxLength(1000))).check(
    Schema.isMaxLength(10000),
    Schema.isUnique(),
  ),
  items: Schema.Array(Schema.String.check(Schema.isMaxLength(1000))).check(
    Schema.isMaxLength(10000),
    Schema.isUnique(),
  ),
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

export function matchesRecipeSearch(recipe: Pick<Recipe, "title" | "ingredients">, search: string): boolean {
  return `${recipe.title} ${recipe.ingredients.map((item) => item.name).join(" ")}`
    .toLowerCase()
    .includes(search.toLowerCase());
}

export function dateKey(date: Date): CalendarDate {
  return DateSchema.make(
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
  );
}

export function addDays(key: string, days: number): CalendarDate {
  const date = new Date(`${key}T12:00:00`);
  date.setDate(date.getDate() + days);

  return dateKey(date);
}

export function weekStart(key: string = dateKey(new Date())): CalendarDate {
  const day = new Date(`${key}T12:00:00`).getDay();

  return addDays(key, -((day + 6) % 7));
}

export function nextDinnerDate(
  meals: readonly Meal[],
  week: string,
  today: string = dateKey(new Date()),
): CalendarDate {
  const end = addDays(week, 6);
  const first = today >= week && today <= end ? today : week;

  for (let day = first; day <= end; day = addDays(day, 1)) {
    if (!meals.some((meal) => meal.date === day && meal.slot === "Dinner")) return DateSchema.make(day);
  }

  return DateSchema.make(first);
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

export type ShoppingItem = {
  key: string;
  name: string;
  grocery: GroceryItem;
  // Retained in MCP output for compatibility; the manual list has no recipe totals.
  needs: ShoppingNeed[];
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
  groceries: readonly GroceryItem[],
  order: ShoppingOrder = { aisles: [], items: [] },
): ShoppingItem[] {
  return groceries
    .map((grocery): ShoppingItem => ({
      key: JSON.stringify(["grocery", grocery.id]),
      name: grocery.name,
      grocery,
      needs: [],
      packages: 1,
      warnings: [],
      recipes: [],
    }))
    .sort((a, b) => {
      const aa = a.grocery.aisle;
      const ba = b.grocery.aisle;

      return (
        savedOrder(aa, ba, order.aisles) ||
        compareAisles(aa, ba) ||
        savedOrder(a.key, b.key, order.items) ||
        a.name.localeCompare(b.name) ||
        a.key.localeCompare(b.key)
      );
    });
}

export function displayAmount(item: ShoppingNeed): string {
  if (item.unit === "g" && item.quantity >= 1000) return `${quantity(item.quantity / 1000)} kg`;

  if (item.unit === "ml" && item.quantity >= 1000) return `${quantity(item.quantity / 1000)} l`;

  if (item.unit === "tsp" && item.quantity >= 3 && item.quantity % 3 === 0)
    return `${quantity(item.quantity / 3)} tbsp`;

  return `${quantity(item.quantity)} ${item.unit === "each" ? "" : item.unit}`.trim();
}

// Separate from old recipe/range checks. New catalog items default to checked (off-list).
export function checkKey(item: ShoppingItem): string {
  return JSON.stringify(["shopping-list", item.grocery.id]);
}
