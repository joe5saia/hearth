import { Effect, Schema } from "effect";
import {
  HouseholdSchema,
  CollectionSchema,
  IdSchema,
  MealSchema,
  ExtraSchema,
  CheckWriteSchema,
  ShoppingOrderSchema,
  DateSchema,
  RecipeId,
  RecipeSchema,
  RecipeWriteSchema,
  type Collection,
  type Meal,
  type Extra,
  type ShoppingOrder,
  type CalendarDate,
} from "./domain";
import {
  database,
  stored,
  ValidationError,
  MissingReference,
  Conflict,
  requireRevision,
  staleWrite,
  deleteVersion,
  checkRevision,
} from "./storage";
import { parseRecipe, recipeStatement, matchRecipeIngredients } from "./recipes";
import { getGroceries, groceryStatement, matchGrocery, parseGrocery } from "./groceries";
import { sampleRecipes, sampleMeals, sampleGroceries } from "./seed";
import { record } from "./observability";
import { preparePhoto } from "./photos";

const validate = <S extends Schema.Constraint>(schema: S, input: S["Encoded"], message: string) =>
  Schema.decodeEffect(schema)(input).pipe(Effect.mapError(() => new ValidationError({ message })));

const ok = { ok: true } as const;

const SavedCollectionSchema = Schema.Struct({ ...CollectionSchema.fields, revision: Schema.NonEmptyString });

const SavedExtraSchema = Schema.Struct({ ...ExtraSchema.fields, revision: Schema.NonEmptyString });

const decodeMealRow = Schema.decodeUnknownSync(
  Schema.Struct({
    ...MealSchema.fields,
    revision: Schema.NonEmptyString,
    recipe: Schema.NullOr(Schema.fromJsonString(RecipeSchema)),
  }),
);

function mealStatement(db: D1Database, meal: Meal, expectedRevision: string | null = null) {
  // Capture the source and preserve omitted snapshots inside the write, not a read/write race.
  return db
    .prepare(`INSERT INTO meals (id,recipeId,date,slot,scale,note,recipe)
    SELECT ?1,?2,?3,?4,?5,?6,COALESCE(?7,(
      SELECT json_object('id',id,'title',title,'description',description,'servings',servings,
        'minutes',minutes,'category',category,'photo',photo,'source',source,'rating',rating,
        'ingredients',json(ingredients),'instructions',json(instructions)) FROM recipes WHERE id=?2
    )) WHERE (?2 IS NULL OR EXISTS (SELECT 1 FROM recipes WHERE id=?2))
      AND (?8 IS NULL OR EXISTS (SELECT 1 FROM meals WHERE id=?1 AND revision=?8))
    ON CONFLICT(id) DO UPDATE SET recipeId=excluded.recipeId,date=excluded.date,slot=excluded.slot,
      scale=excluded.scale,note=excluded.note,
      recipe=CASE WHEN excluded.recipeId IS NULL THEN NULL
        WHEN ?7 IS NULL AND meals.recipeId=excluded.recipeId THEN meals.recipe
        ELSE excluded.recipe END
    WHERE meals.revision=?8`)
    .bind(
      meal.id,
      meal.recipeId,
      meal.date,
      meal.slot,
      meal.scale,
      meal.note,
      meal.recipe == null ? null : JSON.stringify(meal.recipe),
      expectedRevision,
    );
}

