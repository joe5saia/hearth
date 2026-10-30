import { Effect, Schema } from "effect";
import {
  HouseholdSchema,
  CollectionSchema,
  IdSchema,
  MealSchema,
  ShoppingListSchema,
  ShoppingListItemSchema,
  ShoppingAdditionsSchema,
  ShoppingItemPatchSchema,
  ShoppingOrderSchema,
  DateSchema,
  RecipeId,
  RecipeSchema,
  RecipeWriteSchema,
  type Collection,
  type Meal,
  type ShoppingList,
  type ShoppingAddition,
  type ShoppingOrder,
  type CalendarDate,
  type GroceryId,
  weekStart,
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

const SavedShoppingListSchema = Schema.Struct({
  ...ShoppingListSchema.fields,
  revision: Schema.NonEmptyString,
});

const decodeShoppingItemRow = Schema.decodeUnknownSync(
  Schema.Struct({
    ...ShoppingListItemSchema.fields,
    sources: Schema.fromJsonString(ShoppingListItemSchema.fields.sources),
  }),
);

const shoppingItemColumns =
  "list_id AS listId,grocery_id AS groceryId,checked,packages,sources,added_at AS addedAt,checked_at AS checkedAt";

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
    SELECT ?1,?2,?3,?4,?5,?6,CASE WHEN ?9 THEN ?7
      WHEN EXISTS (SELECT 1 FROM meals WHERE id=?1 AND recipeId IS ?2)
        THEN (SELECT recipe FROM meals WHERE id=?1)
      ELSE (
      SELECT json_object('id',id,'title',title,'description',description,'servings',servings,
        'minutes',minutes,'category',category,'photo',photo,'source',source,'rating',rating,
        'ingredients',json(ingredients),'instructions',json(instructions)) FROM recipes WHERE id=?2
    ) END WHERE (?2 IS NULL OR EXISTS (SELECT 1 FROM recipes WHERE id=?2))
      AND (?8 IS NULL OR EXISTS (SELECT 1 FROM meals WHERE id=?1 AND revision=?8))
    ON CONFLICT(id) DO UPDATE SET recipeId=excluded.recipeId,date=excluded.date,slot=excluded.slot,
      scale=excluded.scale,note=excluded.note,recipe=excluded.recipe,
      revision=lower(hex(randomblob(16)))
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
      meal.recipe !== undefined ? 1 : 0,
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
        db.prepare("SELECT id,date,label,revision FROM shopping_lists ORDER BY date,created_at,id"),
        db.prepare(
          `SELECT ${shoppingItemColumns} FROM shopping_list_items ORDER BY list_id,added_at,grocery_id`,
        ),
        db.prepare("SELECT * FROM collections ORDER BY name"),
        db.prepare("SELECT * FROM groceries ORDER BY name,id"),
        db.prepare("SELECT aisles,items,revision FROM shopping_order WHERE id=1"),
      ]),
    );

    const [recipes, recipesAdded, meals, lists, items, collections, groceries, shoppingOrder] = snapshot;

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
        shoppingLists: Schema.decodeUnknownSync(Schema.Array(SavedShoppingListSchema))(lists.results),
        shoppingItems: items.results.map((row) => decodeShoppingItemRow(row)),
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

    if (meal.recipeId === null && meal.recipe == null && !meal.note.trim()) {
      const retained =
        meal.recipe === undefined &&
        (yield* database(() =>
          db
            .prepare("SELECT id FROM meals WHERE id=? AND recipeId IS NULL AND recipe IS NOT NULL")
            .bind(meal.id)
            .first(),
        ));

      if (!retained) return yield* new ValidationError({ message: "Write a note for this meal." });
    }

    if (meal.recipeId !== null && meal.recipe !== undefined) {
      if (meal.recipe === null || meal.recipe.id !== meal.recipeId)
        return yield* new ValidationError({
          message: "Include the meal's recipe with its source recipe ID, or omit it to use the source.",
        });
    }

    if (meal.recipe != null) {
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
          "UPDATE meals SET note=? WHERE id=? AND note=? AND (recipe IS NOT NULL OR length(trim(?))>0)",
        )
        .bind(input.note, id, input.expectedNote, input.note)
        .run(),
    );

    if (!result.meta.changes) return yield* staleWrite();

    return ok;
  });

