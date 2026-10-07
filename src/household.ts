import { Effect, Schema } from "effect";
import {
  HouseholdSchema,
  CollectionSchema,
  IdSchema,
  MealSchema,
  ExtraSchema,
  CheckSchema,
  ShoppingOrderSchema,
  DateSchema,
  type Collection,
  type Meal,
  type Extra,
  type ShoppingOrder,
  type CalendarDate,
} from "./domain";
import { database, stored, ValidationError, MissingReference, NotFound, Conflict } from "./storage";
import { parseRecipe, recipeStatement, matchRecipeIngredients, type RecipeRow } from "./recipes";
import { getGroceries, groceryStatement, matchGrocery, parseGrocery, type GroceryRow } from "./groceries";
import { sampleRecipes, sampleMeals, sampleGroceries } from "./seed";
import { record } from "./observability";

const validate = <S extends Schema.Constraint>(schema: S, input: S["Type"], message: string) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError(() => new ValidationError({ message })));

const ok = { ok: true } as const;

function mealStatement(db: D1Database, meal: Meal) {
  return db
    .prepare(`INSERT INTO meals (id,recipeId,date,slot,scale,note) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET recipeId=excluded.recipeId,date=excluded.date,slot=excluded.slot,scale=excluded.scale,note=excluded.note`)
    .bind(meal.id, meal.recipeId, meal.date, meal.slot, meal.scale, meal.note);
}

export const getHousehold = (db: D1Database) =>
  Effect.gen(function* () {
    // One batch keeps all seven reads in the same transaction snapshot.
    const snapshot = yield* database(() =>
      db.batch([
        db.prepare("SELECT * FROM recipes ORDER BY title"),
        db.prepare("SELECT * FROM meals ORDER BY date,slot,id"),
        db.prepare("SELECT * FROM extras ORDER BY rowid"),
        db.prepare("SELECT * FROM checks WHERE checked=1"),
        db.prepare("SELECT * FROM collections ORDER BY name"),
        db.prepare("SELECT * FROM groceries ORDER BY name,id"),
        db.prepare("SELECT aisles,items FROM shopping_order WHERE id=1"),
      ]),
    );

    // SAFETY: Fixed SELECT order identifies unbranded storage row shapes only.
    // All values, including JSON columns, are decoded inside stored below.
    const [recipes, meals, extras, checks, collections, groceries, shoppingOrder] = snapshot as [
      D1Result<RecipeRow>,
      D1Result,
      D1Result,
      D1Result,
      D1Result,
      D1Result<GroceryRow>,
      D1Result<{ aisles: string; items: string }>,
    ];

    yield* record("household_snapshot", {
      recipes: recipes.results.length,
      meals: meals.results.length,
      groceries: groceries.results.length,
    });

    return yield* stored(() =>
      Schema.decodeUnknownSync(HouseholdSchema)({
        recipes: recipes.results.map(parseRecipe),
        meals: meals.results,
        extras: extras.results,
        checks: checks.results,
        collections: collections.results,
        groceries: groceries.results.map(parseGrocery),
        shoppingOrder: shoppingOrder.results[0]
          ? {
              aisles: JSON.parse(shoppingOrder.results[0].aisles),
              items: JSON.parse(shoppingOrder.results[0].items),
            }
          : { aisles: [], items: [] },
      }),
    );
  }).pipe(Effect.withSpan("household.load"));

export const listCollections = (db: D1Database) =>
  Effect.gen(function* () {
    const rows = yield* database(() => db.prepare("SELECT * FROM collections ORDER BY name,id").all());

    const collections = yield* stored(() =>
      Schema.decodeUnknownSync(Schema.Array(CollectionSchema))(rows.results),
    );

    return { collections };
  });

