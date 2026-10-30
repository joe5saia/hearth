import { Schema } from "effect";

/** Supported ingredient and grocery units, in display order. */
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

/** Shared identifier length constraint; whitespace is allowed unless refined by its owner. */
export const IdSchema = Schema.String.check(Schema.isLengthBetween(1, 100));

/** Recipe identifiers retain the shared identifier contract. */
export const RecipeId = IdSchema.pipe(Schema.brand("RecipeId"));

/** Validated recipe identifier, distinct from grocery identifiers. */
export type RecipeId = typeof RecipeId.Type;

/** Accepts only the supported unit spellings. */
export const UnitSchema = Schema.Literals(units);

/** Canonical unit spelling used in persisted household data. */
export type Unit = typeof UnitSchema.Type;

/** Finite, strictly positive quantity without an input-specific upper bound. */
export const PositiveQuantitySchema = Schema.Finite.check(Schema.isGreaterThan(0));

/** Ingredient and package quantities are capped at one million. */
export const IngredientQuantitySchema = PositiveQuantitySchema.check(
  Schema.isLessThanOrEqualTo(1_000_000),
).pipe(Schema.brand("IngredientQuantity"));

/** Rejects whitespace-only strings without trimming accepted values. */
export const nonblank = Schema.makeFilter<string>((value) => !!value.trim(), {
  expected: "a nonblank string",
  toJsonSchema: () => ({ pattern: "\\S" }),
});

/** Grocery identifiers must contain a non-whitespace character. */
export const GroceryId = IdSchema.check(nonblank).pipe(Schema.brand("GroceryId"));

/** Validated grocery identifier used by ingredient links. */
export type GroceryId = typeof GroceryId.Type;

/** Nonblank household names retain their original whitespace. */
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

/** Validates real calendar dates in zero-padded YYYY-MM-DD form. */
export const DateSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter(validDate, { expected: "a real YYYY-MM-DD date" }),
).pipe(Schema.brand("CalendarDate"));

/** Validated calendar date, independent of a time or time zone. */
export type CalendarDate = typeof DateSchema.Type;

/** Omitted grocery links request matching; null links explicitly disable it. */
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

/** Shared recipe fields; category is a collection name, not its identifier. */
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

/** Readable saved recipe shape, without the write-only size limit. */
export const RecipeSchema = Schema.Struct({
  id: RecipeId,
  revision: Schema.optional(Schema.String),
  ...RecipeFields.fields,
});

/** Limits write inputs to less than 1.9 MB; linked or renamed saved recipes may grow beyond it. */
export const RecipeWriteSchema = RecipeSchema.check(
  Schema.makeFilter((recipe) => new TextEncoder().encode(JSON.stringify(recipe)).length < 1_900_000, {
    expected: "a recipe smaller than 1.9 MB",
  }),
);

/** Meals own editable recipe snapshots; omission on writes preserves or captures one. */
export const MealSchema = Schema.Struct({
  id: IdSchema,
  revision: Schema.optional(Schema.String),
  recipeId: Schema.NullOr(RecipeId).annotate({
    description: "Live source recipe link. Null for note-only meals and meals whose source was deleted.",
  }),
  recipe: Schema.optional(Schema.NullOr(RecipeSchema)).annotate({
    description:
      "Independent meal recipe, with id retaining source provenance. Omit to capture the source on creation/source change or preserve the existing snapshot. Null only for note-only meals.",
  }),
  date: DateSchema,
  slot: Schema.Literals(["Breakfast", "Lunch", "Dinner"]),
  scale: PositiveQuantitySchema.check(Schema.isLessThanOrEqualTo(100)).annotate({
    description: "Recipe multiplier, NOT servings. Desired servings / recipe.servings.",
  }),
  note: Schema.String.check(Schema.isMaxLength(2000)),
});

/** Validated ingredient with optional matching hints and link intent. */
export type Ingredient = typeof IngredientSchema.Type;

/** Validated saved recipe; write size is checked separately. */
export type Recipe = typeof RecipeSchema.Type;

/** Unvalidated recipe input; decode before crossing a write boundary. */
export type RecipeDraft = typeof RecipeSchema.Encoded;

/** Unvalidated ingredient input, preserving omitted versus null links. */
export type IngredientDraft = typeof IngredientSchema.Encoded;

/** Unvalidated meal input; decode before persistence. */
export type MealDraft = typeof MealSchema.Encoded;

/** Household rating choices, including the unrated neutral state. */
export type Rating = Recipe["rating"];

/** Validated scheduled meal or note. */
export type Meal = typeof MealSchema.Type;

/** Whole packages to buy; independent of the quantity contained in one catalog package. */
export const PackageCountSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }));

/** Dated shopping list; several lists may share a date and none is ever finished or locked. */
export const ShoppingListSchema = Schema.Struct({
  id: IdSchema,
  revision: Schema.optional(Schema.String),
  date: DateSchema,
  label: Schema.String.check(Schema.isMaxLength(100)).annotate({
    description: "Optional name shown beside the date, such as Top-up; empty string for none.",
  }),
});