/** Creates or edits a list's date and label; a null expectation is create-only. */
export const saveShoppingList = (db: D1Database, input: ShoppingList, expectedRevision?: string | null) =>
  Effect.gen(function* () {
    const revision = yield* requireRevision(expectedRevision);

    const decoded = yield* validate(
      ShoppingListSchema,
      input,
      "Choose a list date and a label of 100 characters or less.",
    );

    const list = { ...decoded, label: decoded.label.trim() };

    const [write, rows] = yield* database(() =>
      db.batch([
        db
          .prepare(
            `INSERT INTO shopping_lists(id,date,label) SELECT ?1,?2,?3
            WHERE ?4 IS NULL OR EXISTS (SELECT 1 FROM shopping_lists WHERE id=?1 AND revision=?4)
            ON CONFLICT(id) DO UPDATE SET date=excluded.date,label=excluded.label WHERE shopping_lists.revision=?4`,
          )
          .bind(list.id, list.date, list.label, revision),
        db.prepare("SELECT id,date,label,revision FROM shopping_lists WHERE id=?").bind(list.id),
      ]),
    );

    if (!write.meta.changes) return yield* staleWrite();

    return { list: yield* stored(() => Schema.decodeUnknownSync(SavedShoppingListSchema)(rows.results[0])) };
  });

/** Deletes the observed list version together with every item on it. */
export const deleteShoppingList = (db: D1Database, id: string, expectedRevision?: string | null) =>
  deleteVersion(db, "shopping_lists", id, expectedRevision);

const missingList = () =>
  new MissingReference({ message: "That shopping list no longer exists. Refresh to see the current lists." });

/** Reads one list's rows; fails when the list itself is absent. */
export const getShoppingListItems = (db: D1Database, listId: string) =>
  Effect.gen(function* () {
    const [list, rows] = yield* database(() =>
      db.batch([
        db.prepare("SELECT id,date,label,revision FROM shopping_lists WHERE id=?").bind(listId),
        db
          .prepare(
            `SELECT ${shoppingItemColumns} FROM shopping_list_items WHERE list_id=? ORDER BY added_at,grocery_id`,
          )
          .bind(listId),
      ]),
    );

    if (!list.results.length) return yield* missingList();

    return yield* stored(() => ({
      list: Schema.decodeUnknownSync(SavedShoppingListSchema)(list.results[0]),
      items: rows.results.map((row) => decodeShoppingItemRow(row)),
    }));
  });

/**
 * Adds groceries to a list in one transaction. New groceries are inserted. A grocery already on the list
 * changes only with replace; otherwise a matching unchecked row just gains the sources, and a checked or
 * differently counted row is left alone and returned as a conflict.
 */
