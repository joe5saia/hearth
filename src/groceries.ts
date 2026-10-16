import { Effect, Schema } from "effect";
import { Conflict, MissingReference, ValidationError, database, stored } from "./storage";
import {
  GroceryItemSchema,
  RenameAisleSchema,
  type GroceryItem,
  type GroceryDraft,
  type Ingredient,
  type GroceryId,
} from "./domain";

const normalize = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** Browser-safe exact name/alias matching; ambiguous or blank names have no match. */
export function matchGrocery(name: string, groceries: readonly GroceryItem[]): GroceryItem | undefined {
  const key = normalize(name);

  if (!key) return undefined;

  const matches = groceries.filter((item) =>
    [item.name, ...item.aliases].some((alias) => normalize(alias) === key),
  );

  return matches.length === 1 ? matches[0] : undefined;
}

/** SQL representation with aliases stored as JSON text. */
export type GroceryRow = Omit<GroceryDraft, "aliases"> & { aliases: string };

const decodeGroceryRow = Schema.decodeUnknownSync(
  Schema.Struct({
    ...GroceryItemSchema.fields,
    aliases: Schema.fromJsonString(GroceryItemSchema.fields.aliases),
  }),
);

/** Decodes an untrusted SQL grocery row, including its JSON aliases. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the SQL decoding boundary, not an inner operation.
export const parseGrocery = (row: unknown): GroceryItem => decodeGroceryRow(row);

/** Reads validated catalog items in name/ID order. */
export function getGroceries(db: D1Database) {
  return Effect.gen(function* () {
    const rows = yield* database(() => db.prepare("SELECT * FROM groceries ORDER BY name,id").all());

    return yield* stored(() => rows.results.map(parseGrocery));
  });
}

/** Matches omitted links, preserves explicit null, and rejects missing explicit grocery IDs. */
export function linkIngredients(ingredients: readonly Ingredient[], groceries: readonly GroceryItem[]) {
  return Effect.gen(function* () {
    return yield* Effect.forEach(ingredients, (ingredient) =>
      Effect.gen(function* () {
        if (ingredient.groceryItemId !== undefined) {
          if (
            ingredient.groceryItemId !== null &&
            !groceries.some((item) => item.id === ingredient.groceryItemId)
          )
            return yield* new MissingReference({
              message: "That grocery item no longer exists. No recipes were changed.",
            });

          return { ...ingredient, grocerySuggestions: undefined };
        }

        const match = matchGrocery(ingredient.name, groceries);

        const suggestions = ingredient.grocerySuggestions?.filter((id) =>
          groceries.some((item) => item.id === id),
        );

        return match
          ? { ...ingredient, groceryItemId: match.id, grocerySuggestions: undefined }
          : { ...ingredient, grocerySuggestions: suggestions?.length ? suggestions : undefined };
      }),
    );
  });
}

const validGrocery = (item: GroceryItem) =>
  Schema.decodeEffect(GroceryItemSchema)(item).pipe(
    Effect.mapError(
      () => new ValidationError({ message: "Check the grocery name, package quantity, unit, and URL." }),
    ),
    Effect.map((decoded) => ({ ...decoded, name: decoded.name.trim(), aisle: decoded.aisle.trim() })),
  );

/** Validates and upserts a catalog item, trimming its display name and aisle. */
export function saveGrocery(db: D1Database, item: GroceryItem) {
  return Effect.gen(function* () {
    const grocery = yield* validGrocery(item);

    yield* database(() => groceryStatement(db, grocery).run());

    return { grocery };
  });
}

/** Upserts a catalog item and puts it on the shopping list atomically, keeping any saved package count. */
export function saveGroceryToList(db: D1Database, item: GroceryItem) {
  return Effect.gen(function* () {
    const grocery = yield* validGrocery(item);

    yield* database(() =>
      db.batch([
        groceryStatement(db, grocery),
        db
          .prepare(
            "INSERT INTO checks(key,checked,packages) VALUES(?,0,1) ON CONFLICT(key) DO UPDATE SET checked=0",
          )
          .bind(JSON.stringify(["shopping-list", grocery.id])),
      ]),
    );

    return { grocery };
  });
}

/** Builds an upsert for an already validated grocery, encoding aliases as JSON. */
export function groceryStatement(db: D1Database, grocery: GroceryItem) {
  return db
    .prepare(`INSERT INTO groceries(id,name,url,aisle,quantity,unit,aliases) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,aisle=excluded.aisle,quantity=excluded.quantity,unit=excluded.unit,aliases=excluded.aliases`)
    .bind(
      grocery.id,
      grocery.name,
      grocery.url,
      grocery.aisle,
      grocery.quantity,
      grocery.unit,
      JSON.stringify(grocery.aliases),
    );
}

/** Atomically renames an aisle and its saved position, rejecting an occupied target. */
export function renameAisle(db: D1Database, input: typeof RenameAisleSchema.Type) {
  return Effect.gen(function* () {
    const decoded = yield* Schema.decodeEffect(RenameAisleSchema)(input).pipe(
      Effect.mapError(() => new ValidationError({ message: "Enter an aisle name up to 150 characters." })),
    );

    const from = decoded.from;
    const to = decoded.to.trim();

    if (from === to) return { ok: true as const };

    const [result] = yield* database(() =>
      db.batch([
        db
          .prepare(
            "UPDATE groceries SET aisle=? WHERE aisle=? AND NOT EXISTS (SELECT 1 FROM groceries WHERE aisle=?)",
          )
          .bind(to, from, to),
        db
          .prepare(`UPDATE shopping_order SET aisles=(
            SELECT json_group_array(aisle) FROM (
              SELECT CASE WHEN value=? THEN ? ELSE value END AS aisle
              FROM json_each(shopping_order.aisles)
              GROUP BY aisle ORDER BY MIN(CAST(key AS INTEGER))
            )
          ) WHERE id=1 AND changes()>0`)
          .bind(from, to),
      ]),
    );

    if (!result.meta.changes)
      return yield* new Conflict({
        message: "That aisle no longer exists or the new name is already in use.",
      });

    return { ok: true as const };
  });
}

/** Atomically deletes a grocery, unlinks recipe ingredients, and removes list membership. */
export function deleteGrocery(db: D1Database, id: GroceryId) {
  return Effect.gen(function* () {
    const [result] = yield* database(() =>
      db.batch([
        // The database trigger unlinks ingredients in the same atomic deletion.
        db.prepare("DELETE FROM groceries WHERE id=?").bind(id),
        db
          .prepare("DELETE FROM checks WHERE key=? AND NOT EXISTS (SELECT 1 FROM groceries WHERE id=?)")
          .bind(JSON.stringify(["shopping-list", id]), id),
      ]),
    );

    if (!result.meta.changes) return yield* new Conflict({ message: "This grocery no longer exists." });

    return { ok: true as const };
  });
}
