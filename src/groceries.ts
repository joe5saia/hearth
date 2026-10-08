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

// Browser-safe: importing this module never accesses a database or Worker binding.
export function matchGrocery(name: string, groceries: readonly GroceryItem[]): GroceryItem | undefined {
  const key = normalize(name);

  if (!key) return undefined;

  const matches = groceries.filter((item) =>
    [item.name, ...item.aliases].some((alias) => normalize(alias) === key),
  );

  return matches.length === 1 ? matches[0] : undefined;
}

export type GroceryRow = Omit<GroceryDraft, "aliases"> & { aliases: string };

export const parseGrocery = (row: GroceryRow): GroceryItem =>
  Schema.decodeUnknownSync(GroceryItemSchema)({ ...row, aliases: JSON.parse(row.aliases) });

export function getGroceries(db: D1Database) {
  return Effect.gen(function* () {
    const rows = yield* database(() =>
      db.prepare("SELECT * FROM groceries ORDER BY name,id").all<GroceryRow>(),
    );

    return yield* stored(() => rows.results.map(parseGrocery));
  });
}

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

export function saveGrocery(db: D1Database, item: GroceryItem) {
  return Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(GroceryItemSchema)(item).pipe(
      Effect.mapError(
        () => new ValidationError({ message: "Check the grocery name, package quantity, unit, and URL." }),
      ),
    );

    const grocery = { ...decoded, name: decoded.name.trim(), aisle: decoded.aisle.trim() };

    yield* database(() => groceryStatement(db, grocery).run());

    return { grocery };
  });
}

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

export function renameAisle(db: D1Database, input: typeof RenameAisleSchema.Type) {
  return Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(RenameAisleSchema)(input).pipe(
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

export function deleteGrocery(db: D1Database, id: GroceryId) {
  return Effect.gen(function* () {
    const [result] = yield* database(() =>
      db.batch([
        db
          .prepare(`DELETE FROM groceries WHERE id=? AND NOT EXISTS
        (SELECT 1 FROM recipes,json_each(recipes.ingredients) AS ingredient WHERE json_extract(ingredient.value,'$.groceryItemId')=?)`)
          .bind(id, id),
        db
          .prepare("DELETE FROM checks WHERE key=? AND NOT EXISTS (SELECT 1 FROM groceries WHERE id=?)")
          .bind(JSON.stringify(["shopping-list", id]), id),
      ]),
    );

    if (!result.meta.changes)
      return yield* new Conflict({ message: "This grocery is used by a recipe or no longer exists." });

    return { ok: true as const };
  });
}