/** Loads and decodes a single transaction snapshot, retaining each collection's SQL ordering. */
export const getHousehold = (db: D1Database) =>
  Effect.gen(function* () {
    // One batch keeps all eight reads in the same transaction snapshot.
    const snapshot = yield* database(() =>
      db.batch([
        db.prepare("SELECT * FROM recipes ORDER BY title"),
        // Recipe writes upsert in place, so rowid order is addition order; data imports copy rows in rowid order.
        db.prepare("SELECT id FROM recipes ORDER BY rowid"),
        db.prepare("SELECT * FROM meals ORDER BY date,slot,id"),
        db.prepare("SELECT * FROM extras ORDER BY rowid"),
        db.prepare("SELECT * FROM checks"),
        db.prepare("SELECT * FROM collections ORDER BY name"),
        db.prepare("SELECT * FROM groceries ORDER BY name,id"),
        db.prepare("SELECT aisles,items,revision FROM shopping_order WHERE id=1"),
      ]),
    );

    const [recipes, recipesAdded, meals, extras, checks, collections, groceries, shoppingOrder] = snapshot;

    yield* record("household_snapshot", {
      recipes: recipes.results.length,
      meals: meals.results.length,
      groceries: groceries.results.length,
    });

    return yield* stored(() => {
      const order = shoppingOrder.results[0];

      const decodedOrder = Schema.decodeUnknownSync(
        Schema.Struct({
          revision: Schema.NonEmptyString,
          aisles: Schema.fromJsonString(ShoppingOrderSchema.fields.aisles),
          items: Schema.fromJsonString(ShoppingOrderSchema.fields.items),
        }),
      )(order);

      return Schema.decodeUnknownSync(HouseholdSchema)({
        recipes: recipes.results.map(parseRecipe),
        recipesAdded: Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: RecipeId })))(
          recipesAdded.results,
        ).map((row) => row.id),
        meals: meals.results.map((row) => decodeMealRow(row)),
        extras: Schema.decodeUnknownSync(Schema.Array(SavedExtraSchema))(extras.results),
        checks: checks.results,
        collections: Schema.decodeUnknownSync(Schema.Array(SavedCollectionSchema))(collections.results),
        groceries: groceries.results.map(parseGrocery),
        shoppingOrder: decodedOrder,
      });
    });
  }).pipe(Effect.withSpan("household.load"));

/** Lists decoded collections by name then ID, including legacy collection IDs. */
export const listCollections = (db: D1Database) =>
  Effect.gen(function* () {
    const rows = yield* database(() => db.prepare("SELECT * FROM collections ORDER BY name,id").all());

    const collections = yield* stored(() =>
      Schema.decodeUnknownSync(Schema.Array(SavedCollectionSchema))(rows.results),
    );

    return { collections };
  });

/** Upserts a trimmed collection name, enforcing new-write ID and unique-name constraints. */
export const saveCollection = (db: D1Database, input: Collection, expectedRevision?: string | null) =>
  Effect.gen(function* () {
    const revision = yield* requireRevision(expectedRevision);
    const message = "Add a collection name of 100 characters or less.";
    const collection = yield* validate(CollectionSchema, { ...input, name: input.name.trim() }, message);
    yield* validate(IdSchema, collection.id, message);

    const [result, saved] = yield* database(() =>
      db.batch([
        db
          .prepare(`INSERT INTO collections(id,name) SELECT ?1,?2 WHERE NOT EXISTS
          (SELECT 1 FROM collections WHERE name=?2 AND id<>?1)
          AND (?3 IS NULL OR EXISTS (SELECT 1 FROM collections WHERE id=?1 AND revision=?3))
          ON CONFLICT(id) DO UPDATE SET name=excluded.name WHERE collections.revision=?3`)
          .bind(collection.id, collection.name, revision),
        db.prepare("SELECT * FROM collections WHERE id=?").bind(collection.id),
      ]),
    );

    if (!result.meta.changes)
      return yield* new Conflict({
        message:
          "This collection changed, no longer exists, or its name is already in use. Reload before saving.",
      });

    return {
      collection: yield* stored(() => Schema.decodeUnknownSync(SavedCollectionSchema)(saved.results[0])),
    };
  });

/** Deletes a collection; database triggers leave its recipes uncollected. */
export const deleteCollection = (db: D1Database, id: string, expectedRevision?: string | null) =>
  deleteVersion(db, "collections", id, expectedRevision);