export const addShoppingItems = (db: D1Database, listId: string, input: readonly ShoppingAddition[]) =>
  Effect.gen(function* () {
    const additions = yield* validate(
      ShoppingAdditionsSchema,
      input,
      "Add between 1 and 500 groceries, each once, with whole package counts.",
    );

    const ids = additions.map((item) => item.groceryId);

    const known = yield* database(() =>
      db
        .prepare("SELECT id FROM groceries WHERE id IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify(ids))
        .all(),
    );

    if (known.results.length !== ids.length)
      return yield* new MissingReference({
        message:
          "Some of those groceries no longer exist. Refresh the groceries before adding them; no items were added.",
      });

    // Rows before and after share the batch transaction, so classification matches what was written.
    const select = db
      .prepare(
        `SELECT ${shoppingItemColumns} FROM shopping_list_items WHERE list_id=? AND grocery_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(listId, JSON.stringify(ids));

    const results = yield* database(() =>
      db.batch([
        db.prepare("SELECT id FROM shopping_lists WHERE id=?").bind(listId),
        select,
        ...additions.map((item) =>
          db
            .prepare(
              `INSERT INTO shopping_list_items(list_id,grocery_id,checked,packages,sources,checked_at)
              SELECT ?1,?2,?3,COALESCE(?4,1),?5,CASE WHEN ?3 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') END
              WHERE EXISTS (SELECT 1 FROM shopping_lists WHERE id=?1)
                AND EXISTS (SELECT 1 FROM groceries WHERE id=?2)
              ON CONFLICT(list_id,grocery_id) DO UPDATE SET
                checked=CASE WHEN ?6 THEN excluded.checked ELSE checked END,
                checked_at=CASE WHEN ?6 AND excluded.checked<>checked THEN excluded.checked_at ELSE checked_at END,
                packages=CASE WHEN ?6 THEN COALESCE(?4,packages) ELSE packages END,
                sources=(SELECT json_group_array(json(value)) FROM (
                  SELECT value FROM json_each(shopping_list_items.sources)
                  UNION ALL SELECT value FROM json_each(excluded.sources)
                    WHERE value NOT IN (SELECT value FROM json_each(shopping_list_items.sources))
                  -- Stored rows decode with the same 50-source cap as each request, so merges keep the oldest 50.
                  LIMIT 50))
              WHERE ?6 OR (checked=0 AND (?4 IS NULL OR packages=?4))`,
            )
            .bind(
              listId,
              item.groceryId,
              item.checked ?? 0,
              item.packages ?? null,
              JSON.stringify(item.sources ?? []),
              item.replace ? 1 : 0,
            ),
        ),
        select,
      ]),
    );

    const [list, before, ...rest] = results;

    if (!list.results.length) return yield* missingList();

    const after = rest.at(-1);

    return yield* stored(() => {
      const existing = new Map(
        before.results.map((row) => decodeShoppingItemRow(row)).map((row) => [row.groceryId, row]),
      );

      const saved = new Map(
        (after?.results ?? []).map((row) => decodeShoppingItemRow(row)).map((row) => [row.groceryId, row]),
      );

      const added: GroceryId[] = [];
      const updated: GroceryId[] = [];
      const unchanged: GroceryId[] = [];
      const conflicts = [];

      for (const item of additions) {
        const prior = existing.get(item.groceryId);
        const row = saved.get(item.groceryId);

        // A grocery deleted after the existence check is neither added nor reported.
        if (!prior) {
          if (row) added.push(item.groceryId);
        } else if (item.replace) updated.push(item.groceryId);
        else if (prior.checked === 0 && (item.packages === undefined || prior.packages === item.packages))
          unchanged.push(item.groceryId);
        else if (row)
          conflicts.push({ groceryId: row.groceryId, checked: row.checked, packages: row.packages });
      }

      return { added, updated, unchanged, conflicts };
    });
  });

/** Changes checked state or package count for a grocery already on a list; never adds it. */
export const setShoppingItem = (
  db: D1Database,
  listId: string,
  groceryId: GroceryId,
  input: typeof ShoppingItemPatchSchema.Type,
) =>
  Effect.gen(function* () {
    const patch = yield* validate(
      ShoppingItemPatchSchema,
      input,
      "Choose checked or unchecked and a whole package count.",
    );

    const result = yield* database(() =>
      db
        .prepare(
          `UPDATE shopping_list_items SET
            checked=COALESCE(?3,checked),
            checked_at=CASE WHEN ?3 IS NULL OR ?3=checked THEN checked_at
              WHEN ?3=1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
            packages=COALESCE(?4,packages)
          WHERE list_id=?1 AND grocery_id=?2`,
        )
        .bind(listId, groceryId, patch.checked ?? null, patch.packages ?? null)
        .run(),
    );

    if (!result.meta.changes)
      return yield* new MissingReference({
        message: "That grocery is no longer on this list. Refresh the list before changing it.",
      });

    return ok;
  });

/** Deletes groceries from one list; groceries already absent are ignored. */
export const removeShoppingItems = (db: D1Database, listId: string, groceryIds: readonly GroceryId[]) =>
  Effect.gen(function* () {
    const result = yield* database(() =>
      db
        .prepare(
          "DELETE FROM shopping_list_items WHERE list_id=? AND grocery_id IN (SELECT value FROM json_each(?))",
        )
        .bind(listId, JSON.stringify(groceryIds))
        .run(),
    );

    return { removed: result.meta.changes ?? 0 };
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
        db.prepare("INSERT INTO shopping_lists(id,date) VALUES('sample-list',?)").bind(weekStart(today)),
        db.prepare(
          `INSERT INTO shopping_list_items(list_id,grocery_id,sources)
          SELECT 'sample-list',id,'[]' FROM groceries WHERE id IN ('sample-beans','sample-spinach')`,
        ),
      ]),
    );

    return ok;
  });