/** Validated dated shopping list. */
export type ShoppingList = typeof ShoppingListSchema.Type;

/** Why a grocery is on a list: a planned meal (with mealId and date) or a recipe title alone. */
export const ShoppingSourceSchema = Schema.Struct({
  title: Schema.String.check(nonblank, Schema.isMaxLength(200)),
  mealId: Schema.optional(IdSchema),
  date: Schema.optional(DateSchema),
});

/** Validated shopping source attribution. */
export type ShoppingSource = typeof ShoppingSourceSchema.Type;

/** Source attributions per list item are bounded to keep household snapshots small. */
export const ShoppingSourcesSchema = Schema.Array(ShoppingSourceSchema).check(Schema.isMaxLength(50));

/** A grocery on one list; deleting the row removes it, checked only means picked up. */
export const ShoppingListItemSchema = Schema.Struct({
  listId: IdSchema,
  groceryId: GroceryId,
  checked: Schema.Literals([0, 1]),
  packages: PackageCountSchema,
  sources: ShoppingSourcesSchema,
  addedAt: Schema.String,
  checkedAt: Schema.NullOr(Schema.String),
});

/** Validated list membership with its purchase progress and package count. */
export type ShoppingListItem = typeof ShoppingListItemSchema.Type;

/** One requested addition. Existing rows only change when replace is true. */
export const ShoppingAdditionSchema = Schema.Struct({
  groceryId: GroceryId,
  packages: Schema.optional(PackageCountSchema).annotate({
    description: "Whole packages to buy. Omit for one on new rows, or to keep an existing row's count.",
  }),
  checked: Schema.optional(Schema.Literals([0, 1])).annotate({
    description: "Picked-up state for the row; defaults to 0 (still needed).",
  }),
  sources: Schema.optional(ShoppingSourcesSchema),
  replace: Schema.optional(Schema.Boolean).annotate({
    description:
      "When the grocery is already on the list, true applies checked/packages and merges sources; otherwise the existing row is left alone and reported.",
  }),
});

/** Bulk additions to one list, with unique groceries. */
export const ShoppingAdditionsSchema = Schema.Array(ShoppingAdditionSchema).check(
  Schema.isLengthBetween(1, 500),
  Schema.makeFilter((items) => new Set(items.map((item) => item.groceryId)).size === items.length, {
    expected: "each grocery at most once",
  }),
);

/** Validated bulk list additions. */
export type ShoppingAddition = typeof ShoppingAdditionSchema.Type;

/** Field-scoped change to a grocery already on a list; omitted fields stay unchanged. */
export const ShoppingItemPatchSchema = Schema.Struct({
  checked: Schema.optional(Schema.Literals([0, 1])),
  packages: Schema.optional(PackageCountSchema),
});

/** Allows legacy migration identifiers longer than newly written identifiers. */
export const CollectionSchema = Schema.Struct({
  id: Schema.String,
  revision: Schema.optional(Schema.String),
  name: Schema.String.check(nonblank, Schema.isMaxLength(100)),
});

/** Saved collection whose name is referenced by recipes. */
export type Collection = typeof CollectionSchema.Type;