/** Atomically captures/preserves a meal's independent recipe; explicit edits never update its source. */
export const saveMeal = (db: D1Database, input: Meal, expectedRevision?: string | null) =>
  Effect.gen(function* () {
    const revision = yield* checkRevision(db, "meals", input.id, expectedRevision);

    const meal = yield* validate(
      MealSchema,
      input,
      "Choose a valid date and a recipe scale between 0 and 100.",
    );

    if (meal.recipeId === null) {
      if (!meal.note.trim()) return yield* new ValidationError({ message: "Write a note for this meal." });

      if (meal.recipe != null)
        return yield* new ValidationError({ message: "A note-only meal cannot include a recipe." });
    } else if (meal.recipe !== undefined) {
      if (meal.recipe === null || meal.recipe.id !== meal.recipeId)
        return yield* new ValidationError({
          message: "Include the meal's recipe with its source recipe ID, or omit it to use the source.",
        });
      yield* validate(
        RecipeWriteSchema,
        meal.recipe,
        "Check the meal recipe fields and keep its content smaller than 1.9 MB.",
      );
    }

    if (meal.recipeId !== null) {
      const source = yield* database(() =>
        db.prepare("SELECT id FROM recipes WHERE id=?").bind(meal.recipeId).first(),
      );

      if (!source)
        return yield* new MissingReference({
          message: "That recipe no longer exists. Choose another recipe.",
        });
    }

    const photo = meal.recipe ? yield* preparePhoto(db, meal.recipe.photo) : undefined;
    const groceries = meal.recipe ? yield* getGroceries(db) : [];

    const prepared =
      meal.recipe && photo
        ? {
            ...meal,
            recipe: {
              ...meal.recipe,
              photo: photo.photo,
              ingredients: meal.recipe.ingredients.map((ingredient) => {
                // Historical links and explicit exclusions belong to the snapshot; only omissions request matching.
                if (ingredient.groceryItemId !== undefined) return ingredient;
                const match = matchGrocery(ingredient.name, groceries);

                return match
                  ? { ...ingredient, groceryItemId: match.id, grocerySuggestions: undefined }
                  : ingredient;
              }),
            },
          }
        : meal;

    const [write, saved] = yield* database(() =>
      db.batch([
        mealStatement(db, prepared, revision),
        db.prepare("SELECT * FROM meals WHERE id=?").bind(meal.id),
        ...(photo?.statements ?? []),
      ]),
    );

    if (!write.meta.changes) return yield* staleWrite();

    return { meal: yield* stored(() => decodeMealRow(saved.results[0])) };
  });

/** Deletes only the observed meal version. */
export const deleteMeal = (db: D1Database, id: string, expectedRevision?: string | null) =>
  deleteVersion(db, "meals", id, expectedRevision);

/** Compares only the note, preserving concurrent schedule and recipe edits. */
export const patchMealNote = (db: D1Database, id: string, input: { note: string; expectedNote: string }) =>
  Effect.gen(function* () {
    const result = yield* database(() =>
      db
        .prepare(
          "UPDATE meals SET note=? WHERE id=? AND note=? AND (recipeId IS NOT NULL OR length(trim(?))>0)",
        )
        .bind(input.note, id, input.expectedNote, input.note)
        .run(),
    );

    if (!result.meta.changes) return yield* staleWrite();

    return ok;
  });

/** Validates and upserts an independent shopping extra with a trimmed name. */
export const saveExtra = (db: D1Database, input: Extra, expectedRevision?: string | null) =>
  Effect.gen(function* () {
    const revision = yield* requireRevision(expectedRevision);
    const extra = yield* validate(ExtraSchema, input, "Add an item name of 200 characters or less.");
    const saved = { ...extra, name: extra.name.trim() };

    const [write, rows] = yield* database(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO extras(id,name,checked) SELECT ?1,?2,?3 WHERE ?4 IS NULL OR EXISTS (SELECT 1 FROM extras WHERE id=?1 AND revision=?4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,checked=excluded.checked WHERE extras.revision=?4",
          )
          .bind(saved.id, saved.name, saved.checked, revision),
        db.prepare("SELECT * FROM extras WHERE id=?").bind(saved.id),
      ]),
    );

    if (!write.meta.changes) return yield* staleWrite();

    return { extra: yield* stored(() => Schema.decodeUnknownSync(SavedExtraSchema)(rows.results[0])) };
  });

/** Deletes only the observed shopping extra version. */
export const deleteExtra = (db: D1Database, id: string, expectedRevision?: string | null) =>
  deleteVersion(db, "extras", id, expectedRevision);

/** Field-scoped checked intent never creates a missing extra. */
export const patchExtraChecked = (db: D1Database, id: string, checked: 0 | 1) =>
  Effect.gen(function* () {
    const result = yield* database(() =>
      db.prepare("UPDATE extras SET checked=? WHERE id=?").bind(checked, id).run(),
    );

    if (!result.meta.changes) return yield* staleWrite();

    return ok;
  });

