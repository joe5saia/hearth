import { Data, Effect, Schema } from "effect";
import { GroceryItemSchema, RecipeSchema, type Recipe } from "./domain";
import { database, stored } from "./storage";
import { record } from "./observability";
import { parseRecipe } from "./recipes";
import { parseGrocery } from "./groceries";
import {
  matchIngredients,
  matchingFailureReason,
  normalizationModel,
  selectionModel,
} from "./ingredient-matching";

const RecipeStorageRow = Schema.Struct({
  ...RecipeSchema.fields,
  ingredients: Schema.String,
  instructions: Schema.String,
});

const GroceryStorageRow = Schema.Struct({ ...GroceryItemSchema.fields, aliases: Schema.String });

const GroceryRevision = Schema.Struct({ version: Schema.Number });

/** Missing AI binding; transports own rendering its established public message. */
export class AiUnavailable extends Data.TaggedError("AiUnavailable")<{ message: string }> {}

/**
 * Schedules best-effort matching within waitUntil, independently of the saving request's cancellation.
 * Missing bindings or an empty scope are a no-op; matching failures never reject a successful save.
 */
export function matchNewRecipes(
  db: D1Database,
  ai: Ai | undefined,
  ctx: ExecutionContext | undefined,
  recipeIds: readonly string[],
) {
  if (!ai || !ctx || !recipeIds.length) return;

  ctx.waitUntil(
    Effect.runPromise(matchGroceries(db, ai, undefined, recipeIds)).catch(() => {
      // matchGroceries logs failures; they must never turn a successful save into an error.
    }),
  );
}

/**
 * Matches a snapshot and persists only recipes whose context and grocery revision remain unchanged.
 * Draft mode returns a matched draft without saving it; scoped background runs cap inference at 20 seconds.
 * Storage failures do not prove that writes failed to commit and are never retried here.
 */
export const matchGroceries = (
  db: D1Database,
  ai?: Ai,
  ray?: string | null,
  recipeIds?: readonly string[],
  draft?: Recipe,
) =>
  Effect.gen(function* () {
    const started = performance.now();
    const runId = crypto.randomUUID();
    let matchedRecipe: Recipe | undefined;
    console.info(
      JSON.stringify({
        event: "ingredient_matching_started",
        runId,
        scope: draft ? "recipe_draft" : recipeIds ? "new_recipes" : "household",
        cfRay: ray && /^[a-f0-9]{16}-[A-Z]{3}$/.test(ray) ? ray : null,
        normalizationModel,
        selectionModel,
      }),
    );

    if (!ai) {
      yield* record("matching_failure", { reason: "ai_unavailable", outcome: "error" });
      console.error(
        JSON.stringify({
          event: "ingredient_matching_failed",
          runId,
          stage: "setup",
          reason: "ai_unavailable",
        }),
      );

      return yield* new AiUnavailable({
        message:
          "AI ingredient matching requires a Cloudflare deployment with an AI binding. Local recipe saves still use exact matching.",
      });
    }

    let stage = "snapshot";

    const report = yield* Effect.gen(function* () {
      const snapshot = yield* database(() =>
        db.batch([
          db.prepare("SELECT * FROM recipes"),
          db.prepare("SELECT * FROM groceries ORDER BY name,id"),
          db.prepare("SELECT version FROM grocery_revision WHERE id=1"),
        ]),
      );

      const { rows, originals, groceries, revision } = yield* stored(() => {
        const [recipes, products, revisions] = snapshot;

        if (!recipes || !products || !revisions) throw new Error("Incomplete matching snapshot");

        // Decode SQL rows before passing them to the owning JSON/domain parsers. Keep the
        // stored JSON strings intact: optimistic persistence compares their exact bytes.
        const rows = Schema.decodeUnknownSync(Schema.Array(RecipeStorageRow))(recipes.results);
        const groceryRows = Schema.decodeUnknownSync(Schema.Array(GroceryStorageRow))(products.results);
        const revision = Schema.decodeUnknownSync(GroceryRevision)(revisions.results[0]);

        return {
          rows,
          originals: rows.map(parseRecipe),
          groceries: groceryRows.map(parseGrocery),
          revision: revision.version,
        };
      });

      stage = "matching";

      // Reserve ten seconds of waitUntil's lifetime for cancellation and D1 persistence.
      const result = yield* matchIngredients(
        ai,
        draft ? [draft] : originals,
        groceries,
        db,
        runId,
        recipeIds,
        recipeIds ? started + 20_000 : undefined,
        originals,
      ).pipe(Effect.withSpan("matching.ingredients"));

      if (draft) {
        matchedRecipe = result.recipes[0];

        return result.report;
      }

      stage = "persistence";

      const changed = result.recipes.flatMap((recipe, index) => {
        const links = recipe.ingredients.filter(
          (ingredient, position) =>
            ingredient.groceryItemId !== originals[index].ingredients[position].groceryItemId,
        ).length;

        const edits = recipe.ingredients.filter(
          (ingredient, position) =>
            JSON.stringify(ingredient) !== JSON.stringify(originals[index].ingredients[position]),
        ).length;

        return edits ? [{ recipe, before: rows[index], links, edits }] : [];
      });

      console.info(
        JSON.stringify({
          event: "ingredient_matching_persisting",
          runId,
          changedRecipes: changed.length,
          proposedMatches: result.report.matched,
          elapsedMs: Math.round(performance.now() - started),
        }),
      );

      if (!changed.length) return result.report;

      const writes = yield* database(() =>
        db.batch(
          changed.map(({ recipe, before }) =>
            db
              .prepare(
                "UPDATE recipes SET ingredients=? WHERE id=? AND ingredients=? AND title=? AND description=? AND category=? AND instructions=? AND (SELECT version FROM grocery_revision WHERE id=1)=?",
              )
              .bind(
                JSON.stringify(recipe.ingredients),
                recipe.id,
                before.ingredients,
                before.title,
                before.description,
                before.category,
                before.instructions,
                revision,
              ),
          ),
        ),
      );

      for (const [index, saved] of writes.entries()) {
        if (!saved.meta.changes) {
          const { links, edits } = changed[index];
          result.report.matched -= links;
          result.report.conflicts += edits;
        }
      }

      return result.report;
    }).pipe(
      Effect.tapError((error) =>
        record("matching_failure", { reason: matchingFailureReason(error), outcome: "error" }),
      ),
      Effect.tapError((error) =>
        Effect.sync(() => {
          console.error(
            JSON.stringify({
              event: "ingredient_matching_failed",
              runId,
              stage,
              reason: matchingFailureReason(error),
              elapsedMs: Math.round(performance.now() - started),
            }),
          );
        }),
      ),
    );

    report.totalMs = performance.now() - started;
    yield* record("matching_completed", {
      ...report,
      outcome: report.failed || report.conflicts ? "partial" : "complete",
    });
    console.info(
      JSON.stringify({
        event: "ingredient_matching_completed",
        runId,
        outcome: report.failed || report.conflicts ? "partial" : "complete",
        ...report,
      }),
    );

    return matchedRecipe
      ? { ok: true as const, report, recipe: matchedRecipe }
      : { ok: true as const, report };
  }).pipe(Effect.withSpan("matching.run"));