/** Catalog package data; product URLs may be empty but cannot contain credentials. */
export const GroceryItemSchema = Schema.Struct({
  id: GroceryId,
  revision: Schema.optional(Schema.String),
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

/** Validated catalog item describing one package, not a shopping total. */
export type GroceryItem = typeof GroceryItemSchema.Type;

/** Unvalidated catalog input; decode before persistence. */
export type GroceryDraft = typeof GroceryItemSchema.Encoded;

/** Aisle rename input allows an empty source but requires a nonblank destination. */
export const RenameAisleSchema = Schema.Struct({
  from: GroceryItemSchema.fields.aisle,
  to: GroceryItemSchema.fields.aisle.check(
    Schema.makeFilter((value) => value.trim().length > 0, { expected: "an aisle name" }),
  ),
});

/** Computed totals may exceed ingredient input limits after scaling. */
export const ShoppingNeedSchema = Schema.Struct({
  name: Schema.String,
  quantity: PositiveQuantitySchema,
  unit: UnitSchema,
});

/** Positive computed quantity with a canonical unit. */
export type ShoppingNeed = typeof ShoppingNeedSchema.Type;

/** Matching counters and timings exposed in matching reports. */
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

/** Mutable matching counters and timings accumulated during an operation. */
export type MatchReport = {
  -readonly [Key in keyof typeof MatchReportSchema.Type]: (typeof MatchReportSchema.Type)[Key];
};

/** Saved aisle and item precedence lists contain unique keys. */
export const ShoppingOrderSchema = Schema.Struct({
  revision: Schema.optional(Schema.String),
  aisles: Schema.Array(Schema.String.check(Schema.isMaxLength(1000))).check(
    Schema.isMaxLength(10000),
    Schema.isUnique(),
  ),
  items: Schema.Array(Schema.String.check(Schema.isMaxLength(1000))).check(
    Schema.isMaxLength(10000),
    Schema.isUnique(),
  ),
});

/** Saved ordering preferences; missing keys sort after listed keys. */
export type ShoppingOrder = typeof ShoppingOrderSchema.Type;

/** Complete household snapshot shared by transport and browser consumers. */
export const HouseholdSchema = Schema.Struct({
  collections: Schema.Array(CollectionSchema),
  recipes: Schema.Array(RecipeSchema),
  /** Recipe IDs from oldest to newest addition; editing a recipe keeps its place. */
  recipesAdded: Schema.Array(RecipeId),
  meals: Schema.Array(MealSchema),
  shoppingLists: Schema.Array(ShoppingListSchema),
  shoppingItems: Schema.Array(ShoppingListItemSchema),
  groceries: Schema.Array(GroceryItemSchema),
  shoppingOrder: ShoppingOrderSchema,
});

/** Validated household snapshot including every dated shopping list and the shared store route. */
export type Household = typeof HouseholdSchema.Type;

/** Case-insensitive substring search across title and ingredient names, without trimming input. */
export function matchesRecipeSearch(recipe: Pick<Recipe, "title" | "ingredients">, search: string): boolean {
  return `${recipe.title} ${recipe.ingredients.map((item) => item.name).join(" ")}`
    .toLowerCase()
    .includes(search.toLowerCase());
}

/** Formats local calendar components and rejects invalid calendar dates. */
export function dateKey(date: Date): CalendarDate {
  return DateSchema.make(
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
  );
}

/** Adds local calendar days using noon to avoid midnight daylight-saving transitions. */
export function addDays(key: string, days: number): CalendarDate {
  const date = new Date(`${key}T12:00:00`);
  date.setDate(date.getDate() + days);

  return dateKey(date);
}

/** Returns the local Saturday that starts the household's Saturday–Friday week, defaulting to today. */
export function weekStart(key: string = dateKey(new Date())): CalendarDate {
  const day = new Date(`${key}T12:00:00`).getDay();

  return addDays(key, -((day + 1) % 7));
}

/** Finds an open dinner from today within the week, falling back to the starting date when full. */
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

/** Rejects normalized impossible dates as well as non-YYYY-MM-DD strings. */
export function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

const quantityFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** Formats quantities in en-US with at most two fractional digits. */
export function quantity(value: number): string {
  return quantityFormatter.format(value);
}

/** A catalog grocery in store-route order, with its row on the selected list when it is on that list. */
export type ShoppingItem = {
  /** Store-route item key, JSON.stringify(["grocery", id]); not list membership. */
  key: string;
  name: string;
  grocery: GroceryItem;
  entry?: ShoppingListItem;
};

/** Sorts numeric aisles before named aisles and empty aisles last, with deterministic ties. */
export function compareAisles(a: string, b: string): number {
  if (!a || !b) return a === b ? 0 : a ? -1 : 1;
  const numeric = /^\d+(?:\.\d+)?$/;

  if (numeric.test(a) && numeric.test(b)) return Number(a) - Number(b) || a.localeCompare(b);

  if (numeric.test(a) !== numeric.test(b)) return numeric.test(a) ? -1 : 1;

  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }) || a.localeCompare(b);
}

/** Compares saved precedence; two unlisted keys compare equally. */
export function savedOrder(a: string, b: string, order: readonly string[]): number {
  const ai = order.indexOf(a);
  const bi = order.indexOf(b);

  return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || 0;
}

/** Sorts every catalog grocery by store route, attaching the selected list's rows by grocery ID. */
export function shoppingList(
  groceries: readonly GroceryItem[],
  order: ShoppingOrder = { aisles: [], items: [] },
  entries: readonly ShoppingListItem[] = [],
): ShoppingItem[] {
  const byGrocery = new Map(entries.map((entry) => [entry.groceryId, entry]));

  return groceries
    .map((grocery): ShoppingItem => ({
      key: JSON.stringify(["grocery", grocery.id]),
      name: grocery.name,
      grocery,
      entry: byGrocery.get(grocery.id),
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

/** Chooses the list to open: the nearest list dated today or later, else the latest earlier list. */
export function defaultShoppingList(
  lists: readonly ShoppingList[],
  today: string = dateKey(new Date()),
): ShoppingList | undefined {
  const sorted = [...lists].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  return sorted.find((list) => list.date >= today) ?? sorted.at(-1);
}

/** Promotes whole compatible quantities to larger units and omits the each label. */
export function displayAmount(item: ShoppingNeed): string {
  if (item.unit === "g" && item.quantity >= 1000) return `${quantity(item.quantity / 1000)} kg`;

  if (item.unit === "ml" && item.quantity >= 1000) return `${quantity(item.quantity / 1000)} l`;

  if (item.unit === "tsp" && item.quantity >= 3 && item.quantity % 3 === 0)
    return `${quantity(item.quantity / 3)} tbsp`;

  return `${quantity(item.quantity)} ${item.unit === "each" ? "" : item.unit}`.trim();
}