/** Saves membership/counts atomically; conditional additions and omitted counts preserve existing amounts. */
export const setShoppingChecked = (db: D1Database, input: typeof CheckWriteSchema.Type) =>
  Effect.gen(function* () {
    const check = yield* validate(CheckWriteSchema, input, "Invalid shopping item.");
    // Catalog checks default to 1; retain only the unchecked/on-list exception.
    // Legacy recipe check identities defaulted to 0 and remain readable without a migration.
    const defaultChecked = check.key.startsWith('["shopping-list",') ? 1 : 0;

    // Test existence in the write itself: a separate read races with product deletion.
    const result = yield* database(() =>
      check.checked === defaultChecked
        ? db.prepare("DELETE FROM checks WHERE key=?").bind(check.key).run()
        : db
            .prepare(
              `INSERT INTO checks(key,checked,packages) SELECT ?,?,COALESCE(?,1) WHERE ?=0 OR EXISTS
                (SELECT 1 FROM groceries WHERE json_array('shopping-list',id)=?)
                ON CONFLICT(key) DO UPDATE SET checked=excluded.checked,
                packages=CASE WHEN ? THEN checks.packages ELSE COALESCE(?,checks.packages) END`,
            )
            .bind(
              check.key,
              check.checked,
              check.packages ?? null,
              defaultChecked,
              check.key,
              check.onlyIfAbsent ? 1 : 0,
              check.packages ?? null,
            )
            .run(),
    );

    if (check.checked !== defaultChecked && !result.meta.changes)
      return yield* new MissingReference({ message: "That grocery item no longer exists." });

    return ok;
  });

/** Replaces both saved shopping sequences after validating uniqueness and size. */
export const setShoppingOrder = (db: D1Database, input: ShoppingOrder, expectedRevision?: string | null) =>
  Effect.gen(function* () {
    const revision = yield* requireRevision(expectedRevision);
    const order = yield* validate(ShoppingOrderSchema, input, "Shopping order must contain unique strings.");

    const [result, saved] = yield* database(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO shopping_order(id,aisles,items) SELECT 1,?1,?2 WHERE ?3 IS NULL OR EXISTS (SELECT 1 FROM shopping_order WHERE id=1 AND revision=?3) ON CONFLICT(id) DO UPDATE SET aisles=excluded.aisles,items=excluded.items WHERE shopping_order.revision=?3",
          )
          .bind(JSON.stringify(order.aisles), JSON.stringify(order.items), revision),
        db.prepare("SELECT revision FROM shopping_order WHERE id=1"),
      ]),
    );

    if (!result.meta.changes) return yield* staleWrite();

    const token = yield* stored(() =>
      Schema.decodeUnknownSync(Schema.Struct({ revision: Schema.String }))(saved.results[0]),
    );

    return { ...ok, ...token };
  });

/** Atomically adds sample content only after observing an empty recipe catalog. */
export const addDemoData = (db: D1Database, today: CalendarDate) =>
  Effect.gen(function* () {
    yield* validate(DateSchema, today, "Choose a valid sample week.");
    const existing = yield* database(() => db.prepare("SELECT id FROM recipes LIMIT 1").first());

    if (existing)
      return yield* new Conflict({ message: "Sample recipes are only added to an empty household." });

    const collections = yield* database(() => db.prepare("SELECT name FROM collections").all());

    const namesInStorage = yield* stored(() =>
      Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))(collections.results),
    );

    const groceries = yield* getGroceries(db);

    const additions = sampleGroceries.filter(
      (sample) =>
        !groceries.some(
          (grocery) =>
            grocery.id === sample.id || sample.aliases.some((alias) => matchGrocery(alias, [grocery])),
        ),
    );

    const linkedSamples = yield* matchRecipeIngredients(db, sampleRecipes, [...groceries, ...additions]);
    yield* database(() =>
      db.batch([
        ...additions.map((grocery) => groceryStatement(db, grocery)),
        ...linkedSamples.map((recipe) =>
          recipeStatement(db, {
            ...recipe,
            category: namesInStorage.some((collection) => collection.name === recipe.category)
              ? recipe.category
              : "",
          }),
        ),
        ...sampleMeals(today).map((meal) => mealStatement(db, meal)),
        db.prepare("INSERT INTO extras(id,name,checked) VALUES('sample-extra','Greek yogurt',0)"),
      ]),
    );

    return ok;
  });