export const saveCollection = (db: D1Database, input: Collection) =>
  Effect.gen(function* () {
    const message = "Add a collection name of 100 characters or less.";
    const collection = yield* validate(CollectionSchema, { ...input, name: input.name.trim() }, message);
    yield* validate(IdSchema, collection.id, message);

    const result = yield* database(() =>
      db
        .prepare(`INSERT INTO collections(id,name) SELECT ?,? WHERE NOT EXISTS
          (SELECT 1 FROM collections WHERE name=? AND id<>?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name`)
        .bind(collection.id, collection.name, collection.name, collection.id)
        .run(),
    );

    if (!result.meta.changes)
      return yield* new Conflict({ message: "A collection with that name already exists." });

    return { collection };
  });

export const deleteCollection = (db: D1Database, id: string) =>
  Effect.gen(function* () {
    const result = yield* database(() => db.prepare("DELETE FROM collections WHERE id=?").bind(id).run());

    if (!result.meta.changes) return yield* new NotFound({ message: "That collection no longer exists." });

    return ok;
  });

export const saveMeal = (db: D1Database, input: Meal) =>
  Effect.gen(function* () {
    const meal = yield* validate(
      MealSchema,
      input,
      "Choose a valid date and a recipe scale between 0 and 100.",
    );

    if (meal.recipeId === null) {
      if (!meal.note.trim()) return yield* new ValidationError({ message: "Write a note for this meal." });
    } else {
      const recipe = yield* database(() =>
        db.prepare("SELECT id FROM recipes WHERE id=?").bind(meal.recipeId).first(),
      );

      if (!recipe)
        return yield* new MissingReference({
          message: "That recipe no longer exists. Choose another recipe.",
        });
    }

    yield* database(() => mealStatement(db, meal).run());

    return { meal };
  });

export const deleteMeal = (db: D1Database, id: string) =>
  database(() => db.prepare("DELETE FROM meals WHERE id=?").bind(id).run()).pipe(Effect.as(ok));

export const saveExtra = (db: D1Database, input: Extra) =>
  Effect.gen(function* () {
    const extra = yield* validate(ExtraSchema, input, "Add an item name of 200 characters or less.");
    const saved = { ...extra, name: extra.name.trim() };
    yield* database(() =>
      db
        .prepare(
          "INSERT INTO extras(id,name,checked) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,checked=excluded.checked",
        )
        .bind(saved.id, saved.name, saved.checked)
        .run(),
    );

    return { extra: saved };
  });

export const deleteExtra = (db: D1Database, id: string) =>
  database(() => db.prepare("DELETE FROM extras WHERE id=?").bind(id).run()).pipe(Effect.as(ok));

export const setShoppingChecked = (db: D1Database, input: typeof CheckSchema.Type) =>
  Effect.gen(function* () {
    const check = yield* validate(CheckSchema, input, "Invalid shopping item.");
    yield* database(() =>
      check.checked
        ? db
            .prepare("INSERT INTO checks(key,checked) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET checked=1")
            .bind(check.key)
            .run()
        : db.prepare("DELETE FROM checks WHERE key=?").bind(check.key).run(),
    );

    return ok;
  });

export const setShoppingOrder = (db: D1Database, input: ShoppingOrder) =>
  Effect.gen(function* () {
    const order = yield* validate(ShoppingOrderSchema, input, "Shopping order must contain unique strings.");
    yield* database(() =>
      db
        .prepare(
          "INSERT INTO shopping_order(id,aisles,items) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET aisles=excluded.aisles,items=excluded.items",
        )
        .bind(JSON.stringify(order.aisles), JSON.stringify(order.items))
        .run(),
    );

    return ok;
  });

export const addDemoData = (db: D1Database, today: CalendarDate) =>
  Effect.gen(function* () {
    yield* validate(DateSchema, today, "Choose a valid sample week.");
    const existing = yield* database(() => db.prepare("SELECT id FROM recipes LIMIT 1").first());

    if (existing)
      return yield* new Conflict({ message: "Sample recipes are only added to an empty household." });

    const collections = yield* database(() =>
      db.prepare("SELECT name FROM collections").all<{ name: string }>(),
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
            category: collections.results.some((collection) => collection.name === recipe.category)
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
